// Page state for a navigating agent: a compact, indexed list of what can be
// interacted with, plus the plumbing to act on it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { camofox } from "./camofox.mjs";
import { PROBE_JS, classify } from "./obstacles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Vendored from browser-use, MIT — see vendor/browser-use/NOTICE.md for why this
// file and nothing else, and for its entry contract.
const BUILD_DOM_TREE = readFileSync(join(HERE, "../../../vendor/browser-use/buildDomTree.js"), "utf8");

export const HIGHLIGHT_CONTAINER = "playwright-highlight-container";
const TAG_ATTR = "data-nav-idx";

/**
 * Inject the extractor, stamp every interactive element with a stable index
 * attribute, and return a compact description.
 *
 * The stamping is the important part. buildDomTree hands back an xpath, but a
 * real click has to go through the browser's own input pipeline — clicking via
 * `element.click()` from page script skips the mouse events that hover menus,
 * drag handles and analytics-wrapped buttons depend on. Tagging the element and
 * then letting camofox click `[data-nav-idx="7"]` gets a genuine click at real
 * coordinates while still addressing the element by the index the model saw.
 */
const stateScript = ({ highlight, viewportExpansion }) => `(() => {
  const buildDomTree = ${BUILD_DOM_TREE};

  // Any overlay from a previous read would otherwise be measured as page
  // content and stack up box-on-box across steps.
  const old = document.getElementById(${JSON.stringify(HIGHLIGHT_CONTAINER)});
  if (old) old.remove();
  for (const el of document.querySelectorAll('[${TAG_ATTR}]')) el.removeAttribute('${TAG_ATTR}');

  const out = buildDomTree({
    doHighlightElements: ${highlight ? "true" : "false"},
    focusHighlightIndex: -1,
    viewportExpansion: ${Number(viewportExpansion) || 0},
    debugMode: false,
  });

  const map = out.map || {};
  const elements = [];

  const labelFor = (node, el) => {
    const a = node.attributes || {};
    const pick = [
      a['aria-label'], a.placeholder, a.title, a.alt, a.name,
      a.value, a['aria-labelledby'] ? null : null,
    ].find(v => v && String(v).trim());
    if (pick) return String(pick).trim();
    // innerText beats textContent here: it reflects what is actually rendered,
    // so hidden markup and script bodies do not become the label.
    const t = el && el.innerText ? el.innerText.trim().replace(/\\s+/g, ' ') : '';
    if (t) return t;
    return a.id || a.class ? ('#' + (a.id || '') + '.' + String(a.class || '').split(' ')[0]) : '';
  };

  const byXpath = (xpath) => {
    if (!xpath) return null;
    try {
      const r = document.evaluate('/' + xpath.replace(/^\\/+/, ''), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue;
    } catch { return null; }
  };

  for (const key of Object.keys(map)) {
    const node = map[key];
    if (node.highlightIndex === undefined || node.highlightIndex === null) continue;
    const el = byXpath(node.xpath);
    if (el && el.setAttribute) el.setAttribute('${TAG_ATTR}', String(node.highlightIndex));

    const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    elements.push({
      i: node.highlightIndex,
      tag: (node.tagName || '').toLowerCase(),
      type: (node.attributes && node.attributes.type) || undefined,
      label: labelFor(node, el).slice(0, 90),
      // Whether it is on screen decides if it can be clicked without scrolling
      // first, which is a question the caller otherwise has to guess at.
      inView: rect ? (rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0) : false,
      box: rect ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] : null,
    });
  }
  elements.sort((a, b) => a.i - b.i);

  return JSON.stringify({
    url: location.href,
    title: document.title || '',
    scroll: { y: Math.round(scrollY), max: Math.max(0, Math.round(document.body.scrollHeight - innerHeight)) },
    elements,
    highlighted: ${highlight ? "true" : "false"},
  });
})()`;

const parse = (raw) => (typeof raw === "string" ? JSON.parse(raw) : raw);

/**
 * Read page state and assess obstacles in one round trip.
 * Two evaluates rather than one: the obstacle probe must run even when the
 * extractor throws on a hostile page, and merging them would lose that.
 */
export async function readState(tabId, userId, { highlight = false, viewportExpansion = 0 } = {}) {
  let signals = null;
  try {
    signals = parse(await camofox.evaluate(tabId, userId, PROBE_JS));
  } catch (e) {
    signals = {
      url: "", title: "", readyState: "unknown", textLength: 0, head: `probe failed: ${e.message}`,
      phrases: {}, widgets: {}, fingerprint: "probe-failed",
    };
  }

  let dom = null;
  let domError = null;
  try {
    dom = parse(await camofox.evaluate(tabId, userId, stateScript({ highlight, viewportExpansion })));
  } catch (e) {
    domError = e.message.slice(0, 200);
  }

  const obstacle = classify(signals, { interactiveCount: dom ? dom.elements.length : null });

  return {
    url: dom?.url || signals.url,
    title: dom?.title || signals.title,
    scroll: dom?.scroll || null,
    elements: dom?.elements || [],
    highlighted: !!dom?.highlighted,
    fingerprint: signals.fingerprint,
    obstacle,
    domError,
    textPreview: signals.head,
  };
}

/** CSS selector addressing the element the model referred to by index. */
export const selectorFor = (index) => `[${TAG_ATTR}="${Number(index)}"]`;

/** Strip the overlay so a screenshot shows the page rather than our annotations. */
export const CLEAR_HIGHLIGHTS_JS = `(() => {
  const c = document.getElementById(${JSON.stringify(HIGHLIGHT_CONTAINER)});
  if (c) c.remove();
  return JSON.stringify({ cleared: !!c });
})()`;

/**
 * Draw attention to one element only — the thing about to be acted on. A frame
 * showing 80 numbered boxes proves the extractor ran; a frame showing ONE box
 * proves what the agent did, which is what a viewer of the recording needs.
 */
export const focusJs = (index) => `(() => {
  const el = document.querySelector(${JSON.stringify(`[${TAG_ATTR}="${Number(index)}"]`)});
  if (!el) return JSON.stringify({ found: false });
  const c = document.getElementById(${JSON.stringify(HIGHLIGHT_CONTAINER)});
  if (c) c.remove();
  const r = el.getBoundingClientRect();
  const box = document.createElement('div');
  box.id = 'nav-focus-box';
  Object.assign(box.style, {
    position: 'fixed', left: (r.left - 3) + 'px', top: (r.top - 3) + 'px',
    width: (r.width + 6) + 'px', height: (r.height + 6) + 'px',
    border: '3px solid #ff3b30', borderRadius: '4px',
    boxShadow: '0 0 0 3px rgba(255,59,48,.25)', zIndex: 2147483647, pointerEvents: 'none',
  });
  const tag = document.createElement('div');
  tag.textContent = ${JSON.stringify(String(index))};
  Object.assign(tag.style, {
    position: 'fixed', left: (r.left - 3) + 'px', top: Math.max(0, r.top - 22) + 'px',
    background: '#ff3b30', color: '#fff', font: '600 12px/16px system-ui, sans-serif',
    padding: '1px 6px', borderRadius: '3px', zIndex: 2147483647, pointerEvents: 'none',
  });
  document.body.append(box, tag);
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  return JSON.stringify({ found: true, box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
})()`;

export const CLEAR_FOCUS_JS = `(() => {
  for (const id of ['nav-focus-box']) { const e = document.getElementById(id); if (e) e.remove(); }
  for (const e of document.querySelectorAll('div')) {
    if (e.style && e.style.zIndex === '2147483647' && e.textContent && e.textContent.length < 4 && e.style.background === 'rgb(255, 59, 48)') e.remove();
  }
  return JSON.stringify({ ok: true });
})()`;
