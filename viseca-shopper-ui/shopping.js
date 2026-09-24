#!/usr/bin/env node
/**
 * shopping.js — per-account shopping controls for the Viseca Shopper bridge.
 *
 * Zero-dependency companion to accounts.js. Three account-level controls:
 *
 *   1. Spend cap        budget.max_total of any signed policy must be ≤ cap
 *   2. Website whitelist  policy.merchant.allowed_domains must sit inside the
 *                         whitelist (exact or subdomain match). An empty
 *                         whitelist means "not restricted yet".
 *   3. Payment methods   Visa / Mastercard cards in a local vault. The API
 *                         NEVER returns full card data — only brand + last4.
 *                         At sign time the bridge files the instrument for a
 *                         policy as policies/<policy_id>.payment.json in the
 *                         agent workspace (gitignored) so the agent can pay
 *                         at checkout without card numbers ever passing
 *                         through the model context.
 *
 * Files (under ACCOUNTS_DATA_DIR, default ./data):
 *   shopping.json   { users: { <uid>: { spendCapChf, whitelist, updatedAt } } }
 *   vault.json      { users: { <uid>: { methods: [...] } } }   (chmod 0600)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.ACCOUNTS_DATA_DIR || path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "shopping.json");
const VAULT_FILE = path.join(DATA_DIR, "vault.json");

const CARD_BRANDS = ["visa", "mastercard"];

/* ---------- site catalog (curated; web search enriches on top) ---------- */

const CATALOG = [
  // food delivery
  { domain: "ubereats.com", name: "Uber Eats", category: "Food delivery" },
  { domain: "justeat.ch", name: "Just Eat Switzerland", category: "Food delivery" },
  { domain: "smood.ch", name: "Smood", category: "Food delivery" },
  { domain: "deliveroo.ch", name: "Deliveroo", category: "Food delivery" },
  { domain: "pizza-hut.ch", name: "Pizza Hut CH", category: "Food delivery" },
  { domain: "mcdonalds.ch", name: "McDonald's CH", category: "Food delivery" },
  { domain: "dominos.ch", name: "Domino's Pizza CH", category: "Food delivery" },
  { domain: "lieferando.ch", name: "Lieferando", category: "Food delivery" },
  // groceries
  { domain: "migros.ch", name: "Migros Online", category: "Groceries" },
  { domain: "coop.ch", name: "Coop.ch", category: "Groceries" },
  { domain: "aldi-suisse.ch", name: "Aldi Suisse", category: "Groceries" },
  { domain: "lidl.ch", name: "Lidl Switzerland", category: "Groceries" },
  { domain: "volg.ch", name: "Volg Online", category: "Groceries" },
  { domain: "farmy.ch", name: "Farmy", category: "Groceries" },
  // electronics / general
  { domain: "digitec.ch", name: "Digitec", category: "Electronics" },
  { domain: "galaxus.ch", name: "Galaxus", category: "Marketplace" },
  { domain: "brack.ch", name: "Brack.ch", category: "Electronics" },
  { domain: "interdiscount.ch", name: "Interdiscount", category: "Electronics" },
  { domain: "microspot.ch", name: "Microspot", category: "Electronics" },
  { domain: "fust.ch", name: "Fust", category: "Electronics" },
  { domain: "melectronics.ch", name: "melectronics", category: "Electronics" },
  { domain: "manor.ch", name: "Manor", category: "Department store" },
  { domain: "jumbo.ch", name: "Jumbo", category: "DIY" },
  { domain: "hornbach.ch", name: "Hornbach", category: "DIY" },
  { domain: "oto.ch", name: "Oto.ch (Sconto)", category: "DIY" },
  // fashion
  { domain: "zalando.ch", name: "Zalando CH", category: "Fashion" },
  { domain: "aboutyou.ch", name: "About You", category: "Fashion" },
  { domain: "hm.com", name: "H&M", category: "Fashion" },
  { domain: "zara.com", name: "Zara", category: "Fashion" },
  { domain: "uniqlo.com", name: "Uniqlo", category: "Fashion" },
  { domain: "snoooze.ch", name: "Snoooze", category: "Fashion" },
  // marketplaces / intl
  { domain: "ricardo.ch", name: "Ricardo", category: "Marketplace" },
  { domain: "ebay.ch", name: "eBay.ch", category: "Marketplace" },
  { domain: "amazon.de", name: "Amazon.de", category: "Marketplace" },
  { domain: "aliexpress.com", name: "AliExpress", category: "Marketplace" },
  { domain: "temu.com", name: "Temu", category: "Marketplace" },
  { domain: "shein.com", name: "SHEIN", category: "Fashion" },
  { domain: "etsy.com", name: "Etsy", category: "Marketplace" },
  // pharmacy / drugstore
  { domain: "zurrose.ch", name: "Zur Rose", category: "Pharmacy" },
  { domain: "shop-apotheke.ch", name: "Shop Apotheke CH", category: "Pharmacy" },
  { domain: "dm.ch", name: "dm drogerie", category: "Drugstore" },
  // books / misc
  { domain: "exlibris.ch", name: "Ex Libris", category: "Books" },
  { domain: "orellfuessli.ch", name: "Orell Füssli", category: "Books" },
  { domain: "dds.ch", name: "DDS (Deutscher Buchdienst)", category: "Books" },
];

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** Unique category list from the catalog — the vocabulary for parental
 *  category limits (family.js) and the site-search chips. */
const CATEGORIES = [...new Set(CATALOG.map((e) => e.category))].sort();

/* Web enrichment for the site search — off with SHOPPING_WEB_SEARCH=0 (tests,
 * air-gapped hosts). Catalog always answers regardless. */
const WEB_SEARCH = process.env.SHOPPING_WEB_SEARCH !== "0";

class ShoppingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- store plumbing ---------- */

let settings = { users: {} }; // uid -> { spendCapChf, whitelist, updatedAt }
let vault = { users: {} };    // uid -> { methods: [...] }

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (j && typeof j.users === "object") settings = j;
  } catch { /* first boot */ }
  try {
    const j = JSON.parse(fs.readFileSync(VAULT_FILE, "utf8"));
    if (j && typeof j.users === "object") vault = j;
  } catch { /* first boot */ }
}

function atomicWrite(file, obj, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (mode) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function saveSettings() { atomicWrite(SETTINGS_FILE, settings); }
function saveVault() { atomicWrite(VAULT_FILE, vault, 0o600); }

function userSettings(uid) {
  if (!settings.users[uid]) {
    settings.users[uid] = { spendCapChf: null, whitelist: [], updatedAt: new Date().toISOString() };
    saveSettings();
  }
  return settings.users[uid];
}

function userVault(uid) {
  if (!vault.users[uid]) {
    vault.users[uid] = { methods: [] };
    saveVault();
  }
  return vault.users[uid];
}

/* ---------- spend cap ---------- */

function getSpendCap(uid) { return userSettings(uid).spendCapChf; }

function setSpendCap(uid, capChf) {
  let cap = capChf;
  if (cap !== null && cap !== undefined && cap !== "") {
    cap = Number(capChf);
    if (!Number.isFinite(cap) || cap <= 0) throw new ShoppingError(400, "capChf must be a positive number (or null to remove the cap).");
    cap = Math.round(cap * 100) / 100;
    if (cap > 100000) throw new ShoppingError(400, "capChf is unreasonably large (max 100'000).");
  } else {
    cap = null;
  }
  const s = userSettings(uid);
  s.spendCapChf = cap;
  s.updatedAt = new Date().toISOString();
  saveSettings();
  return cap;
}

/* ---------- website whitelist ---------- */

/** Normalize arbitrary user/agent input to a bare registrable-ish domain:
 *  "https://www.ubereats.com/ch/en/" -> "ubereats.com". Throws 400 on junk. */
function normalizeDomain(raw) {
  let d = String(raw || "").trim().toLowerCase();
  if (!d) throw new ShoppingError(400, "Domain is required.");
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  d = d.split("/")[0].split("?")[0].split("#")[0];
  d = d.replace(/:\d+$/, ""); // port
  if (d.startsWith("www.")) d = d.slice(4);
  if (!DOMAIN_RE.test(d)) throw new ShoppingError(400, `'${String(raw).slice(0, 80)}' is not a valid website domain (e.g. ubereats.com).`);
  if (d.length > 253) throw new ShoppingError(400, "Domain too long.");
  return d;
}

function getWhitelist(uid) { return userSettings(uid).whitelist.slice(); }

function addWhitelist(uid, rawDomain) {
  const d = normalizeDomain(rawDomain);
  const s = userSettings(uid);
  // also accept when the user adds a subdomain of something already listed
  if (s.whitelist.some((w) => d === w || d.endsWith(`.${w}`))) {
    return { whitelist: getWhitelist(uid), added: d, already: true };
  }
  // a broader domain already covering the new entry? keep both — the user asked
  // for this site explicitly; dedupe only exact/narrower duplicates
  s.whitelist.push(d);
  s.whitelist.sort();
  s.updatedAt = new Date().toISOString();
  saveSettings();
  return { whitelist: getWhitelist(uid), added: d, already: false };
}

function removeWhitelist(uid, rawDomain) {
  const d = normalizeDomain(rawDomain);
  const s = userSettings(uid);
  const before = s.whitelist.length;
  s.whitelist = s.whitelist.filter((w) => w !== d);
  s.updatedAt = new Date().toISOString();
  saveSettings();
  return { whitelist: getWhitelist(uid), removed: before - s.whitelist.length };
}

/** Is `domain` covered by the whitelist? Exact or subdomain of an entry. */
function whitelisted(list, domain) {
  return list.some((w) => domain === w || domain.endsWith(`.${w}`));
}

/** Map merchant domains to catalog categories — how a policy gets its
 *  categories for parental limits. Unknown domains are skipped by the caller
 *  (family.js maps them to "Other"). Subdomains count (food.ubereats.com →
 *  Food delivery). */
function categoriesForDomains(domains) {
  const cats = [];
  for (const raw of domains || []) {
    let d;
    try { d = normalizeDomain(raw); } catch { continue; }
    const hit = CATALOG.find((e) => d === e.domain || d.endsWith(`.${e.domain}`));
    if (hit && !cats.includes(hit.category)) cats.push(hit.category);
  }
  return cats;
}

/* ---------- site search (catalog + best-effort web) ---------- */

const searchCache = new Map(); // q -> { ts, results }
const SEARCH_TTL_MS = 10 * 60 * 1000;

function catalogSearch(q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return [];
  return CATALOG.filter((e) =>
    e.domain.includes(needle) || e.name.toLowerCase().includes(needle) || e.category.toLowerCase().includes(needle)
  ).map((e) => ({ domain: e.domain, name: e.name, category: e.category, source: "catalog" }));
}

/** Best-effort DuckDuckGo HTML lookup — never throws, adds domains the catalog
 *  misses. 4s timeout; silently empty on any failure (proxy/bot wall). */
async function webSearchDomains(q) {
  if (!WEB_SEARCH) return [];
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${q} online shop`)}`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 viseca-shopper-ui" },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return [];
    const html = await r.text();
    const hosts = new Map();
    const re = /uddg=([^"&]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      let u;
      try { u = decodeURIComponent(m[1]); } catch { continue; }
      try {
        const h = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
        if (DOMAIN_RE.test(h) && !/(duckduckgo|ddg)\./.test(h)) hosts.set(h, h);
      } catch { continue; }
      if (hosts.size >= 12) break;
    }
    return [...hosts.keys()].map((h) => ({ domain: h, name: h, category: "web result", source: "web" }));
  } catch {
    return [];
  }
}

async function searchSites(q) {
  const needle = String(q || "").trim();
  if (needle.length < 2) return [];
  const key = needle.toLowerCase();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.ts < SEARCH_TTL_MS) return cached.results;
  let results = catalogSearch(needle);
  if (results.length < 5) {
    const web = await webSearchDomains(needle);
    const seen = new Set(results.map((r) => r.domain));
    for (const w of web) {
      if (!seen.has(w.domain)) { results.push(w); seen.add(w.domain); }
    }
  }
  results = results.slice(0, 12);
  searchCache.set(key, { ts: Date.now(), results });
  return results;
}

/* ---------- payment methods (vault) ---------- */

function luhn(num) {
  const digits = num.replace(/[\s-]/g, "");
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function detectBrand(num) {
  const n = num.replace(/[\s-]/g, "");
  if (/^4\d{12,18}$/.test(n)) return "visa";
  if (/^(5[1-5]\d{14}|2[2-7]\d{14})$/.test(n)) return "mastercard";
  return null;
}

function normalizeExp(raw) {
  const m = /^(0?[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})$/.exec(String(raw || "").trim());
  if (!m) return null;
  const mm = String(Number(m[1])).padStart(2, "0");
  let yy = m[2];
  if (yy.length === 4) yy = yy.slice(2);
  const exp = `${mm}/${yy}`;
  const [y, mo] = [2000 + Number(yy), Number(mm)];
  const endOfMonth = new Date(y, mo, 1) - 1; // last millisecond of expiry month
  if (endOfMonth < Date.now()) return null;
  return exp;
}

function listMethods(uid) {
  return userVault(uid).methods.map(maskedMethod);
}

function maskedMethod(m) {
  return { id: m.id, brand: m.brand, last4: m.last4, holder: m.holder, exp: m.exp, isDefault: Boolean(m.isDefault), created: m.created };
}

function addMethod(uid, { holder, number, exp, cvc }) {
  const h = String(holder || "").trim();
  if (h.length < 3 || h.length > 80) throw new ShoppingError(400, "Cardholder name is required.");
  const digits = String(number || "").replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(digits)) throw new ShoppingError(400, "Card number must be 12–19 digits.");
  if (!luhn(digits)) throw new ShoppingError(400, "That card number fails the checksum (Luhn) test — please re-check it.");
  const brand = detectBrand(digits);
  if (!brand) throw new ShoppingError(400, "Only Visa or Mastercard are supported.");
  const expOk = normalizeExp(exp);
  if (!expOk) throw new ShoppingError(400, "Expiry must be a future date in MM/YY format.");
  const cvcOk = String(cvc || "").trim();
  if (!/^\d{3,4}$/.test(cvcOk)) throw new ShoppingError(400, "CVC must be 3–4 digits.");
  const mv = userVault(uid);
  if (mv.methods.some((m) => m.number === digits)) throw new ShoppingError(409, "That card is already saved.");
  const rec = {
    id: `pm_${crypto.randomBytes(4).toString("hex")}`,
    brand,
    last4: digits.slice(-4),
    holder: h,
    exp: expOk,
    cvc: cvcOk,
    number: digits,
    isDefault: mv.methods.length === 0,
    created: new Date().toISOString(),
  };
  mv.methods.push(rec);
  saveVault();
  return { record: maskedMethod(rec), method: rec };
}

function deleteMethod(uid, id) {
  const mv = userVault(uid);
  const i = mv.methods.findIndex((m) => m.id === id);
  if (i === -1) return false;
  mv.methods.splice(i, 1);
  if (mv.methods.length && !mv.methods.some((m) => m.isDefault)) mv.methods[0].isDefault = true;
  saveVault();
  return true;
}

function setDefaultMethod(uid, id) {
  const mv = userVault(uid);
  const hit = mv.methods.find((m) => m.id === id);
  if (!hit) return false;
  mv.methods.forEach((m) => { m.isDefault = m.id === id; });
  saveVault();
  return true;
}

/** Pick the instrument for a policy: brand hinted by policy.payment.method
 *  ("mastercard gold", "visa") wins over the default; else default; else null. */
function pickMethod(uid, hint) {
  const mv = userVault(uid);
  if (!mv.methods.length) return null;
  const h = String(hint || "").toLowerCase();
  if (h) {
    const byBrand = mv.methods.find((m) => h.includes(m.brand === "mastercard" ? "master" : m.brand));
    if (byBrand) return byBrand;
  }
  return mv.methods.find((m) => m.isDefault) || mv.methods[0];
}

/* ---------- policy enforcement (sign-time) ---------- */

/** Check a draft policy against the account's spend cap and whitelist.
 *  Returns { ok: true } or { ok: false, violations: [ "...", ... ] }. */
function checkPolicyAgainstSettings(uid, policy) {
  const s = userSettings(uid);
  const violations = [];
  const budget = policy && policy.budget;
  if (s.spendCapChf != null && budget && typeof budget.max_total === "number" && budget.max_total > s.spendCapChf) {
    violations.push(
      `budget.max_total ${budget.max_total} ${budget.currency || "CHF"} exceeds your spending cap of ${s.spendCapChf} CHF — raise the cap in Account → Shopping, or lower the budget.`
    );
  }
  const wl = s.whitelist;
  if (wl.length) {
    const domains = ((policy && policy.merchant) || {}).allowed_domains;
    if (!Array.isArray(domains) || domains.length === 0) {
      violations.push(
        "merchant.allowed_domains is required: your website whitelist is active, so the policy must name the shop domain(s) it will buy from."
      );
    } else {
      const bad = domains.filter((d) => {
        try { return !whitelisted(wl, normalizeDomain(d)); } catch { return true; }
      });
      if (bad.length) {
        violations.push(
          `merchant.allowed_domains not whitelisted: ${bad.join(", ")}. Add ${bad.length === 1 ? "it" : "them"} under Account → Shopping → Whitelisted websites first.`
        );
      }
    }
  }
  return violations.length ? { ok: false, violations } : { ok: true };
}

/* ---------- payment handoff to the agent workspace ---------- */

/** File the instrument for one signed policy. The agent reads this file at the
 *  payment phase — card data never travels through the model context. */
function writePaymentFile(policyDir, policyId, method, extraNote) {
  const body = {
    policy_id: policyId,
    filed_at: new Date().toISOString(),
    source: "account card vault (bridge)",
    instruction: method
      ? "Use exactly this card for checkout of this order only. Never echo the full number, CVC, or expiry into the chat or the receipt — refer to it as brand + last4."
      : "No card on file. Do NOT ask the customer for card details in chat; tell them to add a Visa/Mastercard under Account → Shopping in the web UI, then try the payment phase again.",
    card: method
      ? { brand: method.brand, last4: method.last4, holder: method.holder, exp: method.exp, number: method.number, cvc: method.cvc }
      : null,
    note: extraNote || null,
  };
  fs.mkdirSync(policyDir, { recursive: true });
  const p = path.join(policyDir, `${policyId}.payment.json`);
  fs.writeFileSync(p, JSON.stringify(body, null, 2));
  return p;
}

module.exports = {
  CARD_BRANDS,
  CATEGORIES,
  ShoppingError,
  load,
  getSpendCap, setSpendCap,
  getWhitelist, addWhitelist, removeWhitelist, normalizeDomain, whitelisted, categoriesForDomains,
  searchSites,
  listMethods, addMethod, deleteMethod, setDefaultMethod, pickMethod, maskedMethod,
  checkPolicyAgainstSettings,
  writePaymentFile,
};
