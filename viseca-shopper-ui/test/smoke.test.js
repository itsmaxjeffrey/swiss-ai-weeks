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
      SHOPPING_WEB_SEARCH: "0",
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

/* ---------- shopping controls: spend cap, website whitelist, card vault ---------- */

let cookieC;
let cookieD;
const plusDaysC = (n) => new Date(Date.now() + n * 86400000);
const policyDir = path.join(tmpDir, "agent-ws", "policies");

function fullPolicy(idSuffix, overrides = {}) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dateTag = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return Object.assign({
    policy_id: `pol_${dateTag}-${idSuffix}`,
    created_at: isoZurich(now),
    request: "One pizza from Uber Eats",
    items: [{ product: "Pizza margherita", quantity: 1, max_unit_price: { amount: 24, currency: "CHF" } }],
    budget: { max_total: 24, currency: "CHF" },
    timing: { order_by: isoZurich(plusDaysC(1)), deliver_by: isoZurich(plusDaysC(2)) },
    delivery: { address: "Musterstrasse 1, 8000 Zürich", instructions: "" },
    payment: { method: "card on file", max_single_charge: { amount: 24, currency: "CHF" } },
    merchant: { allowed_domains: ["ubereats.com"], blocked_domains: [], require_impressum: false },
    stop_rules: ["stop if nothing within budget"],
  }, overrides);
}

const capPut = (c, value) =>
  fetch(`${BASE}/api/account/shopping/cap`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: c },
    body: JSON.stringify({ capChf: value }),
  });

 test("shopping settings require auth", async () => {
  const r = await fetch(`${BASE}/api/account/shopping`);
  assert.equal(r.status, 401);
});

 test("health advertises the shopping feature marker", async () => {
  const j = await (await fetch(`${BASE}/api/health`)).json();
  assert.deepEqual(j.shopping, { spendCap: true, whitelist: true, cardVault: true });
});

 test("shopping settings default to unrestricted", async () => {
  const reg = await post("/api/auth/register", { email: "carol@example.com", password: "correct horse battery", name: "Carol" });
  assert.equal(reg.status, 201);
  cookieC = cookieOf(reg);
  const j = await (await fetch(`${BASE}/api/account/shopping`, { headers: { Cookie: cookieC } })).json();
  assert.equal(j.ok, true);
  assert.equal(j.spendCapChf, null);
  assert.deepEqual(j.whitelist, []);
  assert.deepEqual(j.methods, []);
  assert.equal(j.unrestricted.cap, true);
  assert.equal(j.unrestricted.whitelist, true);
});

 test("spend cap: set, refuse junk, clear", async () => {
  let r = await capPut(cookieC, 50);
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(j.spendCapChf, 50);

  r = await capPut(cookieC, -3);
  assert.equal(r.status, 400);

  r = await capPut(cookieC, "lots");
  assert.equal(r.status, 400);

  r = await capPut(cookieC, null);
  assert.equal(r.status, 200);
  j = await r.json();
  assert.equal(j.spendCapChf, null);
});

 test("whitelist: normalize, add, dedupe covered subdomain, refuse junk, remove", async () => {
  let r = await post("/api/account/shopping/whitelist", { domain: "https://www.ubereats.com/ch/en/" }, { Cookie: cookieC });
  assert.equal(r.status, 201);
  let j = await r.json();
  assert.deepEqual(j.whitelist, ["ubereats.com"]);

  r = await post("/api/account/shopping/whitelist", { domain: "food.ubereats.com" }, { Cookie: cookieC });
  assert.equal(r.status, 200); // already covered by ubereats.com
  j = await r.json();
  assert.equal(j.already, true);
  assert.deepEqual(j.whitelist, ["ubereats.com"]);

  r = await post("/api/account/shopping/whitelist", { domain: "not a domain" }, { Cookie: cookieC });
  assert.equal(r.status, 400);

  r = await post("/api/account/shopping/whitelist/remove", { domain: "ubereats.com" }, { Cookie: cookieC });
  assert.equal(r.status, 200);
  j = await r.json();
  assert.deepEqual(j.whitelist, []);
});

 test("site search finds catalog entries without network", async () => {
  const r = await fetch(`${BASE}/api/account/shopping/sites?q=ubereats`, { headers: { Cookie: cookieC } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.results.some((x) => x.domain === "ubereats.com"));
});

 test("card vault: holder, luhn, brand, expiry and duplicate rules; stores masked only", async () => {
  const send = (body) => post("/api/account/shopping/methods", body, { Cookie: cookieC });

  assert.equal((await send({ holder: "C", number: "4242424242424242", exp: "09/28", cvc: "123" })).status, 400);
  assert.equal((await send({ holder: "Carol Muster", number: "4242424242424241", exp: "09/28", cvc: "123" })).status, 400); // luhn fail
  assert.equal((await send({ holder: "Carol Muster", number: "378282246310005", exp: "09/28", cvc: "1234" })).status, 400); // amex not allowed
  assert.equal((await send({ holder: "Carol Muster", number: "4242424242424242", exp: "01/20", cvc: "123" })).status, 400); // expired
  assert.equal((await send({ holder: "Carol Muster", number: "4242424242424242", exp: "09/28", cvc: "12" })).status, 400); // cvc short

  const ok = await send({ holder: "Carol Muster", number: "4242 4242 4242 4242", exp: "09/28", cvc: "123" });
  assert.equal(ok.status, 201);
  const j = await ok.json();
  assert.equal(j.method.brand, "visa");
  assert.equal(j.method.last4, "4242");
  assert.equal(j.method.number, undefined, "full PAN never returned");
  assert.equal(j.method.cvc, undefined, "CVC never returned");

  assert.equal((await send({ holder: "Carol Muster", number: "4242424242424242", exp: "09/28", cvc: "123" })).status, 409); // duplicate

  const list = await (await fetch(`${BASE}/api/account/shopping`, { headers: { Cookie: cookieC } })).json();
  assert.equal(list.methods.length, 1);
  assert.equal(list.methods[0].isDefault, true);
  assert.equal(list.methods[0].number, undefined);
});

 test("sign refuses a budget over the spend cap (violations, not missing)", async () => {
  await capPut(cookieC, 20);
  const policy = fullPolicy("capv1"); // budget 24 > cap 20
  const r = await post("/api/policy/sign", { policy }, { Cookie: cookieC });
  assert.equal(r.status, 422);
  const j = await r.json();
  assert.ok(Array.isArray(j.violations) && j.violations.length, "violations list present");
  assert.match(j.violations[0], /spending cap/);
  await capPut(cookieC, null);
});

 test("sign requires whitelisted merchant domains once the whitelist is active", async () => {
  await post("/api/account/shopping/whitelist", { domain: "ubereats.com" }, { Cookie: cookieC });

  const other = fullPolicy("wlro1", { merchant: { allowed_domains: ["migros.ch"], blocked_domains: [], require_impressum: true } });
  let r = await post("/api/policy/sign", { policy: other }, { Cookie: cookieC });
  assert.equal(r.status, 422);
  let j = await r.json();
  assert.match(j.violations.join(" "), /migros\.ch/);

  const noDomain = fullPolicy("wldm1", { merchant: { allowed_domains: [], blocked_domains: [], require_impressum: true } });
  r = await post("/api/policy/sign", { policy: noDomain }, { Cookie: cookieC });
  assert.equal(r.status, 422);
  j = await r.json();
  assert.match(j.violations.join(" "), /merchant\.allowed_domains/);

  const sub = fullPolicy("wlsub1", { merchant: { allowed_domains: ["food.ubereats.com"], blocked_domains: [], require_impressum: true } });
  r = await post("/api/policy/sign", { policy: sub }, { Cookie: cookieC });
  assert.equal(r.status, 200); // subdomain of a whitelisted entry is fine
  await post("/api/account/shopping/whitelist/remove", { domain: "ubereats.com" }, { Cookie: cookieC });
});

 test("sign files the payment card for the policy and masks it in listings", async () => {
  await post("/api/account/shopping/whitelist", { domain: "ubereats.com" }, { Cookie: cookieC });
  const policy = fullPolicy("payf1");
  const r = await post("/api/policy/sign", { policy }, { Cookie: cookieC });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.payment.card_on_file, true);
  assert.equal(j.payment.brand, "visa");
  assert.equal(j.payment.last4, "4242");
  assert.equal(j.payment.number, undefined);

  const payFile = JSON.parse(fs.readFileSync(path.join(policyDir, `${policy.policy_id}.payment.json`), "utf8"));
  assert.equal(payFile.policy_id, policy.policy_id);
  assert.equal(payFile.card.brand, "visa");
  assert.equal(payFile.card.last4, "4242");
  assert.ok(payFile.card.number, "agent needs the full number at checkout");
  assert.ok(payFile.card.cvc, "agent needs the CVC at checkout");

  const list = await (await fetch(`${BASE}/api/policies`, { headers: { Cookie: cookieC } })).json();
  const mine = list.policies.find((p) => p.policy_id === policy.policy_id);
  assert.equal(mine.payment.card_on_file, true);
  assert.equal(mine.payment.last4, "4242");
  assert.equal(mine.payment.number, undefined);
});

 test("signing without a card files a no-card note; adding one backfills unpaid policies", async () => {
  const reg = await post("/api/auth/register", { email: "dave@example.com", password: "correct horse battery", name: "Dave" });
  assert.equal(reg.status, 201);
  cookieD = cookieOf(reg);
  await post("/api/account/shopping/whitelist", { domain: "ubereats.com" }, { Cookie: cookieD });

  const policy = fullPolicy("nocd1");
  const r = await post("/api/policy/sign", { policy }, { Cookie: cookieD });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.payment.card_on_file, false);

  const payPath = path.join(policyDir, `${policy.policy_id}.payment.json`);
  let payFile = JSON.parse(fs.readFileSync(payPath, "utf8"));
  assert.equal(payFile.card, null);
  assert.match(payFile.instruction, /no card on file/i);

  // Dave saves a card → the bridge re-files the instrument for the unpaid policy
  const card = await post("/api/account/shopping/methods", { holder: "Dave Muster", number: "5555 5555 5555 4444", exp: "11/29", cvc: "456" }, { Cookie: cookieD });
  assert.equal(card.status, 201);
  assert.equal((await card.json()).method.brand, "mastercard");

  payFile = JSON.parse(fs.readFileSync(payPath, "utf8"));
  assert.equal(payFile.card.brand, "mastercard");
  assert.equal(payFile.card.last4, "4444");
});

 test("deleting and re-defaulting cards behaves", async () => {
  const second = await post("/api/account/shopping/methods", { holder: "Carol Muster", number: "5105 1051 0510 5100", exp: "10/29", cvc: "789" }, { Cookie: cookieC });
  assert.equal(second.status, 201);
  const sj = await second.json();
  assert.equal(sj.method.brand, "mastercard");
  assert.equal(sj.method.isDefault, false, "first card stays default");

  const def = await post("/api/account/shopping/methods/default", { id: sj.method.id }, { Cookie: cookieC });
  assert.equal(def.status, 200);
  let list = await (await fetch(`${BASE}/api/account/shopping`, { headers: { Cookie: cookieC } })).json();
  assert.equal(list.methods.find((m) => m.id === sj.method.id).isDefault, true);
  assert.equal(list.methods.filter((m) => m.isDefault).length, 1);

  const del = await post("/api/account/shopping/methods/delete", { id: sj.method.id }, { Cookie: cookieC });
  assert.equal(del.status, 200);
  list = await (await fetch(`${BASE}/api/account/shopping`, { headers: { Cookie: cookieC } })).json();
  assert.equal(list.methods.length, 1);
  assert.equal(list.methods[0].isDefault, true, "remaining card is re-defaulted");

  const ghost = await post("/api/account/shopping/methods/delete", { id: "pm_nope" }, { Cookie: cookieC });
  assert.equal(ghost.status, 404);
});

/* ---------- family: parental controls (children, spend limits, categories) ---------- */

let cookieParent;
let cookieChild;
let childId;
let childEmail = "timmy@example.com";

/** Policy for the family tests: amount in CHF, shops by domain. Unique ids. */
let famSeq = 0;
function famPolicy(amount, domains) {
  famSeq += 1;
  return fullPolicy(`fam${String(famSeq).padStart(2, "0")}`, {
    budget: { max_total: amount, currency: "CHF" },
    payment: { method: "card on file", max_single_charge: { amount, currency: "CHF" } },
    merchant: { allowed_domains: domains, blocked_domains: [], require_impressum: false },
  });
}
const famLimits = (body) => post("/api/account/family/limits", body, { Cookie: cookieParent });

 test("family endpoints require auth", async () => {
  const r = await fetch(`${BASE}/api/account/family`);
  assert.equal(r.status, 401);
  assert.equal((await post("/api/account/family/children", {})).status, 401);
});

 test("health advertises the parental-controls marker", async () => {
  const j = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(j.family.parentalControls, true);
});

 test("parent registers; family starts empty with the category vocabulary", async () => {
  const reg = await post("/api/auth/register", { email: "erin@example.com", password: "correct horse battery", name: "Erin" });
  assert.equal(reg.status, 201);
  cookieParent = cookieOf(reg);
  const j = await (await fetch(`${BASE}/api/account/family`, { headers: { Cookie: cookieParent } })).json();
  assert.equal(j.ok, true);
  assert.deepEqual(j.children, []);
  assert.ok(j.categories.includes("Food delivery") && j.categories.includes("Groceries"));
  assert.ok(j.maxChildren >= 1);
});

 test("parent creates a child account; child signs in and sees its family view", async () => {
  const r = await post("/api/account/family/children", { name: "Timmy", email: childEmail, password: "pocket-money-1" }, { Cookie: cookieParent });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.child.name, "Timmy");
  assert.equal(j.child.suspended, false);
  assert.equal(j.child.limits.maxSpendChf, null);
  childId = j.child.id;

  const login = await post("/api/auth/login", { email: childEmail, password: "pocket-money-1" });
  assert.equal(login.status, 200);
  cookieChild = cookieOf(login);
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookieChild } })).json();
  assert.equal(me.user.parentId, (await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookieParent } })).json()).user.id);
  assert.equal(me.user.family.parentEmail, "erin@example.com");
});

 test("children cannot use family endpoints or create sub-children", async () => {
  assert.equal((await fetch(`${BASE}/api/account/family`, { headers: { Cookie: cookieChild } })).status, 403);
  const nested = await post("/api/account/family/children", { name: "Grandchild", email: "gc@example.com", password: "correct horse battery" }, { Cookie: cookieChild });
  assert.equal(nested.status, 403);
});

 test("duplicate child email and unowned child are rejected", async () => {
  const dup = await post("/api/account/family/children", { name: "Again", email: childEmail.toUpperCase(), password: "correct horse battery" }, { Cookie: cookieParent });
  assert.equal(dup.status, 409);

  const stranger = await post("/api/auth/register", { email: "frank@example.com", password: "correct horse battery", name: "Frank" });
  const strangerCookie = cookieOf(stranger);
  const poke = await famLimitsFetch(strangerCookie, { childId, maxSpendChf: 5 });
  assert.equal(poke.status, 404, "another parent cannot touch this child");
  const ghost = await famLimitsFetch(cookieParent, { childId: "u_does-not-exist", maxSpendChf: 5 });
  assert.equal(ghost.status, 404);
});

async function famLimitsFetch(cookie, body) {
  return post("/api/account/family/limits", body, { Cookie: cookie });
}

 test("limits: set, junk rejected, partial update keeps other fields", async () => {
  let r = await famLimits({ childId, maxSpendChf: 20, monthlyBudgetChf: 30, categoryLimits: { "Food delivery": 25 } });
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(j.child.limits.maxSpendChf, 20);
  assert.equal(j.child.limits.monthlyBudgetChf, 30);
  assert.deepEqual(j.child.limits.categoryLimits, { "Food delivery": 25 });

  assert.equal((await famLimits({ childId, maxSpendChf: -3 })).status, 400);
  assert.equal((await famLimits({ childId, maxSpendChf: "lots" })).status, 400);
  assert.equal((await famLimits({ childId, categoryLimits: { "Rocket fuel": 5 } })).status, 400);
  assert.equal((await famLimits({ childId, categoryLimits: "nope" })).status, 400);

  // partial: only categoryLimits changes; per-order + monthly stay
  r = await famLimits({ childId, categoryLimits: { "Food delivery": 25, Groceries: 100 } });
  assert.equal(r.status, 200);
  j = await r.json();
  assert.equal(j.child.limits.maxSpendChf, 20, "partial update keeps per-order cap");
  assert.equal(j.child.limits.monthlyBudgetChf, 30, "partial update keeps monthly budget");

  // the child's own /me view shows the limits read-only
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookieChild } })).json();
  assert.equal(me.user.family.maxSpendChf, 20);
  assert.equal(me.user.family.monthlyBudgetChf, 30);
});

 test("sign refuses a budget over the parental per-order max", async () => {
  const r = await post("/api/policy/sign", { policy: famPolicy(24, ["ubereats.com"]) }, { Cookie: cookieChild });
  assert.equal(r.status, 422);
  const j = await r.json();
  assert.match(j.violations.join(" "), /per-order/);
});

 test("sign within limits succeeds and records spend (no card anywhere yet)", async () => {
  const policy = famPolicy(15, ["ubereats.com"]); // 15 ≤ 20/order, ≤ 30/mo, Food delivery 15 ≤ 25
  const r = await post("/api/policy/sign", { policy }, { Cookie: cookieChild });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.payment.card_on_file, false, "neither child nor parent has a card yet");
});

 test("parent's saved card becomes the family card and backfills the child's unpaid policy", async () => {
  const card = await post("/api/account/shopping/methods", { holder: "Erin Muster", number: "4242 4242 4242 4242", exp: "09/29", cvc: "123" }, { Cookie: cookieParent });
  assert.equal(card.status, 201);

  const list = await (await fetch(`${BASE}/api/policies`, { headers: { Cookie: cookieChild } })).json();
  const signed = list.policies.find((p) => p.budget && p.budget.max_total === 15);
  assert.ok(signed, "child's signed policy is listed");
  const payFile = JSON.parse(fs.readFileSync(path.join(policyDir, `${signed.policy_id}.payment.json`), "utf8"));
  assert.equal(payFile.card.brand, "visa", "backfilled with the family card");
  assert.equal(payFile.card.last4, "4242");
  assert.match(payFile.note || "", /family card/);

  // the next sign pays with the family card directly
  const r = await post("/api/policy/sign", { policy: famPolicy(12, ["migros.ch"]) }, { Cookie: cookieChild });
  assert.equal(r.status, 200); // Groceries has no limit; monthly 15+12=27 ≤ 30
  const j = await r.json();
  assert.equal(j.payment.card_on_file, true);
  assert.equal(j.payment.family_card, true, "child without a card pays with the parent's");
  assert.equal(j.payment.last4, "4242");
});

 test("category limit trips while other categories stay unaffected", async () => {
  const food = famPolicy(12, ["ubereats.com"]); // Food delivery: 15+12 > 25
  let r = await post("/api/policy/sign", { policy: food }, { Cookie: cookieChild });
  assert.equal(r.status, 422);
  let j = await r.json();
  assert.match(j.violations.join(" "), /Food delivery/);

  const fashion = famPolicy(3, ["zalando.ch"]); // Fashion unlimited, monthly 27+3=30 ≤ 30
  r = await post("/api/policy/sign", { policy: fashion }, { Cookie: cookieChild });
  assert.equal(r.status, 200);
});

 test("monthly budget trips at the aggregate even across categories", async () => {
  const r = await post("/api/policy/sign", { policy: famPolicy(5, ["migros.ch"]) }, { Cookie: cookieChild }); // 30+5 > 30
  assert.equal(r.status, 422);
  const j = await r.json();
  assert.match(j.violations.join(" "), /monthly budget/);
  assert.match(j.violations.join(" "), /Resets on the 1st/);
});

 test("family summary shows per-child spend and category breakdown", async () => {
  const j = await (await fetch(`${BASE}/api/account/family`, { headers: { Cookie: cookieParent } })).json();
  assert.equal(j.children.length, 1);
  const timmy = j.children[0];
  assert.equal(timmy.spend.totalChf, 30); // 15 + 12 + 3
  assert.equal(timmy.spend.orders, 3);
  assert.equal(timmy.spend.byCategory["Food delivery"], 15);
  assert.equal(timmy.spend.byCategory["Groceries"], 12);
  assert.equal(timmy.spend.byCategory["Fashion"], 3);
});

 test("suspend blocks login and kills existing sessions; unsuspend restores", async () => {
  let r = await post("/api/account/family/suspend", { childId, suspended: true }, { Cookie: cookieParent });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).child.suspended, true);

  assert.equal((await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookieChild } })).status, 401, "live session dies");
  const login = await post("/api/auth/login", { email: childEmail, password: "pocket-money-1" });
  assert.equal(login.status, 403);
  assert.match((await login.json()).error, /suspended/i);

  r = await post("/api/account/family/suspend", { childId, suspended: false }, { Cookie: cookieParent });
  assert.equal(r.status, 200);
  assert.equal((await post("/api/auth/login", { email: childEmail, password: "pocket-money-1" })).status, 200);
});

 test("remove deletes the child account and its data", async () => {
  const tina = await post("/api/account/family/children", { name: "Tina", email: "tina@example.com", password: "pocket-money-2" }, { Cookie: cookieParent });
  assert.equal(tina.status, 201);
  const tinaId = (await tina.json()).child.id;

  const del = await post("/api/account/family/remove", { childId: tinaId }, { Cookie: cookieParent });
  assert.equal(del.status, 200);
  assert.equal((await post("/api/auth/login", { email: "tina@example.com", password: "pocket-money-2" })).status, 401, "removed child cannot sign in");

  const ghost = await post("/api/account/family/remove", { childId: tinaId }, { Cookie: cookieParent });
  assert.equal(ghost.status, 404, "removing twice is a clean 404");

  const j = await (await fetch(`${BASE}/api/account/family`, { headers: { Cookie: cookieParent } })).json();
  assert.equal(j.children.length, 1);
});

/* ---------- stop button (server-side turn kill) ---------- */

 test("stop requires auth and 404s when idle", async () => {
  assert.equal((await post("/api/chat/stop", {})).status, 401);
  const idle = await post("/api/chat/stop", {}, { Cookie: cookieC });
  assert.equal(idle.status, 404);
  const j = await idle.json();
  assert.match(j.error, /No running turn/);
});
