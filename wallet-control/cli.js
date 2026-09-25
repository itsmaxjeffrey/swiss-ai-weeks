// LEASH wallet-control — offline replay CLI.
// Replays one or all scenarios from the data pack through the engine and prints a
// decision table. Step-ups are resolved with a fixed customer policy so the whole
// sequence executes: --resolve approve|decline|auto (default: auto).
//   node cli.js                 -> all scenarios
//   node cli.js SCEN0002        -> one scenario
import { HistoryProfiles } from './lib/history.js';
import { evaluate } from './lib/engine.js';
import { buildTrustIndex, hydrateMarketIntel } from './lib/signals.js';
import { compilePolicy } from './lib/policy-compiler.js';
import { offlinePackPath } from './lib/pack-path.js';
import { PackData } from './sim/events.js';
import { readJsonIfExists } from './lib/util.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACK_DIR = offlinePackPath();
const args = process.argv.slice(2);
const resolveArg = (args.find(a => a.startsWith('--resolve=')) || '--resolve=auto').split('=')[1];
const scenarios = args.filter(a => !a.startsWith('--'));

const pack = new PackData(PACK_DIR);
const profiles = HistoryProfiles.load(path.join(PACK_DIR, 'authorization_history.csv'));
const trust = buildTrustIndex(readJsonIfExists(path.join(ROOT, 'data/leash_trust.json')));
hydrateMarketIntel(trust, {
  popularity: readJsonIfExists(path.join(ROOT, 'data/popularity.json')),
  sanctions: readJsonIfExists(path.join(ROOT, 'data/sanctions_names.json')),
  mccRisk: readJsonIfExists(path.join(ROOT, 'data/mcc_risk.json')),
});

// Auto-resolution policy for the simulated customer:
// approve pauses whose uncertainties are "human-judgment" items (substitution,
// extra item, duplicate); decline pauses with safety signals (device, velocity,
// hour, lookalike) or requirements that could not be verified (return window).
// Deterministic, documented in the README.
const APPROVE_OK = new Set(['SUBSTITUTION', 'TERRAIN_UNVERIFIED', 'EXTRA_ITEM', 'DUPLICATE_SUSPECT', 'SIZE_UNVERIFIED', 'REQUESTED_ITEM_UNCLEAR', 'RULE_UNVERIFIED', 'AMOUNT_MISSING', 'PRICE_SANITY', 'FULFILMENT_MISMATCH', 'DESCRIPTION_CONTRADICTION', 'ITEM_UNCLEAR']);

let stepUpCount = 0;

function resolveAuto(codes) {
  if (!codes.length) return 'approve';
  const serious = codes.filter(c => !APPROVE_OK.has(c));
  return serious.length ? 'decline' : 'approve';
}

function runScenario(id) {
  const scen = pack.scenario(id);
  const attempts = pack.byScenario.get(id) || [];
  if (!attempts.length) { console.error(`unknown scenario ${id}`); process.exit(1); }

  const draft = compilePolicy(scen.cardholder_instruction);
  const authority = pack.authorities.find(a => a.authority_id === attempts[0].authority_id);
  const mandate = {
    mandate_id: 'TM_CLI', status: 'active',
    customer_id: authority?.customer_id || 'CU0001',
    instruction: scen.cardholder_instruction,
    hard_rules: draft.hard_rules,
    uncertainty_policy: draft.uncertainty_policy,
  };

  console.log(`\n══ ${id} — ${scen.scenario_name}  (${attempts.length} purchases)`);
  console.log(`  customer: ${mandate.customer_id}`);
  console.log(`  instruction: ${scen.cardholder_instruction}`);
  console.log(`  rules: ${draft.hard_rules.length}, uncertainty: ${draft.uncertainty_policy}`);

  const spend = [];
  const decisions = new Map();
  const rows = [];

  const state = {
    approvedSpendInWindow: (days, beforeTs) => {
      const cutoff = beforeTs - days * 86400_000;
      return Math.round(spend.filter(s => s.simTs > cutoff && s.simTs <= beforeTs).reduce((a, s) => a + s.amount, 0) * 100) / 100;
    },
    inRunApprovedMerchant: (mid) => spend.some(s => s.merchantId === mid),
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

  for (const row of attempts) {
    const event = pack.buildEvent(row, { mandate, context: null });
    const a = event.authorization;
    const ev = evaluate(event, state, profiles, trust);
    let final = ev.decision === 'step_up' ? null : (ev.decision === 'approve' ? 'approved' : 'declined');
    if (ev.decision === 'step_up') {
      stepUpCount++;
      final = resolveArg === 'approve' ? 'approved' : resolveArg === 'decline' ? 'declined' : resolveAuto(ev.reason_codes);
    }
    decisions.set(a.authorization_id, {
      signature: ev.signature, final, billing: a.billing_amount_chf,
      simTs: new Date(a.timestamp).getTime(), merchantId: a.merchant.merchant_id,
    });
    if (final === 'approved' || ev.decision === 'approve') {
      spend.push({ simTs: new Date(a.timestamp).getTime(), amount: a.billing_amount_chf, merchantId: a.merchant.merchant_id });
    }
    rows.push({ row, ev, final });
  }

  for (const { row, ev, final } of rows) {
    const badge = ev.decision === 'approve' ? 'APPROVE ' : ev.decision === 'decline' ? 'DECLINE ' : `STEP_UP→${final ? final.toUpperCase() : '?'} `;
    const codes = ev.reason_codes.slice(0, 3).join(',').padEnd(34);
    const ms = String(ev.evaluation_ms).padStart(5);
    console.log(`  ${row.authorization_id} ${row.timestamp.slice(5, 16)}  ${String(row.merchant_id)}  ${String(row.billing_amount_chf).padStart(6)} ${row.currency.padEnd(4)} ${badge} ${codes} ${ms}ms`);
    if (ev.decision !== 'approve') {
      console.log(`      ${ev.customer_message.replace(/\n/g, ' ').slice(0, 320)}`);
    }
    const beh = (ev.evidence || []).find(e => e.label === 'Behavior model');
    if (beh && !/normal/.test(beh.value)) {
      console.log(`      behavior model: ${beh.value}`);
    }
  }
  const counts = rows.reduce((m, r) => { const f = r.final || r.ev.decision; m[f] = (m[f] || 0) + 1; return m; }, {});
  console.log(`  summary: ${rows.length} purchases → ` + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '));
}

const list = scenarios.length ? scenarios : pack.scenarios.map(s => s.scenario_id);
for (const id of list) runScenario(id);
console.log(`\n(step-ups resolved with policy: ${resolveArg})`);
