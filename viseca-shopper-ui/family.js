#!/usr/bin/env node
/**
 * family.js — parental controls for the Viseca Shopper bridge.
 *
 * Zero-dependency companion to accounts.js / shopping.js. A (parent) account
 * can create child accounts and govern what they may spend:
 *
 *   1. Max spend per order   budget.max_total of any signed policy must be
 *                            ≤ maxSpendChf (when set).
 *   2. Monthly budget        the sum of all budgets the child signed this
 *                            calendar month (UTC) plus the new policy must
 *                            stay ≤ monthlyBudgetChf (when set).
 *   3. Category limits       per-category monthly caps. The policy's
 *                            categories come from `policy.category` (if it
 *                            names a known category) or are derived from
 *                            merchant.allowed_domains via the site catalog;
 *                            unknown domains map to "Other".
 *
 * A child account can be suspended (login + sessions refused) or removed.
 * Children cannot create children and cannot touch the family endpoints.
 * At sign time a child with no card of their own pays with the parent's
 * default card (see server.js) — the ledger records budgets, not receipts.
 *
 * File (under ACCOUNTS_DATA_DIR, default ./data):
 *   family.json   { users: { <uid>: limits+suspended }, ledger: { <uid>: [...] } }
 */

const fs = require("fs");
const path = require("path");
const shopping = require("./shopping"); // canonical categories + domain→category (no cycle)

const DATA_DIR = process.env.ACCOUNTS_DATA_DIR || path.join(__dirname, "data");
const FAMILY_FILE = path.join(DATA_DIR, "family.json");

const MAX_CHILDREN = 10;

class FamilyError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- store plumbing ---------- */

let store = { users: {}, ledger: {} };

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const j = JSON.parse(fs.readFileSync(FAMILY_FILE, "utf8"));
    if (j && typeof j.users === "object") store.users = j.users;
    if (j && typeof j.ledger === "object") store.ledger = j.ledger;
  } catch { /* first boot */ }
}

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function save() { atomicWrite(FAMILY_FILE, store); }

function limitsOf(uid) { return store.users[uid] || null; }

function ensureLimits(uid) {
  if (!store.users[uid]) {
    store.users[uid] = { maxSpendChf: null, monthlyBudgetChf: null, categoryLimits: {}, suspended: false, updatedAt: new Date().toISOString() };
  }
  return store.users[uid];
}

/* ---------- categories (derived from the shopping catalog) ---------- */

/** "2026-09" — ledger periods are UTC calendar months (matches plan-cap style). */
function monthKey(ts) { return new Date(ts || Date.now()).toISOString().slice(0, 7); }

/* ---------- child accounts ---------- */

function childIdsOf(parentId) {
  // The canonical parent→child link lives on the user records (accounts.json).
  const out = [];
  for (const [uid, rec] of Object.entries(store.users)) {
    const u = findUserByIdFn && findUserByIdFn(uid);
    if (rec && u && u.parentId === parentId) out.push(uid);
  }
  return out;
}

function countChildren(parentId) {
  return childIdsOf(parentId).length;
}

/** Bound the module to accounts.findUserById (called once from server.js).
 *  Ownership checks and child listings need to read user records without a
 *  require cycle back into accounts.js. */
let findUserByIdFn = null;
function bindLookup(fn) { findUserByIdFn = fn; }

function assertOwnChild(parent, childId) {
  if (!childId || typeof childId !== "string") throw new FamilyError(400, "childId is required.");
  const child = findUserByIdFn ? findUserByIdFn(childId) : null;
  if (!child || child.parentId !== parent.id) throw new FamilyError(404, "No such child account in your family.");
  return child;
}

/* ---------- limits ---------- */

/** Positive finite CHF amount, or null to clear the limit. */
function normalizeAmount(v, label) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new FamilyError(400, `${label} must be a positive number (or null to remove the limit).`);
  }
  const rounded = Math.round(n * 100) / 100;
  if (rounded > 100000) throw new FamilyError(400, `${label} is unreasonably large (max 100'000).`);
  return rounded;
}

/** Validate + normalize a limits payload without touching stored state.
 *  Semantics: `undefined` = not provided (keep current), null/"" = clear,
 *  positive number = set. */
function normalizeLimitsPayload(body, categories) {
  const known = new Set(categories);
  const out = {};
  out.maxSpendChf = body.maxSpendChf === undefined ? undefined : normalizeAmount(body.maxSpendChf, "maxSpendChf");
  out.monthlyBudgetChf = body.monthlyBudgetChf === undefined ? undefined : normalizeAmount(body.monthlyBudgetChf, "monthlyBudgetChf");
  const raw = body.categoryLimits;
  if (raw === undefined) {
    out.categoryLimits = undefined; // keep current
  } else {
    if (raw === null) {
      out.categoryLimits = {}; // clear all
    } else {
      if (typeof raw !== "object" || Array.isArray(raw)) throw new FamilyError(400, "categoryLimits must be an object of { category: CHF-per-month }.");
      const cl = {};
      for (const [cat, v] of Object.entries(raw)) {
        if (!known.has(cat)) throw new FamilyError(400, `Unknown category '${cat}'. Choose from: ${categories.join(", ")}.`);
        cl[cat] = normalizeAmount(v, `categoryLimits.${cat}`);
        if (cl[cat] === null) delete cl[cat];
      }
      out.categoryLimits = cl;
    }
  }
  return out;
}

function setLimits(parent, childId, payload, categories) {
  const child = assertOwnChild(parent, childId);
  const norm = normalizeLimitsPayload(payload || {}, categories);
  const rec = ensureLimits(child.id);
  if (norm.maxSpendChf !== undefined) rec.maxSpendChf = norm.maxSpendChf;
  if (norm.monthlyBudgetChf !== undefined) rec.monthlyBudgetChf = norm.monthlyBudgetChf;
  if (norm.categoryLimits !== undefined) rec.categoryLimits = norm.categoryLimits;
  rec.updatedAt = new Date().toISOString();
  save();
  return rec;
}

function setSuspended(parent, childId, suspended) {
  const child = assertOwnChild(parent, childId);
  if (typeof suspended !== "boolean") throw new FamilyError(400, "suspended must be true or false.");
  const rec = ensureLimits(child.id);
  rec.suspended = suspended;
  rec.updatedAt = new Date().toISOString();
  save();
  return rec;
}

function isSuspended(uid) {
  const rec = store.users[uid];
  return Boolean(rec && rec.suspended);
}

/* ---------- spend ledger ---------- */

function ledgerOf(uid) { return Array.isArray(store.ledger[uid]) ? store.ledger[uid] : []; }

/** Record one signed policy against the child's month. Prunes anything older
 *  than the previous month so the file stays tiny. */
function recordSpend(uid, { policyId, amountChf, categories, signedAt }) {
  if (!Number.isFinite(amountChf) || amountChf <= 0) return;
  const now = Date.now();
  const keepFrom = monthKey(now - 45 * 86400000); // current + previous month
  const entry = {
    policyId: String(policyId || "").slice(0, 80),
    amountChf: Math.round(amountChf * 100) / 100,
    categories: (Array.isArray(categories) ? categories : []).slice(0, 8),
    signedAt: signedAt || new Date(now).toISOString(),
    month: monthKey(now),
  };
  const list = ledgerOf(uid).filter((e) => e.month === keepFrom || e.month === monthKey(now));
  list.push(entry);
  store.ledger[uid] = list;
  save();
}

function dropLedger(uid) { delete store.ledger[uid]; }

/** Forget a removed child entirely: limits record + spend ledger. */
function dropChild(uid) {
  delete store.users[uid];
  delete store.ledger[uid];
  save();
}

/** Signed-budget totals for the current month. */
function spendSummary(uid) {
  const mk = monthKey();
  const entries = ledgerOf(uid).filter((e) => e.month === mk);
  const byCategory = {};
  let total = 0;
  for (const e of entries) {
    total += e.amountChf;
    for (const c of e.categories.length ? e.categories : ["Other"]) {
      byCategory[c] = Math.round(((byCategory[c] || 0) + e.amountChf) * 100) / 100;
    }
  }
  return { month: mk, totalChf: Math.round(total * 100) / 100, byCategory, orders: entries.length };
}

/** Parent-facing projection for one child. */
function childSummary(child) {
  const rec = limitsOf(child.id) || {};
  const parentUser = child.parentId ? findUserByIdFn(child.parentId) : null;
  return {
    id: child.id,
    name: child.name,
    email: child.email,
    plan: child.plan,
    suspended: isSuspended(child.id),
    limits: {
      maxSpendChf: rec.maxSpendChf ?? null,
      monthlyBudgetChf: rec.monthlyBudgetChf ?? null,
      categoryLimits: rec.categoryLimits || {},
    },
    spend: spendSummary(child.id),
    parentEmail: parentUser ? parentUser.email : null,
    updatedLimitsAt: rec.updatedAt || null,
  };
}

/* ---------- sign-time enforcement ---------- */

/** Which known categories does this policy touch? `policy.category` wins when
 *  it names a known category; otherwise derive from merchant.allowed_domains
 *  via the site catalog. Unknown → "Other". */
function categoriesForPolicy(policy) {
  const known = new Set(shopping.CATEGORIES);
  const explicit = policy && typeof policy.category === "string" && policy.category.trim();
  if (explicit && known.has(explicit)) return [explicit];
  const domains = ((policy && policy.merchant) || {}).allowed_domains;
  if (Array.isArray(domains) && domains.length) {
    const cats = shopping.categoriesForDomains(domains);
    return cats.length ? cats : ["Other"];
  }
  return ["Other"];
}

/** Check a draft policy against a child's parental limits.
 *  Returns { ok: true } or { ok: false, violations: [...] }. A missing
 *  budget.max_total is NOT a violation here — the signer refuses incomplete
 *  policies separately (HTTP 422 `missing`). Accounts without limits
 *  (non-children, or no limits set) always pass. */
function checkParentalLimits(uid, policy) {
  const rec = limitsOf(uid);
  if (!rec) return { ok: true };
  const budget = policy && policy.budget;
  if (!budget || typeof budget.max_total !== "number" || !(budget.max_total > 0)) return { ok: true };
  const amount = budget.max_total;
  const cur = budget.currency || "CHF";
  const violations = [];

  if (rec.maxSpendChf != null && amount > rec.maxSpendChf) {
    violations.push(
      `budget.max_total ${amount} ${cur} exceeds the parental per-order limit of ${rec.maxSpendChf} CHF — a parent must raise it (Account → Family).`
    );
  }

  const summary = spendSummary(uid);
  if (rec.monthlyBudgetChf != null && summary.totalChf + amount > rec.monthlyBudgetChf) {
    const left = Math.max(0, Math.round((rec.monthlyBudgetChf - summary.totalChf) * 100) / 100);
    violations.push(
      `parental monthly budget exceeded: ${summary.totalChf} CHF already signed this month + ${amount} ${cur} would pass ${rec.monthlyBudgetChf} CHF (left: ${left} CHF). Resets on the 1st.`
    );
  }

  const cl = rec.categoryLimits || {};
  const cats = categoriesForPolicy(policy);
  for (const cat of cats) {
    const limit = cl[cat];
    if (limit == null) continue;
    const spent = summary.byCategory[cat] || 0;
    if (spent + amount > limit) {
      const left = Math.max(0, Math.round((limit - spent) * 100) / 100);
      violations.push(
        `parental ${cat} limit exceeded: ${spent} CHF already spent this month + ${amount} ${cur} would pass the ${limit} CHF monthly cap for ${cat} (left: ${left} CHF).`
      );
    }
  }

  return violations.length ? { ok: false, violations } : { ok: true };
}

/* Category vocabulary comes from shopping.js's catalog — no local fallback
 * copy to drift. "Other" covers policies whose shops aren't in the catalog. */

/** Effective per-order ceiling for a child: min(own cap, parental max). */
function effectivePerOrderCap(user, getOwnCap) {
  const rec = limitsOf(user.id);
  const caps = [];
  const own = getOwnCap(user.id);
  if (own != null) caps.push(own);
  if (rec && rec.maxSpendChf != null) caps.push(rec.maxSpendChf);
  if (!caps.length) return null;
  return Math.min(...caps);
}

module.exports = {
  MAX_CHILDREN,
  FamilyError,
  load, save,
  bindLookup, assertOwnChild, childIdsOf, countChildren,
  normalizeAmount, normalizeLimitsPayload, setLimits, setSuspended, isSuspended, limitsOf,
  recordSpend, dropLedger, dropChild, spendSummary, childSummary,
  categoriesForPolicy, checkParentalLimits, effectivePerOrderCap, monthKey,
};
