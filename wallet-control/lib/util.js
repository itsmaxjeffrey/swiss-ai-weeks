// LEASH wallet-control — shared utilities (zero-dependency).
import fs from 'node:fs';

/** Minimal RFC-4180 CSV parser (handles quoted fields, embedded commas/newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false, i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length > 1 || r[0] !== '')
    .map(r => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}

export function loadCsv(path) {
  return parseCsv(fs.readFileSync(path, 'utf8'));
}

export const round2 = (n) => Math.round(n * 100) / 100;

/** Convert an amount between pack currencies using the fixed synthetic rates. */
export const FX = { CHF: 1.0, EUR: 0.95, GBP: 1.12, USD: 0.87 }; // to CHF, rate_date 2026-08-01
export function toChf(amount, currency) {
  const rate = FX[(currency || 'CHF').toUpperCase()];
  return round2(amount * (rate ?? 1));
}

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** null-preserving string: '' -> null */
export function str(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

export function parseTs(s) {
  return s ? new Date(s).getTime() : null;
}

export function fmtChf(n) {
  return `CHF ${round2(n).toFixed(2)}`;
}

/** Normalize a merchant/item name for comparison: lowercase, letters+digits only. */
export function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Jaro-Winkler similarity in [0,1] — used for lookalike-merchant detection. */
export function jaroWinkler(a, b) {
  const s1 = normalizeName(a), s2 = normalizeName(b);
  if (!s1.length || !s2.length) return 0;
  if (s1 === s2) return 1;
  const window = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const f1 = new Array(s1.length).fill(false), f2 = new Array(s2.length).fill(false);
  let m = 0;
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - window), hi = Math.min(s2.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!f2[j] && s1[i] === s2[j]) { f1[i] = true; f2[j] = true; m++; break; }
    }
  }
  if (!m) return 0;
  let k = 0, t = 0;
  for (let i = 0; i < s1.length; i++) {
    if (f1[i]) {
      while (!f2[k]) k++;
      if (s1[i] !== s2[k]) t++;
      k++;
    }
  }
  const jaro = (m / s1.length + m / s2.length + (m - t / 2) / m) / 3;
  let p = 0;
  const maxPrefix = Math.min(4, s1.length, s2.length);
  while (p < maxPrefix && s1[p] === s2[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Truncate long untrusted text for evidence display. */
export function clip(s, n = 90) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export function readJsonIfExists(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}
