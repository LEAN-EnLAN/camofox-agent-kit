#!/usr/bin/env node
//
// End-to-end test of the navigator MCP over stdio — the exact path a calling
// agent takes. Drives a full run against a local fixture so it is deterministic:
// open, read, click, look, extract, journal, close.
//
// The assertions worth having here are the safety ones. A navigator that can
// click is easy; one that refuses to act on a stale index, denies sign-in by
// default, and keeps a password out of its own journal is the point.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- fixture server --------------------------------------------------------
const PAGE = `<!doctype html><title>Navigator fixture</title><body>
<h1>Catalogue</h1>
<nav><a href="#milk" id="milk">Milk</a> <a href="#bread">Bread</a></nav>
<button id="add" onclick="document.getElementById('out').textContent='added'">Add to cart</button>
<input id="q" placeholder="Search products">
<div id="out">nothing yet</div>
<p>Ordinary prose so this reads as a real page rather than an interstitial:
lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor
incididunt ut labore et dolore magna aliqua, enough words to clear the length gate.</p>
</body>`;
const LOGIN = `<!doctype html><title>Sign in</title><body><h1>Sign in to continue</h1>
<form><input type="email" placeholder="Email"><input id="pw" type="password" placeholder="Password">
<button>Log in</button></form></body>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url.startsWith("/login") ? LOGIN : PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

// --- minimal MCP client ----------------------------------------------------
const child = spawn(join(HERE, "navigator-mcp.mjs"), [], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (c) => process.stderr.write(`  [srv] ${c}`));
let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let id = 0;
const rpc = (method, params) => new Promise((res, rej) => {
  const myId = ++id;
  const timer = setTimeout(() => rej(new Error(`timeout: ${method}`)), 180_000);
  pending.set(myId, (m) => { clearTimeout(timer); res(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
});
const callTool = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const content = r.result?.content || [];
  return {
    text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
    images: content.filter((c) => c.type === "image"),
    isError: !!r.result?.isError,
  };
};

let fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✔ ${label}`);
  else { fail++; console.log(`  ✘ ${label}${detail ? ` — ${detail}` : ""}`); }
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "nav-test", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = (await rpc("tools/list", {})).result.tools;
  console.log(`\ntools: ${tools.map((t) => t.name).join(" ")}\n`);
  check("all 8 tools exposed", tools.length === 8, `got ${tools.length}`);

  // Policy defaults — the safety contract.
  const pol = await callTool("nav_policy", {});
  check("sign-in denied by default", /loginWalls\s+deny/.test(pol.text), pol.text.split("\n")[1]);
  check("irreversible actions denied by default", /sideEffects\s+deny/.test(pol.text));
  check("captcha solving allowed by default", /captchas\s+allow/.test(pol.text));

  // Open + read.
  const opened = await callTool("nav_open", { url: origin, task: "navigator e2e" });
  check("nav_open succeeded", !opened.isError, opened.text.slice(0, 160));
  const runId = (opened.text.match(/runId: (\S+)/) || [])[1];
  const tabId = (opened.text.match(/tabId: (\S+)/) || [])[1];
  check("returned a runId and tabId", !!runId && !!tabId);
  check("page classified clear", /obstacle: clear → proceed/.test(opened.text), opened.text.match(/obstacle:.*/)?.[0]);
  const addIdx = (opened.text.match(/\[\s*(\d+)\]\s+button\s+.*Add to cart/) || [])[1];
  check("found the button in the element list", addIdx != null, opened.text.split("\n").filter(l => /button/.test(l)).join(" | "));

  // Stale index must be refused, not guessed at.
  const stale = await callTool("nav_act", { tabId, action: "click", index: 9999 });
  check("stale/unknown index is refused", stale.isError && /not in the last read/.test(stale.text));

  // Real click, and the page must actually change.
  if (addIdx != null) {
    const clicked = await callTool("nav_act", { tabId, action: "click", index: Number(addIdx) });
    check("click reported ok", !clicked.isError, clicked.text.slice(0, 160));
    const out = await callTool("nav_extract", { tabId, expression: `document.getElementById('out').textContent` });
    check("click actually mutated the page", /added/.test(out.text), `out="${out.text.slice(0, 40)}"`);
  }

  // Typing.
  const qIdx = (opened.text.match(/\[\s*(\d+)\]\s+input.*Search products/) || [])[1];
  if (qIdx != null) {
    await callTool("nav_act", { tabId, action: "type", index: Number(qIdx), text: "cheese" });
    const val = await callTool("nav_extract", { tabId, expression: `document.getElementById('q').value` });
    check("typed text landed in the field", /cheese/.test(val.text), val.text.slice(0, 40));
  }

  // Vision path returns a real image.
  const look = await callTool("nav_look", { tabId, highlight: true });
  check("nav_look returns an image", look.images.length === 1 && look.images[0].data?.length > 5000,
    `images=${look.images.length} bytes≈${look.images[0]?.data?.length || 0}`);

  // Login wall: denied by default, with a remedy rather than a bare refusal.
  const loginNav = await callTool("nav_act", { tabId, action: "navigate", url: `${origin}/login` });
  check("login wall detected", /login_wall/.test(loginNav.text), loginNav.text.match(/obstacle:.*/)?.[0]);
  check("login wall stops by default", /login_wall → stop/.test(loginNav.text));
  check("refusal explains how the USER can opt in", /login_walls=ask|CAMOFOX_NAV_LOGIN_POLICY/.test(loginNav.text));

  // A password typed into the page must not appear in the journal.
  const pwIdx = (loginNav.text.match(/\[\s*(\d+)\]\s+input:password/) || [])[1];
  if (pwIdx != null) {
    await callTool("nav_act", { tabId, action: "type", index: Number(pwIdx), text: "hunter2-secret-value" });
  }

  const journal = await callTool("nav_journal", { runId });
  check("journal has entries", /observation|action/.test(journal.text));
  const dir = (journal.text.match(/dir: (\S+)/) || [])[1];
  let raw = "";
  if (dir && existsSync(join(dir, "journal.jsonl"))) raw = readFileSync(join(dir, "journal.jsonl"), "utf8");
  check("password NEVER written to the journal file", !!raw && !raw.includes("hunter2-secret-value"),
    raw.includes("hunter2-secret-value") ? "LEAKED" : raw ? "clean" : "journal unreadable");
  check("journal records that a value was redacted", !pwIdx || /redacted/.test(raw));

  const closed = await callTool("nav_close", { tabId, outcome: "success", summary: "e2e" });
  check("nav_close finishes the run", /run recorded at/.test(closed.text));
} catch (e) {
  fail++;
  console.log(`\n  ✘ threw: ${e.message}`);
} finally {
  child.kill();
  server.close();
}

console.log(`\n${fail ? `FAIL — ${fail} check(s)` : "PASS — navigator MCP behaves, including the safety contract"}`);
process.exit(fail ? 1 : 0);
