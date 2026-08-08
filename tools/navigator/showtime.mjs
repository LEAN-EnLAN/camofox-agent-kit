#!/usr/bin/env node
//
// showtime — record an agent session where you can actually SEE what it did.
//
// A recording of an automated browser is normally useless to watch: Playwright
// clicks are synthetic, so the pointer never moves and things just change. You
// see effects with no causes.
//
// This puts the causes back, on the isolated virtual display camofox already
// runs its browser in — so it is visible in the recording and invisible on the
// user's screen:
//
//   * the REAL X pointer travels to each target with easing, so the cursor is
//     captured by the grabber exactly as a human's would be;
//   * a ripple is drawn in the page at the click point, because a cursor that
//     stops moving does not tell you a click happened;
//   * the click itself still goes through the browser's own input pipeline, so
//     hover menus and wrapped handlers behave.
//
// Page-to-screen conversion comes from Firefox rather than guesswork:
// window.mozInnerScreenX/Y give the viewport origin in screen coordinates, so
// screen = page + origin - scroll. Measured on this machine: origin (0, 57).
//
// Usage:
//   node showtime.mjs <url> <script.json> [--out DIR] [--fps 25]
//   script.json: [ {"click":"Ingresar"}, {"type":["#email","hola@x.com"]}, {"wait":800} ]

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { camofox } from "./lib/camofox.mjs";

const [url, scriptPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const outDir = arg("--out", "./showtime-out");
const fps = Number(arg("--fps", 25));
const USER = "showtime";
if (!url || !scriptPath) {
  console.error("usage: showtime.mjs <url> <script.json> [--out DIR]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const steps = JSON.parse(readFileSync(scriptPath, "utf8"));
const parse = (r) => (typeof r === "string" ? JSON.parse(r) : r);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- find the display camofox's browser is on -------------------------------
// It is an Xvfb the service manages, not the user's session, so recording it
// captures the agent's browser without touching the desktop.
function camofoxDisplay() {
  const out = execFileSync("bash", ["-c", `pgrep -af 'Xvfb :' | grep -o ':[0-9]\\+' | head -1`], { encoding: "utf8" }).trim();
  if (!out) throw new Error("camofox's Xvfb not found — is the service running with the shim on its PATH?");
  return out;
}
const DISPLAY = camofoxDisplay();
const geo = execFileSync("bash", ["-c", `DISPLAY=${DISPLAY} xdpyinfo | awk '/dimensions:/{print $2; exit}'`], { encoding: "utf8" }).trim();
console.log(`recording ${DISPLAY} (${geo})`);

const xdo = (...args) => {
  try { execFileSync("xdotool", args, { env: { ...process.env, DISPLAY }, stdio: "ignore" }); }
  catch { /* a lost pointer move must not abort a run */ }
};

/**
 * Move the pointer along an eased path.
 *
 * Chained into ONE xdotool invocation: a spawn per frame costs more than the
 * frame interval, which turns "smooth" into a stutter that looks worse than
 * teleporting.
 */
function glide(fromX, fromY, toX, toY, ms = 700) {
  const frames = Math.max(6, Math.round((ms / 1000) * fps));
  const chain = [];
  for (let i = 1; i <= frames; i++) {
    const t = i / frames;
    // ease-in-out cubic: starts and stops gently, like a hand does.
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    chain.push("mousemove", String(Math.round(fromX + (toX - fromX) * e)), String(Math.round(fromY + (toY - fromY) * e)));
    chain.push("sleep", (1 / fps).toFixed(3));
  }
  xdo(...chain);
}

// --- in-page helpers --------------------------------------------------------
const OFFSET_JS = `(() => JSON.stringify({
  ox: window.mozInnerScreenX, oy: window.mozInnerScreenY,
  sx: scrollX, sy: scrollY, dpr: devicePixelRatio
}))()`;

const findJs = (text) => `(() => {
  const want = ${JSON.stringify(String(text).toLowerCase())};
  const nodes = [...document.querySelectorAll('a,button,input,select,textarea,[role="button"]')];
  const el = nodes.find(e => {
    const t = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().toLowerCase();
    return t === want;
  }) || nodes.find(e => {
    const t = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().toLowerCase();
    return t.includes(want);
  });
  if (!el) return JSON.stringify({ found: false });
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  el.setAttribute('data-showtime', '1');
  return JSON.stringify({ found: true, x: r.x + r.width / 2, y: r.y + r.height / 2,
    box: [r.x, r.y, r.width, r.height], tag: el.tagName.toLowerCase(),
    label: (el.innerText || el.value || el.placeholder || '').trim().slice(0, 40) });
})()`;

// The ripple exists because a cursor that merely stops moving does not read as
// a click. Drawn in the page so it needs no compositor and lands exactly on the
// element, in page coordinates the browser already knows.
const rippleJs = (x, y) => `(() => {
  const d = document.createElement('div');
  Object.assign(d.style, {
    position: 'fixed', left: (${x} - 6) + 'px', top: (${y} - 6) + 'px',
    width: '12px', height: '12px', borderRadius: '50%',
    border: '2px solid rgba(255,59,48,.95)', background: 'rgba(255,59,48,.25)',
    zIndex: 2147483647, pointerEvents: 'none',
    transition: 'transform .45s cubic-bezier(.2,.7,.3,1), opacity .45s ease-out',
  });
  document.body.appendChild(d);
  requestAnimationFrame(() => { d.style.transform = 'scale(4.5)'; d.style.opacity = '0'; });
  setTimeout(() => d.remove(), 600);
  return JSON.stringify({ rippled: true });
})()`;

// --- run --------------------------------------------------------------------
let rec = null;
let tabId = null;
try {
  await camofox.waitHealthy();
  const tab = await camofox.openTab(url, USER);
  tabId = tab.tabId;
  await sleep(2500);

  const videoPath = join(outDir, "session.mp4");
  rec = spawn("ffmpeg", [
    "-loglevel", "error", "-y",
    "-f", "x11grab", "-draw_mouse", "1", "-framerate", String(fps),
    "-video_size", geo, "-i", DISPLAY,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let recErr = "";
  rec.stderr.on("data", (c) => { recErr += c; });
  await sleep(1200);
  if (rec.exitCode !== null) throw new Error(`recorder died: ${recErr.slice(0, 200)}`);
  console.log(`recording → ${videoPath}`);

  // Park the pointer somewhere neutral so the first glide is visible.
  let px = 40, py = 40;
  xdo("mousemove", String(px), String(py));
  await sleep(400);

  for (const [n, step] of steps.entries()) {
    if (step.wait) { await sleep(step.wait); continue; }

    const target = step.click ?? (step.type ? step.type[0] : null);
    if (!target) continue;

    const found = parse(await camofox.evaluate(tabId, USER, findJs(target)));
    if (!found.found) { console.log(`  [${n}] "${target}" not found — skipping`); continue; }

    const off = parse(await camofox.evaluate(tabId, USER, OFFSET_JS));
    // Firefox reports the viewport origin in screen coords; getBoundingClientRect
    // is already viewport-relative, so no scroll term is needed here.
    const sx = Math.round(off.ox + found.x * off.dpr);
    const sy = Math.round(off.oy + found.y * off.dpr);

    console.log(`  [${n}] ${step.click ? "click" : "type"} "${found.label}" → page(${Math.round(found.x)},${Math.round(found.y)}) screen(${sx},${sy})`);
    glide(px, py, sx, sy, 750);
    px = sx; py = sy;
    await sleep(180);

    await camofox.evaluate(tabId, USER, rippleJs(found.x, found.y));
    await sleep(120);

    if (step.click) {
      // Real click through the browser's input pipeline, addressed by the
      // attribute the finder stamped, so it lands on the element the pointer
      // is visibly hovering.
      await fetch(`${camofox.base}/tabs/${tabId}/click`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: USER, selector: '[data-showtime="1"]' }),
      });
    } else {
      await fetch(`${camofox.base}/tabs/${tabId}/type`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: USER, selector: '[data-showtime="1"]', text: step.type[1], pressEnter: !!step.enter }),
      });
    }
    await camofox.evaluate(tabId, USER, `(() => { for (const e of document.querySelectorAll('[data-showtime]')) e.removeAttribute('data-showtime'); return JSON.stringify({ok:1}); })()`);
    await sleep(step.after ?? 900);
  }

  await sleep(1000);
} finally {
  if (rec && rec.exitCode === null) {
    // SIGINT, so the container trailer is written and the file is playable.
    rec.kill("SIGINT");
    await new Promise((r) => rec.on("close", r));
  }
  if (tabId) await camofox.closeTab(tabId, USER).catch(() => {});
}

const out = join(outDir, "session.mp4");
console.log(`\ndone → ${out}`);
try {
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size",
    "-show_entries", "stream=width,height", "-of", "default=noprint_wrappers=1", out], { encoding: "utf8" });
  console.log(probe.trim().split("\n").map((l) => `  ${l}`).join("\n"));
} catch { console.log("  (ffprobe could not read it — the recording may be empty)"); }
