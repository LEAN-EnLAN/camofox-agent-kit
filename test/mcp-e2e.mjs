#!/usr/bin/env node
//
// End-to-end smoke test of the whole agent path:
//   stdio MCP adapter → REST server → Camoufox → a real page
//
// This is the test that matters. `camofox-doctor` proves each link exists; this
// proves they are actually connected, by driving a live page the way an agent
// does: initialize → tools/list → create_tab → snapshot → evaluate → close_tab.
//
// Usage:  node test/mcp-e2e.mjs [path-to-camofox-browser-mcp] [url]
// Exits non-zero on any failure, so it works in CI.

import { spawn } from "node:child_process";
import { execSync } from "node:child_process";

const BIN =
  process.argv[2] ||
  (() => {
    try {
      return execSync("command -v camofox-browser-mcp", { shell: "/bin/sh" }).toString().trim();
    } catch {
      console.error("camofox-browser-mcp not found on PATH. Pass its path as the first argument.");
      process.exit(1);
    }
  })();
const URL_UNDER_TEST = process.argv[3] || "https://example.com";
const CALL_TIMEOUT_MS = 120_000;

const child = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
child.on("error", (e) => {
  console.error(`could not spawn ${BIN}: ${e.message}`);
  process.exit(1);
});

// The adapter speaks newline-delimited JSON-RPC on stdout; stderr is its log.
let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (c) => process.stderr.write(`  [adapter] ${c}`));

let nextId = 0;
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`timed out after ${CALL_TIMEOUT_MS}ms: ${method}`)), CALL_TIMEOUT_MS);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const textOf = (res) =>
  (res.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

// A tool that fails returns isError with the message in content, not a JSON-RPC
// error — so success has to be asserted explicitly or failures read as passes.
function assertToolOk(label, res) {
  if (res.error) throw new Error(`${label}: JSON-RPC error ${JSON.stringify(res.error)}`);
  if (res.result?.isError) throw new Error(`${label}: ${textOf(res)}`);
  return res;
}

let failures = 0;
const pass = (label, detail = "") => console.log(`  ✔ ${label}${detail ? ` — ${detail}` : ""}`);

let tabId;
try {
  console.log(`camofox MCP end-to-end\n  adapter: ${BIN}\n  target:  ${URL_UNDER_TEST}\n`);

  const init = assertToolOk("initialize", await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "camofox-agent-kit-e2e", version: "1" },
  }));
  pass("initialize", `${init.result.serverInfo.name} v${init.result.serverInfo.version}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const tools = assertToolOk("tools/list", await rpc("tools/list", {}));
  const names = tools.result.tools.map((t) => t.name);
  if (names.length !== 11) throw new Error(`expected 11 tools, got ${names.length}: ${names.join(" ")}`);
  pass("tools/list", `${names.length} tools`);

  const created = assertToolOk("create_tab", await rpc("tools/call", {
    name: "camofox_create_tab",
    arguments: { url: URL_UNDER_TEST },
  }));
  tabId = (textOf(created).match(/"tabId"\s*:\s*"([^"]+)"/) || [])[1];
  if (!tabId) throw new Error(`no tabId in response: ${textOf(created).slice(0, 200)}`);
  pass("create_tab", tabId);

  const snap = assertToolOk("snapshot", await rpc("tools/call", {
    name: "camofox_snapshot",
    arguments: { tabId },
  }));
  const snapText = textOf(snap);
  const hasImage = (snap.result?.content || []).some((c) => c.type === "image");
  if (!/- (heading|paragraph|link|button|textbox)/.test(snapText)) {
    throw new Error(`snapshot has no accessibility nodes: ${snapText.slice(0, 200)}`);
  }
  pass("snapshot", `${snapText.length} chars, screenshot=${hasImage}`);

  // `expression`, not `script` — the parameter name is a common wrong guess.
  const ev = assertToolOk("evaluate", await rpc("tools/call", {
    name: "camofox_evaluate",
    arguments: { tabId, expression: "document.title" },
  }));
  const title = textOf(ev).trim();
  if (!title) throw new Error("evaluate returned nothing");
  pass("evaluate", title.slice(0, 80).replace(/\s+/g, " "));

  assertToolOk("close_tab", await rpc("tools/call", { name: "camofox_close_tab", arguments: { tabId } }));
  tabId = null;
  pass("close_tab");
} catch (e) {
  console.error(`  ✘ ${e.message}`);
  failures = 1;
  // Never leak a tab on failure — the per-session tab budget is finite.
  if (tabId) {
    try { await rpc("tools/call", { name: "camofox_close_tab", arguments: { tabId } }); } catch { /* best effort */ }
  }
}

child.kill();

if (failures) {
  console.error("\nFAIL — run camofox-doctor to find which link is broken.");
  process.exit(1);
}
console.log("\nPASS — stdio MCP → REST → Camoufox works end to end.");
