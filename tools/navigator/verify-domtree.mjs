// Does browser-use's buildDomTree.js actually run in Camoufox (Firefox)?
// Decisive test: inject it, count indexed interactive elements, then screenshot
// so the numbered highlight overlay can be seen with human eyes.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:9377";
const USER = "domtree-test";
const SRC = readFileSync("/home/pulpo/Documents/GitHub/camofox-agent-kit/vendor/browser-use/buildDomTree.js", "utf8");
const URL_UNDER_TEST = process.argv[2] || "https://en.wikipedia.org/wiki/Minecraft";
const OUT = process.argv[3] || "/tmp/claude-1000/-home-pulpo-Documents-GitHub-camofox-browser/51333770-c995-47a6-af98-11075854d5ad/scratchpad/domtree";

const api = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${t.slice(0, 300)}`);
  try { return JSON.parse(t); } catch { return t; }
};
const evaluate = async (tabId, expression) => {
  const o = await api(`/tabs/${tabId}/evaluate`, { method: "POST", body: { userId: USER, expression } });
  return o?.result ?? o;
};

let tabId;
try {
  const tab = await api("/tabs", { method: "POST", body: { url: URL_UNDER_TEST, userId: USER, sessionKey: "default" } });
  tabId = tab.tabId;
  console.log(`tab ${tabId} on ${tab.url}`);

  // Inject and run with highlighting ON.
  const expr = `(() => {
    const fn = ${SRC};
    const out = fn({ doHighlightElements: true, focusHighlightIndex: -1, viewportExpansion: 0, debugMode: false });
    const ids = Object.keys(out.map || {});
    const interactive = ids.filter(k => out.map[k].highlightIndex !== undefined && out.map[k].highlightIndex !== null);
    const sample = interactive.slice(0, 8).map(k => {
      const n = out.map[k];
      return { i: n.highlightIndex, tag: n.tagName, text: (n.attributes && (n.attributes['aria-label'] || n.attributes.title)) || '', xpath: (n.xpath||'').slice(0,60) };
    });
    const container = document.getElementById('playwright-highlight-container');
    return JSON.stringify({
      totalNodes: ids.length,
      interactiveCount: interactive.length,
      overlayPresent: !!container,
      overlayChildren: container ? container.childElementCount : 0,
      sample
    });
  })()`;

  const raw = await evaluate(tabId, expr);
  const info = typeof raw === "string" ? JSON.parse(raw) : raw;
  console.log(`\nnodes mapped:        ${info.totalNodes}`);
  console.log(`interactive indexed: ${info.interactiveCount}`);
  console.log(`overlay container:   ${info.overlayPresent ? "created" : "MISSING"} (${info.overlayChildren} children drawn)`);
  console.log(`\nfirst few indexed elements:`);
  for (const s of info.sample) console.log(`  [${String(s.i).padStart(2)}] ${String(s.tag).padEnd(8)} ${s.text.slice(0, 40).padEnd(40)} ${s.xpath}`);

  // Screenshot WITH the overlay so the numbered boxes are visible.
  // This endpoint returns RAW PNG BYTES, not JSON carrying base64 — decoding it
  // as base64 produces a file that looks written but is not an image.
  mkdirSync(OUT, { recursive: true });
  const res = await fetch(`${BASE}/tabs/${tabId}/screenshot?userId=${USER}`);
  if (!res.ok) throw new Error(`screenshot -> ${res.status}`);
  const path = `${OUT}/highlighted.png`;
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  console.log(`\nscreenshot with overlay -> ${path} (${res.headers.get("content-type")})`);

  const verdict = info.interactiveCount > 0 && info.overlayPresent && info.overlayChildren > 0;
  console.log(`\n${verdict ? "PASS" : "FAIL"} — buildDomTree.js ${verdict ? "runs in Firefox and draws its overlay" : "did not work as expected"}`);
  process.exitCode = verdict ? 0 : 1;
} catch (e) {
  console.error("error:", e.message);
  process.exitCode = 1;
} finally {
  if (tabId) await api(`/tabs/${tabId}?userId=${USER}`, { method: "DELETE" }).catch(() => {});
}
