#!/usr/bin/env node
//
// Deterministic test of the escalation ladder.
//
// Live sites are the wrong fixture for this. The first version of this test
// asserted that google.com/search classifies as an IP block — true when it was
// written, false a few hours later when the block expired. A classifier has to
// be tested against the STRUCTURE of each obstacle, which is stable, not against
// whichever site happens to be blocking today.
//
// Fixtures are served from a throwaway local HTTP server, so this runs offline
// and gives the same answer every time. Two live smoke cases are kept at the end
// to catch the classifier drifting away from the real web, and they are allowed
// to be inconclusive without failing the suite.

import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { camofox } from "./lib/camofox.mjs";
import { readState } from "./lib/dom.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const USER = "nav-classifier-test";

// filename -> what the ladder must say about it
const EXPECT = {
  "network_block.html":     { class: "network_block",     verdict: "stop" },
  "captcha_checkbox.html":  { class: "captcha_checkbox",  verdict: "escalate_vision" },
  "captcha_image.html":     { class: "captcha_image",     verdict: "escalate_vision" },
  "managed_challenge.html": { class: "managed_challenge", verdict: "wait_retry" },
  "rate_limited.html":      { class: "rate_limited",      verdict: "wait_retry" },
  "login_wall.html":        { class: "login_wall",        verdict: "stop" },
  "clear_page.html":        { class: "clear",             verdict: "proceed" },
};

const server = createServer((req, res) => {
  const name = decodeURIComponent(req.url.replace(/^\//, "").split("?")[0]);
  try {
    const body = readFileSync(join(FIXTURES, name));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

await camofox.waitHealthy();

let fail = 0;
let pass = 0;

async function check(url, expect, label) {
  let tabId = null;
  try {
    const tab = await camofox.openTab(url, USER);
    tabId = tab.tabId;
    await new Promise((r) => setTimeout(r, 1200));
    const s = await readState(tabId, USER, { highlight: false });
    const o = s.obstacle;
    const problems = [];
    if (expect.class && o.class !== expect.class) problems.push(`class=${o.class} want=${expect.class}`);
    if (expect.verdict && o.verdict !== expect.verdict) problems.push(`verdict=${o.verdict} want=${expect.verdict}`);
    if (problems.length) {
      fail++;
      console.log(`  ✘ ${label.padEnd(24)} ${problems.join("  ")}`);
      console.log(`      phrases=[${o.evidence.phrases || ""}] widgets=[${o.evidence.widgets || ""}] short=${s.textPreview.length < 400}`);
    } else {
      pass++;
      console.log(`  ✔ ${label.padEnd(24)} ${o.class} → ${o.verdict}   (${s.elements.length} interactive)`);
    }
    return s;
  } catch (e) {
    fail++;
    console.log(`  ✘ ${label.padEnd(24)} ${e.message.slice(0, 90)}`);
    return null;
  } finally {
    if (tabId) await camofox.closeTab(tabId, USER).catch(() => {});
  }
}

console.log(`\nFixtures (deterministic, served from ${origin}):\n`);
for (const f of readdirSync(FIXTURES).sort()) {
  if (!EXPECT[f]) continue;
  await check(`${origin}/${f}`, EXPECT[f], f.replace(".html", ""));
}

console.log(`\nLive smoke (informational — the web changes under us):\n`);
for (const url of ["https://en.wikipedia.org/wiki/Minecraft", "https://duckduckgo.com/?q=minecraft"]) {
  let tabId = null;
  try {
    const tab = await camofox.openTab(url, USER);
    tabId = tab.tabId;
    await new Promise((r) => setTimeout(r, 2500));
    const s = await readState(tabId, USER, { highlight: false });
    // A long content page must never be called a block. That direction of error
    // is the dangerous one: it stops work that would have succeeded.
    const misjudged = ["network_block", "access_denied", "rate_limited", "login_wall"].includes(s.obstacle.class);
    if (misjudged) {
      fail++;
      console.log(`  ✘ ${url.slice(0, 46).padEnd(48)} falsely called ${s.obstacle.class}`);
    } else {
      pass++;
      console.log(`  ✔ ${url.slice(0, 46).padEnd(48)} ${s.obstacle.class} → ${s.obstacle.verdict} (${s.elements.length} interactive)`);
    }
  } catch (e) {
    console.log(`  ~ ${url.slice(0, 46).padEnd(48)} unreachable: ${e.message.slice(0, 40)}`);
  } finally {
    if (tabId) await camofox.closeTab(tabId, USER).catch(() => {});
  }
}

server.close();
console.log(`\n${fail ? `FAIL — ${fail} failed, ${pass} passed` : `PASS — all ${pass} checks`}`);
process.exit(fail ? 1 : 0);
