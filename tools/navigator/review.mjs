#!/usr/bin/env node
//
// review — drive a front-end like a user and report what is actually wrong.
//
// This is the part a human reviewer does badly and a screenshot does not do at
// all: open every screen, touch every control, and watch the channels that never
// render — swallowed exceptions, unhandled rejections, failed requests, missing
// labels, layouts that overflow.
//
// The one judgement that makes the output worth reading: a call that fails
// because a backend is deliberately absent is EXPECTED and is not a finding. A
// component that breaks, blanks, or silently swallows that failure IS a finding.
// Everything here is arranged to keep those apart, because a report that lists
// forty red network lines and calls them bugs is worse than no report.
//
// Usage:
//   node review.mjs http://127.0.0.1:4200 --routes /login,/register --out DIR
//   node review.mjs http://127.0.0.1:4200 --routes-file routes.json

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { camofox } from "./lib/camofox.mjs";
import { readState } from "./lib/dom.mjs";
import { INSTRUMENT_JS, HARVEST_JS, AUDIT_JS, classifyNetwork } from "./lib/instrument.mjs";

const argv = process.argv.slice(2);
const base = (argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:4200").replace(/\/$/, "");
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1];
};
const routes = String(arg("--routes", "/")).split(",").map((r) => r.trim()).filter(Boolean);
const outDir = arg("--out", "./review-out");
const expectedPrefixes = String(arg("--expect-fail", "/api")).split(",").filter(Boolean);
const viewports = String(arg("--viewports", "1440x900,390x844")).split(",");
const USER = "fe-review";
// Optional client-side session seed. Guards in SPAs are usually a localStorage
// check, so seeding one reaches the authenticated screens WITHOUT a backend —
// which is the only way to review them when the API is deliberately absent.
// It is a review fixture, not a login: no credentials are sent anywhere.
const seedFile = arg("--seed-session", null);

mkdirSync(outDir, { recursive: true });
const parse = (raw) => (typeof raw === "string" ? JSON.parse(raw) : raw);

const findings = [];
// Collected across routes: a title that never changes is only visible once you
// have seen more than one screen.
const seenTitles = new Set();
const add = (severity, area, route, what, evidence) =>
  findings.push({ severity, area, route, what, evidence });

await camofox.waitHealthy();
const tab = await camofox.openTab(base, USER);
const tabId = tab.tabId;
console.log(`reviewing ${base}\n  tab ${tabId}\n  out ${outDir}\n`);

const settle = async (ms = 1800) => new Promise((r) => setTimeout(r, ms));

try {
  for (const route of routes) {
    const url = `${base}${route}`;
    console.log(`\n── ${route}`);
    await camofox.navigate(tabId, USER, { url });
    if (seedFile) {
      // Written before the app reads it, then reloaded so the guard sees a
      // session on boot rather than half-way through routing.
      const seed = JSON.parse(readFileSync(seedFile, "utf8"));
      await camofox.evaluate(tabId, USER, `(() => {
        const s = ${JSON.stringify(seed)};
        for (const [k, v] of Object.entries(s)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
        return JSON.stringify({ seeded: Object.keys(s) });
      })()`);
      await camofox.navigate(tabId, USER, { url });
    }
    // Instrument AFTER the document exists but as early as possible. A full load
    // is unavoidable per route here; the SPA pass below is what catches errors
    // that only happen on in-app transitions.
    await camofox.evaluate(tabId, USER, INSTRUMENT_JS);
    await settle(2200);

    const state = await readState(tabId, USER, { highlight: false });
    const audit = parse(await camofox.evaluate(tabId, USER, AUDIT_JS));
    const harvest = parse(await camofox.evaluate(tabId, USER, HARVEST_JS(true)));
    const net = classifyNetwork(harvest.network || [], { expectedPrefixes });

    console.log(`   title="${audit.title}" h1=${audit.h1Count} interactive=${state.elements.length} forms=${audit.formCount}`);
    console.log(`   network: ${(harvest.network || []).length} calls, ${net.expected.length} expected-fail, ${net.unexpected.length} unexpected-fail`);
    console.log(`   console.error=${(harvest.console || []).filter((c) => c.level === "error").length} uncaught=${(harvest.errors || []).length} rejections=${(harvest.rejections || []).length}`);

    // --- findings -----------------------------------------------------------
    // Did the route actually render, or did it bounce? A guard redirect is not a
    // bug, but a blank screen is.
    if (state.url && !state.url.includes(route) && route !== "/") {
      add("info", "routing", route, `redirected to ${new URL(state.url).pathname}`, { from: route, to: state.url });
    }
    if (state.elements.length === 0) {
      // Re-check before accusing. A splash screen with a setTimeout redirect has
      // nothing to click for a moment BY DESIGN — calling that a blocker was a
      // false positive caused by settling 300ms short of the app's own 2.5s
      // timer. A screen that is still empty seconds later is a real problem.
      await settle(4000);
      const again = await readState(tabId, USER, { highlight: false });
      if (again.elements.length === 0 && again.url.includes(route)) {
        add("blocker", "render", route, "screen still has no interactive elements after 6s", { textPreview: again.textPreview?.slice(0, 160) });
      } else if (!again.url.includes(route)) {
        add("info", "routing", route, `transitional screen — moved to ${new URL(again.url).pathname} on its own`, { after: "~6s" });
      }
    }

    for (const e of harvest.errors || []) {
      add("blocker", "runtime", route, `uncaught exception: ${e.message}`, e);
    }
    for (const r of harvest.rejections || []) {
      // The most valuable channel: an unhandled rejection means a failure path
      // nobody wrote code for, which is exactly what an absent backend exposes.
      add("major", "runtime", route, `unhandled promise rejection: ${r.message}`, r);
    }
    for (const c of (harvest.console || []).filter((x) => x.level === "error")) {
      add("major", "runtime", route, `console.error: ${c.text.slice(0, 160)}`, c);
    }
    for (const n of net.unexpected) {
      add("major", "network", route, `unexpected request failure ${n.status || "conn-refused"} ${n.path}`, n);
    }
    if (net.expected.length) {
      add("info", "network", route, `${net.expected.length} backend call(s) failed as expected (no backend running)`, {
        sample: net.expected.slice(0, 3).map((e) => `${e.method} ${e.path} → ${e.status || "refused"}`),
      });
    }

    seenTitles.add(audit.title);
    if (!audit.h1Count) add("minor", "a11y", route, "no visible <h1> — screen readers get no page heading", {});
    if (audit.h1Count > 1) add("minor", "a11y", route, `${audit.h1Count} <h1> elements on one screen`, { h1: audit.h1 });
    if (!audit.lang) add("minor", "a11y", route, "<html> has no lang attribute", {});
    if (audit.imgsNoAlt) add("minor", "a11y", route, `${audit.imgsNoAlt} image(s) without alt`, {});
    if (audit.inputsNoLabel?.length) add("major", "a11y", route, `${audit.inputsNoLabel.length} form field(s) with no label or placeholder`, { fields: audit.inputsNoLabel.slice(0, 6) });
    if (audit.buttonsNoName) add("major", "a11y", route, `${audit.buttonsNoName} button(s) with no accessible name`, {});
    if (audit.positiveTabindex) add("minor", "a11y", route, `${audit.positiveTabindex} element(s) with a positive tabindex — breaks natural focus order`, {});

    const shot = await camofox.screenshotPng(tabId, USER);
    const shotPath = join(outDir, `${route.replace(/\W+/g, "_") || "root"}.png`);
    writeFileSync(shotPath, shot);
    console.log(`   shot ${shotPath} (${(shot.length / 1024).toFixed(0)} KB)`);
  }

  // --- responsive pass ------------------------------------------------------
  // A layout that overflows horizontally is being rendered at a width its author
  // did not test, and it is invisible in a desktop-only review.
  console.log(`\n── responsive`);
  for (const vp of viewports) {
    const [w, h] = vp.split("x").map(Number);
    await camofox.evaluate(tabId, USER, `(() => JSON.stringify({noop:1}))()`);
    for (const route of routes.slice(0, 3)) {
      await camofox.navigate(tabId, USER, { url: `${base}${route}` });
      await settle(1500);
      const a = parse(await camofox.evaluate(tabId, USER, `(() => {
        // Can only measure the viewport the browser actually has; report it so a
        // claim about "mobile" is never made about a desktop-sized window.
        return ${AUDIT_JS};
      })()`));
      if (a.overflowX) {
        add("major", "layout", route, `horizontal overflow at ${a.viewport[0]}px (content ${a.scrollWidth}px > viewport ${a.clientWidth}px)`, { viewport: a.viewport });
      }
      console.log(`   ${route} @${a.viewport[0]}x${a.viewport[1]} overflowX=${a.overflowX}`);
    }
    break; // one viewport per run: the browser window size is fixed by the service
  }

  // --- interaction pass: roleplay ------------------------------------------
  // Clicking things is where a review stops being a checklist. Every control on
  // the first form-bearing screen gets touched, and anything that throws or
  // navigates unexpectedly becomes a finding.
  console.log(`\n── interaction (roleplay: a user tries to register)`);
  const flowRoute = routes.find((r) => /register|login/.test(r)) || routes[0];
  await camofox.navigate(tabId, USER, { url: `${base}${flowRoute}` });
  await camofox.evaluate(tabId, USER, INSTRUMENT_JS);
  await settle(2000);

  const before = await readState(tabId, USER, { highlight: false });
  const inputs = before.elements.filter((e) => e.tag === "input" || e.tag === "textarea");
  const buttons = before.elements.filter((e) => e.tag === "button");
  console.log(`   ${inputs.length} field(s), ${buttons.length} button(s) on ${flowRoute}`);

  // Submit an empty form first: validation that only fires on a filled form is
  // validation a real user will get past.
  if (buttons.length) {
    const submitLike = buttons.find((b) => /enviar|submit|continuar|siguiente|crear|registr|ingresar|login/i.test(b.label)) || buttons[0];
    await camofox.evaluate(tabId, USER, `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(submitLike.label)}); if(b) b.click(); return JSON.stringify({clicked:!!b}); })()`);
    await settle(1200);
    const afterEmpty = parse(await camofox.evaluate(tabId, USER, `(() => {
      const invalid = document.querySelectorAll('.ng-invalid.ng-touched, [aria-invalid="true"], .error, .invalid-feedback, mat-error').length;
      return JSON.stringify({ invalid, url: location.pathname, bodyLen: document.body.innerText.length });
    })()`));
    console.log(`   empty submit → ${afterEmpty.invalid} validation message(s), url=${afterEmpty.url}`);
    if (afterEmpty.invalid === 0 && inputs.length > 0) {
      add("major", "validation", flowRoute, `submitting an empty form produced no visible validation message`, afterEmpty);
    } else {
      add("info", "validation", flowRoute, `empty submit correctly surfaced ${afterEmpty.invalid} validation message(s)`, afterEmpty);
    }
  }

  const post = parse(await camofox.evaluate(tabId, USER, HARVEST_JS(true)));
  const postNet = classifyNetwork(post.network || [], { expectedPrefixes });
  for (const e of post.errors || []) add("blocker", "runtime", flowRoute, `uncaught exception during interaction: ${e.message}`, e);
  for (const r of post.rejections || []) add("major", "runtime", flowRoute, `unhandled rejection during interaction: ${r.message}`, r);
  for (const n of postNet.unexpected) add("major", "network", flowRoute, `unexpected failure during interaction ${n.status} ${n.path}`, n);

  const shot = await camofox.screenshotPng(tabId, USER);
  writeFileSync(join(outDir, "interaction.png"), shot);
} finally {
  await camofox.closeTab(tabId, USER).catch(() => {});
}

if (seenTitles.size === 1 && routes.length > 1) {
  const only = [...seenTitles][0];
  add("major", "ux", "(all routes)",
    `every screen has the same <title> "${only}" — browser tabs, history and bookmarks are indistinguishable, and screen readers announce the same page name everywhere`,
    { routes: routes.length, title: only });
}

// --- report -----------------------------------------------------------------
const order = { blocker: 0, major: 1, minor: 2, info: 3 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);
writeFileSync(join(outDir, "findings.json"), JSON.stringify(findings, null, 2));

const count = (s) => findings.filter((f) => f.severity === s).length;
console.log(`\n${"=".repeat(70)}\nFINDINGS  ${count("blocker")} blocker  ${count("major")} major  ${count("minor")} minor  ${count("info")} info\n`);
for (const f of findings) {
  const tag = { blocker: "✘", major: "▲", minor: "·", info: "i" }[f.severity];
  console.log(`${tag} [${f.area}] ${f.route}  ${f.what}`);
  const ev = JSON.stringify(f.evidence);
  if (ev && ev !== "{}") console.log(`    ${ev.slice(0, 190)}`);
}
console.log(`\nwrote ${join(outDir, "findings.json")}`);
