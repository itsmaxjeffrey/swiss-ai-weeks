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
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "8794", 10);
const HOST = process.env.HOST || "127.0.0.1";
const AGENT = process.env.OPENCLAW_AGENT || "viseca-shopper";
const SESSION = process.env.OPENCLAW_SESSION || "webui";
const BIN = process.env.OPENCLAW_BIN || "openclaw";
const TIMEOUT_MS = parseInt(process.env.OPENCLAW_TIMEOUT_MS || "300000", 10);
const PUBLIC_DIR = path.join(__dirname, "public");

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
    });
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

      inFlight = agentTurn(message.trim());
      inFlight
        .then((reply) => sendJson(res, 200, { reply, agent: AGENT, session: SESSION }))
        .catch((err) => sendJson(res, 502, { error: err.message }))
        .finally(() => { inFlight = null; });
    });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`[viseca-shopper-ui] serving ${PUBLIC_DIR}`);
  console.log(`[viseca-shopper-ui] ${url}  →  agent '${AGENT}' (session key: ${SESSION})`);
});
