// LEASH wallet-control — offline implementation of the challenge API.
// Mirrors the hosted platform's contract (bootstrap, mandates, scenario-runs,
// long-poll decision-requests, decision, resolve, reset) backed by the data pack,
// so the full app — UI + worker + engine — runs end-to-end without a team key.
import crypto from 'node:crypto';
import { PackData } from './events.js';

const rid = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;

export class LocalApi {
  constructor(packDir, store) {
    this.pack = new PackData(packDir);
    this.store = store;
    this.runs = new Map();      // run_id -> {queue, cursor, mandate, awaiting: null|{resolver}}
    this.decisions = new Map(); // live authorization_id -> accepted decision
    this.stepUps = new Map();   // live authorization_id -> true
    this.events = [];           // feed
    this.drafts = new Map();
  }

  bootstrap() {
    return {
      api_version: 'sim-1.0.0',
      pack_version: 'saw26 (offline simulator)',
      scenarios: this.pack.scenarios.map(s => ({ scenario_id: s.scenario_id, name: s.scenario_name, event_count: Number(s.event_count) })),
      timeouts: { decision_seconds: 8, human_window_seconds: 120 },
      features: { offline: true },
    };
  }

  referenceData() {
    return { scenarios: this.pack.scenarios, fx_rates: 'see data/pack/fx_rates.csv', history: 'data/pack/authorization_history.csv' };
  }

  // ---- Mandates --------------------------------------------------------------
  createMandate(body) {
    const draft_id = rid('md');
    const mandate = {
      draft_id,
      status: 'draft',
      instruction: body.instruction,
      hard_rules: body.hard_rules || [],
      uncertainty_policy: body.uncertainty_policy || 'ask',
      guidance: body.guidance || [],
      open_questions: body.open_questions || [],
      created_at: new Date().toISOString(),
    };
    this.drafts.set(draft_id, mandate);
    return { draft_id, ...mandate };
  }

  confirmMandate(draftId, { confirmed }) {
    const m = this.drafts.get(draftId);
    if (!m) throw new HttpError(404, 'draft not found');
    if (!confirmed) throw new HttpError(400, 'confirmation must be true');
    m.status = 'active';
    m.mandate_id = rid('TM_SIM');
    m.confirmed_at = new Date().toISOString();
    this.store.putMandate(m);
    return { mandate_id: m.mandate_id };
  }

  getMandate(id) {
    const m = [...this.drafts.values()].find(x => x.mandate_id === id || x.draft_id === id);
    if (!m) throw new HttpError(404, 'mandate not found');
    return m;
  }

  patchMandate(id, patch) {
    const m = this.getMandate(id);
    if (m.status !== 'active') throw new HttpError(409, 'only active mandates can be patched');
    if (patch.hard_rules) {
      // tightening only: every existing rule must remain, additions allowed
      for (const old of m.hard_rules) {
        if (!patch.hard_rules.some(r => JSON.stringify(r) === JSON.stringify(old))) {
          throw new HttpError(422, 'existing rules cannot be removed or replaced — tightening only');
        }
      }
      m.hard_rules = patch.hard_rules;
    }
    if (patch.uncertainty_policy) {
      const allowed = (m.uncertainty_policy === 'ask' || m.uncertainty_policy === 'approve') && patch.uncertainty_policy === 'decline';
      if (!allowed && patch.uncertainty_policy !== m.uncertainty_policy) {
        throw new HttpError(422, `uncertainty_policy ${m.uncertainty_policy} → ${patch.uncertainty_policy} not allowed by platform rules`);
      }
      m.uncertainty_policy = patch.uncertainty_policy;
    }
    if (patch.guidance) m.guidance = patch.guidance;
    if (patch.open_questions) m.open_questions = patch.open_questions;
    this.store.putMandate(m);
    return m;
  }

  revokeMandate(id) {
    const m = this.getMandate(id);
    m.status = 'revoked';
    m.revoked_at = new Date().toISOString();
    this.store.putMandate(m);
    return { revoked: true, mandate_id: m.mandate_id };
  }

  // ---- Runs -------------------------------------------------------------------
  startRun({ scenario_id, mandate_id }) {
    const mandate = this.getMandate(mandate_id);
    if (mandate.status !== 'active') throw new HttpError(409, 'mandate must be active to start a run');
    const attempts = this.byScenarioChecked(scenario_id);
    const run_id = rid('run');
    const authority = this.pack.authorities.find(a => a.authority_id === attempts[0]?.authority_id);
    const snapshot = JSON.parse(JSON.stringify(mandate));
    // bind a customer identity for the run (offline sim assigns like the platform)
    snapshot.customer_id = authority ? authority.customer_id : 'CU0001';
    this.store.createRun({ run_id, scenario_id, mandate_id, mandateSnapshot: snapshot, totalEvents: attempts.length });
    this.runs.set(run_id, { queue: attempts, cursor: 0, mandate: snapshot, scenario_id });
    return {
      run_id, scenario_id, mandate_id,
      fixture_profiles: { authority_id: attempts[0]?.authority_id, customer_id: snapshot.customer_id },
      event_counters: { total: attempts.length, delivered: 0, decided: 0 },
    };
  }

  byScenarioChecked(id) {
    const list = this.pack.byScenario.get(id);
    if (!list || !list.length) throw new HttpError(404, `unknown scenario ${id}`);
    return list;
  }

  /** Long-poll: delivers the next event once the previous one has a recorded decision. */
  async nextRequest(runId, waitMs = 25000) {
    const R = this.runs.get(runId);
    if (!R) throw new HttpError(404, 'run not found');
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      const prev = R.cursor > 0 ? R.queue[R.cursor - 1] : null;
      const prevLive = prev ? this.liveIdFor(runId, prev.authorization_id) : null;
      const prevDone = !prev || this.decisions.has(prevLive);
      if (prevDone && R.cursor < R.queue.length) {
        const row = R.queue[R.cursor];
        const run = this.store.getRun(runId);
        const event = this.pack.buildEvent(row, {
          mandate: R.mandate,
          context: this.buildContext(runId, row),
        });
        // live id differs from source id; keep stable per run+attempt
        event.authorization.authorization_id = this.liveIdFor(runId, row.authorization_id);
        R.cursor++;
        this.events.push({ event_id: rid('ev'), run_id: runId, type: 'authorization.request', authorization_id: event.authorization.authorization_id, occurred_at: new Date().toISOString(), status: 'delivered' });
        return { envelope: this.envelope(runId, event) };
      }
      if (R.cursor >= R.queue.length && prevDone) {
        const run = this.store.getRun(runId);
        if (run) run.status = [...run.decisions.values()].every(d => d.finalDecision || d.decision !== 'step_up') ? 'completed' : 'awaiting_customers';
        return null; // 204
      }
      await new Promise(r => setTimeout(r, 150));
    }
    return null; // timed out -> 204
  }

  liveIdFor(runId, sourceId) {
    return `AU_LIVE_${runId.slice(-6)}_${sourceId}`;
  }

  buildContext(runId, row) {
    // platform-style context: approved spend this run (rolling 7d on sim timestamps) + recent list
    const run = this.store.getRun(runId);
    let spend = 0;
    const recent = [];
    if (run) {
      const now = new Date(row.timestamp).getTime();
      for (const s of run.spend) {
        if (now - s.simTs <= 7 * 86400_000 && s.simTs <= now) spend += s.amount;
        recent.push({ authorization_id: s.authorization_id, decision: 'approved' });
      }
    }
    return { approved_spend_in_period_chf: Math.round(spend * 100) / 100, recent_authorizations: recent.slice(-5) };
  }

  envelope(runId, event) {
    return {
      run_id: runId,
      event_id: this.events[this.events.length - 1]?.event_id,
      type: 'authorization.request',
      authorization_id: event.authorization.authorization_id,
      status: 'actionable',
      occurred_at: new Date().toISOString(),
      data: event,
    };
  }

  submitDecision(authorizationId, body) {
    if (!this.stepUps.has(authorizationId) && this.decisions.has(authorizationId)) {
      return { accepted: true, duplicate: true };
    }
    if (!['approve', 'decline', 'step_up'].includes(body.decision)) throw new HttpError(422, 'bad decision');
    this.decisions.set(authorizationId, { decision: body.decision, at: Date.now() });
    if (body.decision === 'step_up') this.stepUps.set(authorizationId, true);
    return { accepted: true };
  }

  resolve(authorizationId, body) {
    if (!this.stepUps.has(authorizationId)) throw new HttpError(409, 'no pending step-up for this authorization');
    if (!['approve', 'decline'].includes(body.decision)) throw new HttpError(422, 'resolve requires approve|decline');
    this.stepUps.delete(authorizationId);
    this.decisions.set(authorizationId, { decision: body.decision, resolved: true, at: Date.now() });
    return { accepted: true };
  }

  reset() {
    this.runs.clear(); this.decisions.clear(); this.stepUps.clear();
    this.events = []; this.drafts.clear();
    return { reset: true };
  }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
