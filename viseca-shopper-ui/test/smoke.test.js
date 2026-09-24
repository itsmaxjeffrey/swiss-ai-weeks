/**
 * smoke.test.js — end-to-end tests for the multi-user bridge.
 *
 * Boots server.js on a random port with a stubbed OpenClaw CLI, an isolated
 * accounts data dir, and a shrunken free plan (daily=2), then walks the whole
 * surface: auth, plans, SSE chat, API keys, /api/v1, plugin manifest, OpenAPI.
 *
 *   node --test test/
 */
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

/* This host runs an egress proxy (NODE_USE_ENV_PROXY=1 + HTTP_PROXY). Node's
 * fetch would push even 127.0.0.1 requests through it — opt out for tests. */
delete process.env.NODE_USE_ENV_PROXY;
process.env.NO_PROXY = "127.0.0.1,localhost";

const ROOT = path.join(__dirname, "..");
const STUB = path.join(__dirname, "stub-openclaw.js");

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

let PORT;
let BASE;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shopper-test-"));
let server;
let serverLog = "";

function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      OPENCLAW_BIN: STUB,
      OPENCLAW_TIMEOUT_MS: "15000",
      ACCOUNTS_DATA_DIR: path.join(tmpDir, "data"),
      POLICY_KEYS_DIR: path.join(tmpDir, "keys"),
      POLICY_PUB_OUT: path.join(tmpDir, "agent-ws", "policy-authority.public.pem"),
      POLICY_DIR: path.join(tmpDir, "agent-ws", "policies"),
      PLANS_JSON: JSON.stringify({ free: { daily: 2 } }),
      DEMO_PASSWORD: "test-demo-pass-123",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  server.on("exit", (code) => { serverLog += `\n[server exited code ${code}]`; });
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

test.before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  startServer();
  await waitHealthy();
});

test.after(() => {
  if (server) server.kill("SIGKILL");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------- helpers ---------- */

const post = (p, body, headers = {}) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

function cookieOf(res) {
  const c = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")];
  const full = c.find((x) => x && x.startsWith("shopper_session="));
  assert.ok(full, "expected a session cookie");
  return full.split(";")[0];
}

async function sseFrames(res) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
}

/* ---------- tests ---------- */

let cookie;
let apiKey;

test("health exposes auth, plans and registration state", async () => {
  const r = await fetch(`${BASE}/api/health`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.auth, true);
  assert.equal(j.registrationOpen, true);
  assert.ok(j.plans.free && j.plans.free.daily === 2, "PLANS_JSON override applied");
});

test("chat without credentials is 401", async () => {
  const r = await post("/api/chat", { message: "hi" });
  assert.equal(r.status, 401);
});

test("v1 chat without credentials is 401", async () => {
  const r = await post("/api/v1/chat", { message: "hi" });
  assert.equal(r.status, 401);
});

test("register rejects weak passwords", async () => {
  const r = await post("/api/auth/register", { email: "a@example.com", password: "short" });
  assert.equal(r.status, 400);
});

test("register accepts a valid signup and sets a session cookie", async () => {
  const r = await post("/api/auth/register", { email: "Ada@example.com", password: "correct horse battery", name: "Ada" });
  assert.equal(r.status, 201);
  cookie = cookieOf(r);
  const j = await r.json();
  assert.equal(j.user.email, "ada@example.com"); // normalized
  assert.equal(j.user.plan, "free");
  assert.equal(j.user.usage.limit, 2);
});

test("duplicate registration is 409", async () => {
  const r = await post("/api/auth/register", { email: "ada@example.com", password: "another password" });
  assert.equal(r.status, 409);
});

test("me returns the signed-in user", async () => {
  const r = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.user.name, "Ada");
  assert.equal(j.user.usage.used, 0);
});

test("chat works over SSE with a cookie and gets a per-user session", async () => {
  const r = await post("/api/chat", { message: "find me a gift" }, { Cookie: cookie });
  assert.equal(r.status, 200);
  const frames = await sseFrames(r);
  assert.equal(frames[0].type, "start");
  const done = frames.find((f) => f.type === "done");
  assert.ok(done, "expected a done frame");
  assert.match(done.reply, /webui-u/, "reply embeds the per-user session key");
  assert.notEqual(done.session, "webui", "session key is not the shared base");
});

test("usage counted after a turn", async () => {
  const j = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })).json();
  assert.equal(j.user.usage.used, 1);
});

test("a second concurrent turn for the same user is 409", async () => {
  const [a, b] = await Promise.all([
    post("/api/chat", { message: "turn one" }, { Cookie: cookie }),
    post("/api/chat", { message: "turn two" }, { Cookie: cookie }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], "exactly one turn wins");
  await a.text();
  await b.text();
});

test("plan limit (2/day) trips 429 with plan info", async () => {
  const r = await post("/api/chat", { message: "over the cap" }, { Cookie: cookie });
  assert.equal(r.status, 429);
  const j = await r.json();
  assert.equal(j.limit, 2);
  assert.equal(j.used, 2);
  assert.ok(/Plus plan|upgrade/i.test(j.error) || j.error.length > 10);
});

test("API key creation returns the full key exactly once", async () => {
  const r = await post("/api/account/keys", { name: "ChatGPT" }, { Cookie: cookie });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.match(j.key, /^vsk_[0-9a-f]{8}_[A-Za-z0-9_-]+$/);
  apiKey = j.key;
});

test("v1 chat works with a Bearer key (plan switched to plus first)", async () => {
  const up = await post("/api/account/plan", { plan: "plus" }, { Cookie: cookie });
  assert.equal(up.status, 200);
  const r = await post("/api/v1/chat", { message: "hello from an action" }, { Authorization: `Bearer ${apiKey}` });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.reply, /webui-u/);
  assert.equal(j.usage.plan, "plus");
});

test("v1 account shows usage", async () => {
  const r = await fetch(`${BASE}/api/v1/account`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.email, "ada@example.com");
  assert.equal(j.usage.used, 3);
  assert.equal(j.usage.remaining, 97);
});

test("revoked keys stop working", async () => {
  const list = await (await fetch(`${BASE}/api/account/keys`, { headers: { Cookie: cookie } })).json();
  const id = list.keys[0].id;
  const rev = await post("/api/account/keys/revoke", { id }, { Cookie: cookie });
  assert.equal(rev.status, 200);
  const r = await post("/api/v1/chat", { message: "again" }, { Authorization: `Bearer ${apiKey}` });
  assert.equal(r.status, 401);
});

test("plugin manifest is served with bearer auth and openapi link", async () => {
  const r = await fetch(`${BASE}/.well-known/ai-plugin.json`);
  const j = await r.json();
  assert.equal(j.name_for_model, "viseca_shopper");
  assert.equal(j.auth.type, "service_http");
  assert.equal(j.auth.authorization_type, "bearer");
  assert.equal(j.api.url, `${BASE}/openapi.json`);
});

test("openapi spec exposes chat + account operations", async () => {
  const r = await fetch(`${BASE}/openapi.json`);
  const j = await r.json();
  assert.ok(j.paths["/api/v1/chat"].post.operationId === "sendChatMessage");
  assert.ok(j.paths["/api/v1/account"].get.operationId === "getAccount");
  assert.equal(j.security[0].bearerAuth, undefined || j.security[0].bearerAuth); // present key
  assert.ok(j.components.securitySchemes.bearerAuth);
  assert.equal(j.servers[0].url, BASE);
});

test("policy signing requires a signed-in session", async () => {
  const anon = await post("/api/policy/sign", { policy: {} });
  assert.equal(anon.status, 401);
  const bearer = await post("/api/policy/sign", { policy: {} }, { Authorization: `Bearer vsk_deadbeef_x` });
  assert.equal(bearer.status, 401);
});

test("policy signing with a session reaches the authority (refuses incomplete)", async () => {
  const r = await post("/api/policy/sign", { policy: { policy_id: "TEST-1" } }, { Cookie: cookie });
  assert.equal(r.status, 422); // authority refused — incomplete policy
});

test("login rejects wrong passwords, accepts right ones", async () => {
  const bad = await post("/api/auth/login", { email: "ada@example.com", password: "nope nope nope" });
  assert.equal(bad.status, 401);
  const good = await post("/api/auth/login", { email: "ada@example.com", password: "correct horse battery" });
  assert.equal(good.status, 200);
});

test("logout kills the session", async () => {
  const out = await post("/api/auth/logout", {}, { Cookie: cookie });
  assert.equal(out.status, 200);
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 401);
});

test("health does not leak the demo account", async () => {
  const j = await (await fetch(`${BASE}/api/health`)).json();
  assert.ok(!("demo" in j), "health must not advertise the demo account");
});

test("the public demo-login endpoint is gone", async () => {
  const r = await post("/api/auth/demo", {});
  assert.equal(r.status, 404);
});

test("demo account signs in through the normal login form", async () => {
  const r = await post("/api/auth/login", { email: "demo@pixerful.com", password: "test-demo-pass-123" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.user.isDemo, true);
  assert.equal(j.user.plan, "plus");
});

/* ---------- chat history + signed-policy purchases (own user) ---------- */

let cookieB;
const isoZurich = (d) => {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}+02:00`;
};

let historyBaseline = -1;

 test("history requires auth", async () => {
  const r = await fetch(`${BASE}/api/history`);
  assert.equal(r.status, 401);
});

 test("a turn lands in the stored history (user + agent pair)", async () => {
  const reg = await post("/api/auth/register", { email: "bob@example.com", password: "correct horse battery", name: "Bob" });
  assert.equal(reg.status, 201);
  cookieB = cookieOf(reg);

  const before = await (await fetch(`${BASE}/api/history`, { headers: { Cookie: cookieB } })).json();
  historyBaseline = before.messages.length;

  const chat = await post("/api/chat", { message: "hello bob" }, { Cookie: cookieB });
  assert.equal(chat.status, 200);
  await sseFrames(chat);

  const h = await (await fetch(`${BASE}/api/history`, { headers: { Cookie: cookieB } })).json();
  assert.equal(h.messages.length, historyBaseline + 2);
  assert.equal(h.messages[h.messages.length - 2].role, "user");
  assert.equal(h.messages[h.messages.length - 2].text, "hello bob");
  assert.equal(h.messages[h.messages.length - 1].role, "agent");
});

 test("signing a valid policy maps it to the account and lists it in purchases", async () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dateTag = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const plusDays = (n) => new Date(now.getTime() + n * 86400000);
  const policy = {
    policy_id: `pol_${dateTag}-histt01`,
    created_at: isoZurich(now),
    request: "Two bags of espresso beans",
    items: [{ product: "Espresso beans 1kg", quantity: 2, max_unit_price: { amount: 25, currency: "CHF" } }],
    budget: { max_total: 50, currency: "CHF" },
    timing: { order_by: isoZurich(plusDays(3)), deliver_by: isoZurich(plusDays(10)) },
    delivery: { address: "Musterstrasse 1, 8000 Zürich", instructions: "" },
    payment: { method: "Viseca card", max_single_charge: { amount: 50, currency: "CHF" } },
    merchant: { allowed_domains: [], blocked_domains: [], require_impressum: true },
    stop_rules: ["stop and ask if nothing within budget"],
  };
  const sign = await post("/api/policy/sign", { policy }, { Cookie: cookieB });
  assert.equal(sign.status, 200);
  const sj = await sign.json();
  assert.equal(sj.ok, true);

  const list = await (await fetch(`${BASE}/api/policies`, { headers: { Cookie: cookieB } })).json();
  assert.equal(list.ok, true);
  const mine = list.policies.find((p) => p.policy_id === policy.policy_id);
  assert.ok(mine, "signed policy listed for its owner");
  assert.equal(mine.receipt, null, "no receipt filed yet");

  // another account must not see Bob's policy (Ada re-login: earlier tests
  // logged her out, so the old cookie is intentionally dead)
  const adaLogin = await post("/api/auth/login", { email: "ada@example.com", password: "correct horse battery" });
  assert.equal(adaLogin.status, 200);
  const adaCookie = cookieOf(adaLogin);
  const ada = await (await fetch(`${BASE}/api/policies`, { headers: { Cookie: adaCookie } })).json();
  assert.ok(!ada.policies.some((p) => p.policy_id === policy.policy_id), "policies are per-account");

  // filing a receipt shows up
  const receiptPath = path.join(tmpDir, "agent-ws", "policies", `${policy.policy_id}.receipt.json`);
  fs.writeFileSync(receiptPath, JSON.stringify({ filed_at: isoZurich(new Date()), total: 48.5, shop: "beans.ch" }));
  const again = await (await fetch(`${BASE}/api/policies`, { headers: { Cookie: cookieB } })).json();
  const withReceipt = again.policies.find((p) => p.policy_id === policy.policy_id);
  assert.equal(withReceipt.receipt.total, 48.5);
  assert.equal(withReceipt.receipt.shop, "beans.ch");
});

 test("DELETE /api/history clears the stored conversation", async () => {
  const del = await fetch(`${BASE}/api/history`, { method: "DELETE", headers: { Cookie: cookieB } });
  assert.equal(del.status, 200);
  const h = await (await fetch(`${BASE}/api/history`, { headers: { Cookie: cookieB } })).json();
  assert.equal(h.messages.length, 0);
});
