#!/usr/bin/env node
/**
 * refresh-category-sites.mjs — weekly "top shops per product category" pipeline.
 *
 * Searches the web (DuckDuckGo HTML endpoint) for ~85 Swiss shopping categories,
 * ranks the domains that show up, and writes a deterministic, reproducible
 * artifact for viseca-shopper to consume:
 *
 *   data/category-sites/raw/<YYYY-MM-DD>/<category>__<query#>.json   raw evidence
 *   data/category-sites/category-sites.json                          the artifact
 *   data/category-sites/manifest.json                                sha256 + run report
 *
 * Reproducibility contract:
 *   - The artifact contains NO wall-clock time — only the raw-run date. Rebuilding
 *     from the same raw dir (`--build --date <d>`) yields byte-identical output
 *     (same sha256).
 *   - Every raw fetch is archived with provenance (query, fetchedAt, sha256 in
 *     manifest). Failed queries are never written as stubs — they are listed in
 *     the manifest and excluded from scoring.
 *   - Scoring is position-weighted and deterministic: score = Σ 1/(1+rank_index)
 *     over queries, curated-seed domains get +1.0, ties broken alphabetically.
 *
 * Modes:
 *   --search                 collect fresh raw results (default), then build
 *   --build [--date D]       rebuild artifact offline from raw/<D> (default: latest)
 *   --only id1,id2           restrict to a category subset (smoke runs)
 *   --limit-queries N        cap queries per category (smoke runs)
 *   --list-categories        print the category table and exit
 *   --dry-run                print the plan (categories/queries/paths), no network
 *   --keep-runs N            raw-run retention (default 5, oldest pruned after build)
 *
 * Env: CATEGORY_SEARCH_DELAY_MS (default 1100), CATEGORY_TIMEOUT_MS (default 15000)
 *
 * Exit codes: 0 ok · 1 unexpected error · 2 too many failed queries (artifact left untouched)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_VERSION = "1.0.0";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data", "category-sites");
const RAW_DIR = path.join(DATA_DIR, "raw");
const ARTIFACT = path.join(DATA_DIR, "category-sites.json");
const MANIFEST = path.join(DATA_DIR, "manifest.json");
const MIRROR = path.resolve(ROOT, "..", "viseca-shopper-ui", "data", "category-sites.json");

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const DELAY_MS = parseInt(process.env.CATEGORY_SEARCH_DELAY_MS || "5000", 10);
const TIMEOUT_MS = parseInt(process.env.CATEGORY_TIMEOUT_MS || "15000", 10);
const TOP_N = 20;
const MIN_QUERY_SUCCESS_RATE = 0.6; // below this: exit 2, artifact untouched
const DDG = "https://html.duckduckgo.com/html/";

/* ------------------------------------------------------------------ */
/* Category set — [id, labelDe, labelEn, department, curated seeds]     */
/* Queries are derived deterministically:                               */
/*   q1 = "<labelDe> online shop Schweiz"  (kl=ch-de)                   */
/*   q2 = "<labelEn> online shop Switzerland" (kl=ch-en)                */
/* Seeds are boost-if-seen (+1.0): they win ties but search evidence    */
/* always beats them, and dead seeds can never surface.                 */
/* ------------------------------------------------------------------ */

const CATS = [
  // --- Food & Drink
  ["groceries", "Lebensmittel", "Groceries", "Food & Drink", "migros.ch,coop.ch,farmy.ch,volg.ch,aldi-suisse.ch,lidl.ch"],
  ["organic-food", "Bio-Lebensmittel", "Organic food", "Food & Drink", "farmy.ch,migros.ch"],
  ["drinks-wine", "Wein", "Wine", "Food & Drink", ""],
  ["beer-spirits", "Bier und Spirituosen", "Beer and spirits", "Food & Drink", ""],
  ["coffee-tea", "Kaffee und Tee", "Coffee and tea", "Food & Drink", ""],
  ["chocolate-sweets", "Schokolade und Süssigkeiten", "Chocolate and sweets", "Food & Drink", "laederach.ch,spruengli.ch"],
  ["cheese-deli", "Käse und Delikatessen", "Cheese and delicatessen", "Food & Drink", ""],
  ["meat-fish", "Fleisch und Fisch", "Meat and fish", "Food & Drink", ""],
  ["bakery-cake", "Backwaren und Torten", "Bakery and cakes", "Food & Drink", ""],
  ["food-delivery", "Essen Lieferung", "Food delivery", "Food & Drink", "ubereats.com,justeat.ch,smood.ch,deliveroo.ch,lieferando.ch"],
  ["meal-kits", "Rezeptboxen", "Meal kits", "Food & Drink", "hellofresh.ch"],
  // --- Electronics
  ["electronics", "Elektronik", "Consumer electronics", "Electronics", "digitec.ch,galaxus.ch,brack.ch,interdiscount.ch,microspot.ch"],
  ["phones", "Handys und Smartphones", "Smartphones and phones", "Electronics", "digitec.ch,galaxus.ch,brack.ch,mediamarkt.ch"],
  ["computers", "Computer und Laptops", "Computers and laptops", "Electronics", "digitec.ch,galaxus.ch,brack.ch,pcp.ch"],
  ["pc-components", "PC-Komponenten", "PC components", "Electronics", "pcp.ch,digitec.ch,brack.ch"],
  ["gaming-consoles", "Spielekonsolen", "Game consoles", "Electronics", "brack.ch,microspot.ch,digitec.ch"],
  ["photo-video", "Kamera und Foto", "Cameras and photo", "Electronics", "digitec.ch,brack.ch"],
  ["tv-hifi", "TV und HiFi", "TV and hifi", "Electronics", "fust.ch,brack.ch,digitec.ch"],
  ["audio-headphones", "Kopfhörer und Audio", "Headphones and audio", "Electronics", "digitec.ch,brack.ch"],
  ["smart-home", "Smart Home", "Smart home", "Electronics", "digitec.ch,brack.ch"],
  ["large-appliances", "Grosshaushaltsgeräte", "Large home appliances", "Electronics", "fust.ch,microspot.ch"],
  ["small-appliances", "Küchengeräte", "Small kitchen appliances", "Electronics", "fust.ch,galaxus.ch"],
  ["refurbished", "Refurbished Elektronik", "Refurbished electronics", "Electronics", "revendo.ch,refurbed.ch"],
  // --- Fashion
  ["fashion-women", "Damenmode", "Women's fashion", "Fashion", "zalando.ch,aboutyou.ch,hm.com,manor.ch"],
  ["fashion-men", "Herrenmode", "Men's fashion", "Fashion", "zalando.ch,aboutyou.ch"],
  ["fashion-kids", "Kindermode", "Children's clothing", "Fashion", "zalando.ch,manor.ch"],
  ["shoes", "Schuhe", "Shoes", "Fashion", "zalando.ch,aboutyou.ch,galaxus.ch"],
  ["sneakers", "Sneaker", "Sneakers", "Fashion", "zalando.ch,aboutyou.ch"],
  ["sportswear", "Sportkleidung", "Sportswear", "Fashion", "ochsnersport.ch,zalando.ch"],
  ["underwear-lingerie", "Unterwäsche", "Underwear and lingerie", "Fashion", "zalando.ch,hm.com"],
  ["bags-accessories", "Taschen und Accessoires", "Bags and accessories", "Fashion", "freitag.ch"],
  ["jewelry-watches", "Schmuck und Uhren", "Jewelry and watches", "Fashion", "christ.ch,bucherer.ch,manor.ch"],
  ["eyewear", "Brillen und Kontaktlinsen", "Glasses and contact lenses", "Fashion", ""],
  // --- Sports & Outdoor
  ["sports-general", "Sportartikel", "Sports equipment", "Sports & Outdoor", "ochsnersport.ch,sportxx.ch,decathlon.ch"],
  ["outdoor-hiking", "Outdoor und Wandern", "Outdoor and hiking gear", "Sports & Outdoor", "ochsnersport.ch,decathlon.ch,sportxx.ch"],
  ["winter-sports", "Wintersport und Ski", "Winter sports and ski", "Sports & Outdoor", "ochsnersport.ch,sportxx.ch,brack.ch"],
  ["bikes", "Velos und Fahrräder", "Bikes and cycling", "Sports & Outdoor", "decathlon.ch,galaxus.ch"],
  ["fitness-equipment", "Fitnessgeräte", "Fitness equipment", "Sports & Outdoor", "ochsnersport.ch,sportxx.ch"],
  ["supplements", "Fitness Nahrungsergänzung", "Fitness supplements", "Sports & Outdoor", ""],
  ["camping", "Camping", "Camping gear", "Sports & Outdoor", "ochsnersport.ch,decathlon.ch"],
  // --- Home & Living
  ["furniture", "Möbel", "Furniture", "Home & Living", "pfister.ch,micasa.ch,ikea.com"],
  ["home-decor", "Wohnaccessoires", "Home decor", "Home & Living", "pfister.ch,manor.ch,jysk.ch"],
  ["kitchenware", "Küchenzubehör", "Kitchenware", "Home & Living", "galaxus.ch"],
  ["bed-bedding", "Bett und Bettwäsche", "Beds and bedding", "Home & Living", "pfister.ch,galaxus.ch"],
  ["lighting", "Beleuchtung", "Lighting", "Home & Living", "hornbach.ch,jumbo.ch"],
  ["household-supplies", "Haushaltswaren", "Household goods", "Home & Living", "migros.ch,coop.ch"],
  ["bathroom", "Badezimmer", "Bathroom", "Home & Living", "jumbo.ch,hornbach.ch"],
  // --- DIY & Garden
  ["diy-tools", "Werkzeug", "Tools and hardware", "DIY & Garden", "hornbach.ch,jumbo.ch,oto.ch,brack.ch"],
  ["building-materials", "Baumaterial", "Building materials", "DIY & Garden", "hornbach.ch,jumbo.ch"],
  ["garden", "Garten", "Garden and plants", "DIY & Garden", "hornbach.ch,jumbo.ch,oto.ch"],
  ["bbq-grill", "Grill und BBQ", "Grills and barbecue", "DIY & Garden", "hornbach.ch,oto.ch"],
  // --- Health & Beauty
  ["pharmacy", "Apotheke und Drogerie", "Pharmacy and drugstore", "Health & Beauty", "zurrose.ch,shop-apotheke.ch,amavita.ch"],
  ["beauty-skincare", "Pflege und Kosmetik", "Skincare and cosmetics", "Health & Beauty", "douglas.ch,marionnaud.ch"],
  ["perfume", "Parfüm", "Perfume and fragrance", "Health & Beauty", "douglas.ch,marionnaud.ch"],
  ["haircare", "Haarpflege", "Hair care", "Health & Beauty", ""],
  ["wellness-supplements", "Vitamine und Nahrungsergänzung", "Vitamins and supplements", "Health & Beauty", ""],
  // --- Kids & Toys
  ["toys", "Spielzeug", "Toys", "Kids & Toys", "manor.ch,brack.ch,lego.com"],
  ["baby", "Babyartikel", "Baby essentials", "Kids & Toys", "galaxus.ch,manor.ch"],
  ["strollers-car-seats", "Kinderwagen und Autositze", "Strollers and car seats", "Kids & Toys", ""],
  ["kids-furniture", "Kinderzimmer", "Kids furniture", "Kids & Toys", "pfister.ch,micasa.ch"],
  // --- Leisure & Culture
  ["books", "Bücher", "Books", "Leisure & Culture", "exlibris.ch,orellfuessli.ch,thalia.ch"],
  ["vinyl-music", "Schallplatten und Musik", "Vinyl and music", "Leisure & Culture", ""],
  ["board-games", "Gesellschaftsspiele", "Board games", "Leisure & Culture", "manor.ch,brack.ch"],
  ["movies-games", "Filme und Videospiele", "Movies and video games", "Leisure & Culture", "brack.ch,galaxus.ch"],
  ["musical-instruments", "Musikinstrumente", "Musical instruments", "Leisure & Culture", "thomann.de"],
  ["arts-crafts", "Kunst und Bastelbedarf", "Arts and crafts supplies", "Leisure & Culture", ""],
  ["pet-supplies", "Tierbedarf", "Pet supplies", "Leisure & Culture", "fressnapf.ch,zooplus.ch,galaxus.ch"],
  ["event-tickets", "Konzerttickets", "Concert and event tickets", "Leisure & Culture", "ticketcorner.ch,starticket.ch"],
  // --- Travel & Mobility
  ["flights", "Flüge", "Flights", "Travel & Mobility", ""],
  ["hotels", "Hotels", "Hotels", "Travel & Mobility", "booking.com,airbnb.com"],
  ["package-holidays", "Ferienreisen", "Package holidays", "Travel & Mobility", "hotelplan.ch,kuoni.ch"],
  ["car-rental", "Mietwagen", "Car rental", "Travel & Mobility", ""],
  ["luggage", "Reisegepäck", "Luggage and suitcases", "Travel & Mobility", ""],
  ["e-mobility", "E-Scooter und E-Bikes", "E-scooters and e-bikes", "Travel & Mobility", "galaxus.ch,brack.ch"],
  // --- Marketplace & Second-hand
  ["marketplaces", "Online Marktplätze", "Online marketplaces", "Marketplace & Second-hand", "ricardo.ch,tutti.ch,ebay.ch,amazon.de,aliexpress.com"],
  ["second-hand", "Gebrauchtkauf Schweiz", "Second-hand Switzerland", "Marketplace & Second-hand", "tutti.ch,ricardo.ch,revendo.ch"],
  ["luxury-resale", "Luxus Second Hand", "Luxury resale", "Marketplace & Second-hand", "vestiairecollective.com,chrono24.com"],
  // --- Office & Work
  ["office-supplies", "Bürobedarf", "Office supplies", "Office & Work", "officeworld.ch,lyreco.ch"],
  ["office-furniture", "Büromöbel", "Office furniture", "Office & Work", ""],
  ["printer-toner", "Drucker und Toner", "Printers and toner", "Office & Work", "brack.ch,microspot.ch"],
  // --- Gifts
  ["flowers-gifts", "Blumen und Geschenke", "Flowers and gifts", "Gifts", "interflora.ch,fleurop.ch"],
  ["gifts-gadgets", "Geschenke und Gadgets", "Gifts and gadgets", "Gifts", "galaxus.ch,manor.ch"],
  // --- Swiss specialties
  ["swiss-regional", "Schweizer Spezialitäten", "Swiss specialty products", "Swiss Specialties", "farmy.ch,migros.ch"],
  ["souvenirs", "Souvenirs Schweiz", "Souvenirs Switzerland", "Swiss Specialties", ""],
];

export const CATEGORIES = CATS.map(([id, de, en, department, seedsCsv]) => ({
  id,
  labelDe: de,
  labelEn: en,
  department,
  seeds: seedsCsv ? seedsCsv.split(",").map((s) => s.trim()).filter(Boolean) : [],
  queries: [
    { q: `${de} online shop Schweiz`, kl: "ch-de" },
    { q: `${en} online shop Switzerland`, kl: "ch-en" },
  ],
}));

/* ------------------------------------------------------------------ */
/* Parsing helpers (exported for tests)                                 */
/* ------------------------------------------------------------------ */

// Hosts that are evidence of *talking about* shops, not shops themselves.
const BLOCKED_SUFFIXES = [
  "pinterest.", "facebook.com", "instagram.com", "tiktok.com", "reddit.com",
  "youtube.com", "youtu.be", "wikipedia.org", "tripadvisor.", "trustpilot.com",
  "comparis.ch", "toppreise.ch", "idealo.", "geizhals.", "billiger.de",
  "google.com", "duckduckgo.com", "bing.com", "yahoo.com", "ecosia.org",
  "20min.ch", "watson.ch", "srf.ch", "nzz.ch", "tagesanzeiger.ch", "blick.ch",
  "linkedin.com", "x.com", "twitter.com", "gutscheine.", "rabatt.",
];

// Two-label public suffixes we care about for a registrable-domain approximation.
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "com.ch", "co.at", "or.at", "co.za", "com.au", "co.jp", "com.br",
  "co.in", "co.nz", "com.tr", "com.mx", "com.ar",
]);

/** Best-effort registrable domain: strip scheme/user/port and a leading
 *  www./m./mobile., collapse to the registrable label pair. */
export function extractDomain(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let host = u.hostname.toLowerCase().replace(/\.$/, "");
  host = host.replace(/^(www|m|mobile|shop|www2)\./, "");
  if (!host.includes(".")) return null;
  const parts = host.split(".");
  const lastTwo = parts.slice(-2).join(".");
  const lastThree = parts.slice(-3).join(".");
  const registrable = TWO_PART_SUFFIXES.has(lastTwo) && parts.length >= 3 ? lastThree : lastTwo;
  // ignore bare TLD accidents / IP hosts
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  return registrable;
}

export function isBlockedHost(domain) {
  return BLOCKED_SUFFIXES.some((b) => domain === b.replace(/\.$/, "") || domain.includes(b));
}

/** Decode a DDG html redirect href into the target URL; null for ads/junk.
 *  Ad links route through duckduckgo.com/y.js?ad_domain=... — filter those. */
export function ddgHrefToUrl(href) {
  if (!href) return null;
  const cleaned = href.replace(/&amp;/g, "&");
  const m = cleaned.match(/[?&]uddg=([^&]+)/);
  if (!m) return null;
  let target;
  try { target = decodeURIComponent(m[1]); } catch { return null; }
  if (/duckduckgo\.com\/y\.js/.test(target)) return null; // ad
  if (!/^https?:\/\//i.test(target)) return null;
  return target;
}

/** Parse a DuckDuckGo HTML results page into ordered organic results. */
export function parseDdgHtml(html) {
  const out = [];
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const url = ddgHrefToUrl(m[1]);
    if (!url) continue;
    const title = m[2].replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ").trim();
    out.push({ url, title });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Search collector                                                     */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Thrown when the engine serves an anomaly/challenge page instead of results
 *  (verified live 2026-09-25: DDG answers HTTP 202 + challenge HTML under load,
 *  GET and POST alike; recovery needs minutes, not seconds). */
class ThrottleError extends Error {
  constructor(msg) { super(msg); this.throttled = true; }
}

async function ddgSearch(query, kl) {
  const url = `${DDG}?kl=${encodeURIComponent(kl || "")}&q=${encodeURIComponent(query)}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, "accept-language": "de-CH,de;q=0.9,en;q=0.7", accept: "text/html" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`network: ${e.message}`);
  }
  if (res.status === 202 || res.status === 429 || res.status === 503) throw new ThrottleError(`http ${res.status}`);
  if (!res.ok) throw new Error(`http ${res.status}`);
  const html = await res.text();
  const results = parseDdgHtml(html);
  if (results.length === 0) throw new ThrottleError("empty page (challenge/bot wall)");
  return results;
}

/** Run one query, filter + dedupe to ranked domains with evidence. */
export function collectDomainEvidence(results, seeds) {
  const seedSet = new Set(seeds);
  const byDomain = new Map();
  results.forEach((r, idx) => {
    const domain = extractDomain(r.url);
    if (!domain || isBlockedHost(domain)) return;
    const weight = 1 / (1 + idx);
    const cur = byDomain.get(domain);
    if (cur) {
      cur.score += weight;
      if (cur.title.length < r.title.length) cur.title = r.title;
    } else {
      byDomain.set(domain, { domain, score: weight + (seedSet.has(domain) ? 1.0 : 0), title: r.title, curated: seedSet.has(domain) });
    }
  });
  return [...byDomain.values()];
}

/* ------------------------------------------------------------------ */
/* Deterministic builder                                                */
/* ------------------------------------------------------------------ */

export function buildArtifact(rawDir, runDate) {
  const categories = [];
  const usedProviders = new Set();
  let queriesOk = 0, queriesFailed = 0;
  const failures = [];
  for (const cat of CATEGORIES) {
    const evidence = new Map();
    const seedSet = new Set(cat.seeds);
    const usedQueries = [];
    cat.queries.forEach((qSpec, qi) => {
      const file = path.join(rawDir, `${cat.id}__q${qi}.json`);
      if (!fs.existsSync(file)) {
        queriesFailed++;
        failures.push({ category: cat.id, query: qSpec.q, reason: "no raw file (fetch failed)" });
        return;
      }
      let raw;
      try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
        queriesFailed++;
        failures.push({ category: cat.id, query: qSpec.q, reason: `unreadable raw: ${e.message}` });
        return;
      }
      queriesOk++;
      usedProviders.add(raw.provider || "duckduckgo-html");
      usedQueries.push(raw.query);
      for (const item of collectDomainEvidence(raw.results, cat.seeds)) {
        const cur = evidence.get(item.domain);
        if (cur) { cur.score += item.score - (item.curated ? 1.0 : 0); }
        else evidence.set(item.domain, { ...item });
      }
    });
    // re-apply seed boost once per domain (not per query) for determinism
    const sites = [...evidence.values()]
      .map((s) => ({ domain: s.domain, score: +(s.score + (seedSet.has(s.domain) ? 0 : 0)).toFixed(4), title: s.title || "", curated: seedSet.has(s.domain) }))
      .sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain))
      .slice(0, TOP_N)
      .map((s, i) => ({
        rank: i + 1,
        domain: s.domain,
        name: friendlyName(s.domain, s.title),
        score: s.score,
        curated: s.curated,
      }));
    categories.push({
      id: cat.id,
      label: cat.labelDe,
      labelEn: cat.labelEn,
      department: cat.department,
      queries: usedQueries,
      siteCount: sites.length,
      sites,
    });
  }
  const totalSites = categories.reduce((n, c) => n + c.siteCount, 0);
  const okRate = queriesOk + queriesFailed > 0 ? queriesOk / (queriesOk + queriesFailed) : 0;
  const artifact = {
    schema: "wallet-control.category-sites.v1",
    scriptVersion: SCRIPT_VERSION,
    runDate,
    source: { providers: [...usedProviders].sort(), minQuerySuccessRate: MIN_QUERY_SUCCESS_RATE },
    counts: { categories: categories.length, queriesOk, queriesFailed, sites: totalSites },
    categories,
  };
  return { artifact, queriesOk, queriesFailed, failures, okRate };
}

function friendlyName(domain, title) {
  // Prefer the brand-ish part of the domain; the page title is noisy.
  const core = domain.split(".")[0];
  const name = core.replace(/-/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/* ------------------------------------------------------------------ */
/* IO: atomic writes, hashing, retention                                */
/* ------------------------------------------------------------------ */

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function atomicWrite(file, content) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function listRunDirs() {
  if (!fs.existsSync(RAW_DIR)) return [];
  return fs.readdirSync(RAW_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

function pruneOldRuns(keep) {
  const dirs = listRunDirs();
  for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    fs.rmSync(path.join(RAW_DIR, d), { recursive: true, force: true });
    console.log(`pruned old raw run ${d}`);
  }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                  */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { mode: "search" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--search") args.mode = "search";
    else if (a === "--build") args.mode = "build";
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--list-categories") args.listCategories = true;
    else if (a === "--date") args.date = argv[++i];
    else if (a === "--only") args.only = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--limit-queries") args.limitQueries = parseInt(argv[++i], 10);
    else if (a === "--keep-runs") args.keepRuns = parseInt(argv[++i], 10);
    else if (a === "--emit-pending") args.emitPending = argv[++i];
    else if (a === "--ingest-staged") args.ingestStaged = argv[++i];
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function planCategories(args) {
  let cats = CATEGORIES;
  if (args.only) {
    const want = new Set(args.only);
    const missing = args.only.filter((id) => !CATEGORIES.some((c) => c.id === id));
    if (missing.length) throw new Error(`unknown category id(s): ${missing.join(", ")}`);
    cats = cats.filter((c) => want.has(c.id));
  }
  if (args.limitQueries) {
    cats = cats.map((c) => ({ ...c, queries: c.queries.slice(0, args.limitQueries) }));
  }
  return cats;
}

function pendingQueries(cats, runDir) {
  const out = [];
  for (const c of cats) {
    for (let qi = 0; qi < c.queries.length; qi++) {
      if (!fs.existsSync(path.join(runDir, `${c.id}__q${qi}.json`))) out.push({ cat: c, qi, ...c.queries[qi] });
    }
  }
  return out;
}

const COOLDOWN_LADDER_MS = [120_000, 300_000, 600_000]; // grows with each cooldown used
const MAX_COOLDOWNS = 4;

async function runQueries(cats, runDir) {
  const pending = pendingQueries(cats, runDir);
  let ok = 0, failed = 0, throttles = 0, consecutive = 0, cooldownsUsed = 0;
  const failureRows = [];
  console.log(`fetching ${pending.length} pending queries (pacing ~${DELAY_MS}ms, cooldown ladder ${COOLDOWN_LADDER_MS.join("/")}s)`);
  for (let i = 0; i < pending.length; i++) {
    const { cat, qi, q, kl } = pending[i];
    const file = path.join(runDir, `${cat.id}__q${qi}.json`);
    if (fs.existsSync(file)) { ok++; continue; } // resume-safe (pass 2 / reruns)
    const label = `[${i + 1}/${pending.length}] ${cat.id} q${qi}: ${q}`;
    try {
      const results = await ddgSearch(q, kl);
      atomicWrite(file, JSON.stringify({
        query: q, kl, category: cat.id, provider: "duckduckgo-html", fetchedAt: new Date().toISOString(),
        results: results.slice(0, 30).map((r, rank) => ({ rank, url: r.url, title: r.title })),
      }, null, 1));
      ok++; consecutive = 0;
      console.log(`${label} → ${results.length} results`);
    } catch (e) {
      failed++;
      failureRows.push({ category: cat.id, query: q, reason: e.message });
      console.log(`${label} → FAILED: ${e.message}`);
      // No stub file: a failed query is re-fetched next pass/run (resume-safe).
      if (e.throttled) {
        throttles++; consecutive++;
        if (consecutive >= 2 && cooldownsUsed < MAX_COOLDOWNS) {
          const wait = COOLDOWN_LADDER_MS[Math.min(cooldownsUsed, COOLDOWN_LADDER_MS.length - 1)];
          console.log(`throttled ${consecutive}× in a row — cooling down ${Math.round(wait / 1000)}s`);
          await sleep(wait);
          cooldownsUsed++; consecutive = 0;
        }
      }
    }
    if (i < pending.length - 1) await sleep(DELAY_MS + (i % 7) * 600);
  }
  return { throttles, failureRows };
}

async function runSearchAndBuild(args) {
  const cats = planCategories(args);
  const today = new Date().toISOString().slice(0, 10);
  const runDir = path.join(RAW_DIR, today);
  fs.mkdirSync(runDir, { recursive: true });

  const expected = cats.reduce((n, c) => n + c.queries.length, 0);
  console.log(`category-sites run ${today}: ${cats.length} categories, ${expected} queries (delay ${DELAY_MS}ms)`);

  const failureRows = [];
  for (let pass = 1; pass <= 2; pass++) {
    const before = expected - pendingQueries(cats, runDir).length;
    const stats = await runQueries(cats, runDir);
    failureRows.push(...stats.failureRows);
    const missing = pendingQueries(cats, runDir).length;
    if (missing === 0 || pass === 2) break;
    if (expected - missing - before === 0 && stats.throttles > 0) {
      // Pass 1 fetched nothing and the engine is throttling: a second pass now
      // would just re-lose. Bail fast; the artifact stays untouched.
      console.error("engine fully throttled in pass 1 — skipping pass 2");
      break;
    }
    console.log(`pass ${pass} done, ${missing} queries still missing — cooling down 300s before pass 2`);
    await sleep(300_000);
  }

  const got = expected - pendingQueries(cats, runDir).length;
  const okRate = expected ? got / expected : 0;
  console.log(`search done: ${got}/${expected} queries (${(okRate * 100).toFixed(0)}%)`);
  if (okRate < MIN_QUERY_SUCCESS_RATE) {
    console.error(`ABORT: success rate below ${MIN_QUERY_SUCCESS_RATE * 100}% — artifact left untouched.`);
    writeManifest({ runDate: today, ok: got, failed: expected - got, failures: failureRows, aborted: true,
      hint: "rerun resumes where it stopped; or --emit-pending + --ingest-staged to fill gaps via the agent web-search tool" });
    process.exit(2);
  }
  await finishBuild(runDir, today, { ok: got, failed: expected - got, failures: failureRows }, { catsInScope: cats.length });
  pruneOldRuns(args.keepRuns ?? 5);
}

async function finishBuild(runDir, runDate, searchStats = null, opts = {}) {
  const { artifact, queriesOk, queriesFailed, failures, okRate } = buildArtifact(runDir, runDate);
  const json = JSON.stringify(artifact, null, 2) + "\n";

  // A build is "full" only when every category was in scope and the raw evidence
  // is good enough. Partial runs (smoke subsets, thin raw dirs) must never
  // overwrite the live artifact or the shopper mirror.
  const isFull = opts.catsInScope === CATEGORIES.length && okRate >= MIN_QUERY_SUCCESS_RATE;
  const artifactFile = isFull ? ARTIFACT : path.join(DATA_DIR, "category-sites.partial.json");
  const manifestFile = isFull ? MANIFEST : path.join(DATA_DIR, "manifest.partial.json");
  atomicWrite(artifactFile, json);

  const rawFiles = fs.readdirSync(runDir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => ({ file: `raw/${runDate}/${f}`, sha256: sha256(fs.readFileSync(path.join(runDir, f))) }));
  const manifest = {
    schema: "wallet-control.category-sites.manifest.v1",
    scriptVersion: SCRIPT_VERSION,
    generatedAt: new Date().toISOString(),
    runDate,
    partial: !isFull,
    provider: "duckduckgo-html",
    counts: { ...artifact.counts, queriesOk, queriesFailed, querySuccessRate: +okRate.toFixed(3) },
    artifact: { path: "category-sites.json", sha256: sha256(json), bytes: Buffer.byteLength(json) },
    raw: rawFiles,
    failures,
    searchStats,
  };
  atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + "\n");

  if (!isFull) {
    console.log(`PARTIAL build → ${path.basename(artifactFile)} (live artifact untouched; mirror skipped)`);
    return;
  }

  // Best-effort mirror for the shopper UI (same pattern as merchants.json mirror).
  try {
    fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
    fs.copyFileSync(artifactFile, MIRROR);
    console.log(`mirrored → ${path.relative(ROOT, MIRROR)}`);
  } catch (e) {
    console.log(`mirror skipped: ${e.message}`);
  }

  const cats = artifact.counts.categories;
  const thin = artifact.categories.filter((c) => c.siteCount < TOP_N).map((c) => `${c.id}(${c.siteCount})`);
  console.log(`artifact written: ${cats} categories, ${artifact.counts.sites} sites, sha ${manifest.artifact.sha256.slice(0, 12)}…`);
  if (thin.length) console.log(`categories under ${TOP_N} sites: ${thin.join(", ")}`);
}

function writeManifest(partial) {
  try {
    atomicWrite(MANIFEST, JSON.stringify({
      schema: "wallet-control.category-sites.manifest.v1",
      scriptVersion: SCRIPT_VERSION,
      generatedAt: new Date().toISOString(),
      ...partial,
    }, null, 2) + "\n");
  } catch { /* best effort */ }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.emitPending) {
    const date = args.date || new Date().toISOString().slice(0, 10);
    const cats = planCategories(args);
    const pending = pendingQueries(cats, path.join(RAW_DIR, date))
      .map(({ cat, qi, q, kl }) => ({ category: cat.id, qi, query: q, kl, rawFile: `${cat.id}__q${qi}.json` }));
    atomicWrite(args.emitPending, JSON.stringify({ runDate: date, pending }, null, 2));
    console.log(`${pending.length} pending queries → ${args.emitPending}`);
    return;
  }
  if (args.ingestStaged) {
    // Recovery path when DDG is throttled: the agent fills pending queries with
    // its web_search tool, staging files named <category>__q<qi>.json with
    // provider "openclaw-web-search"; this validates + merges them, then builds.
    const date = args.date || new Date().toISOString().slice(0, 10);
    const runDir = path.join(RAW_DIR, date);
    fs.mkdirSync(runDir, { recursive: true });
    const cats = planCategories(args);
    const byId = new Map(cats.map((c) => [c.id, c]));
    const allowedProviders = new Set(["duckduckgo-html", "openclaw-web-search"]);
    let copied = 0;
    for (const f of fs.readdirSync(args.ingestStaged).sort()) {
      const m = f.match(/^(?<id>[a-z0-9-]+)__q(?<qi>\d+)\.json$/);
      if (!m) { console.log(`skip ${f} (naming)`); continue; }
      const cat = byId.get(m.groups.id);
      const qi = parseInt(m.groups.qi, 10);
      if (!cat || qi >= cat.queries.length) { console.log(`skip ${f} (unknown category/query index)`); continue; }
      const dest = path.join(runDir, f);
      if (fs.existsSync(dest)) { console.log(`skip ${f} (already present)`); continue; }
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(args.ingestStaged, f), "utf8")); }
      catch (e) { console.log(`skip ${f} (${e.message})`); continue; }
      if (doc?.category !== cat.id || doc?.query !== cat.queries[qi].q || !Array.isArray(doc.results)) {
        console.log(`skip ${f} (schema mismatch)`); continue;
      }
      if (!allowedProviders.has(doc.provider)) { console.log(`skip ${f} (provider "${doc.provider}" not allowed)`); continue; }
      const results = doc.results.slice(0, 30)
        .map((r, rank) => ({ rank, url: String(r.url || ""), title: String(r.title || "") }))
        .filter((r) => /^https?:\/\//i.test(r.url));
      if (results.length === 0) { console.log(`skip ${f} (no usable results)`); continue; }
      atomicWrite(dest, JSON.stringify({
        query: doc.query, kl: doc.kl || cat.queries[qi].kl, category: cat.id, provider: doc.provider,
        fetchedAt: doc.fetchedAt || new Date().toISOString(), results,
      }, null, 1));
      copied++;
    }
    console.log(`ingested ${copied} staged files into raw/${date}`);
    await finishBuild(runDir, date, { ingested: copied }, { catsInScope: cats.length });
    return;
  }
  if (args.listCategories) {
    for (const c of CATEGORIES) console.log(`${c.id.padEnd(22)} ${c.department.padEnd(26)} ${c.labelDe} / ${c.labelEn}`);
    console.log(`\n${CATEGORIES.length} categories, ${CATEGORIES.length * 2} queries per full run`);
    return;
  }
  if (args.dryRun) {
    const cats = planCategories(args);
    const q = cats.reduce((n, c) => n + c.queries.length, 0);
    console.log(`DRY RUN — ${cats.length} categories, ${q} queries → ${runDirFor(args)}`);
    for (const c of cats) console.log(`  ${c.id}: ${c.queries.map((x) => x.q).join(" | ")}`);
    return;
  }
  if (args.mode === "build") {
    const dirs = listRunDirs();
    const date = args.date || dirs[dirs.length - 1];
    if (!date) throw new Error("no raw runs available");
    const runDir = path.join(RAW_DIR, date);
    if (!fs.existsSync(runDir)) throw new Error(`raw run not found: raw/${date}`);
    await finishBuild(runDir, date, null, { catsInScope: CATEGORIES.length });
    return;
  }
  await runSearchAndBuild(args);
}

function runDirFor(args) {
  const date = args.date || new Date().toISOString().slice(0, 10);
  return `data/category-sites/raw/${date}`;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((e) => { console.error(`category-sites: ${e.message}`); process.exit(1); });
}
