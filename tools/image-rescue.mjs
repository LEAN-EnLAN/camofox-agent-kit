#!/usr/bin/env node
//
// image-rescue — explain why a page won't let you save an image, and save the
// one you are looking at.
//
// WHAT "PROTECTED" ACTUALLY MEANS
//
// Blocking right-click, disabling drag, laying a transparent div over a photo,
// painting it into a <canvas>, or serving it as a CSS background are all
// CLIENT-SIDE. By the time any of them run, the browser has already downloaded
// and decoded the image — the bytes are in your machine's memory, which is the
// only reason you can see it at all. None of these are access control; they are
// interface friction. A real browser under your control simply reads what it
// already has.
//
// So this tool does two things:
//   1. reports which friction techniques a page uses, and
//   2. fetches an asset you are already viewing, through the page's own origin
//      and session, so hotlink protection and referer checks behave normally.
//
// WHAT THIS IS NOT
//
// Not a crawler and not a bulk downloader: it works on one page at a time and
// saves assets you name. Being able to save a picture says nothing about being
// allowed to republish it — copyright and site terms still apply, and "I could
// download it" has never been a licence. Use it for the thing you were already
// entitled to do by hand, and don't point it at anything behind a paywall.
//
// Usage:
//   node image-rescue.mjs <url>                 inspect: protections + assets
//   node image-rescue.mjs <url> --save 3        save asset #3 from the listing
//   node image-rescue.mjs <url> --save-largest  save the highest-resolution asset
//   node image-rescue.mjs <url> --out DIR

import { writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

const BASE = process.env.CAMOFOX_BASE_URL || "http://127.0.0.1:9377";
const USER = process.env.CAMOFOX_USER_ID || "image-rescue";
const ACCESS_KEY = process.env.CAMOFOX_ACCESS_KEY || "";
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
const evaluate = async (tabId, expression) => {
  const out = await api(`/tabs/${tabId}/evaluate`, { method: "POST", body: { userId: USER, expression } });
  const raw = out?.result ?? out;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
};

// --- in-page probes --------------------------------------------------------
// Detection, not defeat: naming the technique is what turns "it just doesn't
// work" into something the reader can reason about.
const PROBE = `(() => {
  // Two different things, deliberately not mixed. 'blocking' is friction aimed
  // at stopping you from saving. 'delivery' just describes how the pixels reach
  // the page — a CSS background is a normal styling choice, not protection, and
  // filing it under "blocking" would be a confident false accusation.
  const found = [];
  const delivery = [];
  const add = (t, d) => found.push({ technique: t, detail: d });
  const note = (t, d) => delivery.push({ technique: t, detail: d });

  if (typeof document.oncontextmenu === 'function') add('contextmenu blocked', 'document.oncontextmenu handler');
  if (typeof document.body.oncontextmenu === 'function') add('contextmenu blocked', 'body.oncontextmenu handler');
  if (document.body.getAttribute('oncontextmenu')) add('contextmenu blocked', 'inline oncontextmenu attribute');
  if (typeof document.ondragstart === 'function' || document.body.getAttribute('ondragstart')) add('drag blocked', 'ondragstart handler');
  if (typeof document.onselectstart === 'function' || document.body.getAttribute('onselectstart')) add('selection blocked', 'onselectstart handler');

  const bodyStyle = getComputedStyle(document.body);
  if (bodyStyle.userSelect === 'none' || bodyStyle.webkitUserSelect === 'none') add('selection blocked', 'CSS user-select:none on body');

  // A transparent element stacked over a photo so the right-click target is the
  // overlay, not the <img>.
  let overlays = 0;
  for (const el of document.querySelectorAll('div,span,a')) {
    const s = getComputedStyle(el);
    if ((s.position === 'absolute' || s.position === 'fixed') &&
        parseFloat(s.opacity) < 0.1 &&
        el.getBoundingClientRect().width > 150 && el.getBoundingClientRect().height > 150) overlays++;
  }
  if (overlays) add('overlay', overlays + ' near-transparent element(s) covering large areas');

  const canvases = document.querySelectorAll('canvas').length;
  if (canvases) note('canvas rendering', canvases + ' <canvas> element(s) — pixels may be painted rather than served as <img>, so they will not appear in the asset list below');

  let bgImages = 0;
  for (const el of document.querySelectorAll('*')) {
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none' && bg.includes('url(')) bgImages++;
    if (bgImages > 50) break;
  }
  if (bgImages) note('css background', bgImages + ' element(s) render images via background-image, so those assets are in CSS rather than the <img> inventory');

  // Assets actually loaded and decoded. naturalWidth is the decoded size, which
  // is how a 40px thumbnail is told apart from the full-resolution original.
  const seen = new Set();
  const assets = [];
  for (const img of document.querySelectorAll('img')) {
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith('data:') || seen.has(src)) continue;
    seen.add(src);
    assets.push({
      src,
      w: img.naturalWidth, h: img.naturalHeight,
      shown: Math.round(img.getBoundingClientRect().width) + 'x' + Math.round(img.getBoundingClientRect().height),
      alt: (img.alt || '').slice(0, 60),
      // srcset often carries a larger original than the one being displayed.
      srcsetBest: (() => {
        if (!img.srcset) return null;
        const best = img.srcset.split(',').map(s => s.trim().split(/\\s+/))
          .map(([u, d]) => ({ u, n: parseFloat(d) || 0 })).sort((a, b) => b.n - a.n)[0];
        return best ? best.u : null;
      })(),
    });
  }
  assets.sort((a, b) => (b.w * b.h) - (a.w * a.h));
  return JSON.stringify({ url: location.href, title: document.title, protections: found, delivery, assets: assets.slice(0, 40) });
})()`;

// Fetching from inside the page is what makes hotlink protection a non-issue:
// the request carries the page's own origin, referer and cookies, exactly as
// the original <img> request did.
const FETCH_ASSET = (src) => `(async () => {
  const r = await fetch(${JSON.stringify(src)}, { credentials: 'include' });
  if (!r.ok) return JSON.stringify({ error: 'HTTP ' + r.status });
  const buf = await r.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return JSON.stringify({ type: r.headers.get('content-type') || '', bytes: bytes.length, b64: btoa(bin) });
})()`;

// --- main ------------------------------------------------------------------
const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith("--"));
if (!url) {
  console.error(`usage: image-rescue.mjs <url> [--save N | --save-largest] [--out DIR]`);
  process.exit(2);
}
const outDir = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "./rescued";
const saveIdx = argv.includes("--save") ? Number(argv[argv.indexOf("--save") + 1]) : null;
const saveLargest = argv.includes("--save-largest");

let tabId = null;
try {
  const tab = await api("/tabs", { method: "POST", body: { url, userId: USER, sessionKey: "default" } });
  tabId = tab.tabId;
  // Lazy-loaded galleries only populate once something scrolls, so give the page
  // a beat and a nudge before taking inventory.
  await evaluate(tabId, `(() => { window.scrollTo(0, document.body.scrollHeight/2); return JSON.stringify({ok:true}); })()`);
  await new Promise((r) => setTimeout(r, 2500));

  const info = await evaluate(tabId, PROBE);

  console.log(`\n  ${info.title}`);
  console.log(`  ${info.url}\n`);

  if (info.protections.length) {
    console.log(`  Save-blocking techniques in use — all client-side, none of them access control:`);
    for (const p of info.protections) console.log(`    • ${p.technique.padEnd(22)} ${p.detail}`);
  } else {
    console.log(`  No save-blocking techniques detected — nothing here is trying to stop you.`);
  }
  if (info.delivery?.length) {
    console.log(`\n  How images are delivered (not protection, but it affects where to look):`);
    for (const d of info.delivery) console.log(`    • ${d.technique.padEnd(22)} ${d.detail}`);
  }

  console.log(`\n  Assets already downloaded and decoded by the browser (${info.assets.length}):\n`);
  info.assets.forEach((a, i) => {
    const res = a.w && a.h ? `${a.w}x${a.h}` : "?";
    console.log(`   [${String(i).padStart(2)}] ${res.padEnd(11)} shown ${a.shown.padEnd(11)} ${a.alt || basename(a.src.split("?")[0]).slice(0, 40)}`);
    console.log(`        ${a.src.slice(0, 110)}`);
    if (a.srcsetBest && a.srcsetBest !== a.src) console.log(`        srcset offers a larger original: ${a.srcsetBest.slice(0, 100)}`);
  });

  const target =
    saveLargest ? info.assets[0] :
    saveIdx != null ? info.assets[saveIdx] : null;

  if (target) {
    const src = target.srcsetBest || target.src;
    const got = await evaluate(tabId, FETCH_ASSET(src));
    if (got.error) throw new Error(`fetching the asset failed: ${got.error}`);
    mkdirSync(outDir, { recursive: true });
    // image/svg+xml would otherwise become a file called "…svg+xml".
    const ext = (got.type.split("/")[1] || "bin")
      .split(";")[0].trim()
      .replace("jpeg", "jpg")
      .replace(/\+.*$/, "")
      .replace(/[^a-z0-9]/gi, "") || "bin";
    const name = (basename(src.split("?")[0]).split(".")[0] || "asset").slice(0, 60);
    const path = join(outDir, `${name}.${ext}`);
    writeFileSync(path, Buffer.from(got.b64, "base64"));
    console.log(`\n  saved ${path}  (${(got.bytes / 1024).toFixed(0)} KB, ${got.type}, ${target.w}x${target.h})`);
    console.log(`  Being able to save it is not a licence to republish it — check the site's terms.`);
  } else {
    console.log(`\n  Add --save N or --save-largest to write one to disk.`);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (tabId) await api(`/tabs/${tabId}?userId=${encodeURIComponent(USER)}`, { method: "DELETE" }).catch(() => {});
}
