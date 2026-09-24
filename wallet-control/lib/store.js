// LEASH wallet-control — runtime state: mandates, runs, decisions, step-ups.
// In-memory with JSON persistence for restart-safety. All spend tracking uses
// simulated purchase timestamps; decision deadlines use the real clock.

import fs from 'node:fs';
import { round2 } from './util.js';

export class Store {
  constructor(persistPath = null) {
    this.persistPath = persistPath;
    this.mandates = new Map();   // mandate_id -> {mandate_id, status, instruction, hard_rules, uncertainty_policy, guidance, open_questions, created_at, draft_id}
    this.runs = new Map();       // run_id -> RunState
    if (this.persistPath) this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      for (const m of raw.mandates || []) this.mandates.set(m.mandate_id, m);
      for (const r of raw.runs || []) {
        r.decisions = new Map(r.decisionsSerialized || []);
        r.stepUps = new Map(r.stepUpsSerialized || []);
        this.runs.set(r.run_id, r);
      }
    } catch { /* fresh state */ }
  }

  #persist() {
    if (!this.persistPath) return;
    const runs = [...this.runs.values()].map(r => ({
      ...r,
      decisions: undefined, stepUps: undefined,
      decisionsSerialized: [...r.decisions.entries()],
      stepUpsSerialized: [...(r.stepUps?.entries?.() || [])],
    }));
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify({ mandates: [...this.mandates.values()], runs }, null, 1));
    } catch { /* best-effort */ }
  }

  // ---- Mandates ------------------------------------------------------------
  putMandate(m) { this.mandates.set(m.mandate_id, m); this.#persist(); }
  getMandate(id) { return this.mandates.get(id) || null; }

  // ---- Runs ----------------------------------------------------------------
  createRun({ run_id, scenario_id, mandate_id, mandateSnapshot, totalEvents, customerIds }) {
    const run = {
      run_id, scenario_id, mandate_id,
      mandateSnapshot,
      totalEvents,
      customerIds: customerIds || [],
      status: 'running',
      decisions: new Map(),  // live authorization_id -> record
      stepUps: new Map(),    // live authorization_id -> {event, decidedAt, deadline, evaluation}
      spend: [],             // final approvals: {simTs, amount, merchantId, authorization_id}
      createdAt: Date.now(),
    };
    this.runs.set(run_id, run);
    this.#persist();
    return run;
  }

  getRun(id) { return this.runs.get(id) || null; }

  /** Engine-facing state adapter for a run. */
  runState(run) {
    return {
      approvedSpendInWindow: (days, beforeSimTs) => {
        const cutoff = beforeSimTs - days * 86400_000;
        let sum = 0;
        for (const s of run.spend) if (s.simTs > cutoff && s.simTs <= beforeSimTs) sum += s.amount;
        return round2(sum);
      },
      inRunApprovedMerchant: (merchantId) => run.spend.some(s => s.merchantId === merchantId),
      findDuplicate: ({ signature, authId, simTs, merchantId, billing }) => {
        for (const [aid, d] of run.decisions) {
          if (aid === authId) continue;
          const minutesAgo = simTs && d.simTs ? Math.round(Math.abs(simTs - d.simTs) / 60000) : null;
          if (minutesAgo == null || minutesAgo > 240) continue;
          if (d.signature === signature) {
            if (d.finalDecision === 'approved') return { kind: 'approved-similar', billing: d.billing ?? d.amount, minutesAgo };
            if (d.finalDecision === 'declined') return { kind: 'declined-similar', billing: d.billing ?? d.amount, minutesAgo };
          } else if (d.merchantId && d.merchantId === merchantId && minutesAgo <= 15 && Math.abs(d.amount - billing) <= Math.max(2, billing * 0.3)) {
            if (d.finalDecision === 'approved') return { kind: 'split-suspect', billing: d.amount, minutesAgo };
          }
        }
        return null;
      },
      priorDecisions: () => run.decisions,
    };
  }

  recordDecision(runId, authId, record) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.decisions.set(authId, { ...record, decidedAt: Date.now() });
    this.#persist();
  }

  getDecision(runId, authId) {
    return this.runs.get(runId)?.decisions.get(authId) || null;
  }

  /** Final human resolution of a step-up. Counts toward spend when approved. */
  recordStepUpResolution(runId, authId, finalDecision, customerMessage) {
    const run = this.runs.get(runId);
    if (!run) return null;
    const pending = run.stepUps.get(authId);
    if (!pending) return null;
    run.stepUps.delete(authId);
    const d = run.decisions.get(authId);
    if (d) {
      d.finalDecision = finalDecision;
      d.resolvedAt = Date.now();
      d.customerMessage = customerMessage;
    }
    if (finalDecision === 'approved') {
      const a = pending.event.authorization;
      run.spend.push({
        simTs: new Date(a.timestamp).getTime(),
        amount: round2(a.billing_amount_chf),
        merchantId: a.merchant?.merchant_id,
        authorization_id: authId,
      });
    }
    this.#persist();
    return { run, pending, decision: d };
  }

  addStepUp(runId, authId, event, evaluation, deadline) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.stepUps.set(authId, { event, evaluation, deadline, openedAt: Date.now() });
    this.#persist();
  }

  pendingStepUps(runId) {
    const run = this.runs.get(runId);
    return run ? [...run.decisions.entries()].filter(([, d]) => d.decision === 'step_up' && !d.finalDecision && run.stepUps.has(d.authorizationId)) : [];
  }
}
