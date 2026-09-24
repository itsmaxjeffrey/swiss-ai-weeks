#!/usr/bin/env node
/**
 * accounts.js — users, auth sessions, API keys, subscription plans.
 *
 * Zero-dependency JSON-file store for the Viseca Shopper UI bridge.
 *   Passwords   scrypt (random salt, timing-safe compare)
 *   Web login   opaque bearer-ish cookie token; only its SHA-256 is stored
 *   API keys    vsk_<keyid>_<secret>; only SHA-256(secret) is stored
 *   Plans       free / plus / premium → daily message caps (PLANS_JSON overrides)
 *
 * Files (under DATA_DIR, default ./data):
 *   accounts.json       { version, users: [...] }
 *   auth-sessions.json  { sessions: { <sha256(token)>: { userId, expires } } }
 *
 * Stores are tiny; every mutation schedules a debounced atomic save
 * (tmp file + rename).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.ACCOUNTS_DATA_DIR || path.join(__dirname, "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const SESSIONS_FILE = path.join(DATA_DIR, "auth-sessions.json");

const SESSION_COOKIE = "shopper_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PASSWORD_MIN = 8;

/* ---------- subscription plans ---------- */

const DEFAULT_PLANS = {
  free:    { label: "Free",    daily: 10,  price: "CHF 0",     note: "10 messages / day" },
  plus:    { label: "Plus",    daily: 100, price: "CHF 9/mo",  note: "100 messages / day" },
  premium: { label: "Premium", daily: 500, price: "CHF 29/mo", note: "500 messages / day (fair use)" },
};

/** PLANS_JSON env merges over the defaults: '{"free":{"daily":2}}' */
function loadPlans() {
  const plans = JSON.parse(JSON.stringify(DEFAULT_PLANS));
  const raw = process.env.PLANS_JSON;
  if (raw) {
    try {
      const patch = JSON.parse(raw);
      for (const [k, v] of Object.entries(patch)) {
        plans[k] = Object.assign(plans[k] || { label: k, price: "—", note: "" }, v);
      }
    } catch (e) {
      throw new Error(`PLANS_JSON is not valid JSON: ${e.message}`);
    }
  }
  return plans;
}
const PLANS = loadPlans();
const PLAN_IDS = Object.keys(PLANS);

const REGISTRATION_OPEN = process.env.REGISTRATION_OPEN !== "false";

/* ---------- demo account (pitch/testing) ---------- */

const DEMO_ENABLED = process.env.DEMO_MODE !== "false";
const DEMO_EMAIL = (process.env.DEMO_EMAIL || "demo@pixerful.com").toLowerCase();
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "demo-viseca-2026";
const DEMO_PLAN = process.env.DEMO_PLAN || "plus";

/* ---------- helpers ---------- */

function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function b64url(buf) { return Buffer.from(buf).toString("base64url"); }
function newId(prefix) { return `${prefix}_${crypto.randomBytes(4).toString("hex")}`; }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    const candidate = crypto.scryptSync(String(password), salt, 32);
    return crypto.timingSafeEqual(candidate, Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC day is fine for caps
}

/* ---------- store plumbing ---------- */

let users = [];
let sessions = {}; // sha256(token) -> { userId, expires }

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(ACCOUNTS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
      users = Array.isArray(parsed.users) ? parsed.users : [];
    } catch (e) {
      console.error(`[accounts] could not parse ${ACCOUNTS_FILE}: ${e.message}`);
      users = [];
    }
  }
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")).sessions || {};
    } catch {
      sessions = {};
    }
  }
}

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(flushSync, 400);
}

function flushSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    atomicWrite(ACCOUNTS_FILE, { version: 1, users });
    atomicWrite(SESSIONS_FILE, { sessions });
  } catch (e) {
    console.error(`[accounts] save failed: ${e.message}`);
  }
}
const saveNow = flushSync;

/* flush on exit so a pending 400ms debounce cannot lose a final mutation */
process.on("exit", () => { if (saveTimer) flushSync(); });

function findUser(id) { return users.find((u) => u.id === id) || null; }
function findUserByEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  return users.find((u) => u.email === norm) || null;
}

class ApiError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}

/* ---------- registration / login ---------- */

function createUser({ email, password, name }) {
  if (!REGISTRATION_OPEN) throw new ApiError(403, "Registration is currently closed.");
  const norm = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) throw new ApiError(400, "Please provide a valid email address.");
  if (!password || String(password).length < PASSWORD_MIN) {
    throw new ApiError(400, `Password must be at least ${PASSWORD_MIN} characters.`);
  }
  if (findUserByEmail(norm)) throw new ApiError(409, "An account with this email already exists — sign in instead.");
  const { salt, hash } = hashPassword(password);
  const id = newId("u");
  const user = {
    id,
    sid: `${id.replace("u_", "")}`, // agent session-key suffix
    email: norm,
    name: String(name || "").trim().slice(0, 60) || norm.split("@")[0],
    salt,
    hash,
    plan: "free",
    created: Date.now(),
    usage: {},
    apiKeys: [],
  };
  users.push(user);
  saveSoon();
  return user;
}

function verifyLogin(email, password) {
  const user = findUserByEmail(email);
  if (!user || !verifyPassword(password, user.salt, user.hash)) return null;
  return user;
}

/* ---------- web session cookies ---------- */

function createSession(userId) {
  const token = b64url(crypto.randomBytes(32));
  sessions[sha256(token)] = { userId, expires: Date.now() + SESSION_TTL_MS };
  saveSoon();
  return token;
}

function destroySession(token) {
  if (token && sessions[sha256(token)]) { delete sessions[sha256(token)]; saveSoon(); }
}

function pruneSessions() {
  const now = Date.now();
  let dirty = false;
  for (const [h, s] of Object.entries(sessions)) {
    if (!s || s.expires < now) { delete sessions[h]; dirty = true; }
  }
  if (dirty) saveSoon();
}

function userBySessionToken(token) {
  if (!token) return null;
  const rec = sessions[sha256(token)];
  if (!rec || rec.expires < Date.now()) return null;
  return findUser(rec.userId);
}

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
      catch { out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
    }
  });
  return out;
}

function sessionCookieHeader(token, secure) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
}
function clearedSessionCookieHeader(secure) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

/* ---------- API keys (external surfaces: ChatGPT, Claude, OpenClaw) ---------- */

function createApiKey(userId, name) {
  const user = findUser(userId);
  if (!user) throw new ApiError(404, "No such user.");
  const keyId = crypto.randomBytes(4).toString("hex");
  const secret = b64url(crypto.randomBytes(24));
  const rec = { id: keyId, name: String(name || "").trim().slice(0, 40) || "api key", hash: sha256(secret), created: Date.now(), lastUsed: null, revoked: false };
  user.apiKeys.push(rec);
  saveSoon();
  return { key: `vsk_${keyId}_${secret}`, record: rec };
}

function userByApiKey(rawKey) {
  const m = /^vsk_([0-9a-f]{8})_([A-Za-z0-9_-]+)$/.exec(String(rawKey || "").trim());
  if (!m) return null;
  const [, keyId, secret] = m;
  for (const user of users) {
    const rec = (user.apiKeys || []).find((k) => k.id === keyId && !k.revoked);
    if (rec && crypto.timingSafeEqual(Buffer.from(rec.hash, "hex"), Buffer.from(sha256(secret), "hex"))) {
      rec.lastUsed = Date.now();
      saveSoon();
      return { user, key: rec };
    }
  }
  return null;
}

function revokeApiKey(userId, keyId) {
  const user = findUser(userId);
  const rec = user && (user.apiKeys || []).find((k) => k.id === keyId && !k.revoked);
  if (!rec) return false;
  rec.revoked = true;
  saveSoon();
  return true;
}

/* ---------- plans & usage ---------- */

function setPlan(userId, plan) {
  const user = findUser(userId);
  if (!user) throw new ApiError(404, "No such user.");
  if (!PLANS[plan]) throw new ApiError(400, `Unknown plan '${plan}'. Choose one of: ${PLAN_IDS.join(", ")}.`);
  user.plan = plan;
  saveSoon();
  return user;
}

/** Count one message against the plan's daily cap. */
function countMessage(userId) {
  const user = findUser(userId);
  if (!user) throw new ApiError(401, "Not signed in.");
  const plan = PLANS[user.plan] || PLANS.free;
  const today = todayKey();
  if (user.usage[today] === undefined) {
    user.usage = { [today]: 0 }; // drop old days
  }
  if (user.usage[today] >= plan.daily) {
    return { ok: false, used: user.usage[today], limit: plan.daily, plan };
  }
  user.usage[today] += 1;
  saveSoon();
  return { ok: true, used: user.usage[today], limit: plan.daily, plan };
}

function usageInfo(user) {
  const plan = PLANS[user.plan] || PLANS.free;
  const used = user.usage[todayKey()] || 0;
  return { plan: user.plan, planLabel: plan.label, used, limit: plan.daily, remaining: Math.max(0, plan.daily - used) };
}

/** Seed (once) and return the demo account. Returns null when demo mode is
 *  disabled. On first creation also mints an API key and logs the full value
 *  once — grab it from the server log for the ChatGPT/skill demos. */
function ensureDemoAccount() {
  if (!DEMO_ENABLED) return null;
  if (!PLANS[DEMO_PLAN]) throw new Error(`DEMO_PLAN '${DEMO_PLAN}' is not a known plan.`);
  let user = findUserByEmail(DEMO_EMAIL);
  const created = !user;
  if (created) {
    user = createUser({ email: DEMO_EMAIL, password: DEMO_PASSWORD, name: "Demo Shopper" });
  }
  user.demo = true;
  user.plan = DEMO_PLAN;
  let seeded = null;
  if (created) {
    seeded = createApiKey(user.id, "demo seed");
    console.log(`[accounts] demo account ready: ${DEMO_EMAIL} · plan ${DEMO_PLAN} · seeded API key: ${seeded.key}`);
  }
  saveSoon();
  return { created, user, apiKey: seeded ? seeded.key : null };
}

/** Login for POST /api/auth/demo — null when demo mode is off. */
function demoLogin() {
  if (!DEMO_ENABLED) return null;
  return verifyLogin(DEMO_EMAIL, DEMO_PASSWORD);
}

/** Safe projection of a user for the client. */
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    planLabel: (PLANS[user.plan] || PLANS.free).label,
    isDemo: Boolean(user.demo),
    usage: usageInfo(user),
    created: user.created,
    apiKeys: (user.apiKeys || [])
      .filter((k) => !k.revoked)
      .map((k) => ({ id: k.id, name: k.name, created: k.created, lastUsed: k.lastUsed, masked: `vsk_${k.id}_…` })),
  };
}

module.exports = {
  ApiError,
  PLANS, PLAN_IDS, REGISTRATION_OPEN,
  DEMO_ENABLED, DEMO_EMAIL, DEMO_PLAN,
  SESSION_COOKIE,
  load, pruneSessions, ensureDemoAccount, demoLogin,
  createUser, verifyLogin,
  createSession, destroySession, userBySessionToken,
  parseCookies, sessionCookieHeader, clearedSessionCookieHeader,
  createApiKey, userByApiKey, revokeApiKey,
  setPlan, countMessage, usageInfo, publicUser,
};
