#!/usr/bin/env node
/**
 * Viseca Shopper UI — bridge server
 *
 * Zero-dependency Node HTTP server that:
 *   1. serves the static UI from ./public
 *   2. proxies chat messages to the viseca-shopper OpenClaw agent via the
 *      Gateway CLI:  openclaw agent --agent <id> --session-key <key> --json -m <msg>
 *
 * Config (env):
 *   PORT                 default 8794
 *   HOST                 default 127.0.0.1
 *   OPENCLAW_AGENT       default viseca-shopper
 *   OPENCLAW_SESSION     default webui  (session key suffix; keeps history)
 *   OPENCLAW_BIN         default openclaw
 *   OPENCLAW_TIMEOUT_MS  default 300000
 */

const http = require("http");
const { spawn, spawnSync, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "8794", 10);
const HOST = process.env.HOST || "127.0.0.1";
const AGENT = process.env.OPENCLAW_AGENT || "viseca-shopper";
const SESSION = process.env.OPENCLAW_SESSION || "webui";
const BIN = process.env.OPENCLAW_BIN || "openclaw";
const TIMEOUT_MS = parseInt(process.env.OPENCLAW_TIMEOUT_MS || "600000", 10);
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

/* one agent turn at a time — the session is sequential */
let inFlight = null;

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
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

/** Run one agent turn through the Gateway CLI and resolve the reply text. */
function agentTurn(message) {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, [
      "agent",
      "--agent", AGENT,
      "--session-key", SESSION,
      "--json",
      "-m", message,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Agent turn timed out after ${TIMEOUT_MS / 1000}s.`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to launch ${BIN}: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const start = stdout.indexOf("{");
      const end = stdout.lastIndexOf("}");
      if (start === -1 || end === -1 || end <= start) {
        return reject(new Error(
          `Agent returned no JSON (exit ${code}). ${stderr.slice(-400).trim()}`
        ));
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.slice(start, end + 1));
      } catch (e) {
        return reject(new Error(`Unparseable agent JSON: ${e.message}`));
      }
      const reply =
        findKey(parsed, "finalAssistantVisibleText") ||
        findKey(parsed, "finalAssistantRawText");
      if (!reply) {
        return reject(new Error("Agent JSON contained no reply text."));
      }
      resolve(reply);
    });
  });
}

/** Validate + sign via scripts/policy.js, then file the signed envelope as
 *  policies/<policy_id>.signed.json in the agent workspace. The script itself
 *  REFUSES incomplete policies (exit 4) — that is the no-missing-data rule. */
function signPolicy(policy, res) {
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

/** Snapshot of this agent's session from the local store (status, tokens). */
function sessionSnapshot() {
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
            (s) => s.key === `agent:${AGENT}:${SESSION}`
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

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      agent: AGENT,
      session: SESSION,
      bridge: "openclaw-cli",
      busy: Boolean(inFlight),
      policy: {
        authority_fingerprint: AUTH ? AUTH.fingerprint : null,
        policy_dir: POLICY_DIR,
      },
    });
  }

  if (req.method === "GET" && req.url === "/api/policy/pubkey") {
    return sendJson(res, 200, {
      ok: true,
      fingerprint: AUTH ? AUTH.fingerprint : null,
      public_key_pem: fs.readFileSync(path.join(POLICY_KEYS_DIR, "policy-authority.public.pem"), "utf8"),
      agent_public_key: POLICY_PUB_OUT,
      note: "agent verifies with this key; only this bridge holds the signing key",
    });
  }

  if (req.method === "POST" && req.url === "/api/policy/sign") {
    let body = "";
    let oversize = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) { oversize = true; req.destroy(); }
    });
    req.on("end", () => {
      if (oversize) return sendJson(res, 413, { error: "Policy too large (64 KB limit)." });
      let policy;
      try { ({ policy } = JSON.parse(body)); } catch { return sendJson(res, 400, { error: "Invalid JSON body." }); }
      if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
        return sendJson(res, 400, { error: "Field 'policy' must be an object." });
      }
      signPolicy(policy, res);
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    if (inFlight) {
      return sendJson(res, 409, {
        error: "The agent is still answering the previous message — one turn at a time.",
      });
    }
    let body = "";
    let oversize = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 32 * 1024) { oversize = true; req.destroy(); }
    });
    req.on("end", () => {
      if (oversize) return sendJson(res, 413, { error: "Message too large (32 KB limit)." });
      let message;
      try {
        ({ message } = JSON.parse(body));
      } catch {
        return sendJson(res, 400, { error: "Invalid JSON body." });
      }
      if (!message || typeof message !== "string" || !message.trim()) {
        return sendJson(res, 400, { error: "Field 'message' is required." });
      }

      const started = Date.now();
      console.log(`[chat] turn start  (${message.trim().length} chars) from ${req.socket.remoteAddress}`);

      // Live event stream (SSE): start -> progress… -> done|error. Progress is
      // best-effort (session store polling); the final frame is authoritative.
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
      send({ type: "start", agent: AGENT, session: SESSION });

      const poll = setInterval(() => {
        sessionSnapshot().then((snap) => {
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

      inFlight = agentTurn(message.trim());
      inFlight
        .then((reply) => {
          console.log(`[chat] turn done    in ${((Date.now() - started) / 1000).toFixed(1)}s (${reply.length} chars back)`);
          send({ type: "done", reply, agent: AGENT, session: SESSION });
        })
        .catch((err) => {
          console.log(`[chat] turn FAILED  after ${((Date.now() - started) / 1000).toFixed(1)}s: ${err.message}`);
          send({ type: "error", error: err.message });
        })
        .finally(() => {
          clearInterval(poll);
          res.end();
          inFlight = null;
        });
    });
    return;
  }

  serveStatic(req, res);
});

let AUTH = null;
try {
  AUTH = ensurePolicyKeys();
  console.log(`[policy] authority ready · fingerprint ${AUTH.fingerprint} · agent pubkey ${POLICY_PUB_OUT}`);
} catch (e) {
  console.error(`[policy] FATAL: ${e.message}`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`[viseca-shopper-ui] serving ${PUBLIC_DIR}`);
  console.log(`[viseca-shopper-ui] ${url}  →  agent '${AGENT}' (session key: ${SESSION})`);
});
