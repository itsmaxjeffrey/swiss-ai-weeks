/**
 * agent-friendly.test.js — unit tests for the agent-friendly shopping gate.
 *
 * shopping.js catalog site-search must never surface shops flagged
 * agent_friendly: 0 in data/merchants.json (bot-walled: DataDome, Cloudflare,
 * …). The shopping agent discovers shops through site search and onboarding
 * chips, so both surfaces stay agent-friendly only.
 *
 *   node --test test/agent-friendly.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-friendly-"));
const dataDir = path.join(tmpDir, "data");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "merchants.json"),
  JSON.stringify({
    merchants: [
      { domain: "ubereats.com", name: "Uber Eats", category: "Food delivery", agent_friendly: 0 },
      { domain: "migros.ch", name: "Migros Online", category: "Groceries", agent_friendly: 1 },
      // no flag → unprobed → defaults to allowed until measured hostile
      { domain: "hornbach.ch", name: "Hornbach", category: "DIY" },
    ],
  })
);

/* DATA_DIR, WEB_SEARCH and the dataset path are read at module load or first
 * use — env must come first. MERCHANTS_JSON_PATH points the gate at the
 * fixture; ACCOUNTS_DATA_DIR isolates the account stores. */
process.env.MERCHANTS_JSON_PATH = path.join(dataDir, "merchants.json");
process.env.ACCOUNTS_DATA_DIR = dataDir;
process.env.SHOPPING_WEB_SEARCH = "0";
const shopping = require("../shopping.js");

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("site search hides agent_friendly=0 catalog shops", async () => {
  const r = await shopping.searchSites("ubereats");
  assert.ok(Array.isArray(r), "search returns a list");
  assert.ok(!r.some((x) => x.domain === "ubereats.com"), "bot-walled ubereats.com must not surface");
});

test("site search still finds agent-friendly and unprobed catalog shops", async () => {
  const migros = await shopping.searchSites("migros");
  assert.ok(migros.some((x) => x.domain === "migros.ch"), "agent_friendly=1 shop surfaces");

  const hornbach = await shopping.searchSites("hornbach");
  assert.ok(hornbach.some((x) => x.domain === "hornbach.ch"), "unprobed catalog entry defaults to allowed");
});

test("searches matching only a bot-walled entry surface nothing", async () => {
  const r = await shopping.searchSites("eats"); // matches ubereats.com — blocked
  assert.ok(!r.some((x) => x.domain.endsWith("ubereats.com")), "blocked entry must not surface even when it is the only match");
});
