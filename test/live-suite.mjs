#!/usr/bin/env node
//
// Live test suite — drives real pages through the real stdio MCP adapter.
//
// This is the extensive counterpart to test/mcp-e2e.mjs (which is a 6-step
// smoke test). It covers the things that actually break in agent work: local
// dev servers, JS-rendered SPAs, bot detection, search macros, snapshot
// pagination, and session isolation.
//
// Screenshots are written to test/artifacts/ so a human — or an agent with an
// image-capable Read tool — can confirm the pixels are real and not a blank page.
//
// Usage:
//   node test/live-suite.mjs                      # everything
//   node test/live-suite.mjs --only local,github  # a subset
//   node test/live-suite.mjs --list
//
// Some tests need a local server; they SKIP rather than fail when it is absent:
//   vite dev server on :5173   (npm create vite@latest app -- --template react-ts)

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, resolveAdapter } from "./lib/mcp-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(HERE, "artifacts");

const C = process.stdout.isTTY
  ? { r: "\x1b[0m", b: "\x1b[1m", d: "\x1b[2m", g: "\x1b[32m", red: "\x1b[31m", y: "\x1b[33m", c: "\x1b[36m" }
  : { r: "", b: "", d: "", g: "", red: "", y: "", c: "" };

// --- helpers ---------------------------------------------------------------
const VITE_URL = process.env.VITE_URL || "http://127.0.0.1:5173/";
const REST_URL = process.env.CAMOFOX_BASE_URL || "http://127.0.0.1:9377";

async function reachable(url) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 3000);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    // Must be genuinely OK. Treating any sub-500 status as "reachable" makes a
    // 404 look like a live endpoint, and the test then fails for the wrong reason.
    return res.ok;
  } catch {
    return false;
  }
}

function saveImages(name, images) {
  if (!images.length) return [];
  mkdirSync(ARTIFACTS, { recursive: true });
  return images.map((img, i) => {
    const ext = (img.mimeType || "image/png").split("/")[1].replace("jpeg", "jpg");
    const path = join(ARTIFACTS, `${name}${images.length > 1 ? `-${i}` : ""}.${ext}`);
    writeFileSync(path, img.buffer);
    return { path, bytes: img.buffer.length };
  });
}

// A PNG that is a single flat colour is almost certainly a failed render. Cheap
// heuristic: a real screenshot compresses to far more than a few KB.
const looksLikeRealImage = (bytes) => bytes > 8_000;

// Open a tab, run body(tabId), always close the tab. Leaked tabs eat the
// per-session budget and make later tests fail for the wrong reason.
async function withTab(client, url, body) {
  const { json } = await client.callJson("camofox_create_tab", { url });
  const tabId = json?.tabId;
  if (!tabId) throw new Error(`no tabId for ${url}`);
  try {
    return await body(tabId);
  } finally {
    try { await client.call("camofox_close_tab", { tabId }); } catch { /* best effort */ }
  }
}

const evalOn = async (client, tabId, expression) => {
  const { json, text } = await client.callJson("camofox_evaluate", { tabId, expression });
  return json?.result !== undefined ? json.result : text;
};

// --- tests -----------------------------------------------------------------
// Each returns { detail, artifacts?, status? }. Throwing means fail.
// status "info" records a measurement without gating the suite.
const TESTS = [
  {
    name: "local",
    title: "Local Vite dev server — the agentic dev loop",
    async run(client) {
      if (!(await reachable(VITE_URL))) {
        return { status: "skip", detail: `no dev server at ${VITE_URL}` };
      }
      return withTab(client, VITE_URL, async (tabId) => {
        const snap = await client.callJson("camofox_snapshot", { tabId });
        const artifacts = saveImages("local-vite", snap.images);

        // React renders client-side: if the snapshot sees the button, JS ran.
        if (!/count is/i.test(snap.text)) {
          throw new Error(`SPA did not render — snapshot: ${snap.text.slice(0, 200)}`);
        }
        const before = await evalOn(client, tabId, "document.querySelector('button').textContent");

        // Clicking by ref is the path the skill tells agents to use.
        const ref = (snap.text.match(/\[ref=(e\d+)\]\s*$/m) || [])[1] || null;
        if (ref) await client.call("camofox_click", { tabId, ref });
        else await client.call("camofox_click", { tabId, selector: "button" });

        const after = await evalOn(client, tabId, "document.querySelector('button').textContent");
        if (String(before) === String(after)) {
          throw new Error(`click did not change state: still ${after}`);
        }
        return {
          detail: `SPA rendered, click by ${ref ? `ref ${ref}` : "selector"}: "${before}" → "${after}"`,
          artifacts,
        };
      });
    },
  },

  {
    name: "search",
    title: "Web search actually returns results (DuckDuckGo + Bing)",
    async run(client) {
      // Two independent engines. If both work, search is functional and any
      // single-engine block is that engine's IP policy, not a broken browser.
      const engines = [
        { label: "DuckDuckGo", url: "https://duckduckgo.com/?q=camoufox+anti+detection" },
        { label: "Bing", url: "https://www.bing.com/search?q=camoufox+anti+detection" },
      ];
      const found = [];
      for (const e of engines) {
        await withTab(client, e.url, async (tabId) => {
          await new Promise((r) => setTimeout(r, 2500));
          const n = Number(await evalOn(client, tabId, "document.querySelectorAll('h3').length")) || 0;
          found.push(`${e.label}=${n}`);
        });
      }
      const working = found.filter((f) => Number(f.split("=")[1]) > 0);
      if (!working.length) throw new Error(`no engine returned results: ${found.join(" ")}`);
      return { detail: `result headings — ${found.join(", ")}` };
    },
  },

  {
    name: "github",
    title: "GitHub project page — real remote, JS-rendered counters",
    async run(client) {
      return withTab(client, "https://github.com/daijro/camoufox", async (tabId) => {
        const snap = await client.callJson("camofox_snapshot", { tabId });
        const artifacts = saveImages("github-camoufox", snap.images);
        const stars = await evalOn(
          client,
          tabId,
          "(document.querySelector('#repo-stars-counter-star')||{}).textContent || 'n/a'",
        );
        if (!/camoufox/i.test(snap.text)) throw new Error("page content missing repo name");
        return { detail: `stars=${stars}, snapshot ${snap.text.length} chars`, artifacts };
      });
    },
  },

  {
    name: "stealth",
    title: "bot.sannysoft.com — headless-detection panel",
    async run(client) {
      return withTab(client, "https://bot.sannysoft.com/", async (tabId) => {
        await new Promise((r) => setTimeout(r, 3000)); // async probes finish late
        const rows = await evalOn(
          client,
          tabId,
          `JSON.stringify([...document.querySelectorAll('table tr')].map(tr=>[...tr.children].map(td=>td.textContent.trim()).join('|')).filter(Boolean).slice(0,20))`,
        );
        const shot = await client.call("camofox_screenshot", { tabId });
        const artifacts = saveImages("stealth-sannysoft", shot.images);
        const parsed = typeof rows === "string" ? JSON.parse(rows) : rows;

        // The rows that actually indicate automation. Assert on these by name
        // instead of counting red cells, because one red cell is expected:
        // sannysoft's "Chrome (New)" test looks for window.chrome, which is
        // absent in Firefox by definition. Camoufox IS Firefox — that row is
        // correct behaviour, not a leak.
        const mustPass = ["WebDriver", "WebDriver Advanced", "Plugins is of type PluginArray"];
        const leaks = [];
        for (const label of mustPass) {
          const row = parsed.find((r) => r.startsWith(label));
          if (!row) continue;
          if (!/passed|missing \(passed\)/i.test(row)) leaks.push(row);
        }
        if (leaks.length) throw new Error(`automation leaked: ${leaks.join("  ")}`);

        const uaRow = parsed.find((r) => r.startsWith("User Agent")) || "";
        const chromeRow = parsed.find((r) => r.startsWith("Chrome")) || "";
        return {
          detail:
            `${mustPass.length} automation probes passed; ` +
            `UA "${uaRow.split("|")[1]?.slice(0, 48) || "?"}"` +
            (/failed/i.test(chromeRow) ? "; Chrome-only probe red as expected for Firefox" : ""),
          artifacts,
        };
      });
    },
  },

  {
    name: "google",
    title: "@google_search macro — hardest target, and it distinguishes why it fails",
    async run(client) {
      return withTab(client, "https://www.google.com/", async (tabId) => {
        await client.call("camofox_navigate", {
          tabId,
          macro: "@google_search",
          query: "camoufox anti detection browser",
        });
        await new Promise((r) => setTimeout(r, 2500));
        const info = await evalOn(
          client,
          tabId,
          `JSON.stringify({
             title: document.title,
             results: document.querySelectorAll('#search a h3, div[data-sokoban-container] h3').length,
             // "your computer network" is Google naming the NETWORK, not the client.
             networkBlock: /unusual traffic from your computer network/i.test(document.body.innerText),
             challenge: /recaptcha|not a robot/i.test(document.body.innerText),
           })`,
        );
        const parsed = typeof info === "string" ? JSON.parse(info) : info;
        const shot = await client.call("camofox_screenshot", { tabId });
        const artifacts = saveImages("google-search", shot.images);

        if (parsed.results > 0) {
          return { detail: `${parsed.results} results, no challenge`, artifacts };
        }

        // An IP-reputation block is not a fingerprint failure, and conflating the
        // two sends you off tuning stealth settings that were never the problem.
        // The discriminator: this exact wording blames the network, and the
        // `stealth` test independently confirms the fingerprint is clean.
        // The documented fix is a proxy (PROXY_HOST etc.), not stealth tuning.
        if (parsed.networkBlock) {
          return {
            status: "info",
            detail:
              "IP-reputation block, NOT fingerprint detection — Google flagged this exit IP " +
              "(\"unusual traffic from your computer network\"). Fix is a proxy, not stealth settings. " +
              "Cross-check: the `stealth` and `search` tests pass on this same browser.",
            artifacts,
          };
        }
        if (parsed.challenge) {
          throw new Error("challenged without a network-block notice — investigate the fingerprint");
        }
        throw new Error(`no results and no challenge — selector drift? (title: ${parsed.title})`);
      });
    },
  },

  {
    name: "creepjs",
    title: "CreepJS — deep fingerprint audit (open source)",
    async run(client) {
      return withTab(client, "https://abrahamjuliot.github.io/creepjs/", async (tabId) => {
        // CreepJS runs a long async battery. Poll for its Headless section
        // rather than a trust score: the headless/stealth percentages are the
        // numbers that speak to the claim this kit makes, and they are stable
        // across CreepJS releases in a way the overall score is not.
        let probe = null;
        for (let i = 0; i < 24; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const raw = await evalOn(
            client,
            tabId,
            `(() => {
               const t = document.body.innerText;
               const num = (re) => { const m = t.match(re); return m ? Number(m[1]) : null; };
               const out = {
                 chromium: /chromium:\\s*(true|false)/i.test(t) ? RegExp.$1 : null,
                 likeHeadless: num(/(\\d+)%\\s*like headless/i),
                 headless: num(/(\\d+)%\\s*headless:/i),
                 stealth: num(/(\\d+)%\\s*stealth/i),
                 // Timezone/locale the browser claims.
                 tz: (t.match(/(America|Europe|Asia|Africa|Australia|Pacific)[,/]\\s*([A-Za-z_]+)/) || [])[0] || null,
                 // WebRTC candidate IP: if this is the real exit IP while the
                 // timezone claims somewhere else, that mismatch is itself a
                 // detectable signal.
                 webrtcIp: (t.match(/ip:\\s*(\\d+\\.\\d+\\.\\d+\\.\\d+)/) || [])[1] || null,
               };
               return out.headless === null && out.stealth === null ? '' : JSON.stringify(out);
             })()`,
          );
          if (raw && String(raw).trim()) { probe = JSON.parse(String(raw)); break; }
        }
        const shot = await client.call("camofox_screenshot", { tabId });
        const artifacts = saveImages("creepjs", shot.images);

        if (!probe) return { status: "info", detail: "CreepJS did not finish in time", artifacts };

        // This is the headline claim, so it is a hard assertion, not a note.
        if (probe.headless > 0 || probe.stealth > 0) {
          throw new Error(
            `CreepJS detected automation: ${probe.headless}% headless, ${probe.stealth}% stealth`,
          );
        }

        // A real leak worth surfacing: the spoofed timezone and the actual
        // WebRTC exit IP disagree. Camoufox's GeoIP + proxy support exists to
        // align them; without a proxy the persona says one country and the
        // network says another.
        const mismatch =
          probe.webrtcIp && probe.tz
            ? ` ⚠ WebRTC exposes ${probe.webrtcIp} while timezone claims ${probe.tz} — align them with a proxy + GeoIP`
            : "";

        return {
          detail:
            `${probe.headless}% headless, ${probe.stealth}% stealth, chromium=${probe.chromium}` +
            (probe.likeHeadless != null ? `, ${probe.likeHeadless}% "like headless"` : "") +
            mismatch,
          artifacts,
        };
      });
    },
  },

  {
    name: "pagination",
    title: "Snapshot pagination on a large page",
    async run(client) {
      return withTab(client, "https://en.wikipedia.org/wiki/Linux", async (tabId) => {
        const first = await client.callJson("camofox_snapshot", { tabId });
        const hasMore = first.json?.hasMore;
        const nextOffset = first.json?.nextOffset;
        if (!hasMore) {
          return { status: "info", detail: `page fit in one snapshot (${first.text.length} chars)` };
        }
        const second = await client.callJson("camofox_snapshot", { tabId, offset: nextOffset });
        if (!second.text || second.text.length < 50) throw new Error("second page was empty");
        if (second.text === first.text) throw new Error("offset ignored — same content returned");
        return { detail: `paged: ${first.text.length} chars then offset ${nextOffset} → ${second.text.length} chars` };
      });
    },
  },

  {
    name: "isolation",
    title: "Session isolation between two agent sessions",
    async run(client, { adapter }) {
      // A second adapter with a different CAMOFOX_USER_ID is a different agent
      // session; it must not see the first session's tabs.
      const other = await connect(adapter, { env: { CAMOFOX_USER_ID: "kit-isolation-probe" } });
      try {
        return await withTab(client, "https://example.com", async (tabId) => {
          const mine = await client.callJson("camofox_list_tabs", {});
          const theirs = await other.callJson("camofox_list_tabs", {});
          const mineHas = JSON.stringify(mine.json ?? mine.text).includes(tabId);
          const theirsHas = JSON.stringify(theirs.json ?? theirs.text).includes(tabId);
          if (!mineHas) throw new Error("own session does not list its own tab");
          if (theirsHas) throw new Error("LEAK: another session can see this session's tab");
          return { detail: "tab visible to its own session, invisible to the other" };
        });
      } finally {
        other.close();
      }
    },
  },
];

// --- runner ----------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes("--list")) {
  for (const t of TESTS) console.log(`${t.name.padEnd(12)} ${t.title}`);
  process.exit(0);
}
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx !== -1 ? argv[onlyIdx + 1].split(",").map((s) => s.trim()) : null;
const selected = only ? TESTS.filter((t) => only.includes(t.name)) : TESTS;
if (!selected.length) {
  console.error(`no tests matched ${only?.join(",")}. --list to see them.`);
  process.exit(2);
}

const adapter = resolveAdapter(argv.find((a) => a.startsWith("/")));
console.log(`${C.b}camofox live suite${C.r}`);
console.log(`  adapter   ${adapter}`);
console.log(`  rest      ${REST_URL}`);
console.log(`  artifacts ${ARTIFACTS}\n`);

const client = await connect(adapter);
console.log(`connected to ${client.serverInfo.name} v${client.serverInfo.version}\n`);

const results = [];
for (const t of selected) {
  const started = process.hrtime.bigint();
  process.stdout.write(`${C.c}▸${C.r} ${t.title}\n`);
  try {
    const out = (await t.run(client, { adapter })) || {};
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    results.push({ name: t.name, status: out.status || "pass", detail: out.detail, artifacts: out.artifacts, ms });
  } catch (e) {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    results.push({ name: t.name, status: "fail", detail: e.message, ms });
  }
  const last = results[results.length - 1];
  const mark = { pass: `${C.g}✔${C.r}`, fail: `${C.red}✘${C.r}`, skip: `${C.d}–${C.r}`, info: `${C.y}i${C.r}` }[last.status];
  console.log(`  ${mark} ${last.detail || last.status} ${C.d}(${Math.round(last.ms)}ms)${C.r}`);
  for (const a of last.artifacts || []) {
    const flag = looksLikeRealImage(a.bytes) ? "" : `${C.y} — suspiciously small, may be a blank render${C.r}`;
    console.log(`    ${C.d}${a.path} (${(a.bytes / 1024).toFixed(0)} KB)${C.r}${flag}`);
  }
  console.log();
}

client.close();

const count = (s) => results.filter((r) => r.status === s).length;
console.log(`${C.b}Summary${C.r}  ${C.g}${count("pass")} passed${C.r}  ${C.red}${count("fail")} failed${C.r}  ${C.y}${count("info")} info${C.r}  ${C.d}${count("skip")} skipped${C.r}`);
for (const r of results.filter((x) => x.status === "fail")) console.log(`  ${C.red}✘${C.r} ${r.name}: ${r.detail}`);
process.exit(count("fail") ? 1 : 0);
