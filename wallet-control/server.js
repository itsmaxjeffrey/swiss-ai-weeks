// LEASH wallet-control — zero-dependency HTTP server.
// Serves the customer UI and a small app API; hosts the platform client and worker.
// Mode: live platform (LEASH_BASE_URL + TEAM_API_KEY) or offline simulator.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from './lib/store.js';
import { HistoryProfiles } from './lib/history.js';
import { makeClient } from './lib/api.js';
import { Worker } from './lib/worker.js';
import { compilePolicy } from './lib/policy-compiler.js';
import { buildTrustIndex, trustLookup } from './lib/signals.js';
import { TrustedShopsChecker, normalizeDomain } from './lib/trustedshops.js';
import { MerchantDossier } from './lib/yellowlist.js';
import { readJsonIfExists, loadCsv } from './lib/util.js';
import { loadSustainabilityIndex, lookupSustainability, scoreMerchantRisk, rankOffers } from './lib/sustainability.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8790);
const PACK_DIR = process.env.PACK_DIR || path.join(ROOT, 'data/pack');

// ---- Bootstrap singletons ----------------------------------------------------
const store = new Store(path.join(ROOT, 'data/state.json'));
const profiles = HistoryProfiles.load(path.join(PACK_DIR, 'authorization_history.csv'));
const trustRaw = readJsonIfExists(path.join(ROOT, 'data/leash_trust.json'));
const trust = buildTrustIndex(trustRaw);
const client = makeClient(store);
const trustedShops = new TrustedShopsChecker();
const gleifAges = readJsonIfExists(path.join(ROOT, 'data', 'gleif_ch_ages.json'));
const dossierService = new MerchantDossier({ trustedShops, gleifAges });
// Sustainability scores (demo-grade static dataset, data/sustainability.json)
// + persisted UI preferences (data/preferences.json). Advisory only: they
// inform the offer comparison; they never change engine decisions.
const sustainabilityIndex = loadSustainabilityIndex(path.join(ROOT, 'data', 'sustainability.json'));
const PREFS_FILE = path.join(ROOT, 'data', 'preferences.json');
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
const worker = new Worker({ client, store, profiles, trust, trustedShops, bridgeSync });
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
  let raw = '';
  for await (const chunk of req) raw += chunk;
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

function snapshot() {
  const mandate = activeMandateId ? (store.getMandate(activeMandateId) || client.getMandate?.(activeMandateId)) : null;
  const run = activeRunId ? store.getRun(activeRunId) : null;
  const pending = [];
  if (run) {
    for (const [authId, s] of run.stepUps) {
      const d = run.decisions.get(authId);
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
        });
      }
    }
  }
  return {
    mode,
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
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // ---- App API ----
    if (p === '/api/state' && req.method === 'GET') {
      return json(res, 200, snapshot());
    }

    if (p === '/api/policy/compile' && req.method === 'POST') {
      const body = await readBody(req);
      const draft = compilePolicy(body.instruction || '');
      return json(res, 200, draft);
    }

    if (p === '/api/mandates' && req.method === 'POST') {
      const body = await readBody(req); // {instruction, hard_rules, uncertainty_policy, guidance, open_questions}
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
      return json(res, 200, out);
    }

    m = p.match(/^\/api\/mandates\/([^/]+)$/);
    if (m && req.method === 'GET') {
      return json(res, 200, await client.getMandate(m[1]));
    }
    if (m && req.method === 'PATCH') {
      const body = await readBody(req);
      return json(res, 200, await client.patchMandate(m[1], body));
    }
    if (m && req.method === 'DELETE') {
      const out = await client.revokeMandate(m[1]);
      worker.pushFeed({ kind: 'mandate', text: 'Wallet policy revoked — the agent can no longer spend.' });
      return json(res, 200, out);
    }

    if (p === '/api/runs' && req.method === 'POST') {
      const body = await readBody(req); // {scenario_id}
      if (!activeMandateId) return json(res, 409, { error: 'no active mandate — confirm a policy first' });
      const started = await client.startRun({ scenario_id: body.scenario_id, mandate_id: activeMandateId });
      activeRunId = started.run_id;
      const authority = body.customer_hint || null;
      store.createRun({
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
      if (!activeRunId) return json(res, 409, { error: 'no active run' });
      const out = await worker.resolveStepUp(activeRunId, m[1], body.decision, body.message, { whitelist: Boolean(body.whitelist) });
      return json(res, 200, out);
    }

    if (p === '/api/reset' && req.method === 'POST') {
      if (client.reset) await client.reset();
      activeRunId = null;
      worker.feed.length = 0;
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

    if (p === '/api/settings/sustainability' && req.method === 'POST') {
      // UI toggle: when on, the offer comparison prefers the more sustainable
      // shop WITHIN the safest risk band. Advisory only — never an engine rule.
      const body = await readBody(req);
      prefs.prefer_sustainable = Boolean(body.enabled);
      savePrefs();
      return json(res, 200, { prefer_sustainable: prefs.prefer_sustainable });
    }

    if (p === '/api/offers/compare' && req.method === 'POST') {
      // Offer comparison for one item across several shops (up to 8): basic
      // risk score (trusted list + threat intel + Trusted Shops) and a basic
      // sustainability score per shop, ranked. Evidence-only: this suggests an
      // order and a pick; it never decides or changes an engine decision.
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
      const ranked = rankOffers(offers, { prefer });
      const top = ranked[0] || null;
      return json(res, 200, {
        item: (body.item || '').trim() || null,
        prefer,
        count: ranked.length,
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
  console.log(`[leash] wallet control UI → http://127.0.0.1:${PORT}`);
});
