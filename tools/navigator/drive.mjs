#!/usr/bin/env node
//
// drive — a thin stdio client for the navigator MCP, for driving a run by hand.
//
// Exists because MCP servers attach at session start: a server registered
// mid-session is not in the calling agent's tool list until it restarts. This
// speaks to the SAME binary over the SAME protocol, so a run driven here is a
// faithful exercise of what the agent will do, not a simulation of it.
//
// It is deliberately dumb. Every decision — which index to click, when to stop —
// is made by the caller and printed, so the transcript shows the reasoning
// rather than hiding it behind a helper.
//
// Usage: node drive.mjs <script.json>
//   [ {"tool":"nav_open","args":{...}},
//     {"pick":{"from":"last","match":"^Mob$","as":"mobIdx"}},
//     {"tool":"nav_act","args":{"action":"click","index":"$mobIdx"}} ]

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const steps = JSON.parse(readFileSync(process.argv[2], "utf8"));

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
  const t = setTimeout(() => rej(new Error(`timeout: ${method}`)), 180_000);
  pending.set(myId, (m) => { clearTimeout(t); res(m); });
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

// Parse the compact element table the server renders back into rows, so a step
// can say "the link labelled Mob" instead of a magic number.
function parseElements(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\[\s*(\d+)\]\s+(\S+)\s+(?:↓\s*)?(.*)$/);
    if (m) out.push({ i: Number(m[1]), tag: m[2], label: m[3].trim() });
  }
  return out;
}

const vars = {};
const substitute = (args) => {
  const s = JSON.stringify(args).replace(/"\$(\w+)"/g, (_, k) => JSON.stringify(vars[k]));
  return JSON.parse(s);
};

let last = { text: "", elements: [] };
let failed = false;

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "drive", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

for (const [n, step] of steps.entries()) {
  if (step.pick) {
    const re = new RegExp(step.pick.match, step.pick.flags || "");
    const pool = last.elements.filter((e) => (step.pick.tag ? e.tag.startsWith(step.pick.tag) : true));
    const hit = pool.find((e) => re.test(e.label));
    if (!hit) {
      failed = true;
      console.log(`\n[${n}] pick /${step.pick.match}/ → NOT FOUND among ${pool.length} elements`);
      console.log(`      candidates: ${pool.slice(0, 12).map((e) => `[${e.i}]${e.label.slice(0, 22)}`).join("  ")}`);
      break;
    }
    vars[step.pick.as] = hit.i;
    console.log(`\n[${n}] pick /${step.pick.match}/ → [${hit.i}] ${hit.tag} "${hit.label.slice(0, 50)}"`);
    continue;
  }

  const args = substitute(step.args || {});
  const res = await callTool(step.tool, args);
  last = { text: res.text, elements: parseElements(res.text) };

  const head = res.text.split("\n").filter((l) => /^(url|title|obstacle|runId|tabId|journal|frame saved|closed|run )/.test(l));
  console.log(`\n[${n}] ${step.tool} ${JSON.stringify(args).slice(0, 110)}`);
  if (step.note) console.log(`      ${step.note}`);
  for (const h of head) console.log(`      ${h}`);
  if (res.images.length) console.log(`      image returned: ${(res.images[0].data.length / 1024).toFixed(0)} KB base64`);
  if (res.isError) { failed = true; console.log(`      ✘ ${res.text.slice(0, 300)}`); break; }

  for (const [k, v] of Object.entries(step.capture || {})) {
    const m = res.text.match(new RegExp(v));
    // Numeric captures become numbers: the server takes indices as numbers and
    // a stringified one is an easy, confusing mistake to make.
    if (m) vars[k] = /^\d+$/.test(m[1]) ? Number(m[1]) : m[1];
  }
  if (step.expect) {
    const okExp = new RegExp(step.expect).test(res.text);
    console.log(`      ${okExp ? "✔" : "✘"} expect /${step.expect}/`);
    if (!okExp) { failed = true; break; }
  }
}

child.kill();
console.log(`\n${failed ? "RUN FAILED" : "RUN OK"}  vars=${JSON.stringify(vars)}`);
process.exit(failed ? 1 : 0);
