#!/usr/bin/env node
// Register (or remove) the camofox-browser MCP server in every agent host found
// on this machine.
//
// Why Node and not jq: node >= 22 is already a hard requirement of
// camofox-browser, so using it here keeps the kit dependency-free. Each host
// config is merged in place — existing servers and unrelated keys survive, and
// re-running is a no-op beyond rewriting our own entry.
//
// Usage:
//   register-mcp.mjs --bin <path> --base-url <url> [--access-key K] [--api-key K]
//                    [--only host,host] [--all] [--dry-run]
//   register-mcp.mjs --remove [--only host,host]

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";

const HOME = homedir();
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || join(HOME, ".config");
const SERVER_NAME = "camofox-browser";

// --- args ------------------------------------------------------------------
function parseArgs(argv) {
  const out = { env: {}, only: null, all: false, dryRun: false, remove: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--bin": out.bin = next(); break;
      case "--base-url": out.env.CAMOFOX_BASE_URL = next(); break;
      case "--access-key": out.env.CAMOFOX_ACCESS_KEY = next(); break;
      case "--api-key": out.env.CAMOFOX_API_KEY = next(); break;
      case "--only": out.only = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--all": out.all = true; break;
      case "--dry-run": out.dryRun = true; break;
      case "--remove": out.remove = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!out.remove && !out.bin) throw new Error("--bin is required");
  return out;
}

const args = parseArgs(process.argv.slice(2));

// --- io helpers ------------------------------------------------------------
const changed = [];
const skipped = [];

function backupOnce(path) {
  const bak = `${path}.camofox-kit.bak`;
  if (existsSync(path) && !existsSync(bak)) copyFileSync(path, bak);
}

function readJson(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${e.message}) — fix or move it, then re-run`);
  }
}

function writeJson(path, value) {
  if (args.dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  backupOnce(path);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Deep-ish set: walk/create the nested container, then assign the leaf.
function setPath(obj, segments, value) {
  let cur = obj;
  for (const seg of segments.slice(0, -1)) {
    if (typeof cur[seg] !== "object" || cur[seg] === null) cur[seg] = {};
    cur = cur[seg];
  }
  const leaf = segments[segments.length - 1];
  if (value === undefined) delete cur[leaf];
  else cur[leaf] = value;
}

function getPath(obj, segments) {
  let cur = obj;
  for (const seg of segments) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

const envEntries = () => Object.fromEntries(Object.entries(args.env).filter(([, v]) => v));
const hasEnv = () => Object.keys(envEntries()).length > 0;

// --- host definitions ------------------------------------------------------
// `detect` decides whether the host is actually installed. We never create a
// config tree for a tool the user does not have — an empty ~/.cursor/mcp.json on
// a machine without Cursor is litter, not configuration.
const HOSTS = [
  {
    id: "claude-code",
    label: "Claude Code",
    path: join(HOME, ".claude.json"),
    detect: () => existsSync(join(HOME, ".claude.json")) || existsSync(join(HOME, ".claude")),
    keyPath: ["mcpServers", SERVER_NAME],
    entry: () => ({ command: args.bin, ...(hasEnv() ? { env: envEntries() } : {}) }),
  },
  {
    id: "cursor",
    label: "Cursor",
    path: join(HOME, ".cursor", "mcp.json"),
    detect: () => existsSync(join(HOME, ".cursor")),
    keyPath: ["mcpServers", SERVER_NAME],
    entry: () => ({ command: args.bin, ...(hasEnv() ? { env: envEntries() } : {}) }),
  },
  {
    id: "agy",
    label: "Antigravity / agy",
    path: join(HOME, ".gemini", "config", "mcp_config.json"),
    detect: () => existsSync(join(HOME, ".gemini")),
    keyPath: ["mcpServers", SERVER_NAME],
    entry: () => ({ command: args.bin, ...(hasEnv() ? { env: envEntries() } : {}) }),
  },
  {
    id: "opencode",
    label: "opencode",
    path: join(XDG_CONFIG, "opencode", "opencode.json"),
    detect: () => existsSync(join(XDG_CONFIG, "opencode")),
    keyPath: ["mcp", SERVER_NAME],
    entry: () => ({
      type: "local",
      command: [args.bin],
      enabled: true,
      ...(hasEnv() ? { environment: envEntries() } : {}),
    }),
    // opencode validates against its schema; keep the marker it expects.
    seed: (cfg) => {
      if (!cfg.$schema) cfg.$schema = "https://opencode.ai/config.json";
    },
  },
];

// Codex is TOML, so it gets bespoke block handling rather than the JSON path.
const CODEX = {
  id: "codex",
  label: "Codex CLI",
  path: join(HOME, ".codex", "config.toml"),
  detect: () => existsSync(join(HOME, ".codex")),
};

function tomlInlineEnv() {
  const entries = Object.entries(envEntries());
  if (!entries.length) return "";
  const body = entries.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ");
  return `env = { ${body} }\n`;
}

// Replace the [mcp_servers.camofox-browser] table (header to the next top-level
// table header or EOF), or append it. Everything else in the file is untouched.
function applyCodex() {
  const header = `[mcp_servers.${SERVER_NAME}]`;
  const original = existsSync(CODEX.path) ? readFileSync(CODEX.path, "utf8") : "";
  const lines = original.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);

  let stripped = lines;
  if (start !== -1) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) { end = i; break; }
    }
    stripped = [...lines.slice(0, start), ...lines.slice(end)];
  }

  let text = stripped.join("\n").replace(/\n{3,}$/, "\n");

  if (!args.remove) {
    const block = `${header}\ncommand = ${JSON.stringify(args.bin)}\n${tomlInlineEnv()}`;
    if (text.length && !text.endsWith("\n")) text += "\n";
    if (text.trim().length) text += "\n";
    text += block;
  }

  if (text === original) { skipped.push(`${CODEX.label} (already current)`); return; }
  if (!args.dryRun) {
    mkdirSync(dirname(CODEX.path), { recursive: true });
    backupOnce(CODEX.path);
    writeFileSync(CODEX.path, text);
  }
  changed.push(`${CODEX.label} → ${CODEX.path}`);
}

// --- run -------------------------------------------------------------------
const wanted = (id) => !args.only || args.only.includes(id);

for (const host of HOSTS) {
  if (!wanted(host.id)) continue;
  if (!host.detect() && !args.all) { skipped.push(`${host.label} (not installed)`); continue; }

  const cfg = readJson(host.path);
  host.seed?.(cfg);

  const desired = args.remove ? undefined : host.entry();
  const current = getPath(cfg, host.keyPath);
  if (JSON.stringify(current) === JSON.stringify(desired)) {
    skipped.push(`${host.label} (already current)`);
    continue;
  }

  setPath(cfg, host.keyPath, desired);
  writeJson(host.path, cfg);
  changed.push(`${host.label} → ${host.path}`);
}

if (wanted(CODEX.id)) {
  if (!CODEX.detect() && !args.all) skipped.push(`${CODEX.label} (not installed)`);
  else applyCodex();
}

const verb = args.remove ? "removed from" : "registered in";
for (const c of changed) console.log(`  ${args.dryRun ? "would update" : verb} ${c}`);
for (const s of skipped) console.log(`  skipped ${s}`);
if (!changed.length) console.log(`  nothing to do — no host config needed changes`);
