#!/usr/bin/env node
/**
 * Viseca Shopper UI — bridge server
 *
 * Zero-dependency Node HTTP server that:
 *   1. serves the static UI from ./public
 *   2. proxies chat messages to the viseca-shopper OpenClaw agent via the
 *      Gateway CLI:  openclaw agent --agent <id> --session-key <key> --json -m <msg>
 *   3. multi-user: registration/login (scrypt + cookie sessions), per-user agent
 *      sessions, subscription plans with daily message caps  (accounts.js)
 *   4. external surfaces: bearer API keys, POST /api/v1/chat (plain JSON for
 *      ChatGPT Actions & skills), /.well-known/ai-plugin.json + /openapi.json
 *   5. persistence: per-user chat history (GET/DELETE /api/history) survives
 *      reloads; signed order policies are mapped to accounts and listed via
 *      GET /api/policies with receipt status
*   6. shopping controls (shopping.js): per-account spend cap, website
*      whitelist, Visa/Mastercard vault. Enforced at /api/policy/sign; the
*      chosen card is filed as policies/<id>.payment.json for the agent.
 *
 * Config (env):
 *   PORT                  default 8794
 *   HOST                  default 127.0.0.1
 *   OPENCLAW_AGENT        default viseca-shopper
 *   OPENCLAW_SESSION      default webui   (base; users get <base>-u<id>)
 *   OPENCLAW_BIN          default openclaw
 *   OPENCLAW_TIMEOUT_MS   default 600000
 *   AGENT_MAX_CONCURRENT  default 2       (global agent-turn slots across users)
 *   PUBLIC_BASE_URL       default derived (x-forwarded-proto/host) — plugin manifest
 *   REGISTRATION_OPEN     default true ("false" closes signup)
 *   PLANS_JSON            optional override of plan caps, e.g. '{"free":{"daily":2}}'
 *   ACCOUNTS_DATA_DIR     default ./data
*   OPENCLAW_MODEL        optional model override passed as --model to every agent turn
 */

const http = require("http");
const { spawn, spawnSync, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const accounts = require("./accounts");
const shopping = require("./shopping");
const family = require("./family");

const PORT = parseInt(process.env.PORT || "8794", 10);
const HOST = process.env.HOST || "127.0.0.1";
const AGENT = process.env.OPENCLAW_AGENT || "viseca-shopper";
const SESSION = process.env.OPENCLAW_SESSION || "webui";
const BIN = process.env.OPENCLAW_BIN || "openclaw";
const MODEL = (process.env.OPENCLAW_MODEL || "").trim();
const TIMEOUT_MS = parseInt(process.env.OPENCLAW_TIMEOUT_MS || "600000", 10);
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.AGENT_MAX_CONCURRENT || "2", 10));
const PUBLIC_DIR = path.join(__dirname, "public");

/* Order Policy Gate — the bridge is the trusted signing authority.
 * The Ed25519 PRIVATE key lives HERE (outside the agent workspace); the agent
 * only ever gets the public key, so it can verify but never forge a policy.
 * See viseca-shopper/scripts/policy.js. */
const AGENT_WS = process.env.POLICY_AGENT_WS || "/home/coffee/.openclaw/workspace/viseca-shopper";
const POLICY_SCRIPT = process.env.POLICY_SCRIPT || path.join(AGENT_WS, "scripts", "policy.js");
const POLICY_DIR = process.env.POLICY_DIR || path.join(AGENT_WS, "policies");
const POLICY_PUB_OUT = process.env.POLICY_PUB_OUT || path.join(AGENT_WS, "keys", "policy-authority.public.pem");
const POLICY_KEYS_DIR = process.env.POLICY_KEYS_DIR || path.join(__dirname, "keys");
const POLICY_PRIV_KEY = path.join(POLICY_KEYS_DIR, "policy-authority.private.pem");

/* per-user chat history (survives reloads) + policy→account ownership map */
const DATA_DIR = process.env.ACCOUNTS_DATA_DIR || path.join(__dirname, "data");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const POLICY_OWNERS_FILE = path.join(DATA_DIR, "policy-owners.json");
const HISTORY_CAP = 100;

function ensurePolicyKeys() {
  fs.mkdirSync(POLICY_KEYS_DIR, { recursive: true });
  if (!fs.existsSync(POLICY_PRIV_KEY)) {
    const r = spawnSync(process.execPath, [POLICY_SCRIPT, "init-keys", "--dir", POLICY_KEYS_DIR, "--pubout", POLICY_PUB_OUT], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`policy key init failed: ${(r.stderr || r.stdout || "").slice(-300)}`);
    console.log(`[policy] generated new Ed25519 authority keypair -> ${POLICY_KEYS_DIR} (private key mode 0600)`);
  }
  fs.mkdirSync(path.dirname(POLICY_PUB_OUT), { recursive: true });
  fs.copyFileSync(path.join(POLICY_KEYS_DIR, "policy-authority.public.pem"), POLICY_PUB_OUT);
  const pubPem = fs.readFileSync(path.join(POLICY_KEYS_DIR, "policy-authority.public.pem"), "utf8");
  return { fingerprint: crypto.createHash("sha256").update(pubPem).digest("hex").slice(0, 16) };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

/* one agent turn at a time per user session; global cap across users */
const userInFlight = new Map(); // userId -> promise
let activeTurns = 0;

function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  }, extraHeaders || {}));
  res.end(body);
}

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http")).toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${PORT}`).toString().split(",")[0].trim();
  return `${proto}://${host}`;
}

function isSecure(req) {
  return (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim() === "https" || Boolean(req.socket.encrypted);
}

/* ---------- auth glue ---------- */

/** Resolve the requesting user: cookie session, Bearer API key, or Bearer
 *  session token (browsers block cookies outright in some embedded contexts —
 *  the UI keeps its token in localStorage and sends it as a Bearer header). */
function authenticate(req) {
  const via = (user, v, extra) => {
    // A child suspended by its parent loses ALL authenticated access —
    // sessions and API keys alike. Login explains why (403).
    if (family.isSuspended(user.id)) return null;
    return Object.assign({ user, via: v }, extra || {});
  };
  const cookies = accounts.parseCookies(req.headers.cookie);
  const viaCookie = accounts.userBySessionToken(cookies[accounts.SESSION_COOKIE]);
  if (viaCookie) return via(viaCookie, "session");
  const authz = req.headers.authorization || "";
  if (/^Bearer\s+/i.test(authz)) {
    const raw = authz.replace(/^Bearer\s+/i, "").trim();
    const hit = accounts.userByApiKey(raw);
    if (hit) return via(hit.user, "apikey", { key: hit.key });
    const sess = accounts.userBySessionToken(raw);
    if (sess) return via(sess, "session");
  }
  return null;
}

function readBody(req, limitKB) {
  return new Promise((resolve, reject) => {
    let body = "";
    let oversize = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limitKB * 1024) { oversize = true; req.destroy(); }
    });
    req.on("end", () => (oversize ? reject(new Error("oversize")) : resolve(body)));
    req.on("error", reject);
  });
}

async function readJsonBody(req, limitKB) {
  const raw = await readBody(req, limitKB);
  if (raw === undefined) throw new Error("oversize");
  try { return JSON.parse(raw || "{}"); } catch { return null; }
}

/** Recursively find the first value under `key` in a parsed JSON object. */
function findKey(node, key) {
  if (!node || typeof node !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(node, key) && typeof node[key] === "string") {
    return node[key];
  }
  for (const v of Object.values(node)) {
    const hit = findKey(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Recursively collect diagnostic fields (stopReason, errorMessage, …) from a
 *  CLI result payload so failures can be explained instead of swallowed. */
function findDiagnostics(node, acc = {}) {
  if (!node || typeof node !== "object") return acc;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string") {
      if (k === "stopReason" && !acc.stopReason) acc.stopReason = v;
      else if (k === "errorMessage" && !acc.errorMessage) acc.errorMessage = v;
      else if (k === "livenessState" && !acc.livenessState) acc.livenessState = v;
    } else if (v && typeof v === "object") {
      findDiagnostics(v, acc);
    }
  }
  return acc;
}

/** Structured agent-turn failure so the runner can decide on retries. */
function turnError(kind, message, detail) {
  const err = new Error(message);
  err.kind = kind; // "timeout" | "no-json" | "no-reply" | "launch"
  err.detail = detail || "";
  return err;
}

/** Run one agent turn through the Gateway CLI and resolve the reply text. */
function agentTurn(message, sessionKey, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const args = [
      "agent",
      "--agent", AGENT,
      "--session-key", sessionKey,
      "--json",
      "-m", message,
    ];
    if (MODEL) args.push("--model", MODEL);
    const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(turnError("timeout", `Agent turn timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(turnError("launch", `Failed to launch ${BIN}: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const start = stdout.indexOf("{");
      const end = stdout.lastIndexOf("}");
      if (start === -1 || end === -1 || end <= start) {
        return reject(turnError(
          "no-json",
          `Agent returned no JSON (exit ${code}). ${stderr.slice(-400).trim()}`
        ));
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.slice(start, end + 1));
      } catch (e) {
        return reject(turnError("no-json", `Unparseable agent JSON: ${e.message}`));
      }
      const reply =
        findKey(parsed, "finalAssistantVisibleText") ||
        findKey(parsed, "finalAssistantRawText");
      if (!reply) {
        // The run finished (or aborted) without visible text — usually a
        // provider timeout aborting the run mid-task. Surface WHY.
        const diag = findDiagnostics(parsed);
        const bits = [
          diag.stopReason && `stop=${diag.stopReason}`,
          diag.errorMessage,
        ].filter(Boolean).join(" · ");
        return reject(turnError("no-reply", "Agent JSON contained no reply text.", bits));
      }
      resolve(reply);
    });
  });
}

// Retry budget stays under the UI client's 630s abort timer.
const OVERALL_BUDGET_MS = Math.min(TIMEOUT_MS, 590000);
const CONTINUE_NUDGE =
  "\n\n(System note: your previous attempt at this request was cut off before you produced a reply. Continue from where you left off and give your final answer now — do not restart the research from scratch.)";

/** One agent turn with a single budget-aware retry when the run died without
 *  a reply. The session keeps the partial work, so a continuation nudge lets
 *  the agent finish cheaply instead of redoing the whole task. */
async function turnWithRetry(message, sessionKey) {
  const deadline = Date.now() + OVERALL_BUDGET_MS;
  try {
    return await agentTurn(message, sessionKey, OVERALL_BUDGET_MS);
  } catch (err) {
    const left = deadline - Date.now();
    if (err.kind === "no-reply" && left > 90000) {
      console.log(`[chat] retry after no-reply (${err.detail || "no detail"}); ${Math.round(left / 1000)}s left`);
      return await agentTurn(message + CONTINUE_NUDGE, sessionKey, left);
    }
    throw err;
  }
}

/** Map structured turn failures to a message a shopper can act on. */
function friendlyTurnError(err) {
  if (err && err.kind === "timeout") {
    return "This task ran longer than the bridge allows without finishing. The shopper may still complete it in the background — try a smaller ask, or ask a follow-up in a minute.";
  }
  if (err && err.kind === "no-reply") {
    const why = err.detail ? ` (reason: ${err.detail})` : "";
    return `The shopper's run was cut off before it produced a reply${why}. Your conversation history is kept — send the request again and it will pick up where it left off.`;
  }
  return `The shopper could not complete the request: ${(err && err.message) || "unknown error"}`;
}

/** Validate + sign via scripts/policy.js, then file the signed envelope as
 *  policies/<policy_id>.signed.json in the agent workspace. The script itself
 *  REFUSES incomplete policies (exit 4) — that is the no-missing-data rule. */
function signPolicy(policy, res, user) {
  /* Shopping controls first: spend cap + website whitelist (see shopping.js).
   * Violations are a different refusal than incompleteness — they carry
   * `violations` (the customer must change settings or the budget), while the
   * signer's own exit-4 refusal carries `missing` (the agent must ask). */
  const chk = shopping.checkPolicyAgainstSettings(user.id, policy);
  if (!chk.ok) {
    console.log(`[policy] sign REFUSED (shopping settings) user=${user.email}: ${chk.violations.join(" | ")}`);
    return sendJson(res, 422, {
      ok: false,
      error: "The authority refused to sign — the policy conflicts with your shopping settings.",
      violations: chk.violations,
      missing: [],
    });
  }
  /* Parental controls next (family.js): per-order max spend, monthly budget,
   * category limits. Same 422 + violations shape — the child sees exactly why. */
  const pchk = family.checkParentalLimits(user.id, policy);
  if (!pchk.ok) {
    console.log(`[policy] sign REFUSED (parental limits) user=${user.email}: ${pchk.violations.join(" | ")}`);
    return sendJson(res, 422, {
      ok: false,
      error: "The authority refused to sign — the policy exceeds the parental limits on this account.",
      violations: pchk.violations,
      missing: [],
    });
  }
  const tmpIn = path.join(os.tmpdir(), `policy-in-${process.pid}-${Date.now()}.json`);
  const tmpOut = `${tmpIn}.signed`;
  fs.writeFileSync(tmpIn, JSON.stringify(policy, null, 2));
  try {
    const r = spawnSync(process.execPath, [POLICY_SCRIPT, "sign", "--file", tmpIn, "--key", POLICY_PRIV_KEY, "--out", tmpOut], { encoding: "utf8" });
    const stdout = r.stdout || "";
    let payload = null;
    try { payload = JSON.parse(stdout.slice(stdout.indexOf("{"))); } catch { /* fall through */ }
    if (r.status === 0 && payload && payload.ok) {
      const env = JSON.parse(fs.readFileSync(tmpOut, "utf8"));
      fs.mkdirSync(POLICY_DIR, { recursive: true });
      const finalPath = path.join(POLICY_DIR, `${env.policy.policy_id}.signed.json`);
      fs.copyFileSync(tmpOut, finalPath);
      payload.signed_path = finalPath;
      recordPolicyOwner(env.policy.policy_id, user);
      /* Ledger: children's signed budgets count against their monthly limits. */
      if (user.parentId) {
        family.recordSpend(user.id, {
          policyId: env.policy.policy_id,
          amountChf: env.policy.budget && env.policy.budget.max_total,
          categories: family.categoriesForPolicy(env.policy),
        });
      }
      /* A child with no card of their own pays with the family card. */
      const payerUid = paymentPayerUid(user);
      const payer = accounts.findUserById(payerUid) || user;
      const method = shopping.pickMethod(payerUid, env.policy && env.policy.payment && env.policy.payment.method);
      shopping.writePaymentFile(
        POLICY_DIR,
        env.policy.policy_id,
        method,
        payerUid !== user.id ? `No card on this child account — paid with the family card of ${payer.email}.` : undefined
      );
      payload.payment = { card_on_file: Boolean(method), brand: method ? method.brand : null, last4: method ? method.last4 : null, family_card: payerUid !== user.id };
      console.log(`[policy] SIGNED ${env.policy.policy_id} (fingerprint ${payload.signed_by}) -> ${finalPath}`);
      return sendJson(res, 200, payload);
    }
    console.log(`[policy] sign REFUSED (exit ${r.status})`);
    return sendJson(res, r.status === 4 ? 422 : 500,
      payload || { ok: false, error: (r.stderr || "sign failed").slice(-400) });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message });
  } finally {
    fs.rmSync(tmpIn, { force: true });
    fs.rmSync(tmpOut, { force: true });
  }
}

/** Snapshot of one agent session from the local store (status, tokens). */
function sessionSnapshot(sessionKey) {
  return new Promise((resolve) => {
    execFile(
      BIN,
      ["sessions", "--json", "--active", "3", "--agent", AGENT],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const parsed = JSON.parse(stdout);
          const entry = (parsed.sessions || []).find(
            (s) => s.key === `agent:${AGENT}:${sessionKey}`
          );
          resolve(entry || null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

/* ---------- chat history (per user, survives reloads) ---------- */

const historyPath = (userId) => path.join(HISTORY_DIR, `${userId}.json`);

function loadHistory(userId) {
  try {
    const j = JSON.parse(fs.readFileSync(historyPath(userId), "utf8"));
    return Array.isArray(j.messages) ? j.messages : [];
  } catch {
    return [];
  }
}

/** Synchronous small-file writes keep user/agent pairs ordered. */
function appendHistory(userId, role, text) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const messages = loadHistory(userId);
    messages.push({ role, text, ts: new Date().toISOString() });
    fs.writeFileSync(
      historyPath(userId),
      JSON.stringify({ updated: new Date().toISOString(), messages: messages.slice(-HISTORY_CAP) })
    );
  } catch (e) {
    console.log(`[history] append failed: ${e.message}`);
  }
}

/* ---------- policy → account ownership (for GET /api/policies) ---------- */

function loadPolicyOwners() {
  try { return JSON.parse(fs.readFileSync(POLICY_OWNERS_FILE, "utf8")); } catch { return {}; }
}

function recordPolicyOwner(policyId, user) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const owners = loadPolicyOwners();
    owners[policyId] = { userId: user.id, email: user.email, recordedAt: new Date().toISOString() };
    fs.writeFileSync(POLICY_OWNERS_FILE, JSON.stringify(owners, null, 2));
  } catch (e) {
    console.log(`[policy] owner mapping failed: ${e.message}`);
  }
}

/** Which account's card vault pays for this user's orders? The user's own
 *  vault — except a child with no card of their own pays with the parent's
 *  default card ("family card"). */
function paymentPayerUid(user) {
  if (!user.parentId) return user.id;
  if (shopping.listMethods(user.id).length) return user.id;
  const parent = accounts.findUserById(user.parentId);
  return parent && shopping.listMethods(parent.id).length ? parent.id : user.id;
}

/** publicUser plus, for children, a read-only view of the parental limits
 *  that govern them (shown in their Account sheet and enforced at sign time). */
function publicUserView(user) {
  const u = accounts.publicUser(user);
  if (user.parentId) {
    const rec = family.limitsOf(user.id) || {};
    const parent = accounts.findUserById(user.parentId);
    u.family = {
      parentId: user.parentId,
      parentEmail: parent ? parent.email : null,
      maxSpendChf: rec.maxSpendChf ?? null,
      monthlyBudgetChf: rec.monthlyBudgetChf ?? null,
      categoryLimits: rec.categoryLimits || {},
      spend: family.spendSummary(user.id),
    };
  }
  return u;
}

/** A policy signed before the customer added any card carries a payment file
 *  with card:null. When a card arrives, re-file instruments for the account's
 *  still-unpaid policies — and for its children's, whose payer is the family
 *  card — so nobody has to re-sign. */
function backfillPaymentFiles(user) {
  const owners = loadPolicyOwners();
  const targets = [user, ...accounts.childrenOf(user.id)];
  for (const target of targets) {
    const payerUid = paymentPayerUid(target);
    for (const [pid, owner] of Object.entries(owners)) {
      if (owner.userId !== target.id) continue;
      const signedPath = path.join(POLICY_DIR, `${pid}.signed.json`);
      const payPath = path.join(POLICY_DIR, `${pid}.payment.json`);
      if (!fs.existsSync(signedPath) || fs.existsSync(path.join(POLICY_DIR, `${pid}.receipt.json`))) continue;
      try {
        const cur = JSON.parse(fs.readFileSync(payPath, "utf8"));
        if (cur && cur.card) continue;
        const env = JSON.parse(fs.readFileSync(signedPath, "utf8"));
        const method = shopping.pickMethod(payerUid, env.policy && env.policy.payment && env.policy.payment.method);
        if (method) {
          shopping.writePaymentFile(
            POLICY_DIR,
            pid,
            method,
            payerUid !== target.id ? `No card on this child account — paid with the family card of ${user.email}.` : undefined
          );
          console.log(`[policy] payment card backfilled -> ${pid} (${method.brand} ••${method.last4}${payerUid !== target.id ? " · family card" : ""})`);
        }
      } catch { /* signed envelope unreadable — leave it alone */ }
    }
  }
}

/** Card status for GET /api/policies rows (masked — never full numbers). */
function paymentStatusFor(policyId) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(POLICY_DIR, `${policyId}.payment.json`), "utf8"));
    return raw.card
      ? { card_on_file: true, brand: raw.card.brand, last4: raw.card.last4 }
      : { card_on_file: false, note: raw.note ? "no card on file" : null };
  } catch {
    return { card_on_file: false };
  }
}

/* ---------- chat: shared turn runner (SSE for the UI, JSON for /api/v1) ---------- */

const userSessionKey = (user) => `${SESSION}-u${user.sid}`;

async function runChatTurn(req, res, user, message, mode) {
  // one turn at a time per user (their agent session is sequential)
  if (userInFlight.has(user.id)) {
    return sendJson(res, 409, { error: "Your previous message is still being answered — one turn at a time." }, { "Retry-After": "20" });
  }
  // global agent capacity
  if (activeTurns >= MAX_CONCURRENT) {
    return sendJson(res, 503, { error: "All agent slots are busy right now — please try again in a moment." }, { "Retry-After": "30" });
  }
  // plan limit
  const quota = accounts.countMessage(user.id);
  if (!quota.ok) {
    return sendJson(res, 429, {
      error: `Daily limit reached on the ${quota.plan.label} plan (${quota.plan.daily} messages/day). Upgrade in Account to continue.`,
      plan: user.plan, used: quota.used, limit: quota.limit,
    });
  }
  const usage = accounts.usageInfo(user);

  const started = Date.now();
  const sessionKey = userSessionKey(user);
  console.log(`[chat] turn start  (${message.length} chars) user=${user.email} session=${sessionKey} mode=${mode}`);
  appendHistory(user.id, "user", message);

  const turn = (async () => {
    activeTurns += 1;
    try {
      return await turnWithRetry(message, sessionKey);
    } finally {
      activeTurns -= 1;
    }
  })();
  userInFlight.set(user.id, turn);

  if (mode === "sse") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    const send = (obj) => {
      try {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch { /* client gone — the turn still completes server-side */ }
    };
    send({ type: "start", agent: AGENT, session: sessionKey });

    const poll = setInterval(() => {
      sessionSnapshot(sessionKey).then((snap) => {
        if (!snap) return;
        send({
          type: "progress",
          status: snap.status,
          totalTokens: snap.totalTokens,
          updatedAt: snap.updatedAt,
          model: snap.model,
          elapsedMs: Date.now() - started,
        });
      });
    }, 4000);

    turn
      .then((reply) => {
        console.log(`[chat] turn done    in ${((Date.now() - started) / 1000).toFixed(1)}s (${reply.length} chars back) user=${user.email}`);
        appendHistory(user.id, "agent", reply);
        send({ type: "done", reply, agent: AGENT, session: sessionKey });
      })
      .catch((err) => {
        console.log(`[chat] turn FAILED  after ${((Date.now() - started) / 1000).toFixed(1)}s: ${err.message} user=${user.email}`);
        const friendly = friendlyTurnError(err);
        appendHistory(user.id, "error", friendly);
        send({ type: "error", error: friendly });
      })
      .finally(() => {
        clearInterval(poll);
        res.end();
        userInFlight.delete(user.id);
      });
    return;
  }

  // plain JSON (ChatGPT Actions / skills cannot consume SSE)
  try {
    const reply = await turn;
    console.log(`[chat] turn done    in ${((Date.now() - started) / 1000).toFixed(1)}s (${reply.length} chars back) user=${user.email}`);
    appendHistory(user.id, "agent", reply);
    sendJson(res, 200, { reply, agent: AGENT, session: sessionKey, usage });
  } catch (err) {
    console.log(`[chat] turn FAILED  after ${((Date.now() - started) / 1000).toFixed(1)}s: ${err.message} user=${user.email}`);
    const friendly = friendlyTurnError(err);
    appendHistory(user.id, "error", friendly);
    sendJson(res, 502, { error: friendly });
  } finally {
    userInFlight.delete(user.id);
  }
}

/* ---------- plugin manifest + OpenAPI (ChatGPT plugin / GPT Action) ---------- */

function aiPluginManifest(base) {
  return {
    schema_version: "v1",
    name_for_human: "Viseca Shopper",
    name_for_model: "viseca_shopper",
    description_for_human: "Your Swiss personal shopping concierge — find products, compare prices, and plan purchases across Swiss online shops.",
    description_for_model: [
      "Personal shopping concierge for Swiss online shops backed by a live agent.",
      "Relay the user's shopping request VERBATIM via sendChatMessage (finding products, comparing prices across shops, planning purchases, hunting deals, order policies).",
      "The agent browses real shops; a reply can take several minutes — keep waiting, do not invent answers.",
      "Relay the final reply verbatim (it is markdown with product links).",
      "On HTTP 409 the user's previous turn is still running — retry after 30s. On 429 the daily plan limit is exhausted — point the user to the account page to upgrade.",
    ].join(" "),
    auth: { type: "service_http", authorization_type: "bearer" },
    api: { type: "openapi", url: `${base}/openapi.json`, is_user_authenticated: false },
    logo_url: `${base}/logo.svg`,
    contact_email: "concierge@pixerful.com",
    legal_info_url: `${base}/`,
  };
}

function openApiSpec(base) {
  const replySchema = {
    type: "object",
    properties: {
      reply: { type: "string", description: "The concierge's answer, markdown with links. Relay verbatim." },
      agent: { type: "string" },
      session: { type: "string" },
      usage: {
        type: "object",
        properties: {
          plan: { type: "string" }, planLabel: { type: "string" },
          used: { type: "integer" }, limit: { type: "integer" }, remaining: { type: "integer" },
        },
      },
    },
    required: ["reply"],
  };
  const err = (desc) => ({
    type: "object",
    properties: { error: { type: "string", description: desc } },
    required: ["error"],
  });
  return {
    openapi: "3.0.3",
    info: {
      title: "Viseca Shopper API",
      version: "1.0.0",
      description: "Swiss personal shopping concierge. Send the user's shopping request in `message`; the live agent browses Swiss shops and answers in markdown (can take minutes). Bearer auth with a Viseca Shopper API key (Account → API keys).",
    },
    servers: [{ url: base }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/chat": {
        post: {
          operationId: "sendChatMessage",
          summary: "Send a shopping request to the concierge",
          description: "One conversational turn with the live shopping agent. May take minutes. 409 = previous turn still running (retry later); 429 = daily plan limit reached.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { message: { type: "string", description: "The user's shopping request, verbatim." } },
                  required: ["message"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Concierge reply", content: { "application/json": { schema: replySchema } } },
            "401": { description: "Missing/invalid API key", content: { "application/json": { schema: err("why auth failed") } } },
            "409": { description: "A turn is already in flight for this account", content: { "application/json": { schema: err("why busy") } } },
            "429": { description: "Daily message limit for the plan reached", content: { "application/json": { schema: err("limit info") } } },
            "502": { description: "The agent turn failed", content: { "application/json": { schema: err("failure reason") } } },
          },
        },
      },
      "/api/v1/account": {
        get: {
          operationId: "getAccount",
          summary: "Show plan and daily usage for the calling key",
          responses: {
            "200": {
              description: "Account summary",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      email: { type: "string" },
                      plan: { type: "string" },
                      planLabel: { type: "string" },
                      usage: {
                        type: "object",
                        properties: { used: { type: "integer" }, limit: { type: "integer" }, remaining: { type: "integer" } },
                      },
                    },
                  },
                },
              },
            },
            "401": { description: "Missing/invalid API key", content: { "application/json": { schema: err("why auth failed") } } },
          },
        },
      },
    },
  };
}

/* ---------- server ---------- */

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(`[http] ${req.method} ${req.url} -> ${e.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal bridge error." });
    else try { res.end(); } catch { /* client already gone */ }
  });
});

async function handle(req, res) {
  const pathname = new URL(req.url, "http://x").pathname;

  /* ----- public discovery endpoints ----- */

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      agent: AGENT,
      session: SESSION,
      bridge: "openclaw-cli",
      busy: activeTurns >= MAX_CONCURRENT,
      activeTurns,
      maxConcurrent: MAX_CONCURRENT,
      auth: true,
      registrationOpen: accounts.REGISTRATION_OPEN,
      plans: accounts.PLANS,
      policy: {
        authority_fingerprint: AUTH ? AUTH.fingerprint : null,
        policy_dir: POLICY_DIR,
      },
      shopping: { spendCap: true, whitelist: true, cardVault: true },
      family: { parentalControls: true, maxChildren: accounts.MAX_CHILDREN },
    });
  }

  if (req.method === "GET" && pathname === "/.well-known/ai-plugin.json") {
    return sendJson(res, 200, aiPluginManifest(baseUrl(req)));
  }

  if (req.method === "GET" && pathname === "/openapi.json") {
    return sendJson(res, 200, openApiSpec(baseUrl(req)));
  }

  /* ----- auth ----- */

  if (req.method === "POST" && pathname === "/api/auth/register") {
    const body = await readJsonBody(req, 16).catch(() => null);
    if (body === null) return sendJson(res, 413, { error: "Payload too large." });
    let user;
    try {
      user = accounts.createUser({ email: body.email, password: body.password, name: body.name });
    } catch (e) {
      const status = e.status || 500;
      return sendJson(res, status, { error: e.message });
    }
    const token = accounts.createSession(user.id);
    res.setHeader("Set-Cookie", accounts.sessionCookieHeader(token, isSecure(req)));
    console.log(`[auth] registered ${user.email}`);
    return sendJson(res, 201, { ok: true, user: publicUserView(user), session: token });
  }

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const body = await readJsonBody(req, 16).catch(() => null);
    if (body === null) return sendJson(res, 413, { error: "Payload too large." });
    const user = accounts.verifyLogin(body.email, body.password);
    if (!user) {
      console.log(`[auth] FAILED login ${String(body.email || "").slice(0, 80)}`);
      return sendJson(res, 401, { error: "Wrong email or password." });
    }
    if (family.isSuspended(user.id)) {
      console.log(`[auth] BLOCKED login (suspended by parent) ${user.email}`);
      return sendJson(res, 403, { error: "This account is suspended by its parent — ask your parent to unsuspend it (Account → Family)." });
    }
    const token = accounts.createSession(user.id);
    res.setHeader("Set-Cookie", accounts.sessionCookieHeader(token, isSecure(req)));
    console.log(`[auth] login ${user.email}`);
    return sendJson(res, 200, { ok: true, user: publicUserView(user), session: token });
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const cookies = accounts.parseCookies(req.headers.cookie);
    accounts.destroySession(cookies[accounts.SESSION_COOKIE]);
    res.setHeader("Set-Cookie", accounts.clearedSessionCookieHeader(isSecure(req)));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/api/auth/me") {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: "Not signed in." });
    return sendJson(res, 200, { ok: true, user: publicUserView(auth.user), via: auth.via });
  }

  /* ----- account management (session or key auth) ----- */

  if (pathname.startsWith("/api/account") || pathname.startsWith("/api/v1/")) {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in or send a Bearer API key (Account → API keys)." });

    if (req.method === "GET" && (pathname === "/api/v1/account" || pathname === "/api/account")) {
      const u = accounts.publicUser(auth.user);
      return sendJson(res, 200, { ok: true, email: u.email, name: u.name, plan: u.plan, planLabel: u.planLabel, usage: u.usage });
    }

    if (req.method === "POST" && pathname === "/api/account/plan") {
      const body = await readJsonBody(req, 4).catch(() => null);
      if (body === null) return sendJson(res, 413, { error: "Payload too large." });
      try {
        accounts.setPlan(auth.user.id, body.plan);
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
      console.log(`[account] ${auth.user.email} switched plan -> ${body.plan}${auth.via === "session" ? "" : " (demo: billing not wired)"}`);
      return sendJson(res, 200, { ok: true, user: publicUserView(auth.user) });
    }

    if (pathname === "/api/account/keys" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, keys: accounts.publicUser(auth.user).apiKeys });
    }

    if (pathname === "/api/account/keys" && req.method === "POST") {
      const body = await readJsonBody(req, 4).catch(() => null);
      if (body === null) return sendJson(res, 413, { error: "Payload too large." });
      const { key, record } = accounts.createApiKey(auth.user.id, body.name);
      console.log(`[account] API key created for ${auth.user.email} (${record.name})`);
      // the only time the full key is ever returned
      return sendJson(res, 201, { ok: true, key, record: { id: record.id, name: record.name, created: record.created, masked: `vsk_${record.id}_…` } });
    }

    if (pathname === "/api/account/keys/revoke" && req.method === "POST") {
      const body = await readJsonBody(req, 4).catch(() => null);
      if (body === null) return sendJson(res, 413, { error: "Payload too large." });
      const ok = accounts.revokeApiKey(auth.user.id, String(body.id || ""));
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "No such key." });
    }

    /* ----- shopping controls: spend cap, website whitelist, card vault ----- */

    if (pathname === "/api/account/shopping" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        spendCapChf: shopping.getSpendCap(auth.user.id),
        whitelist: shopping.getWhitelist(auth.user.id),
        methods: shopping.listMethods(auth.user.id),
        unrestricted: {
          cap: shopping.getSpendCap(auth.user.id) == null,
          whitelist: shopping.getWhitelist(auth.user.id).length === 0,
        },
      });
    }

    if (pathname === "/api/account/shopping/cap" && req.method === "PUT") {
      const body = await readJsonBody(req, 4).catch(() => null);
      if (body === null) return sendJson(res, 413, { error: "Payload too large." });
      try {
        const cap = shopping.setSpendCap(auth.user.id, body.capChf === undefined ? null : body.capChf);
        console.log(`[shopping] ${auth.user.email} spend cap -> ${cap == null ? "none" : `${cap} CHF`}`);
        return sendJson(res, 200, { ok: true, spendCapChf: cap });
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
    }

    if (pathname === "/api/account/shopping/whitelist" && req.method === "POST") {
      const body = await readJsonBody(req, 4).catch(() => null);
      if (body === null) return sendJson(res, 413, { error: "Payload too large." });
      try {
        const out = shopping.addWhitelist(auth.user.id, body.domain);
        console.log(`[shopping] ${auth.user.email} whitelist +${out.added}${out.already ? " (already covered)" : ""}`);
        return sendJson(res, out.already ? 200 : 201, { ok: true, ...out });
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
    }

    if (pathname === "/api/account/shopping/whitelist/remove" && req.method === "POST") {
      const body = await readJsonBody(req, 4).catch(() => null);
      if (body === null) return sendJson(res, 413, { error: "Payload too large." });
      try {
        const out = shopping.removeWhitelist(auth.user.id, body.domain);
        return sendJson(res, 200, { ok: true, ...out });
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
    }

    if (pathname === "/api/account/shopping/sites" && req.method === "GET") {
      const q = new URL(req.url, "http://x").searchParams.get("q") || "";
      try {
        const results = await shopping.searchSites(q);
        return sendJson(res, 200, { ok: true, query: q, results });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    if (pathname === "/api/account/shopping/methods" && req.method === "POST") {
      const body = await readJsonBody(req, 4).catch(() => null);
      if (body === null) return sendJson(res, 413, { error: "Payload too large." });
      try {
        const { record } = shopping.addMethod(auth.user.id, body);
        console.log(`[shopping] ${auth.user.email} card saved: ${record.brand} ••${record.last4}`);
        backfillPaymentFiles(auth.user);
        return sendJson(res, 201, { ok: true, method: record });
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
    }

    if (pathname === "/api/account/shopping/methods/default" && req.method === "POST") {
      const body = await readJsonBody(req, 4).catch(() => null);
      if (body === null) return sendJson(res, 413, { error: "Payload too large." });
      const ok = shopping.setDefaultMethod(auth.user.id, String(body.id || ""));
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true, methods: shopping.listMethods(auth.user.id) } : { error: "No such card." });
    }

    if (pathname === "/api/account/shopping/methods/delete" && req.method === "POST") {
      const body = await readJsonBody(req, 4).catch(() => null);
      if (body === null) return sendJson(res, 413, { error: "Payload too large." });
      const ok = shopping.deleteMethod(auth.user.id, String(body.id || ""));
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true, methods: shopping.listMethods(auth.user.id) } : { error: "No such card." });
    }

    /* ----- family: parental controls (parent accounts only) ----- */

    if (pathname.startsWith("/api/account/family")) {
      if (auth.user.parentId) {
        return sendJson(res, 403, { error: "Only parent accounts manage the family." });
      }

      if (req.method === "GET" && pathname === "/api/account/family") {
        const children = accounts.childrenOf(auth.user.id).map((c) => family.childSummary(c));
        return sendJson(res, 200, {
          ok: true,
          categories: shopping.CATEGORIES,
          maxChildren: accounts.MAX_CHILDREN,
          children,
        });
      }

      if (req.method === "POST" && pathname === "/api/account/family/children") {
        const body = await readJsonBody(req, 4).catch(() => null);
        if (body === null) return sendJson(res, 413, { error: "Payload too large." });
        let child;
        try {
          child = accounts.createChildAccount(auth.user.id, { name: body.name, email: body.email, password: body.password });
        } catch (e) {
          return sendJson(res, e.status || 500, { error: e.message });
        }
        console.log(`[family] ${auth.user.email} created child account ${child.email}`);
        return sendJson(res, 201, { ok: true, child: family.childSummary(child) });
      }

      if (req.method === "POST" && pathname === "/api/account/family/limits") {
        const body = await readJsonBody(req, 4).catch(() => null);
        if (body === null) return sendJson(res, 413, { error: "Payload too large." });
        const childId = String(body.childId || "");
        try {
          const child = family.assertOwnChild(auth.user, childId);
          family.setLimits(auth.user, childId, body, shopping.CATEGORIES);
          console.log(`[family] ${auth.user.email} updated limits for ${child.email}`);
          return sendJson(res, 200, { ok: true, child: family.childSummary(child) });
        } catch (e) {
          return sendJson(res, e.status || 500, { error: e.message });
        }
      }

      if (req.method === "POST" && pathname === "/api/account/family/suspend") {
        const body = await readJsonBody(req, 4).catch(() => null);
        if (body === null) return sendJson(res, 413, { error: "Payload too large." });
        const childId = String(body.childId || "");
        try {
          const child = family.assertOwnChild(auth.user, childId);
          const suspended = body.suspended === true;
          family.setSuspended(auth.user, childId, suspended);
          console.log(`[family] ${auth.user.email} ${suspended ? "suspended" : "unsuspended"} ${child.email}`);
          return sendJson(res, 200, { ok: true, child: family.childSummary(child) });
        } catch (e) {
          return sendJson(res, e.status || 500, { error: e.message });
        }
      }

      if (req.method === "POST" && pathname === "/api/account/family/remove") {
        const body = await readJsonBody(req, 4).catch(() => null);
        if (body === null) return sendJson(res, 413, { error: "Payload too large." });
        const childId = String(body.childId || "");
        try {
          const child = family.assertOwnChild(auth.user, childId);
          accounts.deleteChildAccount(auth.user.id, childId);
          family.dropChild(childId);
          console.log(`[family] ${auth.user.email} removed child account ${child.email}`);
          return sendJson(res, 200, { ok: true, removed: child.email });
        } catch (e) {
          return sendJson(res, e.status || 500, { error: e.message });
        }
      }
    }
  }

  /* ----- chat ----- */

  if (req.method === "POST" && (pathname === "/api/chat" || pathname === "/api/v1/chat")) {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in or send a Bearer API key (Account → API keys)." });

    let body;
    try {
      body = await readJsonBody(req, 32);
    } catch {
      return sendJson(res, 413, { error: "Message too large (32 KB limit)." });
    }
    if (body === null) return sendJson(res, 400, { error: "Invalid JSON body." });
    const { message } = body;
    if (!message || typeof message !== "string" || !message.trim()) {
      return sendJson(res, 400, { error: "Field 'message' is required." });
    }
    return runChatTurn(req, res, auth.user, message.trim(), pathname === "/api/chat" ? "sse" : "json");
  }

  /* ----- chat history (reload-safe conversation view) ----- */

  if (pathname === "/api/history") {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in." });
    if (req.method === "GET") {
      return sendJson(res, 200, { ok: true, messages: loadHistory(auth.user.id) });
    }
    if (req.method === "DELETE") {
      fs.rmSync(historyPath(auth.user.id), { force: true });
      console.log(`[history] cleared for ${auth.user.email}`);
      return sendJson(res, 200, { ok: true });
    }
  }

  /* ----- signed policies for this account ----- */

  if (req.method === "GET" && pathname === "/api/policies") {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in." });
    const owners = loadPolicyOwners();
    const policies = [];
    for (const [pid, owner] of Object.entries(owners)) {
      if (owner.userId !== auth.user.id) continue;
      try {
        const env = JSON.parse(fs.readFileSync(path.join(POLICY_DIR, `${pid}.signed.json`), "utf8"));
        const p = env.policy || {};
        let receipt = null;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(POLICY_DIR, `${pid}.receipt.json`), "utf8"));
          receipt = {
            filed_at: raw.filed_at || raw.recorded_at || raw.created_at || null,
            total: raw.total ?? raw.amount ?? null,
            shop: raw.shop || raw.merchant || null,
          };
        } catch { /* receipt not filed yet */ }
        policies.push({
          policy_id: p.policy_id || pid,
          request: p.request || "",
          budget: p.budget || null,
          timing: p.timing || null,
          items: p.items || [],
          signed_at: env.signed_at || owner.recordedAt,
          signed_by: env.signed_by || null,
          receipt,
          payment: paymentStatusFor(pid),
        });
      } catch {
        policies.push({ policy_id: pid, request: "(policy file missing)", items: [], budget: null, timing: null, signed_at: owner.recordedAt, signed_by: null, receipt: null, missing: true });
      }
    }
    policies.sort((a, b) => String(b.signed_at).localeCompare(String(a.signed_at)));
    return sendJson(res, 200, { ok: true, policies });
  }

  /* ----- policy gate (signing authority — signed-in users only) ----- */

  if (req.method === "GET" && pathname === "/api/policy/pubkey") {
    return sendJson(res, 200, {
      ok: true,
      fingerprint: AUTH ? AUTH.fingerprint : null,
      public_key_pem: fs.readFileSync(path.join(POLICY_KEYS_DIR, "policy-authority.public.pem"), "utf8"),
      agent_public_key: POLICY_PUB_OUT,
      note: "agent verifies with this key; only this bridge holds the signing key",
    });
  }

  if (req.method === "POST" && pathname === "/api/policy/sign") {
    const auth = authenticate(req);
    if (!auth || auth.via !== "session") {
      return sendJson(res, 401, { error: "Policies can only be signed by a signed-in customer in the web UI." });
    }
    let body;
    try {
      body = await readJsonBody(req, 64);
    } catch {
      return sendJson(res, 413, { error: "Policy too large (64 KB limit)." });
    }
    if (body === null) return sendJson(res, 400, { error: "Invalid JSON body." });
    const { policy } = body;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      return sendJson(res, 400, { error: "Field 'policy' must be an object." });
    }
    return signPolicy(policy, res, auth.user);
  }

  serveStatic(req, res);
}

let AUTH = null;
try {
  AUTH = ensurePolicyKeys();
  console.log(`[policy] authority ready · fingerprint ${AUTH.fingerprint} · agent pubkey ${POLICY_PUB_OUT}`);
} catch (e) {
  console.error(`[policy] FATAL: ${e.message}`);
  process.exit(1);
}

accounts.load();
accounts.pruneSessions();
accounts.ensureDemoAccount();
accounts.ensureDummyAccount();
shopping.load();
family.bindLookup(accounts.findUserById);
family.load();

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`[viseca-shopper-ui] serving ${PUBLIC_DIR}`);
  console.log(`[viseca-shopper-ui] ${url}  →  agent '${AGENT}' (base session key: ${SESSION})`);
  console.log(`[viseca-shopper-ui] multi-user on · plans: ${Object.keys(accounts.PLANS).join("/")} · registration ${accounts.REGISTRATION_OPEN ? "open" : "closed"} · agent slots: ${MAX_CONCURRENT}`);
});
