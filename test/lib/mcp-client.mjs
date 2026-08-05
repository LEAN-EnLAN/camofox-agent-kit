// Minimal MCP stdio client, so tests exercise the exact path an agent uses
// (spawn the adapter, speak JSON-RPC over stdin/stdout) instead of shortcutting
// to the REST API. If a test passes here, an agent can do it.

import { spawn, execSync } from "node:child_process";

export function resolveAdapter(explicit) {
  if (explicit) return explicit;
  try {
    return execSync("command -v camofox-browser-mcp", { shell: "/bin/sh" }).toString().trim();
  } catch {
    throw new Error("camofox-browser-mcp not on PATH — pass its path explicitly");
  }
}

export async function connect(bin, { env = {}, callTimeoutMs = 180_000 } = {}) {
  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  const stderr = [];
  child.stderr.on("data", (c) => stderr.push(c.toString()));

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
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });

  let nextId = 0;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${callTimeoutMs}ms: ${method} ${JSON.stringify(params).slice(0, 120)}`)),
        callTimeoutMs,
      );
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "camofox-agent-kit-tests", version: "1" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  return {
    serverInfo: init.result.serverInfo,
    async listTools() {
      const r = await rpc("tools/list", {});
      return r.result.tools;
    },
    // Returns { text, images, raw }. A failing tool call comes back as
    // isError with the message in content, NOT as a JSON-RPC error — so it has
    // to be checked explicitly or failures silently read as passes.
    async call(name, args = {}) {
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.error) throw new Error(`${name}: JSON-RPC error ${JSON.stringify(r.error)}`);
      const content = r.result?.content || [];
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const images = content
        .filter((c) => c.type === "image" && c.data)
        .map((c) => ({ mimeType: c.mimeType, buffer: Buffer.from(c.data, "base64") }));
      if (r.result?.isError) throw new Error(`${name}: ${text}`);
      return { text, images, raw: r.result };
    },
    // Convenience: most tools return a JSON document as their text block.
    async callJson(name, args = {}) {
      const { text, images } = await this.call(name, args);
      try {
        return { json: JSON.parse(text), images, text };
      } catch {
        return { json: null, images, text };
      }
    },
    stderr: () => stderr.join(""),
    close() { child.kill(); },
  };
}
