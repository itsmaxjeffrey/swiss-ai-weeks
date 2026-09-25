// LEASH wallet-control — evstats benchmark. Run: node tools/evstats-bench.js
// Compares quantity-cap methods on synthetic per-customer histories:
//   heuristic — current rule: max(class base, 3 × observed max)
//   mad / gpd / gev — individual estimators (lib/evstats.js)
//   blend     — statThreshold default: max of the methods that pass their
//               sample floors, clamped to [deterministic floor, hard ceiling]
// Protocol per customer: fit on the first 60% of a legit quantity series,
// evaluate on the held-out 40% (legit tail ⇒ false positive if cap < held-out
// max) and on one injected fraud extreme (miss if cap ≥ fraud qty).
import { baseCap } from '../lib/item-classes.js';
import { statThreshold, madBaseline, gevLmomFit, gevQuantile, gpdLmomFit, potQuantile, quantile } from '../lib/evstats.js';

// seeded PRNG (mulberry32) so results are reproducible
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r, mu, sig) => mu + sig * Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

// Legit per-customer quantity series: mostly 1-3, occasional genuinely large
// bulk/durable orders (lognormal tail), clipped to something a human could do.
function legitSeries(r, n) {
  return Array.from({ length: n }, () => Math.min(80, Math.max(1, Math.round(Math.exp(gauss(r, 0.45, 1.05))))));
}

const METHODS = {
  heuristic: (xs, floor) => {
    const obsMax = Math.max(...xs);
    return Math.max(floor, 3 * obsMax);
  },
  mad: (xs, floor) => {
    if (xs.length < 4) return Math.max(floor, 3 * Math.max(...xs));
    const m = madBaseline(xs);
    return Math.max(floor, Math.max(...xs), m ?? 0);
  },
  gpd: (xs, floor) => {
    if (xs.length < 10) return Math.max(floor, 3 * Math.max(...xs));
    const sorted = [...xs].sort((a, b) => a - b);
    const u = quantile(sorted, 0.75);
    const exceed = xs.filter((x) => x > u);
    if (exceed.length < 3) return Math.max(floor, 3 * Math.max(...xs));
    const fit = gpdLmomFit(exceed);
    if (!fit) return Math.max(floor, 3 * Math.max(...xs));
    const v = potQuantile(u, xs.length, exceed.length, 10, fit);
    return Math.max(floor, Math.max(...xs), Number.isFinite(v) ? v : 0);
  },
  gev: (xs, floor) => {
    if (xs.length < 12) return Math.max(floor, 3 * Math.max(...xs));
    const blocks = [];
    for (let i = 0; i + 3 <= xs.length; i += 3) blocks.push(Math.max(xs[i], xs[i + 1], xs[i + 2]));
    const fit = gevLmomFit(blocks);
    if (!fit) return Math.max(floor, 3 * Math.max(...xs));
    const v = gevQuantile(1 - 1e-4, fit);
    return Math.max(floor, Math.max(...xs), Number.isFinite(v) ? v : 0);
  },
  blend: (xs, floor) => {
    const obsMax = Math.max(...xs);
    return statThreshold(xs, {
      floor,
      observedMax: obsMax,
      heuristicFloor: Math.max(floor, 3 * obsMax), // incumbent qtyCap rule
    })?.value ?? Math.max(floor, 3 * obsMax);
  },
};

const fmt = (x) => (x >= 1000 ? Math.round(x).toString() : x.toFixed(1));

const SCENARIOS = [
  { name: 'finite (clothing, base 12)', category: 'clothing', fraud: (r) => 50 + Math.round(r() * 4950), nPurchases: 40 },
  { name: 'gift (gift_card, base 2)', category: 'gift_card', fraud: (r) => 5 + Math.round(r() * 45), nPurchases: 40 },
  { name: 'bulk (household, base 500)', category: 'household', fraud: (r) => 5000 + Math.round(r() * 45000), nPurchases: 40 },
];

const CUSTOMERS = 400, SEED = 20260925;
const results = {};

for (const sc of SCENARIOS) {
  const floor = baseCap(sc.category);
  for (const [method, fn] of Object.entries(METHODS)) {
    let fp = 0, det = 0, sev = 0, capSum = 0, belowOwnMax = 0;
    const caps = [];
    for (let c = 0; c < CUSTOMERS; c++) {
      const r = rng(SEED + 7919 * c + 104729 * (SCENARIOS.indexOf(sc) + 1));
      const full = legitSeries(r, sc.nPurchases);
      const fitN = Math.max(12, Math.floor(full.length * 0.6));
      const fit = full.slice(0, fitN);
      const held = full.slice(fitN);
      const cap = fn(fit, floor);
      const heldMax = Math.max(...held);
      if (cap < heldMax) fp++;                       // legit order flagged
      if (cap < Math.max(...fit)) belowOwnMax++;     // flagging own history
      const fraudQty = sc.fraud(rng(SEED + c * 31 + 7));
      if (fraudQty > cap) det++;                     // fraud flagged at all
      if (fraudQty > cap * 3) sev++;                 // forced step-up band
      caps.push(cap);
    }
    caps.sort((a, b) => a - b);
    results[sc.name] ??= {};
    results[sc.name][method] = {
      fpr: fmt(100 * fp / CUSTOMERS),
      ownMaxHits: belowOwnMax,
      detect: fmt(100 * det / CUSTOMERS),
      severe: fmt(100 * sev / CUSTOMERS),
      capMed: fmt(caps[CUSTOMERS >> 1]),
      capP90: fmt(caps[Math.floor(CUSTOMERS * 0.9)]),
    };
  }
}

console.log(`evstats benchmark — ${CUSTOMERS} customers/scene, fit on 60% of 40-purchase history, seed ${SEED}\n`);
for (const [scene, byMethod] of Object.entries(results)) {
  console.log(`── ${scene} ──`);
  console.log('method      FP%   own-max-hits  detect%  severe%  cap-med  cap-p90');
  for (const [m, s] of Object.entries(byMethod)) {
    console.log(
      m.padEnd(11) + String(s.fpr).padStart(5) + String(s.ownMaxHits).padStart(14)
      + String(s.detect).padStart(9) + String(s.severe).padStart(9)
      + String(s.capMed).padStart(9) + String(s.capP90).padStart(8)
    );
  }
  console.log('');
}

// Sample-size sweep: where do the EV methods stop being noise?
// (finite scene, heuristic vs blend, per-customer n varies)
console.log('── sample-size sweep (finite/clothing, heuristic vs blend) ──');
console.log('n     method      FP%   detect%  severe%  cap-med');
for (const nP of [12, 24, 48, 64]) {
  for (const [method, fn] of [['heuristic', METHODS.heuristic], ['blend', METHODS.blend]]) {
    let fp = 0, det = 0, sev = 0;
    const caps = [];
    for (let c = 0; c < CUSTOMERS; c++) {
      const r = rng(SEED + 7919 * c + 13 * nP);
      const full = legitSeries(r, nP);
      const fitN = Math.max(12, Math.floor(nP * 0.6));
      const fit = full.slice(0, fitN);
      const held = full.slice(fitN);
      const floor = baseCap('clothing');
      const cap = fn(fit, floor);
      if (cap < Math.max(...held)) fp++;
      const fraudQty = 50 + Math.round(rng(SEED + c * 31 + 7)() * 4950);
      if (fraudQty > cap) det++;
      if (fraudQty > cap * 3) sev++;
      caps.push(cap);
    }
    caps.sort((a, b) => a - b);
    console.log(
      String(nP).padEnd(5) + method.padEnd(11)
      + fmt(100 * fp / CUSTOMERS).padStart(5) + fmt(100 * det / CUSTOMERS).padStart(9)
      + fmt(100 * sev / CUSTOMERS).padStart(9) + fmt(caps[CUSTOMERS >> 1]).padStart(9)
    );
  }
}

// small-sample behaviour: degenerate all-ones history must stay inert/fallback
const inert = statThreshold([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], { floor: 12, observedMax: 1 });
console.log('degenerate all-ones sample →', inert
  ? `cap ${inert.value} via ${inert.used.join('+')} (clamped to floor/ceiling)`
  : 'inert (fallback to heuristic)');
