// Page instrumentation for front-end review.
//
// A human reviewing a UI sees what rendered. Most of what is WRONG with a
// front-end never renders: a caught-and-swallowed exception, a failed request
// the component quietly treats as "no data", a validator that never fires, a
// promise rejection with no handler. Reviewing without capturing those is
// reviewing the half of the app that already works.
//
// This installs before the app boots and records four channels:
//   console.error / console.warn
//   window.onerror (uncaught exceptions)
//   unhandledrejection (the one that hides async failures)
//   fetch + XMLHttpRequest (URL, status, duration)
//
// The network channel exists to make one distinction, which is the whole
// difference between a useful review and a useless one: a call that fails
// because a backend is deliberately absent is EXPECTED, and a component that
// breaks when it does is a FINDING. Without the URLs and statuses you cannot
// tell those apart, and every review becomes "lots of errors, probably the
// backend".

export const INSTRUMENT_JS = `(() => {
  if (window.__review) return JSON.stringify({ already: true });
  const R = window.__review = { console: [], errors: [], rejections: [], network: [], routes: [], startedAt: Date.now() };
  const cap = 400;
  const push = (arr, v) => { if (arr.length < cap) arr.push(v); };
  const now = () => Date.now() - R.startedAt;

  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...a) => {
      try {
        push(R.console, { t: now(), level, text: a.map(x => {
          if (x instanceof Error) return x.message;
          if (typeof x === 'object') { try { return JSON.stringify(x).slice(0, 300); } catch { return String(x); } }
          return String(x);
        }).join(' ').slice(0, 500) });
      } catch {}
      orig(...a);
    };
  }

  window.addEventListener('error', (e) => {
    push(R.errors, { t: now(), message: String(e.message || '').slice(0, 300),
      source: (e.filename || '').split('/').pop(), line: e.lineno,
      stack: (e.error && e.error.stack ? String(e.error.stack) : '').split('\\n').slice(0, 3).join(' | ').slice(0, 400) });
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    push(R.rejections, { t: now(),
      message: (r && (r.message || r.statusText)) ? String(r.message || r.statusText).slice(0, 300) : String(r).slice(0, 300),
      status: r && r.status !== undefined ? r.status : undefined });
  });

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const started = performance.now();
    const url = String(args[0] && args[0].url ? args[0].url : args[0]);
    const method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
    try {
      const res = await origFetch.apply(this, args);
      push(R.network, { t: now(), via: 'fetch', method, url: url.slice(0, 200), status: res.status, ms: Math.round(performance.now() - started) });
      return res;
    } catch (err) {
      // A network-layer throw (connection refused) never reaches a status code,
      // and is exactly what an absent backend looks like from the page.
      push(R.network, { t: now(), via: 'fetch', method, url: url.slice(0, 200), status: 0, error: String(err.message).slice(0, 120), ms: Math.round(performance.now() - started) });
      throw err;
    }
  };

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__m = m; this.__u = String(u); return XO.call(this, m, u, ...rest); };
  XMLHttpRequest.prototype.send = function (...a) {
    const started = performance.now();
    this.addEventListener('loadend', () => {
      push(R.network, { t: now(), via: 'xhr', method: this.__m, url: (this.__u || '').slice(0, 200), status: this.status, ms: Math.round(performance.now() - started) });
    });
    return XS.apply(this, a);
  };

  // Route changes, so a finding can be attributed to the screen it happened on.
  const record = () => push(R.routes, { t: now(), url: location.pathname + location.search });
  record();
  for (const m of ['pushState', 'replaceState']) {
    const o = history[m].bind(history);
    history[m] = (...a) => { const r = o(...a); record(); return r; };
  }
  window.addEventListener('popstate', record);

  return JSON.stringify({ installed: true });
})()`;

/** Read what the instrumentation collected, optionally clearing it. */
export const HARVEST_JS = (clear = false) => `(() => {
  const R = window.__review;
  if (!R) return JSON.stringify({ missing: true });
  const out = {
    url: location.pathname,
    console: R.console.slice(),
    errors: R.errors.slice(),
    rejections: R.rejections.slice(),
    network: R.network.slice(),
    routes: R.routes.slice(),
  };
  ${clear ? "R.console.length = 0; R.errors.length = 0; R.rejections.length = 0; R.network.length = 0;" : ""}
  return JSON.stringify(out);
})()`;

/**
 * Split network noise into "expected because a dependency is absent" and
 * "something else". Everything the review says about reliability rests on this
 * line being drawn honestly, so it is drawn from the proxy config rather than a
 * guess about what looks like an API.
 */
export function classifyNetwork(entries, { expectedPrefixes = ["/api"], expectedOrigins = [] } = {}) {
  const expected = [];
  const unexpected = [];
  for (const e of entries) {
    const failed = e.status === 0 || e.status >= 400;
    if (!failed) continue;
    const path = (() => { try { return new URL(e.url, "http://x").pathname; } catch { return e.url; } })();
    const isExpected =
      expectedPrefixes.some((p) => path.startsWith(p)) ||
      expectedOrigins.some((o) => e.url.includes(o));
    (isExpected ? expected : unexpected).push({ ...e, path });
  }
  return { expected, unexpected };
}

/** A11y and UI-quality probes that do not need a backend to be meaningful. */
export const AUDIT_JS = `(() => {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  const imgsNoAlt = q('img').filter(i => visible(i) && !i.hasAttribute('alt')).length;
  const inputsNoLabel = q('input,select,textarea').filter(el => {
    if (!visible(el)) return false;
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return false;
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('placeholder')) return false;
    if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return false;
    return !el.closest('label');
  }).map(el => el.name || el.id || el.type);

  const buttonsNoName = q('button,[role="button"]').filter(b => visible(b) &&
    !(b.innerText || '').trim() && !b.getAttribute('aria-label') && !b.title).length;

  // Overflow is the classic symptom of a layout being rendered at a width the
  // author did not test.
  const overflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;

  const emptyLinks = q('a[href]').filter(a => visible(a) && !(a.innerText || '').trim() && !a.getAttribute('aria-label')).length;
  const tabbables = q('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').filter(visible).length;
  const positiveTabindex = q('[tabindex]').filter(el => Number(el.getAttribute('tabindex')) > 0).length;

  const h1 = q('h1').filter(visible).map(h => h.innerText.trim().slice(0, 60));
  const lang = document.documentElement.getAttribute('lang') || null;
  const title = document.title || '';

  return JSON.stringify({
    viewport: [innerWidth, innerHeight],
    title, lang,
    h1Count: h1.length, h1: h1.slice(0, 3),
    imgsNoAlt, inputsNoLabel, buttonsNoName, emptyLinks,
    overflowX, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
    tabbables, positiveTabindex,
    formCount: q('form').length,
    requiredFields: q('[required]').filter(visible).length,
  });
})()`;
