#!/usr/bin/env node
// Verify the state reader and the escalation ladder against live pages.
//
// The load-bearing assertion is the Google one. From a flagged IP, google.com's
// /search serves /sorry/index, which shows BOTH "unusual traffic from your
// computer network" and a reCAPTCHA widget. A naive classifier sees the widget
// and escalates to vision — burning the caller's tokens on a challenge that
// will not let them through, because the block is on the network, not the
// browser. It has to come back as network_block/stop.

import { camofox } from "./lib/camofox.mjs";
import { readState } from "./lib/dom.mjs";

const USER = "nav-verify";

const CASES = [
  {
    name: "normal page",
    url: "https://en.wikipedia.org/wiki/Minecraft",
    expectClass: "clear",
    expectVerdict: "proceed",
    also: (s) => (s.elements.length > 20 ? null : `expected many interactive elements, got ${s.elements.length}`),
  },
  {
    name: "IP-reputation block that LOOKS like a CAPTCHA",
    url: "https://www.google.com/search?q=minecraft",
    expectClass: "network_block",
    expectVerdict: "stop",
    also: (s) =>
      s.obstacle.evidence.widgets?.some((w) => w.startsWith("recaptcha"))
        ? null
        : `expected a reCAPTCHA widget to be present (that is what makes this case a trap); widgets=${JSON.stringify(s.obstacle.evidence.widgets)}`,
  },
  {
    name: "search engine that works",
    url: "https://duckduckgo.com/?q=minecraft",
    expectVerdict: "proceed",
  },
];

await camofox.waitHealthy();
let failures = 0;

for (const c of CASES) {
  let tabId = null;
  try {
    const tab = await camofox.openTab(c.url, USER);
    tabId = tab.tabId;
    await new Promise((r) => setTimeout(r, 2500));
    const s = await readState(tabId, USER, { highlight: false });

    const o = s.obstacle;
    const problems = [];
    if (c.expectClass && o.class !== c.expectClass) problems.push(`class ${o.class} != ${c.expectClass}`);
    if (c.expectVerdict && o.verdict !== c.expectVerdict) problems.push(`verdict ${o.verdict} != ${c.expectVerdict}`);
    const extra = c.also ? c.also(s) : null;
    if (extra) problems.push(extra);

    const mark = problems.length ? "✘" : "✔";
    console.log(`\n${mark} ${c.name}`);
    console.log(`   ${s.url.slice(0, 90)}`);
    console.log(`   class=${o.class}  verdict=${o.verdict}  elements=${s.elements.length}`);
    console.log(`   why: ${o.why}`);
    if (o.evidence.phrases?.length) console.log(`   phrases: ${o.evidence.phrases.join(", ")}`);
    if (o.evidence.widgets?.length) console.log(`   widgets: ${o.evidence.widgets.join(", ")}`);
    if (o.evidence.quote) console.log(`   quote: "${o.evidence.quote.slice(0, 110)}"`);
    if (s.elements.length) {
      console.log(`   first elements:`);
      for (const e of s.elements.slice(0, 4)) {
        console.log(`     [${String(e.i).padStart(2)}] ${e.tag.padEnd(8)} ${e.inView ? "in-view " : "off-view"} ${e.label.slice(0, 52)}`);
      }
    }
    if (problems.length) {
      failures++;
      for (const p of problems) console.log(`   ✘ ${p}`);
    }
  } catch (e) {
    failures++;
    console.log(`\n✘ ${c.name}: ${e.message}`);
  } finally {
    if (tabId) await camofox.closeTab(tabId, USER).catch(() => {});
  }
}

console.log(`\n${failures ? `FAIL — ${failures} case(s)` : "PASS — escalation ladder behaves"}`);
process.exit(failures ? 1 : 0);
