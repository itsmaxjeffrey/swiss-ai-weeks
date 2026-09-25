// LEASH wallet-control — worker.
// Long-polls the platform for authorization requests, evaluates each against the
// wallet policy with the deterministic engine, and submits decisions well inside
// the 8-second deadline. Step-ups are surfaced to the customer UI and resolved via
// /resolve with the real customer's answer (never invented by the worker).
import { evaluate } from './engine.js';
import { normalizeDomain } from './trustedshops.js';
import { purchaseDigest, digest, controlChecks, enforceControls, fail } from './wallet-controls.js';

export class Worker {
  constructor({ client, store, profiles, trust, trustedShops = null, jev = null, bridgeSync = null, log = console }) {
    this.jev = jev;
    this.client = client;       // HttpApiClient | LocalApi
    this.store = store;
    this.profiles = profiles;
    this.trust = trust;
    this.trustedShops = trustedShops;  // TrustedShopsChecker (optional, advisory evidence)
    this.bridgeSync = bridgeSync;      // { url, token, user, fetchImpl? } — shopper bridge whitelist mirror (optional)
    this.log = log;
    this.activeRuns = new Map(); // run_id -> {stop}
    this.feed = [];              // UI event feed (bounded)
    this.humanWindowMs = 120000;
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
    }).finally(() => this.activeRuns.delete(runId));
  }

  stopRun(runId) {
    this.activeRuns.get(runId)?.stop();
  }

  async #loop(runId, isStopped) {
    let emptyStreak = 0;
    while (!isStopped()) {
      const run = this.store.getRun(runId);
      if (run && ['completed','revoked'].includes(run.status)) break;
      let res;
      try {
        res = await this.client.nextRequest(runId, 25000);
      } catch (err) {
        this.pushFeed({ kind: 'error', run_id: runId, text: `poll failed: ${err.message}` });
        await sleep(2000);
        continue;
      }
      if(isStopped() || ['completed','revoked'].includes(this.store.getRun(runId)?.status))break;
      if (!res) {
        emptyStreak++;
        const runNow = this.store.getRun(runId);
        if (runNow && emptyStreak >= 2 && runNow.decisions.size >= (runNow.totalEvents || Infinity)) {
          runNow.status = runNow.stepUps.size ? 'awaiting_customers' : 'completed';
          this.pushFeed({ kind: 'run', run_id: runId, text: runNow.stepUps.size ? 'All purchases evaluated — waiting for customer answers.' : 'Run complete — all purchases decided.' });
          break;
        }
        continue;
      }
      emptyStreak = 0;
      const actualRunId = res.envelope.run_id || res.envelope.data?.run_id || runId;
      if (!this.store.getRun(actualRunId)) { this.pushFeed({kind:'error',text:'Purchase received for an unknown run; no permission issued.'}); continue; }
      await this.store.exclusive(() => this.#handleRequest(actualRunId, res.envelope));
    }
    this.activeRuns.delete(runId);
  }

  async #handleRequest(runId, envelope) {
    const event = envelope.data;
    const a = event.authorization;
    const run = this.store.getRun(runId);
    const liveId = a.authorization_id;
    const fingerprint = purchaseDigest(event);

    // Repeated delivery of the same live purchase: reconcile with the saved result.
    const prior = this.store.getDecision(runId, liveId);
    if(prior?.fingerprint && prior.fingerprint!==fingerprint)throw fail('Purchase ID reused with changed facts');
    if (prior && prior.submitted) {
      if (prior.fingerprint !== fingerprint) {
        this.store.audit('purchase.conflict',{run_id:runId,authorization_id:liveId});
        throw fail('An authorization ID was reused with changed purchase facts');
      }
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
    const remaining = event.deadline_at ? Date.parse(event.deadline_at) - Date.now() : 8000;
    const enrichmentBudget = Math.max(0, Math.min(2500, remaining - 2000));
    const extras = {};
    await Promise.all([
      this.trustedShops && merchantSite && enrichmentBudget >= 50
        ? withinBudget(() => this.trustedShops.checkOne(merchantSite), enrichmentBudget).then(value => { extras.trustedShops = value; })
        : Promise.resolve(),
      this.jev ? this.jev.evaluate(event, enrichmentBudget).then(value => { extras.jev = value; }).catch(() => { extras.jev = { status: 'unavailable' }; }) : Promise.resolve(),
    ]);

    // Evaluate (deadline-aware: engine is sub-ms; guard anyway).
    const report = controlChecks(event,this.store.controls,this.store.ledger(),{run,currentMandate:this.store.getMandate(run.mandate_id)});
    const snapshot = run.mandateSnapshot;
    if (snapshot && digest(snapshot.hard_rules || []) !== digest(event.mandate?.hard_rules || [])) report.issues.push({code:'POLICY_MISMATCH',detail:'Purchase policy differs from the confirmed run permission'});
    const latestPolicy=this.store.getMandate(run.mandate_id);
    const evaluatedEvent=latestPolicy?{...event,mandate:{...event.mandate,...latestPolicy,customer_id:event.mandate?.customer_id}}:event;
    const evaluation = enforceControls(evaluate(evaluatedEvent, this.store.runState(run), this.profiles, this.trust, extras), report);
    const record = {
      authorizationId: liveId,
      sourceAuthorizationId: a.source_authorization_id || null,
      decision: evaluation.decision,
      reason_codes: evaluation.reason_codes,
      customer_message: evaluation.customer_message,
      confidence: evaluation.confidence,
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
      fingerprint, event: structuredClone(event), engine_version:evaluation.engine_version,
      next_steps:evaluation.next_steps, control_checks:evaluation.control_checks,
    };

    // Retry transport failures, then finalize every accepted response identically.
    let accepted = false;
    if (evaluation.decision === 'approve') this.store.reserve(run,event);
    let submitError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const remaining = event.deadline_at ? Date.parse(event.deadline_at) - Date.now() : 8000;
        if (!Number.isFinite(remaining) || remaining <= 50) throw new Error('Decision deadline exhausted');
        await this.client.submitDecision(liveId, this.#decisionBody(record), Math.max(1, remaining - 50));
        accepted = true;
        break;
      } catch (err) { submitError = err; }
    }
    if (!accepted) {
      this.store.recordDecision(runId, liveId, { ...record, submitted: false, submitError: submitError?.message });
      this.pushFeed({ kind: 'error', run_id: runId, authorization_id: liveId, text: `decision submit failed: ${submitError?.message}` });
      return;
    }
    this.store.acceptDecision(runId, liveId, record, event, evaluation, Date.now() + this.humanWindowMs);
    this.store.audit('purchase.decided',{run_id:runId,authorization_id:liveId,decision:evaluation.decision,fingerprint});
    this.onReceipt?.('decision',run,liveId);
    this.pushFeed({
      kind: 'decision', run_id: runId, authorization_id: liveId,
      decision: evaluation.decision, merchant: record.merchant, amount: record.amount,
      reason_codes: evaluation.reason_codes, message: evaluation.customer_message,
      confidence: evaluation.confidence, evidence: evaluation.evidence,
      uncertainties: evaluation.uncertainties, manipulation: evaluation.flags.manipulation,
      items: record.items, replay_order: a.replay_order, evaluation_ms: evaluation.evaluation_ms,
    });
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
    return this.store.exclusive(async () => {
      const run=this.store.getRun(runId), pending=run?.stepUps.get(authorizationId), prior=run?.decisions.get(authorizationId);
      if(!['approve','decline'].includes(decision))throw fail('Choose approve or decline',400);
      const normalized=decision==='approve'?'approved':'declined';
      if (!pending) {
        if (prior?.finalDecision===normalized) return {ok:true,already_resolved:true};
        throw fail('This purchase is no longer awaiting a decision');
      }
      if (opts.fingerprint && opts.fingerprint!==purchaseDigest(pending.event)) throw fail('Purchase details changed. Reload the review.');
      if (decision==='approve') {
        if (Date.now()>=pending.deadline) throw fail('The approval window has expired; request a new purchase');
        const latest=this.store.getMandate(run.mandate_id);
        const event={...pending.event,mandate:{...pending.event.mandate,...(latest || {}),customer_id:pending.event.mandate?.customer_id}};
        const reevaluated=enforceControls(evaluate(event,this.store.runState(run),this.profiles,this.trust),controlChecks(event,this.store.controls,this.store.ledger(),{run,currentMandate:latest}));
        if (reevaluated.decision==='decline') throw fail('Approval is blocked: '+reevaluated.customer_message);
        this.store.reserve(run,event);
      }
      const out=await this.resolveChecked(runId,authorizationId,decision,customerMessage,opts);
      this.store.audit('purchase.resolved',{run_id:runId,authorization_id:authorizationId,decision});
      this.onReceipt?.('resolution',run,authorizationId);
      return out;
    });
  }

  async resolveChecked(runId, authorizationId, decision, customerMessage, opts = {}) {
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

async function withinBudget(fn, ms) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(fn), new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
  catch { return null; }
  finally { clearTimeout(timer); }
}
