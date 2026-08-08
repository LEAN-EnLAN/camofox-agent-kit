#!/usr/bin/env node
//
// camofox-navigator — a local MCP server that lets the CALLING model navigate
// the web, rather than embedding a model of its own.
//
// The division of labour is the whole design. The caller (Claude Code, Codex,
// whatever) is the intelligence: it reads the page, decides the next action,
// and looks at screenshots when eyes are required. This server is the hands and
// the safety rail: it makes each step cheap, keeps a journal, and refuses to let
// the caller waste itself on obstacles that intelligence cannot fix.
//
// Three things it does that a thin browser wrapper does not:
//
//   * OBSTACLE ESCALATION. Every read classifies the page and returns a verdict:
//     proceed / wait_retry / escalate_vision / ask_user / stop. An IP-reputation
//     block and a checkbox CAPTCHA look almost identical on screen and need
//     opposite responses — one needs a proxy, the other needs eyes — so they are
//     never conflated.
//   * DEFAULT DENY on consequences. Signing in and irreversible submissions are
//     off unless the user turned them on, because those are their accounts.
//     Anything typed into a password field is redacted from the journal.
//   * A VISIBLE TRAIL. Interactive elements can be outlined and numbered on the
//     page, and the element about to be acted on gets its own marker, so a
//     recording of a run shows what the agent did instead of a cursor teleporting.
//
// Element addressing: numbers, not selectors. nav_state returns an indexed list;
// every action refers to an index from the most recent read of THAT tab. Indices
// are invalidated by navigation and DOM changes, which the server tracks and
// tells you about instead of clicking the wrong thing.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { camofox, CamofoxError } from "./lib/camofox.mjs";
import { readState, selectorFor, focusJs, CLEAR_FOCUS_JS, CLEAR_HIGHLIGHTS_JS } from "./lib/dom.mjs";
import { ProgressGuard } from "./lib/obstacles.mjs";
import { Journal, loadJournal, listRuns, RUNS_ROOT } from "./lib/journal.mjs";
import { allPolicies, POLICY_CONFIG_PATH, isSecretField } from "./lib/policy.mjs";

const VERSION = "0.1.0";
const USER_ID = process.env.CAMOFOX_USER_ID || `nav-${process.pid}`;

// Per-tab bookkeeping. The element list is kept so an action can name what it
// clicked in the journal, and so a stale-index click can be caught before it
// lands on whatever now occupies that number.
const tabs = new Map(); // tabId -> { journal, guard, elements, fingerprint, url }

// --- helpers ---------------------------------------------------------------
const ok = (text, extra = []) => ({ content: [{ type: "text", text }, ...extra] });
const fail = (text) => ({ isError: true, content: [{ type: "text", text }] });

/**
 * Render state as a compact table. A JSON dump of 100 elements costs the caller
 * far more tokens than it gives back; this is the same information at a fraction
 * of the width, which is the difference between a usable loop and an expensive one.
 */
function renderState(s, { limit = 60 } = {}) {
  const lines = [];
  lines.push(`url: ${s.url}`);
  lines.push(`title: ${s.title}`);
  if (s.scroll) lines.push(`scroll: ${s.scroll.y}/${s.scroll.max}px`);

  const o = s.obstacle;
  lines.push(`obstacle: ${o.class} → ${o.verdict}${o.policy ? ` (policy ${o.policy.capability}=${o.policy.mode} via ${o.policy.source})` : ""}`);
  if (o.class !== "clear") {
    lines.push(`  why: ${o.why}`);
    if (o.remedy) lines.push(`  what to do: ${o.remedy}`);
    if (o.evidence?.quote) lines.push(`  page says: "${o.evidence.quote.slice(0, 140)}"`);
  }

  if (s.domError) lines.push(`element extraction failed: ${s.domError}`);
  const shown = s.elements.slice(0, limit);
  lines.push("", `interactive elements (${s.elements.length}${s.elements.length > limit ? `, showing ${limit}` : ""}):`);
  for (const e of shown) {
    const type = e.type ? `:${e.type}` : "";
    lines.push(`  [${String(e.i).padStart(3)}] ${(e.tag + type).padEnd(14)} ${e.inView ? "  " : "↓ "}${e.label || "—"}`);
  }
  if (s.elements.length > limit) lines.push(`  … ${s.elements.length - limit} more; scroll or narrow the task`);
  if (!s.elements.length) lines.push(`  none — read textPreview or extract from the DOM instead of clicking`);
  lines.push("", `text preview: ${s.textPreview?.slice(0, 200) || ""}`);
  return lines.join("\n");
}

async function observe(tabId, { highlight = false } = {}) {
  const entry = tabs.get(tabId);
  if (!entry) throw new Error(`unknown tabId ${tabId} — open one with nav_open`);
  const s = await readState(tabId, USER_ID, { highlight });
  entry.elements = s.elements;
  entry.fingerprint = s.fingerprint;
  entry.url = s.url;
  entry.journal.observation({
    url: s.url, title: s.title, elementCount: s.elements.length,
    obstacle: s.obstacle, fingerprint: s.fingerprint,
  });
  return s;
}

// --- tools -----------------------------------------------------------------
const TOOLS = [
  {
    name: "nav_open",
    description:
      "Open a page and start a navigation run. Returns a runId, a tabId, and the page state: an INDEXED list of " +
      "interactive elements plus an obstacle verdict. Always read the verdict before acting — if it says stop, " +
      "stop and report why; if it says escalate_vision, call nav_look and use your eyes.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
        task: { type: "string", description: "What this run is for. Recorded in the journal so a later reader knows the intent." },
        highlight: { type: "boolean", description: "Outline and number the interactive elements on the page (default false). Turn on when you will screenshot for vision." },
      },
      required: ["url"],
    },
  },
  {
    name: "nav_state",
    description:
      "Re-read the current page: indexed interactive elements and an obstacle verdict. Element indices come from " +
      "THIS read and are invalidated by any navigation or DOM change — re-read after every action rather than " +
      "reusing old numbers.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        highlight: { type: "boolean", description: "Draw the numbered overlay (default false)" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "nav_act",
    description:
      "Do one thing to the page and get the resulting state back. Actions: click, type, scroll, navigate, back, " +
      "press. Refer to elements by the index from the most recent nav_state of this tab. A real browser click at " +
      "real coordinates, so hover menus and wrapped buttons behave.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        action: { type: "string", enum: ["click", "type", "scroll", "navigate", "back", "press"] },
        index: { type: "number", description: "Element index for click/type" },
        text: { type: "string", description: "Text for type, or key name for press (e.g. Enter)" },
        pressEnter: { type: "boolean", description: "Submit after typing" },
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "For scroll" },
        amount: { type: "number", description: "Pixels for scroll" },
        url: { type: "string", description: "For navigate" },
        highlight: { type: "boolean", description: "Number the elements in the returned state" },
      },
      required: ["tabId", "action"],
    },
  },
  {
    name: "nav_look",
    description:
      "Screenshot the page and return it as an image for you to inspect. Use this when the obstacle verdict is " +
      "escalate_vision, when the element list is not enough to decide, or to check that an action did what you " +
      "meant. focusIndex marks one element so you can confirm you are about to touch the right thing.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        focusIndex: { type: "number", description: "Outline this element only" },
        highlight: { type: "boolean", description: "Outline and number ALL interactive elements" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "nav_extract",
    description:
      "Evaluate a JavaScript expression in the page and return the result. For pulling out structured data " +
      "(prices, tables, lists) without paging through a snapshot. Return a JSON string for anything non-trivial.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        expression: { type: "string", description: "JS expression evaluated in page context" },
      },
      required: ["tabId", "expression"],
    },
  },
  {
    name: "nav_journal",
    description:
      "The run record: every observation, action, verdict and frame, in order. Read this to explain what " +
      "happened, or to diagnose a run that went wrong. Without a runId, lists recent runs.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        limit: { type: "number", description: "Max entries (default 60)" },
      },
    },
  },
  {
    name: "nav_policy",
    description:
      "What this navigator is currently allowed to do without asking, and where each setting came from. " +
      "Signing in and irreversible submissions are denied by default; only the user changes that.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nav_close",
    description: "Close a tab and finish its run. Always call this when done — open tabs consume the session budget.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        outcome: { type: "string", enum: ["success", "blocked", "failed", "abandoned"] },
        summary: { type: "string", description: "One line on what the run achieved. Goes in the journal." },
      },
      required: ["tabId"],
    },
  },
];

// --- handlers --------------------------------------------------------------
async function handle(name, args) {
  switch (name) {
    case "nav_policy": {
      const p = allPolicies();
      const lines = Object.entries(p).map(([k, v]) => `  ${k.padEnd(14)} ${v.mode.padEnd(6)} (${v.source})`);
      return ok(
        [
          `navigator policy — default answer to anything with consequences is NO`,
          ...lines,
          ``,
          `config file: ${POLICY_CONFIG_PATH}`,
          `to change, the USER writes e.g. "login_walls=ask" there, or exports CAMOFOX_NAV_LOGIN_POLICY.`,
          `Do not change these on their behalf.`,
        ].join("\n"),
      );
    }

    case "nav_open": {
      await camofox.waitHealthy();
      const journal = Journal.create({ task: args.task || "" });
      const tab = await camofox.openTab(args.url, USER_ID);
      tabs.set(tab.tabId, {
        journal,
        guard: new ProgressGuard({ stallLimit: 3, maxSteps: 40 }),
        elements: [], fingerprint: null, url: tab.url,
      });
      const s = await observe(tab.tabId, { highlight: !!args.highlight });
      return ok(
        [
          `runId: ${journal.runId}`,
          `tabId: ${tab.tabId}`,
          `journal: ${journal.dir}`,
          ``,
          renderState(s),
        ].join("\n"),
      );
    }

    case "nav_state": {
      const s = await observe(args.tabId, { highlight: !!args.highlight });
      return ok(renderState(s));
    }

    case "nav_act": {
      const entry = tabs.get(args.tabId);
      if (!entry) return fail(`unknown tabId ${args.tabId} — open one with nav_open`);

      // An index from an older read points at whatever now occupies that number,
      // so a stale click is a wrong click rather than a failed one. Catch it here.
      const element = args.index != null ? entry.elements.find((e) => e.i === args.index) : null;
      if (args.index != null && !element) {
        return fail(
          `index ${args.index} is not in the last read of this tab (it had ${entry.elements.length} elements). ` +
            `Call nav_state and use a current index — acting on a stale number clicks whatever now occupies it.`,
        );
      }

      let result;
      try {
        switch (args.action) {
          case "click": {
            if (args.index == null) return fail("click needs an index");
            // Mark the target before acting so a recording shows WHAT was clicked.
            await camofox.evaluate(args.tabId, USER_ID, focusJs(args.index)).catch(() => {});
            // The actual click goes through the browser's input pipeline, not
            // page script, so hover-dependent UIs behave.
            const clickRes = await fetch(`${camofox.base}/tabs/${args.tabId}/click`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ userId: USER_ID, selector: selectorFor(args.index) }),
            });
            const clickText = await clickRes.text();
            if (!clickRes.ok) throw new Error(`click -> ${clickRes.status}: ${clickText.slice(0, 200)}`);
            result = clickText.slice(0, 200);
            await camofox.evaluate(args.tabId, USER_ID, CLEAR_FOCUS_JS).catch(() => {});
            break;
          }
          case "type": {
            if (args.index == null) return fail("type needs an index");
            if (args.text == null) return fail("type needs text");
            const res = await fetch(`${camofox.base}/tabs/${args.tabId}/type`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                userId: USER_ID, selector: selectorFor(args.index),
                text: args.text, pressEnter: !!args.pressEnter,
              }),
            });
            const t = await res.text();
            if (!res.ok) throw new Error(`type -> ${res.status}: ${t.slice(0, 200)}`);
            result = t.slice(0, 200);
            break;
          }
          case "scroll": {
            const res = await fetch(`${camofox.base}/tabs/${args.tabId}/scroll`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ userId: USER_ID, direction: args.direction || "down", amount: args.amount || 600 }),
            });
            const t = await res.text();
            // scroll often reports ok on lazy-load pages without moving; the
            // fingerprint comparison below is what actually tells the truth.
            result = res.ok ? t.slice(0, 120) : `scroll -> ${res.status}`;
            break;
          }
          case "navigate": {
            if (!args.url) return fail("navigate needs a url");
            result = JSON.stringify(await camofox.navigate(args.tabId, USER_ID, { url: args.url })).slice(0, 200);
            break;
          }
          case "back": {
            result = String(await camofox.evaluate(args.tabId, USER_ID, `(() => { history.back(); return JSON.stringify({back:true}); })()`));
            break;
          }
          case "press": {
            if (!args.text) return fail("press needs a key name in `text`");
            result = String(await camofox.evaluate(
              args.tabId, USER_ID,
              `(() => { const el = document.activeElement || document.body; el.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(args.text)},bubbles:true})); return JSON.stringify({pressed:${JSON.stringify(args.text)}}); })()`,
            ));
            break;
          }
          default:
            return fail(`unknown action ${args.action}`);
        }
      } catch (e) {
        entry.journal.action({ action: args.action, index: args.index, value: args.text, element, result: `error: ${e.message}` });
        return fail(`${args.action} failed: ${e.message}`);
      }

      // Let the page settle, then re-read: the caller needs the consequence of
      // the action, not the state before it.
      await new Promise((r) => setTimeout(r, 900));
      const s = await observe(args.tabId, { highlight: !!args.highlight });

      entry.journal.action({
        action: args.action, index: args.index, value: args.text,
        element, result, obstacle: s.obstacle,
      });

      const progress = entry.guard.record(s.fingerprint);
      const notes = [];
      if (!progress.ok) notes.push(`⚠ ${progress.reason}`);
      if (element && isSecretField(element)) notes.push(`(value redacted in the journal — this looked like a secret field)`);

      return ok([`${args.action} ok${args.index != null ? ` on [${args.index}] ${element?.label || ""}` : ""}`, ...notes, ``, renderState(s)].join("\n"));
    }

    case "nav_look": {
      const entry = tabs.get(args.tabId);
      if (!entry) return fail(`unknown tabId ${args.tabId}`);
      if (args.focusIndex != null) {
        await camofox.evaluate(args.tabId, USER_ID, focusJs(args.focusIndex)).catch(() => {});
      } else if (args.highlight) {
        await readState(args.tabId, USER_ID, { highlight: true });
      } else {
        await camofox.evaluate(args.tabId, USER_ID, CLEAR_HIGHLIGHTS_JS).catch(() => {});
      }
      const png = await camofox.screenshotPng(args.tabId, USER_ID);
      const path = entry.journal.frame(png, {
        label: args.focusIndex != null ? `focus ${args.focusIndex}` : args.highlight ? "all elements" : "plain",
        annotated: args.focusIndex != null || !!args.highlight,
      });
      return ok(`frame saved: ${path} (${(png.length / 1024).toFixed(0)} KB)`, [
        { type: "image", mimeType: "image/png", data: png.toString("base64") },
      ]);
    }

    case "nav_extract": {
      const entry = tabs.get(args.tabId);
      if (!entry) return fail(`unknown tabId ${args.tabId}`);
      const out = await camofox.evaluate(args.tabId, USER_ID, args.expression);
      const text = typeof out === "string" ? out : JSON.stringify(out);
      entry.journal.append("extract", { expression: args.expression.slice(0, 200), bytes: text?.length || 0 });
      return ok(text?.slice(0, 20000) ?? "null");
    }

    case "nav_journal": {
      if (!args.runId) {
        const runs = listRuns(args.limit || 15);
        if (!runs.length) return ok(`no runs yet (they will appear under ${RUNS_ROOT})`);
        return ok(
          [`recent runs:`, ...runs.map((r) => `  ${r.id}  ${r.outcome || "in-progress"}  ${(r.task || "").slice(0, 60)}`)].join("\n"),
        );
      }
      const j = loadJournal(args.runId);
      const entries = j.read().slice(-(args.limit || 60));
      const lines = entries.map((e) => {
        const head = `${String(e.step).padStart(3)} ${e.kind.padEnd(13)}`;
        if (e.kind === "action") return `${head} ${e.action}${e.index != null ? ` [${e.index}]` : ""} ${e.element?.label ? `"${e.element.label.slice(0, 40)}"` : ""} ${e.valueRedacted ? "value=«redacted»" : e.value != null ? `value=${JSON.stringify(String(e.value).slice(0, 40))}` : ""} → ${e.obstacle?.class || ""}`;
        if (e.kind === "observation") return `${head} ${e.elementCount} els  ${e.obstacle?.class || ""}→${e.obstacle?.verdict || ""}  ${(e.title || "").slice(0, 44)}`;
        if (e.kind === "frame") return `${head} ${e.file} ${e.annotated ? "(annotated)" : ""}`;
        return `${head} ${JSON.stringify(e).slice(0, 160)}`;
      });
      return ok([`run ${args.runId}`, `dir: ${j.dir}`, ``, ...lines].join("\n"));
    }

    case "nav_close": {
      const entry = tabs.get(args.tabId);
      await camofox.closeTab(args.tabId, USER_ID).catch(() => {});
      if (entry) {
        const dir = entry.journal.finish({ outcome: args.outcome || "abandoned", summary: args.summary || "" });
        tabs.delete(args.tabId);
        return ok(`closed. run recorded at ${dir}`);
      }
      return ok(`closed (no run was tracked for that tab)`);
    }

    default:
      return fail(`unknown tool ${name}`);
  }
}

// --- wire up ---------------------------------------------------------------
const server = new Server({ name: "camofox-navigator", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    return await handle(name, args || {});
  } catch (e) {
    // Surface camofox's own diagnosis rather than a generic failure — "the
    // browser died, restart the service" is actionable, "error" is not.
    if (e instanceof CamofoxError) {
      return fail(`camofox: ${e.message}\nCheck the service with: camofox-doctor`);
    }
    return fail(`${name} failed: ${e.message}`);
  }
});

await server.connect(new StdioServerTransport());
console.error(`[camofox-navigator] v${VERSION} ready — userId=${USER_ID}, runs in ${RUNS_ROOT}`);
