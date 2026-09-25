// LEASH wallet-control — SAW26 sandbox driver.
// Wires the live "Agent on a Leash" sandbox to the wallet-control engine:
// mandate (compilePolicy) -> confirm -> scenario-run -> long-poll decision
// requests -> evaluate() -> POST decision within the 8 s deadline.
//
// Usage: node scripts/saw26-driver.mjs [SCENxxxx] (interactive policy confirmation; human step-ups remain pending)
// Network: curl --noproxy '*' (egress proxy 502s on this host; see docs/saw26-sandbox-api.md).
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HistoryProfiles } from '../lib/history.js';
import { evaluate } from '../lib/engine.js';
import { buildTrustIndex, hydrateMarketIntel } from '../lib/signals.js';
import { compilePolicy } from '../lib/policy-compiler.js';
import { readJsonIfExists } from '../lib/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://saw26api.ashyground-364e1d07.switzerlandnorth.azurecontainerapps.io';
const KEY = readFileSync(path.join(ROOT, '.saw26-key'), 'utf8').replace(/[\s"]/g, '');
const args = process.argv.slice(2);
const SCENARIO = args.find(a => !a.startsWith('--')) || 'SCEN0101';
if (args.some(a => a.startsWith('--resolve='))) throw new Error('Automatic human resolution is forbidden in the hosted driver. Use cli.js for synthetic offline resolution.');
if (!process.stdin.isTTY) throw new Error('Use an interactive terminal to review and confirm the wallet policy, or use the customer UI.');

let pkgVersion = '1';
try { pkgVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '1'; } catch {}

function api(method, p, body) {
  const argv = ['--noproxy', '*', '-s', '--max-time', '40', '-X', method,
    '-H', `Authorization: Bearer ${KEY}`, '-H', 'Content-Type: application/json'];
  if (body !== undefined) argv.push('-d', JSON.stringify(body));
  argv.push(`${BASE}${p}`);
  const out = execFileSync('curl', argv, { maxBuffer: 16 * 1024 * 1024 }).toString();
  if (!out.trim()) return null;
  const j = JSON.parse(out);
  if (j && j.error) throw new Error(`API ${method} ${p} -> ${JSON.stringify(j.error)}`);
  return j;
}

// Canonical live events may carry numerics as strings; the engine wants numbers.
const NUM_A = ['amount', 'billing_amount_chf', 'items_subtotal', 'delivery_fee', 'replay_order'];
function normalize(ev) {
  const a = { ...(ev.authorization || ev) };
  for (const k of NUM_A) if (typeof a[k] === 'string') a[k] = Number(a[k]) || 0;
  const items = (ev.items || a.items || []).map(i => ({
    ...i, quantity: Number(i.quantity) || 1, unit_price: Number(i.unit_price) || 0,
  }));
  return { ...ev, authorization: a, items };
}

const boot = api('GET', '/v1/bootstrap');
const scen = boot.scenarios.find(s => s.scenario_id === SCENARIO);
if (!scen) { console.error(`unknown scenario ${SCENARIO}; have: ${boot.scenarios.map(s => s.scenario_id).join(' ')}`); process.exit(1); }

console.log(`═ ${SCENARIO} — ${scen.scenario_name} (${scen.event_count} events) · team ${boot.team_id}`);
console.log(`  instruction: ${scen.cardholder_instruction}`);

// 1) mandate: compilePolicy turns the cardholder instruction into structured rules
const draft = compilePolicy(scen.cardholder_instruction);
const ruleKeys = ['field', 'operator', 'value', 'currency', 'scope', 'period_days'];
const mandateDraft = {
  instruction: scen.cardholder_instruction,
  hard_rules: (draft.hard_rules || []).map(r => Object.fromEntries(ruleKeys.filter(k => r[k] !== undefined && r[k] !== null).map(k => [k, r[k]]))),
  uncertainty_policy: draft.uncertainty_policy || 'ask',
  guidance: draft.guidance || [],
  open_questions: draft.open_questions || [],
};
const created = api('POST', '/v1/mandates', mandateDraft);
const draftId = created.draft_id || created.id;
console.log(`  mandate draft: ${draftId} (${mandateDraft.hard_rules.length} rules, uncertainty=${mandateDraft.uncertainty_policy})`);
console.log(JSON.stringify(mandateDraft, null, 2));
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const consent = await terminal.question('Confirm these exact permissions? Type yes: ');
terminal.close();
if (consent.trim().toLowerCase() !== 'yes') process.exit(0);
const confirmed = api('POST', `/v1/mandates/${draftId}/confirm`, { confirmed: true });
const mandateId = confirmed.mandate_id || confirmed.id || draftId;
console.log(`  mandate confirmed: ${mandateId}`);

// 2) start the scenario run
const run = api('POST', '/v1/scenario-runs', { scenario_id: SCENARIO, mandate_id: mandateId });
const runId = run.run_id || run.id;
console.log(`  run started: ${runId}`);

// 3) engine + state (same construction as cli.js)
const profiles = HistoryProfiles.load(path.join(ROOT, 'data/pack', 'authorization_history.csv'));
const trust = buildTrustIndex(readJsonIfExists(path.join(ROOT, 'data/leash_trust.json')));
hydrateMarketIntel(trust, {
  popularity: readJsonIfExists(path.join(ROOT, 'data/popularity.json')),
  sanctions: readJsonIfExists(path.join(ROOT, 'data/sanctions_names.json')),
  mccRisk: readJsonIfExists(path.join(ROOT, 'data/mcc_risk.json')),
});
const spend = [];
const decisions = new Map();
const state = {
  approvedSpendInWindow: (days, beforeTs) => {
    const cutoff = beforeTs - days * 86400_000;
    return Math.round(spend.filter(s => s.simTs > cutoff && s.simTs <= beforeTs).reduce((x, s) => x + s.amount, 0) * 100) / 100;
  },
  inRunApprovedMerchant: mid => spend.some(s => s.merchantId === mid),
  findDuplicate: ({ signature, authId, simTs, merchantId, billing }) => {
    for (const [aid, d] of decisions) {
      if (aid === authId) continue;
      const min = simTs && d.simTs ? Math.round(Math.abs(simTs - d.simTs) / 60000) : null;
      if (min == null || min > 240) continue;
      if (d.signature === signature) {
        if (d.final === 'approved') return { kind: 'approved-similar', billing: d.billing, minutesAgo: min };
        if (d.final === 'declined') return { kind: 'declined-similar', billing: d.billing, minutesAgo: min };
      } else if (d.merchantId === merchantId && min <= 15 && Math.abs(d.billing - billing) <= Math.max(2, billing * 0.3)) {
        if (d.final === 'approved') return { kind: 'split-suspect', billing: d.billing, minutesAgo: min };
      }
    }
    return null;
  },
  priorDecisions: () => decisions,
};

// 4) decision loop
const seen = new Set();
let empty = 0;
const rows = [];
while (empty < 4) {
  let evt;
  try { evt = api('GET', '/v1/decision-requests/next?wait=25'); }
  catch (e) { console.error(`  poll error: ${e.message}`); break; }
  if (!evt) { empty++; continue; }
  empty = 0;
  const d = evt.data || evt;
  const a = d.authorization || d;
  const authId = a.authorization_id;
  if (!authId) continue;
  if (seen.has(authId)) { execFileSync('sleep', ['1']); continue; }

  const msLeft = d.deadline_at ? new Date(d.deadline_at).getTime() - Date.now() : null;
  const norm = normalize(d);
  let out, final = null;
  try {
    out = evaluate(norm, state, profiles, trust);
  } catch (e) {
    console.error(`  ENGINE ERROR on ${authId}: ${e.message} -> fail-closed decline`);
    out = { decision: 'decline', reason_codes: ['ENGINE_ERROR'], customer_message: 'Engine failure — declined for safety.', evidence: [], evaluation_ms: 0, signature: '' };
  }
  try {
    api('POST', `/v1/authorizations/${authId}/decision`, {
      decision: out.decision,
      reason_codes: out.reason_codes || [],
      customer_message: out.customer_message || '',
      evidence: (out.evidence || []).slice(0, 8).map(e => ({ label: e.label, value: String(e.value) })),
      engine_version: `wallet-control/${pkgVersion}`,
    });
  } catch (e) { console.error(`  decision POST failed for ${authId}: ${e.message}`); execFileSync('sleep', ['2']); continue; }
  seen.add(authId);

  if (out.decision === 'step_up') {
    console.log(`  HUMAN REVIEW REQUIRED: ${authId}; left pending. No automated resolution submitted.`);
  } else {
    final = out.decision === 'approve' ? 'approved' : 'declined';
  }

  const simTs = a.timestamp ? new Date(a.timestamp).getTime() : Date.now();
  decisions.set(authId, {
    signature: out.signature, final, billing: Number(a.billing_amount_chf) || 0,
    simTs, merchantId: a.merchant?.merchant_id ?? a.merchant_id,
  });
  if (final === 'approved') spend.push({ simTs, amount: Number(a.billing_amount_chf) || 0, merchantId: a.merchant?.merchant_id ?? a.merchant_id });

  const merch = a.merchant?.merchant_name || a.merchant?.merchant_id || a.merchant_id || '?';
  console.log(`  ${authId}  ${merch}  CHF ${a.billing_amount_chf}  -> ${out.decision.toUpperCase()}${final && out.decision === 'step_up' ? `→${final}` : ''}  [${(out.reason_codes || []).slice(0, 3).join(',') || '-'}]  ${out.evaluation_ms}ms, ${msLeft != null ? Math.max(0, Math.round(msLeft / 100) / 10) + 's left' : 'no deadline'}`);
  if (out.decision !== 'approve' && out.customer_message) console.log(`      ${String(out.customer_message).replace(/\n/g, ' ').slice(0, 240)}`);
  rows.push({ authId, decision: out.decision, final });
}

const counts = rows.reduce((m, r) => { const k = r.final || r.decision; m[k] = (m[k] || 0) + 1; return m; }, {});
console.log(`  done: ${rows.length} authorizations -> ` + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '));
try {
  const st = api('GET', `/v1/scenario-runs/${runId}`);
  console.log(`  run status: ${JSON.stringify({ status: st.status, generated: st.generated_event_count, delivered: st.delivered_event_count, finalized: st.finalized_event_count, processed: st.processed_event_count, pending: st.pending_event_count, rejected: st.platform_rejected_count })}`);
} catch (e) { console.log(`  run status unavailable: ${e.message}`); }
