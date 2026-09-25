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
const walletReview = require("./wallet-review");
const { agentTimeoutSeconds, classifyFailure, turnSafetyNote } = require("./turn-reliability");

const PORT = parseInt(process.env.PORT || "8794", 10);
const HOST = process.env.HOST || "127.0.0.1";
const AGENT = process.env.OPENCLAW_AGENT || "viseca-shopper";
const SESSION = process.env.OPENCLAW_SESSION || "webui";
const BIN = process.env.OPENCLAW_BIN || "openclaw";
const MODEL = (process.env.OPENCLAW_MODEL || "").trim();
const TIMEOUT_MS = parseInt(process.env.OPENCLAW_TIMEOUT_MS || "600000", 10);
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.AGENT_MAX_CONCURRENT || "2", 10));
const PUBLIC_DIR = path.join(__dirname, "public");

/* wallet-control → bridge whitelist sync: when a customer approves a purchase
 * with "trust merchant" in the wallet UI, wallet-control mirrors the domain
 * into this bridge's per-account whitelist via POST /api/internal/shopping/
 * whitelist. Both processes run on 127.0.0.1; the shared secret keeps the
 * endpoint unusable by anything else. Unset => endpoint answers 404 (off). */
const SHOPPING_SYNC_TOKEN = (process.env.SHOPPING_SYNC_TOKEN || "").trim();

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
const userProcs = new Map();    // userId -> child process of the running turn (for stop)
const stoppedTurns = new Set(); // userId -> turn was stopped by the customer
let activeTurns = 0;

/* ---------- per-turn process timing ---------- */

/** One timing record per in-flight chat turn: ordered stage marks plus an
 *  optional live listener (SSE) so the UI sees stages as they happen. */
const turnStageLogs = new Map(); // userId -> { marks: [], onStage: fn|null, activityToken }
const activityTokens = new Map(); // per-turn token -> userId (agent activity reports)
const ACTIVITY_MAX = 40; // trail entries kept per turn

/** System note appended to the shopper's prompt so it reports progress steps
 *  live; the token scopes reports to exactly this turn. The customer reads
 *  every label verbatim, so labels must name the real query or domain. */
function activityNote(token) {
  return "\n\n(System: the customer watches a LIVE checklist while you work — your labels appear verbatim on their screen. Within your first tool calls, report the plan; after that, EVERY time you START a step, immediately run exactly:\n" +
    `curl -s --noproxy '*' -X POST http://127.0.0.1:${PORT}/api/chat/activity -H "X-Activity-Token: ${token}" -H "Content-Type: application/json" -d '{"label":"..."}'\n` +
    "Required labels, always with the REAL query or domain: plan → \"Plan: search Swiss shops, compare prices, order\"; every web search → \"Searching the web for <actual query>\"; every site you open → \"Visiting <domain>\"; reading offers → \"Reading <domain> results\"; comparing → \"Comparing prices: <domain1> vs <domain2>\"; cart/checkout → \"Checking out at <domain>\"; policy → \"Preparing your order policy\"; payment → \"Filing payment\". One curl per step, the moment it starts — never batch, never invent domains.)";
}

/** Record one agent-reported activity step for the in-flight turn. */
function recordActivity(userId, label) {
  const log = turnStageLogs.get(userId);
  if (!log) return false;
  if (log.marks.filter((m) => m.kind === "activity").length >= ACTIVITY_MAX) return false;
  recordTurnStage(userId, { kind: "activity", label: String(label).slice(0, 200), ok: true });
  return true;
}

/** The finished-turn trail: agent-reported steps + Viseca-control gate events
 *  in order, kept client-side above the reply so nothing is lost. */
function trailFromMarks(marks) {
  return marks.map((m) => m.kind === "activity"
    ? { kind: "activity", label: m.label, ts: m.at, ok: true }
    : {
        kind: "stage",
        stage: m.stage,
        label: m.ok === false ? "Viseca control — order policy refused" : "Viseca control — order policy signed",
        ts: m.at,
        ok: m.ok !== false,
        durationMs: m.durationMs || null,
        policyId: m.policyId || null,
      });
}

/** Record a process-stage mark for the user's in-flight turn (no-op when no
 *  turn is running, e.g. a policy card approved after the reply arrived). */
function recordTurnStage(userId, mark) {
  const log = turnStageLogs.get(userId);
  if (!log) return;
  mark.at = Date.now();
  log.marks.push(mark);
  if (log.onStage) {
    try { log.onStage(mark); } catch { /* SSE client may be gone */ }
  }
}

/** Human-readable duration for logs and cards: ms under 1 s, else s / m s. */
function fmtMs(ms) {
  if (typeof ms !== "number" || !isFinite(ms)) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** Assemble the per-process timing report attached to every finished turn.
 *  `think` is derived (turn minus tool time); sign/gate marks are measured
 *  where they happen and can land inside the tool-work window. */
function buildTimings({ receivedAt, started, finished, stats, marks }) {
  const totalMs = Math.max(0, finished - receivedAt);
  const queueMs = Math.max(0, started - receivedAt);
  const agentTurnMs = Math.max(0, finished - started);
  const toolMs = (stats && stats.toolTimeMs) || 0;
  const thinkMs = Math.max(0, agentTurnMs - toolMs);
  const processes = [
    { label: "Request accepted (bridge queue + auth)", durationMs: queueMs },
    {
      label: "Agent thinking (model turns)",
      durationMs: thinkMs,
      note: stats && stats.assistantTurns != null ? `${stats.assistantTurns} model turns` : null,
    },
    {
      label: "Tool work (finding products, browsing shops)",
      durationMs: toolMs,
      note: stats && stats.toolCalls != null ? `${stats.toolCalls} tool calls` : null,
    },
  ];
  for (const m of marks) {
    if (m.kind === "activity") continue; // agent-reported steps live in the trail, not the timings grid
    processes.push({
      label: m.ok === false
        ? "Viseca control — order policy refused"
        : "Viseca control — order policy signed",
      durationMs: m.durationMs,
      note: m.policyId || m.detail || null,
      insideToolWork: true,
    });
  }
  processes.push({ label: "Bridge overhead (streaming, history)", durationMs: Math.max(0, totalMs - queueMs - agentTurnMs) });
  return { totalMs, agentTurnMs, processes };
}

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

/** Run stats from the CLI envelope: docs place run-stats on meta.agentMeta
 *  with the tool summary on meta.toolSummary, but flat envelopes also occur. */
function extractRunStats(parsed) {
  const meta = parsed && typeof parsed === "object" ? parsed.meta || {} : {};
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
  const am = obj(meta.agentMeta) || parsed || {};
  const ts = obj(meta.toolSummary) || obj(parsed && parsed.toolSummary) || {};
  const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);
  return {
    assistantTurns: num(am.assistantTurns),
    toolCalls: num(ts.calls),
    toolTimeMs: num(ts.totalToolTimeMs),
    tools: Array.isArray(ts.tools) ? ts.tools.slice(0, 8) : null,
    model: typeof parsed.model === "string" && parsed.model ? parsed.model : null,
    provider: typeof parsed.provider === "string" && parsed.provider ? parsed.provider : null,
  };
}

/** Structured agent-turn failure so the runner can decide on retries. */
function turnError(kind, message, detail) {
  const err = new Error(message);
  err.kind = kind; // "timeout" | "no-json" | "no-reply" | "launch"
  err.detail = detail || "";
  return err;
}

/** Kill the whole process tree of a spawned CLI child. The openclaw bin is a
 *  launcher: the direct child exits at once and the real CLI runs as a
 *  grandchild holding the stdio pipes (verified live 2026-09-25 — a plain
 *  child.kill() never reaches it). Children are spawned detached, so they are
 *  their own process-group leader and a negative-pid kill reaches the tree. */
function killTree(child) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/** PIDs of live processes carrying an env marker (same-user /proc scan).
 *  This reaches the anchored CLI grandchild that child.kill() and process-
 *  group kills both miss (verified live 2026-09-25: the openclaw bin is only
 *  a launcher; the real CLI is re-parented into a supervisor-owned group). */
function pidsWithEnvMarker(marker) {
  const hits = [];
  let dirs = [];
  try { dirs = fs.readdirSync("/proc"); } catch { return hits; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (fs.readFileSync(`/proc/${d}/environ`).includes(marker)) hits.push(Number(d));
    } catch { /* vanished or not ours */ }
  }
  return hits;
}

/** Run one agent turn through the Gateway CLI and resolve the reply text.
 *  onSpawn receives the child process right after launch (used for stop). */
function agentTurn(message, sessionKey, timeoutMs = TIMEOUT_MS, onSpawn = null) {
  return new Promise((resolve, reject) => {
    const args = [
      "agent",
      "--agent", AGENT,
      "--session-key", sessionKey,
      "--json",
      "--timeout", String(agentTimeoutSeconds(timeoutMs)),
      "-m", message + turnSafetyNote(timeoutMs),
    ];
    if (MODEL) args.push("--model", MODEL);
    // Unique per-turn env marker: lets /api/chat/stop find and kill the REAL
    // CLI process tree via /proc, wherever the supervisor anchored it.
    const turnToken = crypto.randomBytes(8).toString("hex");
    const child = spawn(BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, VISECA_TURN_TOKEN: turnToken },
    });
    if (onSpawn) { try { onSpawn(child, turnToken); } catch { /* registry is best-effort */ } }

    const runStarted = Date.now();
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      // The launcher can exit while its supervised grandchild stays alive.
      for (const pid of pidsWithEnvMarker(Buffer.from(`VISECA_TURN_TOKEN=${turnToken}\0`))) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
      }
      killTree(child);
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
        const failure = classifyFailure({ detail: bits, stderr, elapsedMs: Date.now() - runStarted, timeoutMs });
        return reject(turnError(failure.kind, failure.message, bits));
      }
      resolve({ reply, stats: extractRunStats(parsed) });
    });
  });
}

// Retry budget stays under the UI client's abort timer (app.js keeps its timer
// above this value). Override per-deployment for long real-shop checkouts.
const OVERALL_BUDGET_MS = Math.min(TIMEOUT_MS, parseInt(process.env.OPENCLAW_OVERALL_BUDGET_MS || "590000", 10));
// Retry only when the leftover budget could plausibly finish real work: a
// shopping-scale turn needs minutes, and retrying with pocket change left
// just guarantees a second failure (observed 2026-09-25: a 278s-left retry
// re-planned from scratch and timed out while the first run's gateway-side
// orphan finished on its own minutes later). Default: half the budget.
const RETRY_MIN_LEFT_MS = parseInt(process.env.OPENCLAW_RETRY_MIN_LEFT_MS || "0", 10) || Math.round(OVERALL_BUDGET_MS / 2);
const CONTINUE_NUDGE =
  "\n\n(System note: your previous attempt at this request was cut off before you produced a reply. Continue from where you left off and give your final answer now — do not restart the research from scratch.)";

/** One agent turn. Automatic retry is disabled unless explicitly opted in.
 *  With OPENCLAW_ALLOW_AUTOMATIC_RETRY=1, permit one budget-aware retry without a reply. The session keeps the partial work, so a continuation nudge lets
 *  the agent finish cheaply instead of redoing the whole task.
 *  `isStopped` short-circuits the retry when the CUSTOMER stopped the turn —
 *  a stop-aborted run looks exactly like a no-reply failure, and auto-retrying
 *  it would restart the work the customer just asked to stop. */
async function turnWithRetry(message, sessionKey, onSpawn = null, isStopped = null) {
  const deadline = Date.now() + OVERALL_BUDGET_MS;
  try {
    return await agentTurn(message, sessionKey, OVERALL_BUDGET_MS, onSpawn);
  } catch (err) {
    const left = deadline - Date.now();
    if (process.env.OPENCLAW_ALLOW_AUTOMATIC_RETRY === "1" && err.kind === "no-reply" && left > RETRY_MIN_LEFT_MS && !(isStopped && isStopped())) {
      console.log(`[chat] retry after no-reply (${err.detail || "no detail"}); ${Math.round(left / 1000)}s left`);
      return await agentTurn(message + CONTINUE_NUDGE, sessionKey, left, onSpawn);
    }
    throw err;
  }
}

/** Map structured turn failures to a message a shopper can act on. */
function friendlyTurnError(err) {
  if (err && err.kind === "infrastructure") {
    return "The shopping service lost access to its browser or agent runtime. This attempt could not finish. Check Purchases before trying again; no new order will be started automatically.";
  }
  if (err && (err.kind === "timeout" || err.kind === "agent-timeout")) {
    return "The shopper reached its time limit before finishing. Check Purchases or the merchant confirmation before retrying an order. No new order will be started automatically.";
  }
  if (err && err.kind === "no-reply") {
    const why = err.detail ? ` (reason: ${err.detail})` : "";
    return `The shopper's run was cut off before it produced a reply${why}. Your conversation history is kept. Check Purchases before retrying an order; no new order will be started automatically.`;
  }
  return `The shopper could not complete the request: ${(err && err.message) || "unknown error"}`;
}

/* ---------- opt-in legacy late delivery (disabled in production by default) ----------
 * The gateway-side run survives any bridge-side kill, so a turn that hit the
 * budget often FINISHES in the session minutes later — invisibly (observed
 * 2026-09-25: the full shoe-order report landed at 08:58 after the 08:55
 * failure frame). One same-session pickup turn fetches it; delivery is via
 * GET /api/chat/late (polled by the UI after a failure) or flushed at the
 * start of the session's next turn. */
const LATE_PICKUP_DELAY_MS = parseInt(process.env.OPENCLAW_LATE_PICKUP_DELAY_MS || "45000", 10);
const LATE_PICKUP_BUDGET_MS = parseInt(process.env.OPENCLAW_LATE_PICKUP_BUDGET_MS || "420000", 10);
const LATE_PICKUP_PROMPT =
  "(System: bridge task-completion pickup — your previous turn in this conversation was cut off by the bridge deadline while still working; the gateway may have finished that work after the cutoff, and the finished reply is in this conversation's history. Do NOT restart the task and do NO new research or browsing. If the finished final answer exists in the conversation, output exactly that final answer, unchanged, with no preamble. If the work never finished and you have nothing new to report, output exactly NOTHING_NEW and nothing else.)";
const pendingLateDeliveries = new Map(); // sessionKey -> { text, ts }
const latePickupArmed = new Set(); // sessionKeys with a pickup pending/in flight

/** Arm one pickup turn for this session. Postpones while a customer turn is
 *  running (two CLI runs on one agent session would interleave); gives up
 *  after ~10 minutes of postponement. */
function scheduleLatePickup(sessionKey, attempts = 0) {
  if (process.env.OPENCLAW_LATE_PICKUP_ENABLED !== "1") return;
  if (latePickupArmed.has(sessionKey)) return;
  latePickupArmed.add(sessionKey);
  setTimeout(() => {
    const busy = [...userProcs.values()].some((p) => p.sessionKey === sessionKey);
    if (busy) {
      latePickupArmed.delete(sessionKey);
      if (attempts < 20) scheduleLatePickup(sessionKey, attempts + 1);
      else console.log(`[chat] late pickup: gave up, session stayed busy (${sessionKey})`);
      return;
    }
    agentTurn(LATE_PICKUP_PROMPT, sessionKey, LATE_PICKUP_BUDGET_MS)
      .then(({ reply }) => {
        const text = String(reply || "").trim();
        if (!text || /^NOTHING_NEW\b/.test(text)) {
          console.log(`[chat] late pickup: nothing new session=${sessionKey}`);
          return;
        }
        pendingLateDeliveries.set(sessionKey, { text, ts: Date.now() });
        console.log(`[chat] late pickup: captured ${text.length} chars session=${sessionKey}`);
      })
      .catch((err) => console.log(`[chat] late pickup failed session=${sessionKey}: ${err.message}`))
      .finally(() => latePickupArmed.delete(sessionKey));
  }, attempts === 0 ? LATE_PICKUP_DELAY_MS : 30000).unref();
}

/** Validate + sign via scripts/policy.js, then file the signed envelope as
 *  policies/<policy_id>.signed.json in the agent workspace. The script itself
 *  REFUSES incomplete policies (exit 4) — that is the no-missing-data rule. */
/** This account's customer block for signed envelopes: identity + delivery
 *  address on file. Children with no address of their own inherit the parent's
 *  — mirrors the family-card rule. Per-customer by design: the shared agent
 *  workspace must never supply a global default identity or address. */
function customerBlock(user) {
  let holder = user;
  let d = shopping.getDelivery(user.id);
  if (!d && user.parentId) {
    const parent = accounts.findUserById(user.parentId);
    if (parent) {
      d = shopping.getDelivery(parent.id);
      holder = parent;
    }
  }
  if (!d) return null;
  return {
    user_id: user.id,
    email: user.email,
    name: user.name || null,
    delivery_address: shopping.deliveryAddressString(d),
    delivery_source: user.id === holder.id ? "account" : "parent account",
    source: "bridge account profile",
  };
}

/* Per-customer shopping controls, self-served by the agent: the website
 * whitelist and spend cap are already on file (onboarding / Account →
 * Shopping), so every draft policy carries merchant.allowed_domains and a
 * budget within the cap — the customer is never asked about either. With no
 * whitelist the agent picks and evaluates shops itself instead of bouncing
 * the choice back. */
function shoppingControlsNote(user) {
  const wl = shopping.getWhitelist(user.id);
  const cap = shopping.getSpendCap(user.id);
  const parts = [];
  if (cap != null) parts.push(`spend cap ${cap} CHF is a hard max for budget.max_total`);
  if (wl.length) {
    parts.push(
      `website whitelist ACTIVE (${wl.join(", ")}; subdomains of these count as whitelisted): search ONLY these shops and ALWAYS set merchant.allowed_domains to the whitelisted domain(s) you will buy from — the whitelist is already on file, never ask the customer about it`
    );
  } else {
    parts.push(
      "no website whitelist on file: pick the shops yourself — search the web for reputable Swiss shops, evaluate each candidate (merchant directory GET /api/merchants, scripts/impressum-check.js, Trusted Shops evidence), and set merchant.allowed_domains to the evaluated domain(s) you chose — never ask the customer to whitelist or name domains"
    );
  }
  return `(System: shopping controls — ${parts.join("; ")}. A policy without valid merchant.allowed_domains is refused at sign time.)`;
}

/** Per-customer context prepended to every shopper turn so the agent uses
 *  THIS web customer's data, never a stored default. */
function customerContextNote(user) {
  const cust = customerBlock(user);
  if (!cust) {
    return "\n\n(System: this customer has NO delivery address on file. If this request could end in a purchase, tell them to add their address under Account → Shopping → Delivery address in the web UI — the authority refuses to sign without it. Never guess or default an address or email.)";
  }
  return `\n\n(System: customer on file — email ${cust.email}, name ${cust.name || "unknown"}, delivery address: ${cust.delivery_address}. Use exactly this identity and address for order policies, merchant checkouts and deliveries — never a different or historical default.)\n\n${shoppingControlsNote(user)}`;
}

async function signPolicy(policy, res, user, sessionId) {
  const signT0 = Date.now(); // every exit below reports its gate duration

  /* Shopping controls first: spend cap + website whitelist (see shopping.js).
   * Violations are a different refusal than incompleteness — they carry
   * `violations` (the customer must change settings or the budget), while the
   * signer's own exit-4 refusal carries `missing` (the agent must ask). */
  const chk = shopping.checkPolicyAgainstSettings(user.id, policy);
  if (!chk.ok) {
    console.log(`[policy] sign REFUSED (shopping settings) user=${user.email}: ${chk.violations.join(" | ")}`);
    recordTurnStage(user.id, { stage: "policy_sign", ok: false, detail: "refused: shopping settings", durationMs: Date.now() - signT0 });
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
    recordTurnStage(user.id, { stage: "policy_sign", ok: false, detail: "refused: parental limits", durationMs: Date.now() - signT0 });
    return sendJson(res, 422, {
      ok: false,
      error: "The authority refused to sign — the policy exceeds the parental limits on this account.",
      violations: pchk.violations,
      missing: [],
    });
  }
  /* Per-customer data separation: the signed envelope carries THIS account's
   * identity + on-file delivery address, overriding whatever the agent drafted.
   * Checked after the shopping/parental gates so their violations surface first. */
  const cust = customerBlock(user);
  if (!cust) {
    console.log(`[policy] sign REFUSED (no delivery address on file) user=${user.email}`);
    recordTurnStage(user.id, { stage: "policy_sign", ok: false, detail: "refused: no delivery address on file", durationMs: Date.now() - signT0 });
    return sendJson(res, 422, {
      ok: false,
      error: "The authority refused to sign — no delivery address is on file for this account.",
      violations: ["No delivery address on file — add it under Account → Shopping → Delivery address, then have the agent re-propose the policy."],
      missing: [],
    });
  }
  // Evaluate the actual proposed order against THIS customer's chat and saved controls.
  const reviewSession = loadSession(user.id, sessionId);
  const reviewInput = walletReview.buildReview(policy,
    { cap: shopping.getSpendCap(user.id), whitelist: shopping.getWhitelist(user.id) },
    (reviewSession && Array.isArray(reviewSession.messages) ? reviewSession.messages : []).filter(m => m.role === "user").map(m => m.text));
  const assessment = await walletReview.reviewPolicy(reviewInput, { token: SHOPPING_SYNC_TOKEN, port: Number(process.env.WALLET_CONTROL_PORT || 8790) });
  recordTurnStage(user.id, { stage: "wallet_ai_review", ok: assessment.status === "ok" && !assessment.review_required,
    detail: assessment.status === "ok" ? (assessment.review_required ? "Jev requests policy review" : "Jev reviewed your order and account controls") : `Jev ${assessment.status}; account controls still enforced`, durationMs: Date.now() - signT0 });
  if (assessment.review_required) return sendJson(res, 422, { ok: false,
    error: "Jev found a possible conflict between this order and your instructions. Ask the shopper to revise the policy before signing.",
    violations: ["Order permissions need review against your original request."], missing: [], wallet_review: assessment });
  // Recheck after the asynchronous assessment: account/family settings may have changed.
  const latest = shopping.checkPolicyAgainstSettings(user.id, policy);
  const latestFamily = family.checkParentalLimits(user.id, policy);
  if (!latest.ok || !latestFamily.ok) return sendJson(res, 422, { ok: false, error: "Your spending controls changed during review.", violations: [...(latest.violations || []), ...(latestFamily.violations || [])], missing: [] });
  policy.delivery = policy.delivery && typeof policy.delivery === "object" && !Array.isArray(policy.delivery) ? policy.delivery : {};
  policy.delivery.address = cust.delivery_address;
  policy.customer = cust;
  console.log(`[policy] customer block injected user=${user.email} -> ${cust.delivery_address}`);
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
      payload.wallet_review = assessment;
      const reviewDir = path.join(DATA_DIR, "wallet-reviews");
      fs.mkdirSync(reviewDir, { recursive: true });
      fs.writeFileSync(path.join(reviewDir, crypto.createHash("sha256").update(env.policy.policy_id).digest("hex") + ".json"),
        JSON.stringify({ at: new Date().toISOString(), input_sha256: walletReview.digest(reviewInput), assessment }), { mode: 0o600 });
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
      recordTurnStage(user.id, { stage: "policy_sign", ok: true, policyId: env.policy.policy_id, durationMs: Date.now() - signT0 });
      return sendJson(res, 200, payload);
    }
    console.log(`[policy] sign REFUSED (exit ${r.status})`);
    recordTurnStage(user.id, { stage: "policy_sign", ok: false, detail: r.status === 4 ? "refused: incomplete policy" : "signer error", durationMs: Date.now() - signT0 });
    return sendJson(res, r.status === 4 ? 422 : 500,
      payload || { ok: false, error: (r.stderr || "sign failed").slice(-400) });
  } catch (e) {
    recordTurnStage(user.id, { stage: "policy_sign", ok: false, detail: "signer error", durationMs: Date.now() - signT0 });
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

/* ---------- conversation sessions (sidebar list) ---------- */

const SESSION_ID_RE = /^(main|s_[0-9a-f]{8})$/;
const userHistoryDir = (userId) => path.join(HISTORY_DIR, userId);
const sessionPath = (userId, sessionId) => path.join(userHistoryDir(userId), `${sessionId}.json`);

/** Legacy single-history files migrate into a "Previous chat" session whose
 *  agent key stays unchanged, so the old conversation keeps its context. */
function migrateLegacyHistory(userId) {
  const legacy = historyPath(userId);
  if (!fs.existsSync(legacy)) return;
  const dir = userHistoryDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const target = sessionPath(userId, "main");
  if (!fs.existsSync(target)) {
    try {
      const j = JSON.parse(fs.readFileSync(legacy, "utf8"));
      j.id = "main";
      j.title = "Previous chat";
      j.created = j.updated || new Date().toISOString();
      fs.writeFileSync(target, JSON.stringify(j));
    } catch { fs.renameSync(legacy, target); }
  }
  fs.rmSync(legacy, { force: true });
}

function listSessions(userId) {
  migrateLegacyHistory(userId);
  let files = [];
  try { files = fs.readdirSync(userHistoryDir(userId)).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(userHistoryDir(userId), f), "utf8"));
      const messages = Array.isArray(j.messages) ? j.messages : [];
      out.push({
        id: j.id || f.replace(/\.json$/, ""),
        title: j.title || "(untitled chat)",
        created: j.created || j.updated || null,
        updated: j.updated || null,
        messageCount: messages.length,
        preview: messages.length ? String(messages[messages.length - 1].text || "").replace(/\s+/g, " ").slice(0, 80) : "",
      });
    } catch { /* skip corrupt session files */ }
  }
  out.sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
  return out;
}

function loadSession(userId, sessionId) {
  if (!SESSION_ID_RE.test(String(sessionId || ""))) return null;
  try { return JSON.parse(fs.readFileSync(sessionPath(userId, sessionId), "utf8")); } catch { return null; }
}

function saveSession(userId, sess) {
  fs.mkdirSync(userHistoryDir(userId), { recursive: true });
  fs.writeFileSync(sessionPath(userId, sess.id), JSON.stringify(sess));
}

/** The session a turn runs in: adopt the requested one, or lazily create a
 *  fresh conversation when the client has none (ChatGPT-style new chat). */
function resolveTurnSession(userId, sessionId) {
  const existing = loadSession(userId, sessionId);
  if (existing) return existing;
  const id = `s_${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();
  return { id, title: "", created: now, updated: now, messages: [] };
}

function appendSessionMessage(userId, sess, role, text) {
  try {
    sess.messages.push({ role, text, ts: new Date().toISOString() });
    if (role === "user" && !sess.title) sess.title = String(text).replace(/\s+/g, " ").slice(0, 48) || "(untitled chat)";
    sess.updated = new Date().toISOString();
    sess.messages = sess.messages.slice(-HISTORY_CAP);
    saveSession(userId, sess);
  } catch (e) {
    console.log(`[history] append failed: ${e.message}`);
  }
}

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

const userSessionKey = (user, sessionId) =>
  sessionId && sessionId !== "main" ? `${SESSION}-u${user.sid}-c${sessionId}` : `${SESSION}-u${user.sid}`;

async function runChatTurn(req, res, user, message, mode, sessionId) {
  const receivedAt = Date.now();
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
  let sess = resolveTurnSession(user.id, sessionId) || resolveTurnSession(user.id, null);
  const sessionKey = userSessionKey(user, sess.id);
  stoppedTurns.delete(user.id);
  const stageLog = { marks: [], onStage: null, activityToken: null };
  turnStageLogs.set(user.id, stageLog);
  // Per-turn activity reporting: the agent POSTs progress steps to the bridge
  // while it works; each one streams to the UI as a live checkmark trail.
  let fullMessage = message + customerContextNote(user);
  if (process.env.ACTIVITY_REPORTING !== "off") {
    stageLog.activityToken = crypto.randomBytes(16).toString("hex");
    activityTokens.set(stageLog.activityToken, user.id);
    fullMessage += activityNote(stageLog.activityToken);
  }
  console.log(`[chat] turn start  (${message.length} chars) user=${user.email} session=${sessionKey} mode=${mode}`);
  appendSessionMessage(user.id, sess, "user", message);

  /** A customer-requested stop reports differently from a failure. */
  const friendlyError = (err) => {
    if (stoppedTurns.has(user.id)) {
      stoppedTurns.delete(user.id);
      return "Stopped — the task is no longer running. (Anything already ordered stays done.) Tell me what to do next.";
    }
    return friendlyTurnError(err);
  };

  const turn = (async () => {
    activeTurns += 1;
    try {
      return await turnWithRetry(
        fullMessage,
        sessionKey,
        (child, turnToken) => userProcs.set(user.id, { child, sessionKey, turnToken }),
        () => stoppedTurns.has(user.id)
      );
    } finally {
      activeTurns -= 1;
      userProcs.delete(user.id);
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
    send({ type: "start", agent: AGENT, session: sessionKey, sessionId: sess.id });
    // Flush a late pickup captured for a previously interrupted turn before
    // this turn's work starts.
    const lateNow = pendingLateDeliveries.get(sessionKey);
    if (lateNow) {
      pendingLateDeliveries.delete(sessionKey);
      appendSessionMessage(user.id, sess, "agent", lateNow.text);
      console.log(`[chat] late delivery flushed with new turn session=${sessionKey}`);
      send({ type: "late", text: lateNow.text, ts: lateNow.ts });
    }
    // Live process-stage events (e.g. the Viseca control policy gate) reach
    // the UI the moment they happen, not only in the final done frame.
    stageLog.onStage = (mark) => {
      if (mark.kind === "activity") {
        send({ type: "activity", label: mark.label, ts: mark.at });
      } else {
        send({
          type: "stage",
          stage: mark.stage,
          ok: mark.ok,
          policyId: mark.policyId || null,
          detail: mark.detail || null,
          durationMs: mark.durationMs,
        });
      }
    };

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
      .then(({ reply, stats }) => {
        const finished = Date.now();
        const timings = buildTimings({ receivedAt, started, finished, stats, marks: stageLog.marks });
        const gateBit = stageLog.marks.length
          ? ` · gate=${stageLog.marks.map((m) => fmtMs(m.durationMs)).join("+")}`
          : "";
        console.log(`[chat] turn done    in ${(timings.agentTurnMs / 1000).toFixed(1)}s (${reply.length} chars back) user=${user.email}`);
        console.log(`[chat] timings     total=${fmtMs(timings.totalMs)} · queue=${fmtMs(timings.processes[0].durationMs)} · think=${fmtMs(timings.processes[1].durationMs)} · tools=${fmtMs(timings.processes[2].durationMs)}${gateBit} user=${user.email}`);
        appendSessionMessage(user.id, sess, "agent", reply);
        send({ type: "done", reply, timings, trail: trailFromMarks(stageLog.marks), sessionId: sess.id, agent: AGENT, session: sessionKey });
      })
      .catch((err) => {
        console.log(`[chat] turn FAILED  after ${((Date.now() - started) / 1000).toFixed(1)}s: ${err.message} user=${user.email}`);
        const wasStopped = stoppedTurns.has(user.id);
        const friendly = friendlyError(err);
        appendSessionMessage(user.id, sess, "error", friendly);
        send({ type: "error", error: friendly });
        // The gateway-side run survives the CLI-tree kill — arm one pickup to
        // fetch the late reply unless the customer stopped this turn on purpose.
        if (!wasStopped && (err.kind === "timeout" || err.kind === "no-reply")) {
          scheduleLatePickup(sessionKey);
        }
      })
      .finally(() => {
        clearInterval(poll);
        if (stageLog.activityToken) activityTokens.delete(stageLog.activityToken);
        turnStageLogs.delete(user.id);
        res.end();
        userInFlight.delete(user.id);
      });
    return;
  }

  // plain JSON (ChatGPT Actions / skills cannot consume SSE)
  try {
    const { reply, stats } = await turn;
    const timings = buildTimings({ receivedAt, started, finished: Date.now(), stats, marks: stageLog.marks });
    console.log(`[chat] turn done    in ${(timings.agentTurnMs / 1000).toFixed(1)}s (${reply.length} chars back) user=${user.email}`);
    appendSessionMessage(user.id, sess, "agent", reply);
    sendJson(res, 200, { reply, agent: AGENT, session: sessionKey, usage, timings, trail: trailFromMarks(stageLog.marks), sessionId: sess.id });
  } catch (err) {
    console.log(`[chat] turn FAILED  after ${((Date.now() - started) / 1000).toFixed(1)}s: ${err.message} user=${user.email}`);
    const wasStopped = stoppedTurns.has(user.id);
    const friendly = friendlyError(err);
    appendSessionMessage(user.id, sess, "error", friendly);
    sendJson(res, 502, { error: friendly });
    if (!wasStopped && (err.kind === "timeout" || err.kind === "no-reply")) {
      scheduleLatePickup(sessionKey);
    }
  } finally {
    if (stageLog.activityToken) activityTokens.delete(stageLog.activityToken);
    turnStageLogs.delete(user.id);
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
  if(req.url === '/wallet') {res.writeHead(302,{Location:'/wallet/'});return res.end();}
  if(req.url.startsWith('/wallet/')) {
    const upstream=http.request({hostname:'127.0.0.1',port:Number(process.env.WALLET_CONTROL_PORT||8790),path:req.url,method:req.method,headers:req.headers},incoming=>{
      res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);
    });
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Wallet control is temporarily unavailable'}));});
    req.pipe(upstream);return;
  }
  handle(req, res).catch((e) => {
    console.error(`[http] ${req.method} ${req.url} -> ${e.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal bridge error." });
    else try { res.end(); } catch { /* client already gone */ }
  });
});

/* Merchant directory (data/merchants.json): curated CH shops + weekly
 * evidence refresh (scripts/refresh-merchants.mjs). Served to the onboarding
 * wizard and shop pickers; 60 s cache so a refresh shows without a restart. */
const MERCHANTS_FILE = path.join(__dirname, "data", "merchants.json");
let merchantsCache = { at: 0, data: null };
function merchantsData() {
  if (!merchantsCache.data || Date.now() - merchantsCache.at > 60_000) {
    try {
      merchantsCache = { at: Date.now(), data: JSON.parse(fs.readFileSync(MERCHANTS_FILE, "utf8")) };
    } catch (e) {
      console.error(`[merchants] read failed: ${e.message}`); // keep last good data
    }
  }
  return merchantsCache.data;
}

async function handle(req, res) {
  const pathname = new URL(req.url, "http://x").pathname;

  /* ----- public discovery endpoints ----- */

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      agent: AGENT,
      session: SESSION,
      bridge: "openclaw-cli",
      build: "shopper-reliability-1",
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

  if (req.method === "GET" && pathname === "/api/merchants") {
    const data = merchantsData();
    // Only recommend shops that let automated agents actually browse and buy
    // (agent_friendly=0 marks bot-walled shops — DataDome, Cloudflare, …).
    // Flag is set by scripts/agent-friendly-check.mjs; unknown (unprobed)
    // entries stay recommended until proven hostile.
    const all = Array.isArray(data?.merchants) ? data.merchants : [];
    const list = all.filter((m) => m.agent_friendly !== 0);
    return sendJson(res, 200, { ok: true, updated_at: data?.updated_at || null, count: list.length, merchants: list });
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

  /* ----- internal: wallet-control → whitelist sync (localhost + shared token) -----
   * Mirrors a customer-trusted merchant into the account's website whitelist so
   * the agent's signed policies for that domain pass sign-time enforcement.
   * Guard order: token configured → peer is 127.0.0.1 → constant-time bearer. */

  if (pathname === "/api/internal/shopping/whitelist" && req.method === "POST") {
    if (!SHOPPING_SYNC_TOKEN) {
      return sendJson(res, 404, { error: "Internal sync endpoint is disabled (SHOPPING_SYNC_TOKEN not set)." });
    }
    const ra = req.socket.remoteAddress || "";
    if (ra !== "127.0.0.1" && ra !== "::1" && ra !== "::ffff:127.0.0.1") {
      console.log(`[shopping] internal sync refused: non-local peer ${ra}`);
      return sendJson(res, 403, { error: "Forbidden." });
    }
    const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const a = Buffer.from(got);
    const b = Buffer.from(SHOPPING_SYNC_TOKEN);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.log("[shopping] internal sync refused: bad token");
      return sendJson(res, 401, { error: "Bad sync token." });
    }
    const body = await readJsonBody(req, 4).catch(() => null);
    if (body === null) return sendJson(res, 413, { error: "Payload too large." });
    const user = accounts.findUserByEmail(String(body.email || ""));
    if (!user) return sendJson(res, 404, { error: "Unknown account." });
    try {
      const out = shopping.addWhitelist(user.id, body.domain);
      console.log(`[shopping] internal sync +${out.added} -> ${user.email}${out.already ? " (already covered)" : ""}`);
      return sendJson(res, out.already ? 200 : 201, { ok: true, added: out.added, already: out.already });
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message });
    }
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

    if (req.method === "POST" && pathname === "/api/account/onboarded") {
      accounts.markOnboarded(auth.user.id);
      console.log(`[account] ${auth.user.email} finished onboarding`);
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
        delivery: shopping.getDelivery(auth.user.id),
        unrestricted: {
          cap: shopping.getSpendCap(auth.user.id) == null,
          whitelist: shopping.getWhitelist(auth.user.id).length === 0,
        },
      });
    }

    if (pathname === "/api/account/shopping/delivery" && req.method === "PUT") {
      const body = await readJsonBody(req, 4).catch(() => null);
      if (body === null) return sendJson(res, 413, { error: "Payload too large." });
      try {
        const saved = shopping.setDelivery(auth.user.id, body);
        console.log(`[shopping] ${auth.user.email} delivery address saved (${saved.zip} ${saved.city})`);
        return sendJson(res, 200, { ok: true, delivery: saved });
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
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

  /* ----- agent activity reports (token-scoped, per-turn) ----- */

  if (req.method === "POST" && pathname === "/api/chat/activity") {
    const token = String(req.headers["x-activity-token"] || "");
    const userId = token && activityTokens.get(token);
    if (!userId) return sendJson(res, 404, { ok: false, error: "No active turn for this token." });
    let body;
    try {
      body = await readJsonBody(req, 2);
    } catch {
      return sendJson(res, 413, { error: "Payload too large." });
    }
    const label = body && typeof body.label === "string" ? body.label.trim() : "";
    if (!label) return sendJson(res, 400, { error: "Field 'label' is required." });
    recordActivity(userId, label);
    console.log(`[chat] activity user=${userId}: ${label.slice(0, 100)}`);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/api/chat/late") {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in or send a Bearer API key." });
    const wanted = new URL(req.url, "http://localhost").searchParams.get("sessionId");
    // resolveTurnSession CREATES a session when none matches — wrong for a
    // read-only lookup. Read the requested session, else the most recent one.
    let sess = loadSession(auth.user.id, wanted || "");
    if (!sess) {
      const latest = listSessions(auth.user.id)[0];
      sess = latest ? loadSession(auth.user.id, latest.id) : null;
    }
    if (!sess) return sendJson(res, 200, { late: null });
    const lateKey = userSessionKey(auth.user, sess.id);
    const late = pendingLateDeliveries.get(lateKey) || null;
    if (late) {
      pendingLateDeliveries.delete(lateKey);
      appendSessionMessage(auth.user.id, sess, "agent", late.text);
      console.log(`[chat] late delivery served via poll session=${lateKey}`);
    }
    return sendJson(res, 200, { late });
  }

  if (req.method === "POST" && pathname === "/api/chat/stop") {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in or send a Bearer API key." });
    const entry = userProcs.get(auth.user.id);
    if (!entry) return sendJson(res, 404, { error: "No running turn to stop." });
    stoppedTurns.add(auth.user.id);
    // 1) Kill the REAL CLI: scan /proc for the turn's env marker and SIGKILL
    //    every match. Gateway abort RPCs (chat.abort / sessions.abort) refuse
    //    cross-connection aborts of CLI-spawned runs ("unauthorized"), and
    //    child/group kills miss the anchored grandchild — the env marker is
    //    the one handle that always reaches it. When it dies, its stdio pipes
    //    close, the turn settles, and the customer gets the Stopped message.
    const killed = [];
    if (entry.turnToken) {
      for (const p of pidsWithEnvMarker(entry.turnToken)) {
        try { process.kill(p, "SIGKILL"); killed.push(p); } catch { /* gone */ }
      }
    }
    // 2) Backstop: group-kill the launcher's tree anyway (harmless when the
    //    launcher's group is already empty).
    const pid = entry.child.pid;
    if (pid) {
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
          console.log(`[chat] STOP backstop: killed group -${pid}`);
        } catch (e) {
          console.log(`[chat] STOP backstop: group -${pid} already gone (${e.code || e.message})`);
        }
      }, 12000).unref();
    }
    console.log(`[chat] STOP requested by ${auth.user.email} for ${entry.sessionKey} (killed CLI pids: ${killed.join(",") || "none"})`);
    return sendJson(res, 200, { ok: true });
  }

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
    const { message, sessionId } = body;
    if (!message || typeof message !== "string" || !message.trim()) {
      return sendJson(res, 400, { error: "Field 'message' is required." });
    }
    return runChatTurn(req, res, auth.user, message.trim(), pathname === "/api/chat" ? "sse" : "json", typeof sessionId === "string" ? sessionId : "");
  }

  /* ----- chat history (reload-safe conversation view) ----- */

  if (pathname === "/api/history") {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in." });
    const qs = new URL(req.url, "http://x").searchParams;
    const sessionId = SESSION_ID_RE.test(qs.get("session") || "") ? qs.get("session") : "main";
    if (req.method === "GET") {
      const sess = loadSession(auth.user.id, sessionId);
      return sendJson(res, 200, { ok: true, sessionId, messages: sess && Array.isArray(sess.messages) ? sess.messages : [] });
    }
    if (req.method === "DELETE") {
      fs.rmSync(sessionPath(auth.user.id, sessionId), { force: true });
      console.log(`[history] cleared session ${sessionId} for ${auth.user.email}`);
      return sendJson(res, 200, { ok: true, sessionId });
    }
  }

  /* ----- conversation sessions (sidebar list) ----- */

  if (pathname === "/api/sessions" && req.method === "GET") {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in." });
    return sendJson(res, 200, { ok: true, sessions: listSessions(auth.user.id) });
  }

  if (req.method === "POST" && pathname === "/api/sessions/delete") {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in." });
    const body = await readJsonBody(req, 2).catch(() => null);
    const id = body ? String(body.id || "") : "";
    if (!SESSION_ID_RE.test(id)) return sendJson(res, 400, { error: "Invalid session id." });
    fs.rmSync(sessionPath(auth.user.id, id), { force: true });
    console.log(`[sessions] ${auth.user.email} deleted ${id}`);
    return sendJson(res, 200, { ok: true, id });
  }

  if (req.method === "POST" && pathname === "/api/sessions/rename") {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in." });
    const body = await readJsonBody(req, 2).catch(() => null);
    const id = body ? String(body.id || "") : "";
    const title = body && typeof body.title === "string" ? body.title.trim().slice(0, 80) : "";
    if (!SESSION_ID_RE.test(id) || !title) return sendJson(res, 400, { error: "Fields 'id' and 'title' are required." });
    const sess = loadSession(auth.user.id, id);
    if (!sess) return sendJson(res, 404, { error: "No such session." });
    sess.title = title;
    saveSession(auth.user.id, sess);
    return sendJson(res, 200, { ok: true, id, title });
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
    return signPolicy(policy, res, auth.user, body.sessionId);
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
  console.log(`[viseca-shopper-ui] marker: shopper-reliability-1 explicit agent deadline`);
});

/* Last words: two silent deaths tonight (22:55, ~23:22) left no evidence.
   Next time the log tells us whether a signal arrived or the code crashed.
   The watchdog automation relaunches within 5 min either way. */
process.on("SIGTERM", () => { console.log(`[lifecycle] SIGTERM ${new Date().toISOString()} — exiting`); process.exit(0); });
process.on("SIGINT", () => { console.log(`[lifecycle] SIGINT ${new Date().toISOString()} — exiting`); process.exit(0); });
process.on("uncaughtException", (err) => { console.error(`[fatal] uncaughtException ${new Date().toISOString()}: ${(err && err.stack) || err}`); process.exit(1); });
process.on("unhandledRejection", (err) => { console.error(`[warn] unhandledRejection ${new Date().toISOString()}: ${(err && (err.stack || err.message)) || err}`); });
