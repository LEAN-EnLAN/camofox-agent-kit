# Vendored from browser-use

`buildDomTree.js` is taken verbatim from
[browser-use/browser-use](https://github.com/browser-use/browser-use) at tag
**0.3.2** (commit `98d08cc04044`), sha256 prefix `0c63bfa5545b2f5d`.
MIT licensed — the upstream licence is alongside it in `LICENSE`, and the
copyright is Gregor Zunic's.

## Why this file and nothing else

browser-use is a Python agent built on **CDP**, the Chrome DevTools Protocol.
`browser_use/dom/service.py` imports `cdp_use.cdp.accessibility`,
`cdp_use.cdp.dom` and `cdp_use.cdp.target`, with 23 CDP call sites, and the
current tree contains **zero `.js` files** — the DOM pipeline is Python built
around CDP snapshots and CDP accessibility trees.

This kit drives **Camoufox**, a Firefox fork spoken to over Juggler. There is no
CDP. So forking browser-use's DOM layer would mean porting a CDP-shaped Python
pipeline onto a protocol it was never written for: a large, fragile
reimplementation whose output we would then have to prove matches the original.
That is a worse deliverable than not doing it.

`buildDomTree.js` is the exception, and it is the valuable part:

- **1480 lines, zero imports** — self-contained, so it can be injected into any
  page as-is.
- **No Chrome-only APIs.** No `chrome.*`, no `webkit*`, no CDP. It is DOM, CSSOM
  and `getBoundingClientRect` — all of which Firefox implements. Verified by
  grep before adopting, then by running it in Camoufox.
- It carries the two things worth having: an **indexed map of genuinely
  interactive elements** (with occlusion, viewport and visibility handling that
  took that project a very long time to get right), and `highlightElement()`,
  which draws the numbered boxes over those elements. That overlay is what makes
  an agent's actions visible in a screenshot or recording instead of invisible.

Present in older tags, removed upstream after the CDP rewrite, so 0.3.2 is the
last release where it exists.

## Local modifications

None. The file is byte-identical to upstream so it can be diffed against a newer
tag if one ever reappears. Everything this kit adds — injection, the element
index, action execution, the visible action trail — lives outside this directory
in `tools/navigator/`, and treats this file as a black box with a documented
entry contract:

```js
buildDomTree({ doHighlightElements, focusHighlightIndex, viewportExpansion, debugMode })
// -> { rootId, map: { <id>: { tagName, attributes, xpath, highlightIndex, ... } } }
```

The highlight container it creates is `#playwright-highlight-container`, which
must be removed before a clean screenshot and re-added for an annotated one.

## Upgrading

Diff against upstream 0.3.2 first to confirm this copy is still unmodified, then
re-read the entry contract above — the argument names and the shape of `map` are
the only surface this kit depends on.
