// Model-backed prompt-injection scoring.
// ---------------------------------------------------------------------------
// The artifact (injection-model.json) is trained + exported by
// merchant-trust-data/models/prompt_injection/train_detector.py — hashed TF-IDF
// (md5 feature hashing, uni+bi-grams) + L2-normalised linear classifier trained
// on TensorTrust attacks vs defenses. The implementation here must stay in
// lockstep with that file; test/injection-model.test.js asserts score parity
// against vectors generated in Python at training time.
//
// Scoring definition (identical on both sides):
//   tokens: lowercase, regex [a-z0-9']+
//   grams : unigrams + bigrams (joined with one space)
//   hash  : md5(gram utf-8); idx = int(h[0..8],16) % n_features
//           sign = +1 if int(h[8..16],16) is even else -1
//   vec   : sign-weighted gram counts restricted to exported features,
//           x idx, L2-normalised; logit = w·x + intercept; score = sigmoid(logit)
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN_RE = /[a-z0-9']+/g;

function loadModel() {
  const candidates = [
    new URL('./injection-model.json', import.meta.url),
    new URL('../../merchant-trust-data/models/prompt_injection/injection-model-v1.json', import.meta.url),
  ];
  for (const url of candidates) {
    try {
      const m = JSON.parse(readFileSync(url, 'utf8'));
      if (m && m.schema === 'openclaw.injection-model/1' && m.weights && typeof m.threshold === 'number') return m;
    } catch { /* try next candidate */ }
  }
  return null;
}

let cached = loadModel(); // eager: artifact parse (~100ms) must never sit in the decision path
export function getInjectionModel() {
  return cached; // null when artifact is absent -> engine skips the model layer
}

function gramsOf(tokens) {
  const grams = [];
  for (let i = 0; i < tokens.length; i++) {
    grams.push(tokens[i]);
    if (i + 1 < tokens.length) grams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return grams;
}

function windowLogit(counts, m) {
  // restrict to exported features, apply idf, L2-normalise, dot with weights
  const active = []; // [weight, x]
  let sq = 0;
  for (const [idx, v] of counts) {
    const pair = m.weights[String(idx)];
    if (!pair) continue;
    const x = v * pair[0]; // count * idf
    active.push([pair[1], x]);
    sq += x * x;
  }
  const norm = Math.sqrt(sq);
  let logit = m.intercept;
  if (norm > 0) {
    for (const [w, x] of active) logit += w * (x / norm);
  }
  return { logit: Math.max(-60, Math.min(60, logit)), norm };
}

/** Score one string; returns null when no model artifact is deployed.
 *
 * Scoring mode comes from the artifact (`scoring.mode`, default `window_max`):
 * the text is scored whole AND over sliding token windows (attacks embedded in
 * otherwise-benign product text would otherwise be diluted below threshold);
 * the final score is the maximum.
 */
export function scoreInjectionText(text) {
  const m = getInjectionModel();
  if (!m) return null;
  const tokens = String(text).toLowerCase().match(TOKEN_RE) || [];
  if (!tokens.length) return { score: 0, logit: m.intercept, topGrams: [], tokens: 0 };

  const win = m.scoring?.mode === 'full_text'
    ? { window_tokens: 0, stride_tokens: 0 }
    : { window_tokens: m.scoring?.window_tokens ?? 40, stride_tokens: m.scoring?.stride_tokens ?? 20 };

  // build evaluation spans: whole text + sliding windows
  const spans = [[0, tokens.length]];
  if (win.window_tokens > 0 && tokens.length > win.window_tokens) {
    for (let start = 0; start + win.window_tokens <= tokens.length; start += win.stride_tokens) {
      spans.push([start, start + win.window_tokens]);
    }
    const tail = tokens.length - win.stride_tokens;
    const last = spans[spans.length - 1];
    if (tail > 0 && (last[0] !== tail)) spans.push([tail, tokens.length]);
  }

  let best = null;
  for (const [a, b] of spans) {
    const slice = tokens.slice(a, b);
    const counts = new Map();
    const gramMeta = new Map();
    for (const g of gramsOf(slice)) {
      const h = createHash('md5').update(g, 'utf8').digest('hex');
      const idx = parseInt(h.slice(0, 8), 16) % m.n_features;
      const sign = parseInt(h.slice(8, 16), 16) % 2 === 0 ? 1 : -1;
      counts.set(idx, (counts.get(idx) || 0) + sign);
      if (!gramMeta.has(g)) gramMeta.set(g, { idx, sign });
    }
    const { logit, norm } = windowLogit(counts, m);
    if (!best || logit > best.logit) {
      // evidence: strongest positive n-grams within the winning span
      // (display-only approximation under hash collisions; score is exact)
      let topGrams = [];
      if (norm > 0) {
        for (const [g, { idx, sign }] of gramMeta) {
          const pair = m.weights[String(idx)];
          if (!pair) continue;
          const c = (sign * pair[0] * pair[1]) / norm;
          topGrams.push({ gram: g, contribution: c });
        }
        topGrams = topGrams.filter(t => t.contribution > 0)
          .sort((x, y) => y.contribution - x.contribution).slice(0, 3);
      }
      best = { logit, norm, topGrams, span: [a, b] };
    }
  }
  const score = 1 / (1 + Math.exp(-best.logit));
  return { score, logit: best.logit, topGrams: best.topGrams, tokens: tokens.length, span: best.span };
}

function snippetAround(text, needle) {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return needle;
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + needle.length + 40);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/** Words reconstructed from the winning token window, for evidence snippets. */
function spanText(text, span) {
  if (!span || span[1] - span[0] >= 10000) return String(text);
  const toks = String(text).toLowerCase().match(TOKEN_RE) || [];
  return toks.slice(span[0], span[1]).join(' ');
}

/**
 * Scan untrusted fields ([{field, text}]) with the model.
 * Returns null when no artifact is deployed; otherwise:
 *   { threshold, suspect, best: {field, score, topGrams, snippet} | null,
 *     perField: [{field, score}] }
 */
export function scanInjectionModel(fields) {
  const m = getInjectionModel();
  if (!m) return null;
  const threshold = m.threshold;
  const suspect = Math.min(0.6, threshold * 0.55);
  const perField = [];
  let best = null;
  for (const { field, text } of fields) {
    if (!text || typeof text !== 'string') continue;
    const r = scoreInjectionText(text);
    if (!r) continue;
    perField.push({ field, score: r.score });
    if (!best || r.score > best.score) {
      const winText = spanText(text, r.span);
      best = {
        field, score: r.score, topGrams: r.topGrams,
        snippet: r.topGrams.length ? snippetAround(winText, r.topGrams[0].gram) : winText.slice(0, 90),
      };
    }
  }
  return { threshold, suspect, best, perField };
}
