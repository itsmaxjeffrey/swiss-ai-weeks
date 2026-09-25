// LEASH wallet-control — worker.
// Long-polls the platform for authorization requests, evaluates each against the
// wallet policy with the deterministic engine, and submits decisions well inside
// the 8-second deadline. Step-ups are surfaced to the customer UI and resolved via
// /resolve with the real customer's answer (never invented by the worker).
import { evaluate } from './engine.js';
import { normalizeDomain } from './trustedshops.js';

export class Worker {
  constructor({ client, store, profiles, trust, trustedShops = null, bridgeSync = null, log = console }) {
    this.client = client;       // HttpApiClient | LocalApi
    this.store = store;
    this.profiles = profiles;
    this.trust = trust;
    this.trustedShops = trustedShops;  // TrustedShopsChecker (optional, advisory evidence)
    this.bridgeSync = bridgeSync;      // { url, token, user, fetchImpl? } — shopper bridge whitelist mirror (optional)
    this.log = log;
    this.activeRuns = new Map(); // run_id -> {stop}
    this.feed = [];              // UI event feed (bounded)
  }

  pushFeed(entry) {
    this.feed.unshift({ at: new Date().toISOString(), ...entry });
    if (this.feed.length > 500) this.feed.length = 500;
  }

  async startRun(runId) {
    if (this.activeRuns.has(runId)) return;
    let stopped = false;
    this.activeRuns.set(runId, { stop: () => { stopped = true; } });
    this.pushFeed({ kind: 'run', run_id: runId, text: `Worker attached to run ${runId}` });
    // fire-and-forget loop; the server keeps serving while it runs
    this.#loop(runId, () => stopped).catch(err => {
      this.pushFeed({ kind: 'error', run_id: runId, text: `worker crashed: ${err.message}` });
      this.log.error?.('[worker]', err);
    });
  }

  stopRun(runId) {
    this.activeRuns.get(runId)?.stop();
  }

  async #loop(runId, isStopped) {
    let emptyStreak = 0;
    while (!isStopped()) {
      const run = this.store.getRun(runId);
      if (run && run.status === 'completed') break;
      let res;
      try {
        res = await this.client.nextRequest(runId, 25000);
      } catch (err) {
        this.pushFeed({ kind: 'error', run_id: runId, text: `poll failed: ${err.message}` });
        await sleep(2000);
        continue;
      }
      if (!res) {
        emptyStreak++;
        const runNow = this.store.getRun(runId);
        if (runNow && emptyStreak >= 2 && runNow.decisions.size >= (runNow.totalEvents || Infinity)) {
          runNow.status = 'completed';
          this.pushFeed({ kind: 'run', run_id: runId, text: 'Run complete — all purchases decided.' });
          break;
        }
        continue;
      }
      emptyStreak = 0;
      await this.#handleRequest(runId, res.envelope);
    }
    this.activeRuns.delete(runId);
  }

  async #handleRequest(runId, envelope) {
    const event = envelope.data;
    const a = event.authorization;
    const run = this.store.getRun(runId);
    const liveId = a.authorization_id;

    // Repeated delivery of the same live purchase: reconcile with the saved result.
    const prior = this.store.getDecision(runId, liveId);
    if (prior && prior.submitted) {
      this.pushFeed({ kind: 'replay', run_id: runId, authorization_id: liveId, text: `repeated delivery of ${liveId} — saved decision re-confirmed (no double count)` });
      try { await this.client.submitDecision(liveId, this.#decisionBody(prior)); } catch { /* already accepted */ }
      return;
    }

    // Trusted Shops verification (advisory evidence; capped at 2.5 s so the 8 s
    // decision deadline is never at risk — the engine itself stays sub-ms). A cold
    // check spans the member registry + 12 country-site searches (~1–2 s); a check
    // that misses the budget keeps running and lands in the checker cache, so
    // later events for the same merchant get the evidence instantly.
    const merchantSite = a.merchant?.merchant_url || a.merchant?.website_url || a.merchant?.merchant_domain || a.merchant?.url || null;
    const merchantDomain = normalizeDomain(merchantSite)?.domain?.replace(/^www\./, '') || null;
    let extras = {};
    if (this.trustedShops && merchantSite) {
      extras.trustedShops = await Promise.race([
        this.trustedShops.checkOne(merchantSite),
        new Promise(r => setTimeout(() => r(null), 2500)),
      ]);
    }

    // Evaluate (deadline-aware: engine is sub-ms; guard anyway).
    const evaluation = evaluate(event, this.store.runState(run), this.profiles, this.trust, extras);
    const record = {
      authorizationId: liveId,
      sourceAuthorizationId: a.source_authorization_id || null,
      decision: evaluation.decision,
      reason_codes: evaluation.reason_codes,
      customer_message: evaluation.customer_message,
      evidence: evaluation.evidence,
      uncertainties: evaluation.uncertainties,
      flags: evaluation.flags,
      signature: evaluation.signature,
      evaluation_ms: evaluation.evaluation_ms,
      merchant: a.merchant?.merchant_name,
      merchantId: a.merchant?.merchant_id,
      merchantUrl: merchantSite,
      merchantDomain,
      amount: a.billing_amount_chf,
      currency: a.currency,
      simTs: new Date(a.timestamp).getTime(),
      replay_order: a.replay_order,
      purchase_description: a.purchase_description,
      items: (a.items || []).map(i => ({ name: i.item_name, qty: i.quantity, price: i.unit_price, currency: i.currency, category: i.item_category, details: i.item_details })),
      finalDecision: evaluation.decision === 'approve' || evaluation.decision === 'decline' ? evaluation.decision : null,
      submitted: false,
    };

    // Submit inside the deadline (leave ≥1.5s margin).
    const deadlineMs = event.deadline_at ? new Date(event.deadline_at).getTime() : Date.now() + 8000;
    const budget = deadlineMs - Date.now() - 1500;
    try {
      if (budget < 500) throw new Error(`deadline budget exhausted (${Math.round(budget)}ms)`);
      await this.client.submitDecision(liveId, this.#decisionBody(record));
      record.submitted = true;
      record.finalDecision = evaluation.decision === 'step_up' ? null : (evaluation.decision === 'approve' ? 'approved' : 'declined');
      this.store.recordDecision(runId, liveId, record);
      if (evaluation.decision === 'step_up') {
        this.store.addStepUp(runId, liveId, event, evaluation, Date.now() + 120_000);
      }
      if (evaluation.decision === 'approve') {
        run.spend.push({ simTs: record.simTs, amount: record.amount, merchantId: a.merchant?.merchant_id, authorization_id: liveId });
      }
      this.pushFeed({
        kind: 'decision', run_id: runId, authorization_id: liveId,
        decision: evaluation.decision, merchant: record.merchant, amount: record.amount,
        reason_codes: evaluation.reason_codes, message: evaluation.customer_message,
        evidence: evaluation.evidence, uncertainties: evaluation.uncertainties,
        manipulation: evaluation.flags.manipulation,
        items: record.items, replay_order: a.replay_order,
        evaluation_ms: evaluation.evaluation_ms,
      });
    } catch (err) {
      // Last-resort: never miss a deadline. Re-try once immediately; on failure, record locally.
      try {
        await this.client.submitDecision(liveId, this.#decisionBody(record));
        record.submitted = true;
        this.store.recordDecision(runId, liveId, record);
      } catch (err2) {
        this.store.recordDecision(runId, liveId, { ...record, submitted: false, submitError: err2.message });
        this.pushFeed({ kind: 'error', run_id: runId, authorization_id: liveId, text: `decision submit failed: ${err2.message}` });
      }
    }
  }

  #decisionBody(record) {
    return {
      authorization_id: record.authorizationId,
      decision: record.decision,
      reason_codes: record.reason_codes,
      customer_message: record.customer_message,
      evidence: record.evidence?.map(e => ({ label: e.label, value: e.value })) || [],
      engine_version: 'leash-engine 1.0.0',
    };
  }

  /** Best-effort mirror of a customer-trusted merchant into the shopper
   *  bridge's per-account website whitelist (viseca-shopper-ui), so the
   *  agent's signed policies for that domain pass the bridge's sign-time
   *  enforcement. Config arrives via server.js from SHOPPER_BRIDGE_URL /
   *  SHOPPER_BRIDGE_SYNC_TOKEN / SHOPPER_BRIDGE_USER. Never throws — the
   *  customer's approval must never depend on this succeeding. */
  async syncBridgeWhitelist(domain) {
    const cfg = this.bridgeSync || {};
    if (!cfg.url || !cfg.token || !cfg.user) return { skipped: 'not configured' };
    try {
      const doFetch = cfg.fetchImpl || fetch;
      const res = await doFetch(`${String(cfg.url).replace(/\/+$/, '')}/api/internal/shopping/whitelist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ email: cfg.user, domain }),
        signal: AbortSignal.timeout(4000),
      });
      const detail = await res.json().catch(() => null);
      return {
        ok: Boolean(res.ok),
        status: res.status,
        added: detail?.added ?? null,
        already: Boolean(detail?.already),
        error: res.ok ? null : (detail?.error || `HTTP ${res.status}`),
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /** Customer answered a step-up from the UI. When `opts.whitelist` is set the
   *  customer explicitly trusted the merchant: the domain joins the persisted
   *  trusted list, so future purchases there skip the yellow-list review. */
  async resolveStepUp(runId, authorizationId, decision, customerMessage, opts = {}) {
    if (!['approve', 'decline'].includes(decision)) throw new Error('decision must be approve|decline');
    await this.client.resolve(authorizationId, {
      decision,
      customer_message: customerMessage || `The customer reviewed and chose to ${decision} this purchase.`,
    });
    const normalized = decision === 'approve' ? 'approved' : 'declined';
    const { decision: rec } = this.store.recordStepUpResolution(runId, authorizationId, normalized, customerMessage) || {};
    let whitelistAdded = null;
    let bridgeSync = null;
    if (opts.whitelist && decision === 'approve' && rec?.merchantDomain) {
      whitelistAdded = this.store.addTrustedDomain(rec.merchantDomain, 'customer approved during purchase review');
      if (whitelistAdded) {
        bridgeSync = await this.syncBridgeWhitelist(whitelistAdded);
        const outcome = bridgeSync.skipped ? 'shopper-bridge sync skipped (not configured)'
          : bridgeSync.ok ? (bridgeSync.already ? 'also on the shopper-bridge whitelist already'
            : 'also whitelisted in the shopper bridge')
          : `shopper-bridge sync failed: ${bridgeSync.error}`;
        this.pushFeed({ kind: 'trust', run_id: runId, text: `🤝 ${whitelistAdded} added to your trusted merchants — future purchases there skip the yellow-list review.`, bridge_sync: outcome });
      }
    }
    this.pushFeed({
      kind: 'resolution', run_id: runId, authorization_id: authorizationId,
      decision: normalized, text: `Customer ${normalized} the paused purchase${rec?.merchant ? ` at ${rec.merchant}` : ''}.`,
    });
    return { ok: true, whitelist_added: whitelistAdded, bridge_sync: bridgeSync };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
