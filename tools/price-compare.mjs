#!/usr/bin/env node
//
// price-compare — compare a product's price across supermarkets, through a real
// browser.
//
// WHY A BROWSER IS NOT OPTIONAL HERE
//
// These storefronts are single-page apps. `curl https://www.carrefour.com.ar/...`
// returns 200 and 1.4 MB of HTML containing ZERO prices — the catalogue is
// fetched by JavaScript after load. Measured, not assumed. So the choice is not
// "browser or HTTP", it is "browser or nothing".
//
// The query itself goes to the storefront's own public catalogue endpoint,
// issued FROM INSIDE the page. That matters: a same-origin fetch inherits the
// session, headers and TLS fingerprint of a real visit, so it behaves like a
// shopper rather than an anonymous scraper — and it asks for a handful of JSON
// records instead of re-rendering and parsing megabytes of markup.
//
// Scope and manners: this reads public shelf prices, a few records per store,
// one request per store per run. It is a price check, not a harvester. Do not
// loop it, and do not point it at anything behind a login.
//
// Usage:
//   node price-compare.mjs "leche entera 1l"
//   node price-compare.mjs "yerba mate" --limit 8 --json out.json
//   node price-compare.mjs --list-stores

const BASE = process.env.CAMOFOX_BASE_URL || "http://127.0.0.1:9377";
const USER = process.env.CAMOFOX_USER_ID || "price-compare";
const ACCESS_KEY = process.env.CAMOFOX_ACCESS_KEY || "";

// VTEX powers most Argentine supermarket storefronts, so one adapter covers
// them all. Coto and others run different platforms and would need their own
// extractor — better to omit a store than to report a wrong price for it.
const STORES = [
  { id: "carrefour", label: "Carrefour", origin: "https://www.carrefour.com.ar", platform: "vtex" },
  { id: "dia", label: "Día", origin: "https://diaonline.supermercadosdia.com.ar", platform: "vtex" },
  { id: "jumbo", label: "Jumbo", origin: "https://www.jumbo.com.ar", platform: "vtex" },
  { id: "disco", label: "Disco", origin: "https://www.disco.com.ar", platform: "vtex" },
  { id: "vea", label: "Vea", origin: "https://www.vea.com.ar", platform: "vtex" },
];

// --- camofox REST ----------------------------------------------------------
const authHeaders = ACCESS_KEY ? { authorization: `Bearer ${ACCESS_KEY}` } : {};

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...authHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

const openTab = (url) => api("/tabs", { method: "POST", body: { url, userId: USER, sessionKey: "default" } });
const closeTab = (tabId) => api(`/tabs/${tabId}?userId=${encodeURIComponent(USER)}`, { method: "DELETE" }).catch(() => {});
const evaluate = (tabId, expression) =>
  api(`/tabs/${tabId}/evaluate`, { method: "POST", body: { userId: USER, expression } });

// --- extraction ------------------------------------------------------------
// Runs in the page. Kept as a string because it is shipped to the browser, and
// deliberately defensive: a missing seller or offer is normal for out-of-stock
// items and must not take down the whole store's result.
const vtexQuery = (term, limit) => `(async () => {
  const url = '/api/catalog_system/pub/products/search/?ft=' +
    encodeURIComponent(${JSON.stringify(term)}) + '&_from=0&_to=' + ${limit - 1};
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  // VTEX answers 206 Partial Content for ranged catalogue queries; that is success.
  if (r.status !== 200 && r.status !== 206) {
    return JSON.stringify({ error: 'HTTP ' + r.status });
  }
  const j = await r.json();
  const items = (Array.isArray(j) ? j : []).map(p => {
    const offer = p.items && p.items[0] && p.items[0].sellers && p.items[0].sellers[0]
      ? p.items[0].sellers[0].commertialOffer : null;
    return {
      name: p.productName || '',
      brand: p.brand || '',
      price: offer ? offer.Price : null,
      // Two "before" fields exist and they do NOT agree. Cencosud storefronts
      // (Jumbo/Disco/Vea) return an uninitialised ListPrice — 260331 for a
      // 3150 bottle of milk — which turns into a fabricated "-99% off".
      // PriceWithoutDiscount is the one that tracks reality, so prefer it and
      // keep ListPrice only as a fallback for stores that omit it.
      list: offer ? (offer.PriceWithoutDiscount || offer.ListPrice) : null,
      available: offer ? (offer.AvailableQuantity > 0) : false,
      link: p.linkText ? '/' + p.linkText + '/p' : null,
    };
  }).filter(x => x.price != null && x.price > 0 && x.available);
  return JSON.stringify({ items });
})()`;

// A store that is down, blocked or slow must not abort the comparison; it is
// reported as its own row so the gap is visible instead of silently missing.
async function queryStore(store, term, limit) {
  const started = Date.now();
  let tabId = null;
  try {
    const tab = await openTab(store.origin);
    tabId = tab.tabId;
    const out = await evaluate(tabId, vtexQuery(term, limit));
    const raw = out?.result ?? out;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed?.error) return { store, error: parsed.error, ms: Date.now() - started };
    return { store, items: parsed.items || [], ms: Date.now() - started };
  } catch (e) {
    return { store, error: e.message.slice(0, 120), ms: Date.now() - started };
  } finally {
    if (tabId) await closeTab(tabId);
  }
}

// --- presentation ----------------------------------------------------------
const ars = (n) => "$" + n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Only claim a discount when the numbers are believable. Supermarket data is
// full of placeholder "before" prices, and printing "-99%" off a garbage field
// is worse than printing nothing: it is a confident lie the reader cannot check.
const MAX_PLAUSIBLE_DISCOUNT = 0.7;
function discountPct(price, list) {
  if (!list || list <= price) return "";
  const off = 1 - price / list;
  if (off > MAX_PLAUSIBLE_DISCOUNT) return "";
  return `  −${Math.round(off * 100)}%`;
}

// Pull a size out of the product name so per-unit comparison is possible.
// Without this, "1 L at $1600" and "3 L at $4200" look like the 1 L is cheaper.
function unitPrice(name, price) {
  // Ordered longest-first: a plain (l|lt) alternative would match the "l" of
  // "lts" and leave the "ts", so the size silently fails to parse.
  const m = name.match(/(\d+(?:[.,]\d+)?)\s*(kgs|kg|grs|gr|g|ltrs|ltr|lts|lt|l|ml|cc)\b/i);
  if (!m) return null;
  let qty = parseFloat(m[1].replace(",", "."));
  const unit = m[2].toLowerCase();
  if (["g", "gr", "grs", "ml", "cc"].includes(unit)) qty /= 1000;
  if (!qty) return null;
  return { perUnit: price / qty, unit: ["kg", "kgs", "g", "gr", "grs"].includes(unit) ? "kg" : "L" };
}

function render(term, results, limit) {
  const W = (s, n) => String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s).padEnd(n);
  console.log(`\n  Price check — "${term}"   ${new Date().toLocaleString("es-AR")}\n`);

  const all = [];
  for (const r of results) {
    if (r.error) {
      console.log(`  ${W(r.store.label, 12)} ${"—".padEnd(46)} ${r.error}`);
      continue;
    }
    if (!r.items.length) {
      console.log(`  ${W(r.store.label, 12)} no matching in-stock products`);
      continue;
    }
    console.log(`  ${r.store.label}  ${String(r.ms + "ms").padStart(6)}`);
    for (const it of r.items.slice(0, limit)) {
      const u = unitPrice(it.name, it.price);
      const perUnit = u ? `  (${ars(u.perUnit)}/${u.unit})` : "";
      const discount = discountPct(it.price, it.list);
      console.log(`    ${W(it.name, 52)} ${ars(it.price).padStart(12)}${perUnit}${discount}`);
      all.push({ store: r.store.label, ...it, unit: u });
    }
    console.log("");
  }

  // The verdict people actually want. Compared per unit where a size could be
  // parsed, because that is the only comparison that means anything.
  const comparable = all.filter((x) => x.unit);
  if (comparable.length > 1) {
    comparable.sort((a, b) => a.unit.perUnit - b.unit.perUnit);
    const best = comparable[0];
    const worst = comparable[comparable.length - 1];
    const gap = Math.round((worst.unit.perUnit / best.unit.perUnit - 1) * 100);
    console.log(`  Cheapest per ${best.unit.unit}: ${best.store} — ${best.name}`);
    console.log(`    ${ars(best.unit.perUnit)}/${best.unit.unit} vs ${ars(worst.unit.perUnit)} at ${worst.store} — a ${gap}% spread\n`);
  } else {
    console.log("  Not enough parseable sizes for a per-unit verdict.\n");
  }
  return all;
}

// --- main ------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes("--list-stores")) {
  for (const s of STORES) console.log(`${s.id.padEnd(12)} ${s.label.padEnd(12)} ${s.origin}`);
  process.exit(0);
}
const term = argv.find((a) => !a.startsWith("--"));
if (!term) {
  console.error(`usage: price-compare.mjs "<product>" [--limit N] [--stores a,b] [--json FILE]`);
  process.exit(2);
}
const limit = Number(argv[argv.indexOf("--limit") + 1]) || 5;
const only = argv.includes("--stores") ? argv[argv.indexOf("--stores") + 1].split(",") : null;
const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;

const chosen = STORES.filter((s) => !only || only.includes(s.id));

// The service recycles its browser when a health probe fails, and answers 503
// for the couple of seconds that takes. Treating that window as "camofox is
// down" makes the tool look flaky when the service is behaving correctly.
async function waitHealthy(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const h = await api("/health");
      if (h?.browserConnected) return true;
      last = `browserConnected=${h?.browserConnected}`;
    } catch (e) {
      last = e.message.slice(0, 80);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.error(`camofox never became healthy at ${BASE} (${last}). Run: camofox-doctor`);
  return false;
}
if (!(await waitHealthy())) process.exit(1);

console.error(`querying ${chosen.length} stores through camofox…`);
// Sequential on purpose: one tab at a time is gentler on both the browser's tab
// budget and the stores.
const results = [];
for (const s of chosen) results.push(await queryStore(s, term, limit));

const all = render(term, results, limit);

if (jsonOut) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(jsonOut, JSON.stringify({ term, at: new Date().toISOString(), results, flat: all }, null, 2));
  console.log(`  wrote ${jsonOut}`);
}
process.exit(results.every((r) => r.error) ? 1 : 0);
