// Extreme-value / robust statistical thresholds for per-customer behavioral
// baselines (quantities today, amounts later). Pure JS, zero deps.
// ---------------------------------------------------------------------------
// Companions to the deterministic class caps in lib/item-classes.js. Where
// `qtyCap` uses the crude "3× observed max" heuristic, the estimators here fit
// an upper tail to the customer's own sample:
//
//   mad  — robust z-scale: median + k·(1.4826·MAD). Cheap, honest for small n,
//          useless when the sample is degenerate (all-equal, e.g. all qty 1).
//   gpd  — Peaks-over-threshold (Pickands–Balkema–de Haan): exceedances over
//          the empirical q75 fitted with a Generalized Pareto (L-moments),
//          threshold = POT return level "once per returnPeriodK·n purchases".
//          The statistically recommended tail method for thresholds.
//   gev  — Block-maxima (Fisher–Tippett): GEV fitted by L-moments to maxima of
//          consecutive blocks; threshold = high quantile of the fitted GEV.
//
// Every method has a minimum-sample floor below which it refuses to speak
// (small-sample EV fits are noise, not signal). `statThreshold` combines the
// methods that pass their floors (max = conservative: the higher honest
// estimate wins) and clamps the result:
//   • never below `floor` (the deterministic class cap) — safety stays;
//   • never below the observed maximum — never flag what the customer did;
//   • never above `upperBound(floor, observedMax)` — a wild fit cannot blind
//     the check to fraud.
//
// This module is engine-side enforcement only. The trained feature 14
// (qty_over_class_cap) and the Python trainer's mirrored qty_cap rule stay on
// the stable `qtyCap` heuristic — see lib/item-classes.js lockstep note.

const MAX_SAMPLES = 64;

export const METHOD_FLOORS = { mad: 4, gpd: 10, gev: 12 };

/** Lanczos approximation of Γ(z), z > 0 (g=7, n=9 coefficients). */
export function gammaFn(z) {
  const g = 7;
  const C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  z -= 1;
  let x = C[0];
  for (let i = 1; i < g + 2; i++) x += C[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

const EULER_GAMMA = 0.5772156649015329;

/** Clean a raw sample: finite positive numbers, deduped order preserved,
 *  most recent last, bounded length. Returns a sorted ascending copy too. */
export function cleanSamples(raw, maxLen = MAX_SAMPLES) {
  const xs = (Array.isArray(raw) ? raw : [])
    .map(Number)
    .filter((x) => Number.isFinite(x) && x > 0)
    .slice(-maxLen);
  return { xs, sorted: [...xs].sort((a, b) => a - b) };
}

export function median(sorted) {
  if (!sorted.length) return NaN;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** Empirical quantile (linear interpolation), p in [0,1], sorted input. */
export function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** First three unbiased L-moments (l1, l2, l3) of a sample. */
export function lmoments(xs) {
  const n = xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  const b0 = sorted.reduce((s, x) => s + x, 0) / n;
  let b1 = 0, b2 = 0;
  if (n >= 2) for (let i = 0; i < n; i++) b1 += ((i) / (n - 1)) * sorted[i];
  b1 /= n;
  if (n >= 3) for (let i = 0; i < n; i++) b2 += ((i * (i - 1)) / ((n - 1) * (n - 2))) * sorted[i];
  b2 /= n;
  return { l1: b0, l2: 2 * b1 - b0, l3: 6 * b2 - 6 * b1 + b0 };
}

/** GEV (block-maxima) L-moment fit → {mu, sigma, xi} or null when degenerate. */
export function gevLmomFit(xs) {
  if (xs.length < 4) return null;
  const { l1, l2, l3 } = lmoments(xs);
  if (!(l2 > 0) || !Number.isFinite(l1)) return null;
  const t3 = l3 / l2;
  const c = 2 / (3 + t3) - Math.log(2) / Math.log(3); // Hosking c-substitution (no Math.LN3!)
  let xi = 7.859 * c + 2.9554 * c * c; // Hosking–Wallis–Wood approx.
  let sigma, mu;
  if (Math.abs(xi) < 1e-8) {
    xi = 0; // Gumbel limit
    sigma = l2 / Math.LN2;
    mu = l1 - EULER_GAMMA * sigma;
  } else {
    const g = gammaFn(1 + xi);
    if (!Number.isFinite(g) || g === 0) return null;
    sigma = (l2 * xi) / ((1 - Math.pow(2, -xi)) * g);
    mu = l1 - (sigma * (1 - g)) / xi;
  }
  if (!Number.isFinite(mu) || !Number.isFinite(sigma) || sigma <= 0) return null;
  if (Math.abs(xi) >= 0.99) return null; // wild shape — refuse to speak
  return { mu, sigma, xi };
}

/** GEV quantile (inverse CDF) at probability F. */
export function gevQuantile(F, { mu, sigma, xi }) {
  if (F <= 0 || F >= 1) return NaN;
  if (xi === 0) return mu - sigma * Math.log(-Math.log(F));
  return mu + (sigma / xi) * (1 - Math.pow(-Math.log(F), xi));
}

/** GPD L-moment fit to exceedances (over threshold) → {sigma, xi} or null.
 *  Parameterization: F(x) = 1 - (1 - xi·x/sigma)^(1/xi), x ≥ 0. */
export function gpdLmomFit(exceed) {
  if (exceed.length < 3) return null;
  const { l2, l3 } = lmoments(exceed);
  if (!(l2 > 0)) return null;
  const t3 = l3 / l2;
  // τ3 = (1-ξ)/(3+ξ)  ⇒  ξ = (1-3τ3)/(1+τ3); σ = l2(1+ξ)(2+ξ)
  const xi = (1 - 3 * t3) / (1 + t3);
  const sigma = l2 * (1 + xi) * (2 + xi);
  if (!Number.isFinite(sigma) || sigma <= 0) return null;
  if (xi >= 0.99) return null; // unbounded wild tail — refuse
  return { sigma, xi };
}

/** POT return level: value exceeded with probability 1/n·(1/returnPeriodK)
 *  given n total samples and Nu exceedances over threshold u. */
export function potQuantile(u, n, nExceed, returnPeriodK, { sigma, xi }) {
  const ratio = n / Math.max(1, nExceed);
  const zeta = 1 - 1 / (returnPeriodK * n);
  if (Math.abs(xi) < 1e-8) return u + sigma * Math.log(ratio * zeta);
  return u + (sigma / xi) * (Math.pow(ratio * zeta, -xi) - 1);
}

/** Robust MAD baseline: median + k·(1.4826·MAD). Null when degenerate
 *  (MAD = 0 — e.g. every observed quantity is 1). */
export function madBaseline(xs, k = 6) {
  const sorted = [...xs].sort((a, b) => a - b);
  const med = median(sorted);
  const dev = sorted.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  const mad = median(dev);
  if (!(mad > 0)) return null;
  return med + k * 1.4826 * mad;
}

/** Combined statistical threshold from one customer's sample.
 *  floor        — deterministic lower bound (class base cap)
 *  observedMax  — customer's own observed maximum (never flag the past)
 *  alpha        — GEV tail probability for the block-maxima quantile
 *  returnPeriodK — POT return period in units of n purchases
 *  upperMult    — hard ceiling multiplier (see header)
 *  Returns {value, used, n, detail} or null when no method has enough data. */
export function statThreshold(raw, {
  floor = 0,
  observedMax = 0,
  heuristicFloor = null,
  alpha = 1e-4,
  returnPeriodK = 10,
  upperMult = 10,
} = {}) {
  const { xs, sorted } = cleanSamples(raw);
  const n = xs.length;
  if (!n) return null;
  const obsMax = Math.max(observedMax, sorted[n - 1]);
  const incumbent = Math.max(0, Number(heuristicFloor) || 0); // current rule's cap
  const ceiling = Math.max(upperMult * floor, upperMult * obsMax);
  const used = [];
  const detail = {};
  let best = 0;

  // mad — cheap and honest, runs first on any non-degenerate sample
  if (n >= METHOD_FLOORS.mad) {
    const m = madBaseline(xs);
    if (m != null && Number.isFinite(m)) {
      detail.mad = m;
      used.push('mad');
      best = Math.max(best, m);
    }
  }

  // gpd — POT over the empirical q75
  if (n >= METHOD_FLOORS.gpd) {
    const u = quantile(sorted, 0.75);
    const exceed = xs.filter((x) => x > u);
    if (exceed.length >= 3) {
      const fit = gpdLmomFit(exceed);
      if (fit) {
        const v = potQuantile(u, n, exceed.length, returnPeriodK, fit);
        if (Number.isFinite(v) && v > 0) {
          detail.gpd = v;
          used.push('gpd');
          best = Math.max(best, v);
        }
      }
    }
  }

  // gev — block maxima of consecutive blocks of 3
  if (n >= METHOD_FLOORS.gev) {
    const blocks = [];
    for (let i = 0; i + 3 <= n; i += 3) {
      blocks.push(Math.max(xs[i], xs[i + 1], xs[i + 2]));
    }
    if (blocks.length >= 4) {
      const fit = gevLmomFit(blocks);
      if (fit) {
        const v = gevQuantile(1 - alpha, fit);
        if (Number.isFinite(v) && v > 0) {
          detail.gev = v;
          used.push('gev');
          best = Math.max(best, v);
        }
      }
    }
  }

  if (!used.length && !(incumbent > 0)) return null;
  // The incumbent rule participates as a floor: statistics may only LOOSEN a
  // cap when the customer's own history justifies it — never tighten below
  // what the deterministic rule already allows (no tail-underestimation FPs).
  const value = Math.min(ceiling, Math.max(floor, obsMax, incumbent, best));
  return { value, used, n, detail: { ...detail, ceiling, floor, incumbent, observedMax: obsMax } };
}
