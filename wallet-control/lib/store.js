// LEASH wallet-control — runtime state: mandates, runs, decisions, step-ups.
// In-memory with JSON persistence for restart-safety. All spend tracking uses
// simulated purchase timestamps; decision deadlines use the real clock.

import fs from 'node:fs';
import { round2 } from './util.js';
import { digest, fail, validateControls } from './wallet-controls.js';

export class Store {
  constructor(persistPath = null) {
    this.persistPath = persistPath;
    this.mandates = new Map();   // mandate_id -> {mandate_id, status, instruction, hard_rules, uncertainty_policy, guidance, open_questions, created_at, draft_id}
    this.runs = new Map();       // run_id -> RunState
    this.trustedDomains = new Map(); // domain -> {addedAt, note} — customer-approved ("yellow-list resolved") merchants
    this.controls = {};
    this.controlVersion = 0;
    this.journal = [];
    this.receipts = [];
    this.reservations = new Map();
    this.queue = Promise.resolve();
    if (this.persistPath) this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      this.controls = raw.controls || {};
      this.controlVersion = raw.controlVersion || 0;
      this.journal = raw.journal || [];
      this.receipts = raw.receipts || [];
      this.reservations = new Map(raw.reservations || []);
      for (const m of raw.mandates || []) this.mandates.set(m.mandate_id || m.draft_id, m);
      for (const [d, meta] of raw.trusted_domains || []) this.trustedDomains.set(d, meta);
      for (const r of raw.runs || []) {
        r.decisions = new Map(r.decisionsSerialized || []);
        r.stepUps = new Map(r.stepUpsSerialized || []);
        this.runs.set(r.run_id, r);
      }
      if (!this.verifyJournal()) throw new Error('Wallet audit chain is damaged');
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
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
      const pendingPath = this.persistPath + '.pending';
      fs.writeFileSync(pendingPath, JSON.stringify({ controls:this.controls, controlVersion:this.controlVersion, journal:this.journal, receipts:this.receipts, reservations:[...this.reservations], mandates: [...this.mandates.values()], trusted_domains: [...this.trustedDomains.entries()], runs }, null, 1), { mode: 0o600 });
      const fd = fs.openSync(pendingPath, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(pendingPath, this.persistPath);
    } catch (err) { this.writeError = err; throw err; }
  }

  async exclusive(fn) {
    const previous = this.queue;
    let release;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try { if (this.writeError) throw fail('Wallet storage unavailable; spending is paused',503); return await fn(); }
    finally { release(); }
  }
  save() { this.#persist(); }
  audit(kind, data) {
    const entry = { sequence:this.journal.length+1, at:new Date().toISOString(), kind, data, previous:this.journal.at(-1)?.hash || null };
    entry.hash = digest(entry);
    this.journal.push(entry); this.#persist(); return entry;
  }
  verifyJournal() {
    return this.journal.every((entry,i) => { const {hash,...rest}=entry; return hash===digest(rest) && entry.sequence===i+1 && entry.previous===(this.journal[i-1]?.hash || null); });
  }
  updateControls(value, version) {
    if (version !== this.controlVersion) throw fail('Controls changed elsewhere. Reload before saving.');
    this.controls = validateControls(value); this.controlVersion++;
    this.audit('controls.updated',{version:this.controlVersion,controls:this.controls});
    return {controls:this.controls,version:this.controlVersion};
  }
  ledger() {
    const all = new Map();
    for (const run of this.runs.values()) for (const s of run.spend) all.set(s.authorization_id,{...s,mandate_id:run.mandate_id,run_id:run.run_id});
    for (const [id,s] of this.reservations) if (!all.has(id)) all.set(id,s);
    return [...all.values()];
  }
  reserve(run, event) {
    const a=event.authorization;
    this.reservations.set(a.authorization_id,{authorization_id:a.authorization_id,amount:a.billing_amount_chf,simTs:Date.parse(a.timestamp),merchantId:a.merchant?.merchant_id,mandate_id:run.mandate_id,run_id:run.run_id});
    this.#persist();
  }
  revoke(id) {
    const m=this.getMandate(id); if (m) { m.status='revoked'; this.putMandate(m); }
    for (const run of this.runs.values()) if(run.mandate_id===id) {
      run.status='revoked';
      for (const [aid] of run.stepUps) { const d=run.decisions.get(aid); if(d){d.finalDecision='declined';d.customerMessage='Permission revoked';} }
      run.stepUps.clear();
    }
    this.audit('policy.revoked',{mandate_id:id});
  }

  // ---- Mandates ------------------------------------------------------------
  putMandate(m) {
    const id = m.mandate_id || m.draft_id;
    if (!id) throw new Error('Mandate or draft ID required');
    if (m.mandate_id && m.draft_id) this.mandates.delete(m.draft_id);
    this.mandates.set(id, m); this.#persist();
  }
  getMandate(id) { return this.mandates.get(id) || null; }

  // ---- Trusted merchant domains ("whitelist"; filled by customer approval) ----
  /** Add a domain to the customer's trusted list. Tolerates URL-shaped input;
   *  stores the bare registrable host (no scheme, path, or www). Idempotent. */
  addTrustedDomain(domain, note) {
    let d = String(domain || '').toLowerCase().trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(d) || d.includes('/')) {
      try { d = new URL(d.includes('://') ? d : `https://${d}`).hostname; } catch { /* keep raw */ }
    }
    d = d.replace(/^www\./, '');
    if (!d || !d.includes('.')) return null;
    const meta = this.trustedDomains.get(d) || { addedAt: Date.now() };
    meta.note = note || meta.note || 'customer approved';
    this.trustedDomains.set(d, meta);
    this.#persist();
    return d;
  }

  /** Exact or subdomain match: trusting example.com covers shop.example.com. */
  isTrustedDomain(domain) {
    const d = String(domain || '').toLowerCase().trim().replace(/^www\./, '');
    if (!d || !d.includes('.')) return null;
    if (this.trustedDomains.has(d)) return this.trustedDomains.get(d);
    for (const [trusted, meta] of this.trustedDomains) {
      if (d.endsWith('.' + trusted)) return meta;
    }
    return null;
  }

  // ---- Runs ----------------------------------------------------------------
  createRun({ run_id, scenario_id, mandate_id, mandateSnapshot, totalEvents, customerIds }) {
    const run = {
      run_id, scenario_id, mandate_id,
      mandateSnapshot: structuredClone(mandateSnapshot),
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
      trustedDomainCheck: (domain) => this.isTrustedDomain(domain),
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

  /** Commit accepted decisions, spend and human-review state together, once. */
  acceptDecision(runId, authId, record, event, evaluation, deadline) {
    const run = this.runs.get(runId);
    if (!run) throw new Error('Unknown run');
    if (run.decisions.get(authId)?.submitted) return false;
    const finalDecision = record.decision === 'step_up' ? null
      : record.decision === 'approve' ? 'approved' : 'declined';
    run.decisions.set(authId, { ...record, submitted: true, finalDecision, decidedAt: Date.now() });
    if (record.decision === 'step_up') {
      run.stepUps.set(authId, { event, evaluation, deadline, openedAt: Date.now() });
    } else if (finalDecision === 'approved' && !run.spend.some(s => s.authorization_id === authId)) {
      run.spend.push({ simTs: record.simTs, amount: record.amount, merchantId: record.merchantId, authorization_id: authId });
    }
    this.reservations.delete(authId);
    this.#persist();
    return true;
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
    this.reservations.delete(authId);
    if (!run.stepUps.size && run.decisions.size >= run.totalEvents) run.status = 'completed';
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
