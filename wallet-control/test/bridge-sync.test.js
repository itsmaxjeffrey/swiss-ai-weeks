// LEASH wallet-control — shopper-bridge whitelist sync hook. Run: node test/bridge-sync.test.js
// Covers Worker.syncBridgeWhitelist (stubbed fetch) and its best-effort wiring
// inside resolveStepUp: the approval must never fail because the sync did.
import assert from 'node:assert/strict';
import { Worker } from '../lib/worker.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

function makeWorker(bridgeSync) {
  return new Worker({ client: {}, store: {}, profiles: {}, trust: null, trustedShops: null, bridgeSync });
}

/** Stub fetch: records calls, replies from a handler. */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (typeof body === 'string' ? Promise.reject(new TypeError('not JSON')) : body),
});

await test('unconfigured bridge sync reports skipped and never fetches', async () => {
  const f = stubFetch(() => { throw new Error('must not be called'); });
  const w = makeWorker({ fetchImpl: f });
  const out = await w.syncBridgeWhitelist('example.com');
  assert.deepEqual(out, { skipped: 'not configured' });
  assert.equal(f.calls.length, 0);
  // partially configured (missing token/user) counts as unconfigured too
  const w2 = makeWorker({ url: 'http://127.0.0.1:8794', fetchImpl: f });
  assert.ok((await w2.syncBridgeWhitelist('example.com')).skipped);
  assert.equal(f.calls.length, 0);
});

await test('success POSTs bare-domain + bearer token to the internal endpoint', async () => {
  const f = stubFetch(() => jsonResponse(201, { ok: true, added: 'example.com', already: false }));
  const w = makeWorker({ url: 'http://127.0.0.1:8794/', token: 'sekrit', user: 'owner@example.ch', fetchImpl: f });
  const out = await w.syncBridgeWhitelist('example.com');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://127.0.0.1:8794/api/internal/shopping/whitelist'); // trailing slash trimmed
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer sekrit');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { email: 'owner@example.ch', domain: 'example.com' });
  assert.equal(out.ok, true);
  assert.equal(out.status, 201);
  assert.equal(out.added, 'example.com');
  assert.equal(out.already, false);
  assert.equal(out.error, null);
});

await test('already-whitelisted response is ok with already=true', async () => {
  const f = stubFetch(() => jsonResponse(200, { ok: true, added: 'example.com', already: true }));
  const w = makeWorker({ url: 'http://127.0.0.1:8794', token: 't', user: 'u@x.ch', fetchImpl: f });
  const out = await w.syncBridgeWhitelist('example.com');
  assert.equal(out.ok, true);
  assert.equal(out.already, true);
});

await test('HTTP error surfaces the bridge error detail', async () => {
  const f = stubFetch(() => jsonResponse(404, { error: 'Unknown account.' }));
  const w = makeWorker({ url: 'http://127.0.0.1:8794', token: 't', user: 'u@x.ch', fetchImpl: f });
  const out = await w.syncBridgeWhitelist('example.com');
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.error, 'Unknown account.');
});

await test('non-JSON error body degrades to HTTP status text', async () => {
  const f = stubFetch(() => jsonResponse(500, 'boom'));
  const w = makeWorker({ url: 'http://127.0.0.1:8794', token: 't', user: 'u@x.ch', fetchImpl: f });
  const out = await w.syncBridgeWhitelist('example.com');
  assert.equal(out.ok, false);
  assert.equal(out.error, 'HTTP 500');
});

await test('network failure is caught, not thrown', async () => {
  const f = stubFetch(() => { throw new Error('ECONNREFUSED'); });
  const w = makeWorker({ url: 'http://127.0.0.1:8794', token: 't', user: 'u@x.ch', fetchImpl: f });
  const out = await w.syncBridgeWhitelist('example.com');
  assert.equal(out.ok, false);
  assert.equal(out.error, 'ECONNREFUSED');
});

await test('resolveStepUp with whitelist mirrors the trusted domain to the bridge', async () => {
  const added = [];
  const store = {
    recordStepUpResolution: () => ({ decision: { merchantDomain: 'https://www.example.com/checkout', merchant: 'Example AG' } }),
    addTrustedDomain: (d, note) => { added.push({ d, note }); return 'example.com'; }, // mirrors real Store's normalized return
  };
  const resolved = [];
  const client = { resolve: async (id, body) => { resolved.push({ id, body }); } };
  const f = stubFetch(() => jsonResponse(201, { ok: true, added: 'example.com', already: false }));
  const w = new Worker({ client, store, profiles: {}, trust: null, bridgeSync: { url: 'http://127.0.0.1:8794', token: 't', user: 'u@x.ch', fetchImpl: f } });

  const out = await w.resolveStepUp('run_1', 'AU_1', 'approve', 'ok', { whitelist: true });

  assert.deepEqual(resolved, [{ id: 'AU_1', body: { decision: 'approve', customer_message: 'ok' } }]);
  assert.deepEqual(added, [{ d: 'https://www.example.com/checkout', note: 'customer approved during purchase review' }]);
  assert.equal(JSON.parse(f.calls[0].init.body).domain, 'example.com'); // normalized domain, not the URL
  assert.equal(out.ok, true);
  assert.equal(out.whitelist_added, 'example.com');
  assert.equal(out.bridge_sync.ok, true);
  const trust = w.feed.find((e) => e.kind === 'trust');
  assert.ok(trust, 'trust feed entry exists');
  assert.equal(trust.bridge_sync, 'also whitelisted in the shopper bridge');
});

await test('bridge sync failure never fails the approval (best-effort)', async () => {
  const store = {
    recordStepUpResolution: () => ({ decision: { merchantDomain: 'example.com' } }),
    addTrustedDomain: (d) => d,
  };
  const client = { resolve: async () => {} };
  const f = stubFetch(() => { throw new Error('ECONNREFUSED'); });
  const w = new Worker({ client, store, profiles: {}, trust: null, bridgeSync: { url: 'http://127.0.0.1:8794', token: 't', user: 'u@x.ch', fetchImpl: f } });

  const out = await w.resolveStepUp('run_1', 'AU_1', 'approve', null, { whitelist: true });

  assert.equal(out.ok, true, 'approval still ok');
  assert.equal(out.bridge_sync.ok, false);
  const trust = w.feed.find((e) => e.kind === 'trust');
  assert.match(trust.bridge_sync, /^shopper-bridge sync failed: ECONNREFUSED$/);
});

await test('unconfigured sync still records the trust feed entry with skip outcome', async () => {
  const store = {
    recordStepUpResolution: () => ({ decision: { merchantDomain: 'example.com' } }),
    addTrustedDomain: (d) => d,
  };
  const w = new Worker({ client: { resolve: async () => {} }, store, profiles: {}, trust: null, bridgeSync: null });
  const out = await w.resolveStepUp('run_1', 'AU_1', 'approve', null, { whitelist: true });
  assert.equal(out.ok, true);
  assert.ok(out.bridge_sync.skipped);
  const trust = w.feed.find((e) => e.kind === 'trust');
  assert.equal(trust.bridge_sync, 'shopper-bridge sync skipped (not configured)');
});

await test('decline never touches the bridge', async () => {
  const f = stubFetch(() => { throw new Error('must not be called'); });
  const store = {
    recordStepUpResolution: () => ({ decision: { merchantDomain: 'example.com' } }),
    addTrustedDomain: () => { throw new Error('must not be called'); },
  };
  const w = new Worker({ client: { resolve: async () => {} }, store, profiles: {}, trust: null, bridgeSync: { url: 'http://x', token: 't', user: 'u', fetchImpl: f } });
  const out = await w.resolveStepUp('run_1', 'AU_1', 'decline', null, { whitelist: true });
  assert.equal(out.ok, true);
  assert.equal(out.whitelist_added, null);
  assert.equal(out.bridge_sync, null);
  assert.equal(f.calls.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
