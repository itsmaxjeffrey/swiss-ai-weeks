// LEASH wallet-control — zero-dependency HTTP server.
// Serves the customer UI and a small app API; hosts the platform client and worker.
// Mode: live platform (LEASH_BASE_URL + TEAM_API_KEY) or offline simulator.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { offlinePackPath } from './lib/pack-path.js';
import { Store } from './lib/store.js';
import { HistoryProfiles } from './lib/history.js';
import { makeClient } from './lib/api.js';
import { Worker } from './lib/worker.js';
import { createJevFromEnv, jevNeedsReview } from './lib/jev.js';
import { compilePolicy } from './lib/policy-compiler.js';
import { buildTrustIndex, hydrateMarketIntel, trustLookup } from './lib/signals.js';
import { TrustedShopsChecker, normalizeDomain } from './lib/trustedshops.js';
import { MerchantDossier } from './lib/yellowlist.js';
import { readJsonIfExists, loadCsv } from './lib/util.js';
import { loadSustainabilityIndex, lookupSustainability, scoreMerchantRisk, rankOffers } from './lib/sustainability.js';
import { WalletProof, DeviceAccess, acquireWalletLock } from './lib/wallet-proof.js';
import { digest, fail } from './lib/wallet-controls.js';
import { trialPurchase, replayPurchases } from './lib/wallet-lab.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8790);
const liveConfigured = process.env.LEASH_BASE_URL && process.env.TEAM_API_KEY && process.env.LEASH_MODE !== 'offline';
const PACK_DIR = liveConfigured ? (process.env.PACK_DIR || path.join(ROOT, 'data/pack')) : offlinePackPath();

// ---- Bootstrap singletons ----------------------------------------------------
const store = new Store(process.env.LEASH_STATE_FILE || path.join(ROOT, 'data/state.json'));
const privateDirectory=path.join(path.dirname(store.persistPath),'.wallet-private');
fs.mkdirSync(privateDirectory,{recursive:true,mode:0o700});
acquireWalletLock(path.join(privateDirectory,'writer.lock'));
const proof=new WalletProof(privateDirectory);
const access=new DeviceAccess(privateDirectory, !(process.env.LEASH_MODE==='offline' && process.env.LEASH_DEVICE_AUTH==='off'));
const profiles = HistoryProfiles.load(path.join(PACK_DIR, 'authorization_history.csv'));
const trustRaw = readJsonIfExists(path.join(ROOT, 'data/leash_trust.json'));
const trust = buildTrustIndex(trustRaw);
// Market-intel datasets (tools/build-datasets.mjs): web popularity (Tranco ∪
// Majestic), sanctions names (SECO/OFAC/UN), MCC fraud priors (TabFormer).
hydrateMarketIntel(trust, {
  popularity: readJsonIfExists(path.join(ROOT, 'data/popularity.json')),
  sanctions: readJsonIfExists(path.join(ROOT, 'data/sanctions_names.json')),
  mccRisk: readJsonIfExists(path.join(ROOT, 'data/mcc_risk.json')),
});
const client = makeClient(store);
const trustedShops = new TrustedShopsChecker();
const gleifAges = readJsonIfExists(path.join(ROOT, 'data', 'gleif_ch_ages.json'));
const dossierService = new MerchantDossier({ trustedShops, gleifAges, trust });
// Sustainability scores (demo-grade static dataset, data/sustainability.json)
// + persisted UI preferences (data/preferences.json). Advisory only: they
// inform the offer comparison; they never change engine decisions.
const sustainabilityIndex = loadSustainabilityIndex(path.join(ROOT, 'data', 'sustainability.json'));
const PREFS_FILE = process.env.LEASH_PREFS_FILE || path.join(ROOT, 'data', 'preferences.json');
const prefs = (() => { try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; } })();
function savePrefs() { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)); }
// Shopper-bridge whitelist mirror: when the customer approves with "trust
// merchant", the worker best-effort POSTs the domain to the bridge's internal
// sync endpoint so sign-time whitelist enforcement there passes too. The token
// is never logged. Unset vars => sync reports { skipped: 'not configured' }.
const bridgeSync = {
  url: (process.env.SHOPPER_BRIDGE_URL || '').trim(),
  token: process.env.SHOPPER_BRIDGE_SYNC_TOKEN || '',
  user: (process.env.SHOPPER_BRIDGE_USER || '').trim(),
};
const jev = createJevFromEnv();
const JEV_AUDIT_FILE = process.env.LEASH_JEV_USAGE_FILE || path.join(ROOT, 'data', 'jev-usage.json');
const jevUsage = readJsonIfExists(JEV_AUDIT_FILE) || { attempts: 0, successful: 0, last: null };
function recordShopperReview(input, result) {
  jevUsage.attempts++;
  if (result.status === 'ok') jevUsage.successful++;
  jevUsage.last = { at: new Date().toISOString(), source: input.source, status: result.status,
    model: result.model || jev.model, input_sha256: crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    items: input.permissions.items.length, customer_messages: input.customer_messages.length,
    review_required: result.review_required };
  fs.writeFileSync(JEV_AUDIT_FILE, JSON.stringify(jevUsage), { mode: 0o600 });
}

const worker = new Worker({ client, store, profiles, trust, trustedShops, jev, bridgeSync });
worker.onReceipt=(kind,run,id)=>{
  const d=run.decisions.get(id);
  const receipt=proof.sign(kind,{run_id:run.run_id,mandate_id:run.mandate_id,authorization_id:id,purchase_digest:d.fingerprint,decision:d.finalDecision||d.decision,amount_chf:d.amount,merchant:d.merchant,reason_codes:d.reason_codes,engine_version:d.engine_version,policy_digest:digest(run.mandateSnapshot),controls_version:store.controlVersion,audit_head:store.journal.at(-1)?.hash});
  store.receipts.push(receipt);store.save();
};
const platformHealth={ready:false,last_error:null};
try {const b=await client.bootstrap(); const seconds=Number(b?.timeouts?.human_window_seconds);if(Number.isFinite(seconds)&&seconds>0)worker.humanWindowMs=seconds*1000;platformHealth.ready=true;}
catch {platformHealth.last_error='Platform bootstrap unavailable';}
const pack = {
  scenarios: loadCsv(path.join(PACK_DIR, 'scenario_catalogue.csv')),
};

const mode = client.mode === 'live' ? 'LIVE PLATFORM' : 'OFFLINE SIMULATOR';
console.log(`[leash] mode: ${mode}`);
console.log(`[leash] history profiles: ${profiles.purchaseCount.size} customers, trust dataset: ${trust ? Object.keys(trust.malicious_domains).length + ' malicious domains / ' + (trust.legit_companies?.length || 0) + ' legit companies' : 'not loaded'}`);
console.log(`[leash] shopper bridge sync: ${bridgeSync.url ? `${bridgeSync.url} (account ${bridgeSync.user || '??'})` : 'disabled (SHOPPER_BRIDGE_URL not set)'}`);

// ---- Helpers -------------------------------------------------------------------
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req) {
  if (req.walletRaw !== undefined) return req.walletRaw ? JSON.parse(req.walletRaw) : {};
  let raw = '';
  for await (const chunk of req) {raw += chunk;if(Buffer.byteLength(raw)>65536)throw fail('Request exceeds 64 KB',413);}
  req.walletRaw=raw;
  if (!raw) return {};
  return JSON.parse(raw);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function staticFile(res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(ROOT, 'web', p));
  if (!filePath.startsWith(path.join(ROOT, 'web'))) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- UI state snapshot -----------------------------------------------------------
let activeMandateId = process.env.LEASH_MANDATE_ID || null;
let activeRunId = null;

// Restore the active-mandate pointer after a restart (process-local otherwise).
if (!activeMandateId) {
  const candidates = [...store.mandates.values()].filter(m => m.status === 'active' && m.mandate_id);
  if (candidates.length) {
    activeMandateId = candidates[candidates.length - 1].mandate_id;
    console.log(`[leash] restored active mandate ${activeMandateId} from persisted state`);
  }
}

// Keep the latest run and any pending customer decisions visible after restart.
const restoredRun = [...store.runs.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
if (restoredRun) {
  activeRunId = restoredRun.run_id;
  if (restoredRun.status === 'running') worker.startRun(activeRunId);
}

function snapshot() {
  const mandate = activeMandateId ? (store.getMandate(activeMandateId) || client.getMandate?.(activeMandateId)) : null;
  const run = activeRunId ? store.getRun(activeRunId) : null;
  const pending = [];
  for (const pendingRun of store.runs.values()) {
    for (const [authId, s] of pendingRun.stepUps) {
      const d = pendingRun.decisions.get(authId);
      if (d && !d.finalDecision) {
        pending.push({
          authorization_id: authId,
          merchant: d.merchant, amount: d.amount, currency: d.currency,
          merchant_site: d.merchantDomain || null,
          merchant_url: d.merchantUrl || null,
          message: d.customer_message, evidence: d.evidence, uncertainties: d.uncertainties,
          confidence: d.confidence,
          manipulation: d.flags?.manipulation || [],
          items: d.items, deadline: s.deadline, opened_at: s.openedAt,
          run_id:pendingRun.run_id, fingerprint:d.fingerprint, expired:Date.now()>=s.deadline,
        });
      }
    }
  }
  return {
    mode,
    controls:{values:store.controls,version:store.controlVersion},
    jev: { ...jev.status(), real_app_usage: jevUsage },
    scenarios: pack.scenarios.map(s => ({ scenario_id: s.scenario_id, name: s.scenario_name, instruction: s.cardholder_instruction, event_count: Number(s.event_count) })),
    mandate: mandate || null,
    activeMandateId,
    activeRunId,
    run: run ? {
      run_id: run.run_id, scenario_id: run.scenario_id, status: run.status,
      total: run.totalEvents, decided: run.decisions.size,
      approved: [...run.decisions.values()].filter(d => d.finalDecision === 'approved').length,
      declined: [...run.decisions.values()].filter(d => d.finalDecision === 'declined').length,
      pending: pending.length,
      spend_window: run.mandateSnapshot?.hard_rules?.find(r => r.scope === 'period') ? {
        cap: run.mandateSnapshot.hard_rules.find(r => r.scope === 'period')?.value,
        days: run.mandateSnapshot.hard_rules.find(r => r.scope === 'period')?.period_days,
        used: Math.round(run.spend.filter(() => true).reduce((s, x) => s + x.amount, 0) * 100) / 100,
      } : null,
    } : null,
    feed: worker.feed.slice(0, 60),
    sustainability: { prefer: prefs.prefer_sustainable === true },
    pending_step_ups: pending,
  };
}

// ---- HTTP server --------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if(req.url.startsWith('/wallet/'))req.url=req.url.slice(7);
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/') && !['GET','HEAD'].includes(req.method)) await readBody(req);
    const publicPaths=['/api/access','/api/devices/request','/api/proofs/key','/api/proofs/verify','/api/trustedshops/check','/api/merchant/dossier','/api/shopping/categories','/api/offers/compare'];
    if(p.startsWith('/api/')&&!p.startsWith('/api/internal/')&&!publicPaths.includes(p))access.verify(req,req.walletRaw||'');
    if(p==='/api/access'&&req.method==='GET')return json(res,200,{required:access.enabled,device:access.list().find(d=>d.id===url.searchParams.get('device'))||null});
    if(p==='/api/devices/request'&&req.method==='POST')return json(res,200,access.request(await readBody(req)));
    if(p==='/api/devices'&&req.method==='GET')return json(res,200,{devices:access.list()});
    let deviceRoute=p.match(/^\/api\/(internal\/)?devices\/([a-f0-9]+)\/(approve|revoke)$/);
    if(deviceRoute&&req.method==='POST'){
      if(deviceRoute[1]&&!access.internalAuthorized(req))return json(res,401,{error:'unauthorized'});
      const out=access.setStatus(deviceRoute[2],deviceRoute[3]==='approve'?'active':'revoked');
      store.audit('device.'+deviceRoute[3],{id:deviceRoute[2]});return json(res,200,out);
    }
    if(p==='/api/controls'&&req.method==='PUT'){
      const body=await readBody(req);return json(res,200,await store.exclusive(()=>store.updateControls(body.controls,body.version)));
    }
    if(p==='/api/health'&&req.method==='GET')return json(res,200,{platform:platformHealth,writer:'active',storage:store.writeError?'unavailable':'ready',audit_valid:store.verifyJournal(),audit_entries:store.journal.length,unreconciled_submissions:store.reservations.size,active_workers:worker.activeRuns.size,human_window_seconds:worker.humanWindowMs/1000});
    if(p==='/api/proofs/key'&&req.method==='GET')return json(res,200,{key_id:proof.keyId,algorithm:'Ed25519',public_key:proof.publicKey});
    if(p==='/api/proofs/verify'&&req.method==='POST')return json(res,200,{valid:proof.verify(await readBody(req)),key_id:proof.keyId});
    if(p==='/api/proofs'&&req.method==='GET')return json(res,200,{receipts:store.receipts.slice(-100).reverse(),audit_valid:store.verifyJournal(),audit_head:store.journal.at(-1)?.hash||null});
    if(p==='/api/activity'&&req.method==='GET')return json(res,200,{purchases:[...store.runs.values()].flatMap(run=>[...run.decisions.values()].map(d=>({run_id:run.run_id,authorization_id:d.authorizationId,merchant:d.merchant,amount:d.amount,decision:d.finalDecision||d.decision,at:d.decidedAt,message:d.customerMessage||d.customer_message,reason_codes:d.reason_codes,next_steps:d.next_steps}))).sort((a,b)=>b.at-a.at).slice(0,250)});
    if((p==='/api/purchases/try'||p==='/api/policy/replay')&&req.method==='POST'){
      const body=await readBody(req);
      const mandate=body.draft_proof?(proof.verify(body.draft_proof)&&body.draft_proof.document.kind==='policy_draft'?body.draft_proof.document.payload:null):store.getMandate(activeMandateId);
      if(!mandate)throw fail('Translate or activate a policy first',400);
      if(p==='/api/purchases/try')return json(res,200,trialPurchase(body.purchase||{},mandate,store.controls,trust));
      const records=[...store.runs.values()].flatMap(r=>[...r.decisions.values()]).filter(d=>d.event);
      return json(res,200,replayPurchases(records,mandate,store.controls,profiles,trust));
    }
    // ---- App API ----
    if (p === '/api/state' && req.method === 'GET') {
      return json(res, 200, snapshot());
    }

    if (p === '/api/internal/shopper/policy-review' && req.method === 'POST') {
      const expected = Buffer.from(`Bearer ${bridgeSync.token}`);
      const supplied = Buffer.from(String(req.headers.authorization || ''));
      if (!bridgeSync.token || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return json(res, 401, { error: 'unauthorized' });
      // Rebuild the allowlisted state at the receiving trust boundary too.
      const body = await readBody(req);
      if (!['shopper_policy_sign', 'shopper_saved_policy_verification'].includes(body.source) || !body.permissions || !Array.isArray(body.permissions.items) || !Array.isArray(body.customer_messages)) return json(res, 400, { error: 'invalid shopper review' });
      const input = { source: body.source, customer_messages: body.customer_messages.slice(-4).map(v => String(v).slice(0, 2000)),
        proposed_request: String(body.proposed_request || '').slice(0, 2000), permissions: body.permissions, account_controls: body.account_controls };
      // Internal caller already strips payment/delivery identity; reject extra fields.
      const permitted = new Set(['items', 'budget', 'timing', 'merchant', 'stop_rules']);
      if (Object.keys(input.permissions).some(k => !permitted.has(k))) return json(res, 400, { error: 'unexpected policy data' });
      const assessment = await jev.reviewShopperPolicy(input);
      const result = { ...assessment, review_required: assessment.status === 'ok' && Object.values(assessment.answers).some(jevNeedsReview), source: input.source };
      recordShopperReview(input, result);
      return json(res, 200, result);
    }

    if (p === '/api/policy/compile' && req.method === 'POST') {
      const body = await readBody(req);
      const draft = compilePolicy(body.instruction || '');
      draft.jev = await jev.reviewPolicy(draft.instruction, draft.hard_rules);
      if (draft.jev.status === 'ok' && jevNeedsReview(draft.jev.answers.coverage)) {
        draft.open_questions.push('Jev flagged a possible omitted or mistranslated restriction. Review your original instruction before permitting purchases.');
        if (!draft.hard_rules.some(r => r.field === 'policy.requires_review')) {
          const rule = { field: 'policy.requires_review', operator: '=', value: 'true' };
          draft.hard_rules.push(rule);
          draft.understood.push({ label: 'Policy review', plain: 'Every purchase requires review until the translation is resolved.', rule });
        }
      }
      draft.draft_proof=proof.sign('policy_draft',structuredClone(draft));
      return json(res, 200, draft);
    }

    if (p === '/api/mandates' && req.method === 'POST') {
      const body = await readBody(req); // {instruction, hard_rules, uncertainty_policy, guidance, open_questions}
      if(!proof.verify(body.draft_proof)||body.draft_proof.document.kind!=='policy_draft')throw fail('Translate the instruction again before confirming',400);
      const approved=body.draft_proof.document.payload;
      for(const key of ['instruction','hard_rules','uncertainty_policy','guidance','open_questions'])if(digest(body[key])!==digest(approved[key]))throw fail('Draft changed after translation',400);
      const created = await client.createMandate({
        instruction: body.instruction,
        hard_rules: body.hard_rules,
        uncertainty_policy: body.uncertainty_policy,
        guidance: body.guidance || [],
        open_questions: body.open_questions || [],
      });
      // keep a local mirror for the UI
      store.putMandate({ ...created, status: 'draft' });
      activeMandateId = created.mandate_id || null;
      return json(res, 200, created);
    }

    let m = p.match(/^\/api\/mandates\/([^/]+)\/confirm$/);
    if (m && req.method === 'POST') {
      const out = await client.confirmMandate(m[1], { confirmed: true });
      activeMandateId = out.mandate_id;
      const local = store.getMandate(m[1]);
      if (local) { local.mandate_id = out.mandate_id; local.status = 'active'; store.putMandate(local); }
      store.audit('policy.confirmed',{mandate_id:out.mandate_id});
      store.receipts.push(proof.sign('policy',{mandate:store.getMandate(out.mandate_id),version:1,audit_head:store.journal.at(-1)?.hash}));store.save();
      return json(res, 200, out);
    }

    m = p.match(/^\/api\/mandates\/([^/]+)$/);
    if (m && req.method === 'GET') {
      return json(res, 200, await client.getMandate(m[1]));
    }
    if (m && req.method === 'PATCH') {
      const body = await readBody(req);
      return json(res, 200, await store.exclusive(async()=>{
        const current=store.getMandate(m[1]);if(!current)throw fail('Unknown policy',404);
        if(current.status!=='active')throw fail('Only an active policy can be tightened');
        if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(key=>!['hard_rules','uncertainty_policy'].includes(key)))throw fail('Only additional rules and stricter uncertainty handling may be changed',400);
        if(body.hard_rules!==undefined && (!Array.isArray(body.hard_rules)||body.hard_rules.some(rule=>!rule||typeof rule!=='object'||typeof rule.field!=='string'||typeof rule.operator!=='string'||rule.value===undefined)))throw fail('Rules must contain a field, operator and value',400);
        if(body.uncertainty_policy!==undefined && !['ask','decline','approve'].includes(body.uncertainty_policy))throw fail('Invalid uncertainty policy',400);
        if(body.hard_rules && (current.hard_rules||[]).some(old=>!body.hard_rules.some(r=>digest(r)===digest(old))))throw fail('Existing rules must remain');
        if(body.uncertainty_policy&&body.uncertainty_policy!==current.uncertainty_policy&&body.uncertainty_policy!=='decline')throw fail('Uncertainty handling can only tighten');
        const out=await client.patchMandate(m[1],body);store.putMandate({...current,...out,...body});
        store.audit('policy.tightened',{mandate_id:m[1]});store.receipts.push(proof.sign('policy',{mandate:store.getMandate(m[1]),audit_head:store.journal.at(-1)?.hash}));store.save();return out;
      }));
    }
    if (m && req.method === 'DELETE') {
      const out = await store.exclusive(async()=>{store.revoke(m[1]);for(const r of store.runs.values())if(r.mandate_id===m[1])worker.stopRun(r.run_id);return client.revokeMandate(m[1]);});
      worker.pushFeed({ kind: 'mandate', text: 'Wallet policy revoked — the agent can no longer spend.' });
      return json(res, 200, out);
    }

    if (p === '/api/runs' && req.method === 'POST') {
      const body = await readBody(req); // {scenario_id}
      if (!activeMandateId) return json(res, 409, { error: 'no active mandate — confirm a policy first' });
      if(store.getMandate(activeMandateId)?.status!=='active')throw fail('Confirm an active policy first');
      if(client.mode==='live'&&worker.activeRuns.size)throw fail('Wait for the current platform run to finish');
      if(!platformHealth.ready)throw fail('Platform is not ready',503);
      const started = await client.startRun({ scenario_id: body.scenario_id, mandate_id: activeMandateId });
      activeRunId = started.run_id;
      const authority = body.customer_hint || null;
      if (!store.getRun(started.run_id)) store.createRun({
        run_id: started.run_id,
        scenario_id: body.scenario_id,
        mandate_id: activeMandateId,
        mandateSnapshot: store.getMandate(activeMandateId) || { hard_rules: [], uncertainty_policy: 'ask' },
        totalEvents: started.event_counters?.total ?? 0,
        customerIds: authority ? [authority] : [],
      });
      await worker.startRun(started.run_id);
      return json(res, 200, started);
    }

    m = p.match(/^\/api\/stepups\/([^/]+)\/resolve$/);
    if (m && req.method === 'POST') {
      const body = await readBody(req); // {decision: approve|decline, message}
      const target=[...store.runs.values()].find(r=>(!body.run_id||r.run_id===body.run_id)&&(r.stepUps.has(m[1])||r.decisions.has(m[1])));
      if (!target) return json(res, 409, { error: 'purchase was not found' });
      const out = await worker.resolveStepUp(target?.run_id||activeRunId, m[1], body.decision, body.message, { whitelist: Boolean(body.whitelist),fingerprint:body.fingerprint });
      return json(res, 200, out);
    }

    if (p === '/api/reset' && req.method === 'POST') {
      await store.exclusive(async()=>{
        if(worker.activeRuns.size || [...store.runs.values()].some(run=>run.stepUps.size))throw fail('Finish or revoke outstanding purchases before resetting the session');
        if (client.reset) await client.reset();
        activeRunId = null;
        activeMandateId = null;
        worker.feed.length = 0;
        store.audit('session.reset',{});
      });
      return json(res, 200, { reset: true });
    }

    if (p === '/api/trustedshops/check' && (req.method === 'POST' || req.method === 'GET')) {
      // Agent-facing concurrent merchant verification: is the suggested website
      // listed on Trusted Shops (global registry behind the .com/.de/.ch/… sites)?
      // POST {merchants: ["digitec.ch", "https://www.brack.ch/", …]} or GET ?merchant=
      let merchants = null;
      if (req.method === 'POST') {
        const body = await readBody(req);
        merchants = body.merchants || body.domains || body.merchant || body.domain || null;
      } else {
        merchants = url.searchParams.get('merchant') || url.searchParams.get('domain') || url.searchParams.get('q');
      }
      if (!merchants || (Array.isArray(merchants) && !merchants.length)) {
        return json(res, 400, { error: 'provide merchants to check: POST {merchants: [url-or-domain, …]} or GET ?merchant=' });
      }
      const out = await trustedShops.check(merchants);
      return json(res, 200, { count: out.results.length, took_ms: out.tookMs, cache: trustedShops.stats, results: out.results });
    }

    if (p === '/api/merchant/dossier' && (req.method === 'POST' || req.method === 'GET')) {
      // Agent/UI-facing yellow-list dossier for a domain that is on neither the
      // trusted list nor a known-bad list: Zefix registry (token-free Lindas
      // SPARQL; API adds registration date/age when LEASH_ZEFIX_TOKEN is set),
      // imprint + registry comparison, LinkedIn/Instagram, payment methods,
      // country vs the customer, Trusted Shops + product-page reviews.
      let inputs = null;
      if (req.method === 'POST') {
        const body = await readBody(req);
        const productUrl = body.product_url || body.productUrl || null;
        const raw = body.merchants || body.domains || body.merchant || body.domain || null;
        const wrap = (x) => (typeof x === 'string' ? { domain: x, product_url: productUrl } : { product_url: productUrl, ...x });
        inputs = Array.isArray(raw) ? raw.map(wrap) : (raw ? wrap(raw) : null);
      } else {
        const m = url.searchParams.get('merchant') || url.searchParams.get('domain') || url.searchParams.get('q');
        const pu = url.searchParams.get('product_url') || url.searchParams.get('productUrl') || null;
        inputs = m ? { domain: m, product_url: pu } : null;
      }
      if (!inputs) {
        return json(res, 400, { error: 'provide a merchant: POST {merchant: url-or-domain, product_url?} or GET ?merchant=<domain>&product_url=<url>' });
      }
      const out = await dossierService.check(inputs);
      for (const r of out.results) {
        r.sustainability = lookupSustainability(r.domain, sustainabilityIndex);
        r.trusted = r.domain ? Boolean(store.isTrustedDomain(r.domain)) : null;
      }
      return json(res, 200, { took_ms: out.tookMs, cache: dossierService.stats, results: out.results });
    }

    if (p === '/api/merchant/trust' && req.method === 'POST') {
      // Customer-initiated: trust a merchant the wallet surfaced (yellow-listed
      // → resolved) straight from its dossier — no paused purchase required.
      // Persists to the trusted list, mirrors to the shopper-bridge whitelist
      // (sign-time enforcement there), and records a feed event.
      const body = await readBody(req);
      const domain = store.addTrustedDomain(body.domain || body.merchant, 'customer trusted this merchant from its dossier');
      if (!domain) return json(res, 400, { error: 'provide a merchant domain or URL' });
      const bridge = await worker.syncBridgeWhitelist(domain).catch((e) => ({ ok: false, error: e?.message || String(e) }));
      const outcome = bridge.skipped ? 'shopper-bridge sync skipped (not configured)'
        : bridge.ok ? (bridge.already ? 'already on the shopper-bridge whitelist' : 'also whitelisted in the shopper bridge')
        : `shopper-bridge sync failed: ${bridge.error}`;
      worker.pushFeed({ kind: 'trust', text: `🤝 ${domain} added to your trusted merchants — future purchases there skip the yellow-list review.`, bridge_sync: outcome });
      console.log(`[trust] ${domain} trusted by customer (${outcome})`);
      return json(res, 200, { ok: true, domain, trusted: true, bridge_sync: outcome });
    }

    if (p === '/api/shopping/categories' && req.method === 'GET') {
      // Weekly "top shops per category" discovery artifact from
      // scripts/refresh-category-sites.mjs (static, public data). Served
      // byte-exact with a modest cache window — unlike the no-store API below.
      try {
        const raw = fs.readFileSync(path.join(ROOT, 'data', 'category-sites', 'category-sites.json'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
        return res.end(raw);
      } catch {
        return json(res, 503, { error: 'category-sites not built yet — run: node scripts/refresh-category-sites.mjs' });
      }
    }

    if (p === '/api/settings/sustainability' && req.method === 'POST') {
      // UI toggle: when on, the offer comparison prefers the more sustainable
      // shop WITHIN the safest risk band. Advisory only — never an engine rule.
      const body = await readBody(req);
      prefs.prefer_sustainable = Boolean(body.enabled);
      savePrefs();
      return json(res, 200, { prefer_sustainable: prefs.prefer_sustainable });
    }

    if (p === '/api/offers/compare' && req.method === 'POST') {
      // Offer comparison for one item across several shops (up to 8 pasted):
      // basic risk score (trusted list + threat intel + Trusted Shops) and a
      // basic sustainability score per shop, ranked — FOR NOW only the top 3
      // shops by our score are compared (demo cap). Evidence-only: this
      // suggests an order and a pick; it never decides or changes an engine
      // decision.
      const body = await readBody(req);
      const rawList = body.merchants ?? body.domains ?? body.shops ?? [];
      const list = (Array.isArray(rawList) ? rawList : String(rawList).split(/[,;\n]/))
        .map(s => String(s).trim()).filter(Boolean).slice(0, 8);
      if (!list.length) return json(res, 400, { error: 'provide shops: POST {merchants: ["ochsnersport.ch", …], item?}' });
      const prefer = prefs.prefer_sustainable === true;
      const ts = await trustedShops.check(list).catch(err => ({ results: [], error: err.message }));
      const offers = list.map((input) => {
        const domain = normalizeDomain(input)?.domain || input;
        const tsResult = ts.results.find(r => r.resolvedDomain === domain) || null;
        const hit = trust ? trustLookup(domain, trust) : null;
        const risk = scoreMerchantRisk({
          trusted: Boolean(store.isTrustedDomain(domain)),
          malicious: Boolean(hit?.malicious),
          trustedShopsResult: tsResult,
        });
        return { merchant: domain, name: tsResult?.name || domain, risk, sustainability: lookupSustainability(domain, sustainabilityIndex) };
      });
      const ranked = rankOffers(offers, { prefer, limit: 3 }); // demo cap: compare only the top 3 by our score
      const top = ranked[0] || null;
      return json(res, 200, {
        item: (body.item || '').trim() || null,
        prefer,
        count: ranked.length,
        total_candidates: offers.length,
        recommended: top ? {
          merchant: top.merchant,
          reason: prefer
            ? `safest risk band first${top.sustainability.score != null ? ', more sustainable shop preferred within it' : ''}`
            : 'ranked by risk score (sustainability preference is off)',
        } : null,
        offers: ranked,
        trustedshops_error: ts.error || null,
      });
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'unknown api path' });

    // ---- Static ----
    return staticFile(res, p);
  } catch (err) {
    console.error('[server]', err);
    return json(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[leash] wallet control UI → http://127.0.0.1:${server.address().port}`);
});
