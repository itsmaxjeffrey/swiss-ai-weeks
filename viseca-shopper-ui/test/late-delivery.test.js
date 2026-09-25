/**
 * late-delivery.test.js — a turn that fails (timeout / no-reply) must not
 * burn its last budget on a doomed retry, and the late pickup must capture
 * the orphan's finished reply and deliver it via GET /api/chat/late and via
 * a `late` SSE frame at the start of the session's next turn.
 *
 * Boots server.js on a scratch port with stub-openclaw-late.js: real turns
 * fail as no-reply after FAIL_DELAY_MS; pickup turns answer instantly.
 *
 *   node --test test/late-delivery.test.js
 */

/* This host runs an egress proxy (NODE_USE_ENV_PROXY=1 + HTTP_PROXY). Node's
 * fetch would push even 127.0.0.1 requests through it — opt out for tests. */
delete process.env.NODE_USE_ENV_PROXY;
process.env.NO_PROXY = "127.0.0.1,localhost";

const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STUB = path.join(__dirname, "stub-openclaw-late.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
    probe.on("error", reject);
  });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "late-delivery-"));
let server;
let serverLog = "";
let PORT;
let BASE;

function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      OPENCLAW_BIN: STUB,
      OPENCLAW_TIMEOUT_MS: "20000",
      OPENCLAW_OVERALL_BUDGET_MS: "8000",
      OPENCLAW_RETRY_MIN_LEFT_MS: "4000",
      OPENCLAW_LATE_PICKUP_ENABLED: "1",
      OPENCLAW_LATE_PICKUP_DELAY_MS: "300",
      OPENCLAW_LATE_PICKUP_BUDGET_MS: "10000",
      FAIL_DELAY_MS: "5000", // first attempt dies at ~5s → ~3s left < 4s floor → no retry
      ACCOUNTS_DATA_DIR: path.join(tmpDir, "data"),
      POLICY_KEYS_DIR: path.join(tmpDir, "keys"),
      POLICY_PUB_OUT: path.join(tmpDir, "agent-ws", "policy-authority.public.pem"),
      POLICY_DIR: path.join(tmpDir, "agent-ws", "policies"),
      PLANS_JSON: JSON.stringify({ free: { daily: 5 } }),
      DEMO_PASSWORD: "test-demo-pass-123",
      SHOPPING_WEB_SEARCH: "0",
      ACTIVITY_REPORTING: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
}

async function waitHealthy() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy. server log:\n${serverLog || "(no output)"}`);
}

async function register(email) {
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery", name: "Late" }),
  });
  assert.ok(r.ok, `register failed: ${r.status}`);
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie, "register set a session cookie");
  return cookie;
}

function chatSse(cookie, message, signal, sessionId) {
  return fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message, sessionId: sessionId || "" }),
    signal,
  });
}

/** Read SSE frames until pred(ev) is true; resolves that event. Releases the
 *  reader lock on exit so the same response can be read again. */
async function readSseUntil(res, pred, timeoutMs = 25000) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (Date.now() > deadline) throw new Error(`SSE timeout. buf=${buf.slice(-300)}`);
      const { done, value } = await reader.read();
      if (done) throw new Error(`stream ended before matching frame. buf=${buf.slice(-300)}`);
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!frame.startsWith("data: ")) continue;
        let ev;
        try { ev = JSON.parse(frame.slice(6)); } catch { continue; }
        if (pred(ev)) return ev;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(() => {
  try { if (server) server.kill(); } catch { /* already gone */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("boot + register fresh user", async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  startServer();
  const health = await waitHealthy();
  assert.ok(health.build, "health carries a build marker");
});

test("failed turn: no doomed retry, late pickup captured and served via GET", async () => {
  const cookie = await register(`late1-${Date.now()}@example.com`);
  const res = await chatSse(cookie, "order black running shoes");
  assert.ok(res.ok, `chat SSE responded ${res.status}`);
  const ev = await readSseUntil(res, (e) => e.type === "error" || e.type === "done");
  assert.equal(ev.type, "error", "stub turn fails");
  assert.match(ev.error || "", /cut off/, "friendly no-reply error surfaced");
  if (res.body && !res.body.locked) { try { await res.body.cancel(); } catch { /* done */ } }

  // The floor must have skipped the retry (3s left < 4s floor).
  assert.ok(!serverLog.includes("retry after no-reply"), "no doomed retry after no-reply");

  // Pickup fires after 300ms; poll the late endpoint for the captured reply.
  let late = null;
  for (let i = 0; i < 40 && !late; i += 1) {
    await sleep(250);
    const r = await fetch(`${BASE}/api/chat/late`, { headers: { Cookie: cookie } });
    assert.ok(r.ok, `late endpoint responded ${r.status}`);
    const j = await r.json();
    if (j.late) late = j.late;
  }
  assert.ok(late, "late pickup captured a reply");
  assert.match(late.text, /Late result:/, "captured text is the pickup reply");

  // Delivery is exactly-once: consumed by the first read.
  const again = await (await fetch(`${BASE}/api/chat/late`, { headers: { Cookie: cookie } })).json();
  assert.equal(again.late, null, "late delivery consumed on read");
});

test("late delivery flushes as a `late` frame on the session's next turn", async () => {
  const cookie = await register(`late2-${Date.now()}@example.com`);

  // Turn 1 fails and its pickup captures (delay 300ms + instant stub).
  // Pin the session from the start frame — exactly what the fixed UI does —
  // so the follow-up turn lands in the SAME conversation.
  const res1 = await chatSse(cookie, "another long task");
  const startEv = await readSseUntil(res1, (e) => e.type === "start");
  assert.ok(startEv.sessionId, "start frame carries sessionId");
  const sid = startEv.sessionId;
  await readSseUntil(res1, (e) => e.type === "error");
  try { if (res1.body && !res1.body.locked) await res1.body.cancel(); } catch { /* done */ }
  await sleep(2000); // let the pickup land

  // Turn 2 must flush the late reply before its own work starts.
  const ctrl = new AbortController();
  const res2 = await chatSse(cookie, "and one more", ctrl.signal, sid);
  assert.ok(res2.ok, `turn 2 responded ${res2.status}`);
  const lateEv = await readSseUntil(res2, (e) => e.type === "late" || e.type === "error");
  assert.equal(lateEv.type, "late", "late frame arrives before this turn's result");
  assert.match(lateEv.text, /Late result:/, "late frame carries the captured reply");
  ctrl.abort();
});
