// Obstacle detection and the escalation ladder.
//
// THE POINT OF THIS FILE
//
// A navigation loop that treats every failure the same way is the expensive
// kind of broken: it retries an IP ban forty times, or it hands a hopeless page
// to a vision model, or it silently loops on an unchanged DOM until the budget
// is gone. So every page is classified, and each class maps to exactly one of
// four verdicts:
//
//   proceed          nothing in the way
//   wait_retry       transient — bounded backoff, then give up honestly
//   escalate_vision  a human-solvable obstacle; hand the screenshot to the
//                    caller's model, because THAT is what it is good at
//   stop             no amount of intelligence fixes this; say so and stop
//
// The distinction that matters most is the last one. An IP-reputation block and
// a checkbox CAPTCHA look similar on screen and are completely different
// problems: one needs a proxy, the other needs eyes. Escalating the first wastes
// the caller's tokens on something vision cannot fix, and stopping on the second
// throws away a page that was one click from working.

import { policyFor } from "./policy.mjs";

// Runs in the page. Gathers signals only — the judgement happens in Node, where
// it can be tested without a browser.
export const PROBE_JS = `(() => {
  const text = (document.body ? document.body.innerText : '') || '';
  const lower = text.toLowerCase();

  // Interstitials are SHORT and lead with their message; a content page is long
  // and can contain any word incidentally. Searching the whole body for "banned"
  // or "429" classified the Wikipedia article on Minecraft as an IP block —
  // observed, and the reason this is gated on the opening of the page instead.
  const LEAD = 1200;
  const lead = lower.slice(0, LEAD);
  const has = (re) => re.test(lead);
  const anywhere = (re) => re.test(lower);
  const q = (sel) => !!document.querySelector(sel);
  const count = (sel) => document.querySelectorAll(sel).length;

  // A page that is genuinely refusing you ANNOUNCES it — in the title or the
  // first heading. The same words buried in a paragraph are prose. Gating the
  // refusal classes on the headline is what separates "403 Forbidden" the page
  // from "...forbidden by policy" the sentence.
  const headline = [
    document.title || '',
    ...Array.from(document.querySelectorAll('h1,h2')).slice(0, 3).map(h => h.innerText || ''),
  ].join(' ').toLowerCase();
  const inHeadline = (re) => re.test(headline);

  return JSON.stringify({
    url: location.href,
    title: document.title || '',
    readyState: document.readyState,
    textLength: text.length,
    // The single most useful signal: a real block replaces the page. Anything
    // this short is an interstitial; anything long is a document that merely
    // happens to contain scary words.
    isShort: text.length < 2000,
    head: text.slice(0, 400).replace(/\\s+/g, ' '),

    headline: headline.slice(0, 200),
    phrases: {
      // Full phrases only. Bare tokens like "429", "banned" or "forbidden"
      // appear in ordinary prose and are worse than no signal at all.
      unusualTraffic: has(/unusual traffic|tráfico inusual/),
      notARobot: has(/i'?m not a robot|no soy un robot/),
      verifyHuman: has(/verify (you are|you'?re) (a )?human|verifica que eres humano|are you human/),
      checkingBrowser: has(/checking your browser|verifying you are human|just a moment/),
      // Headline-gated: these are the two most easily faked by ordinary prose.
      tooManyRequests: inHeadline(/too many requests|rate limit|429|demasiadas solicitudes/),
      accessDenied: inHeadline(/access denied|acceso denegado|forbidden|401|403/),
      signIn: has(/sign in to continue|log in to continue|iniciar sesión para continuar|sign in|log in/),
      blocked: has(/you have been blocked|has sido bloqueado|your ip has been/) ||
               inHeadline(/blocked|bloqueado/),
      // A consent banner is a live dialog, not a word. Matching the word
      // "privacidad" flagged a normal Google results page as a consent wall.
      consentText: has(/accept (all )?cookies|aceptar (todas las )?cookies|we use cookies|usamos cookies/),
    },

    widgets: {
      recaptchaFrame: count('iframe[src*="recaptcha"]'),
      recaptchaDiv: count('.g-recaptcha,[data-sitekey]'),
      hcaptcha: count('iframe[src*="hcaptcha"],.h-captcha'),
      turnstile: count('iframe[src*="challenges.cloudflare.com"],.cf-turnstile'),
      cfChallenge: q('#challenge-form,#cf-challenge-running,#cf-wrapper') ? 1 : 0,
      imageGrid: count('.rc-imageselect,.rc-imageselect-table'),
      passwordField: count('input[type="password"]'),
      // A consent banner is a fixed/sticky container with an accept control.
      // Requiring the element stops the word "cookies" in body copy from being
      // reported as a wall.
      consentBanner: (() => {
        for (const el of document.querySelectorAll('div,section,aside,dialog')) {
          const st = getComputedStyle(el);
          if (st.position !== 'fixed' && st.position !== 'sticky') continue;
          const r = el.getBoundingClientRect();
          if (r.height < 40 || r.width < 200) continue;
          if (/accept|aceptar|consent|cookie/i.test(el.innerText || '')) return 1;
        }
        return 0;
      })(),
    },

    // Cheap structural fingerprint for no-progress detection. Full text would
    // change on every clock tick or animation; this only moves when the page
    // actually becomes a different page.
    fingerprint: [
      location.pathname,
      document.title,
      document.querySelectorAll('*').length,
      document.querySelectorAll('a,button,input,select,textarea').length,
    ].join('|'),
  });
})()`;

// Ordered most-specific first: the first rule that matches wins, so a page that
// is BOTH an IP block and shows a reCAPTCHA widget is correctly called an IP
// block. Google's /sorry page is exactly that, and getting the order wrong
// sends the caller off solving a CAPTCHA that will not let them through.
const RULES = [
  {
    class: "network_block",
    verdict: "stop",
    // Corroborated on purpose: the phrase must appear in a page SHORT enough to
    // be an interstitial, or the URL must be an explicit block path. Either
    // alone produces false accusations against ordinary documents.
    match: (s) =>
      /\/sorry\/|\/blocked|\/challenge/.test(s.url) ||
      ((s.phrases.unusualTraffic || s.phrases.blocked) && s.isShort),
    why: "the site is blocking this network, not this browser",
    remedy:
      "This is IP reputation, not bot detection — the fingerprint is fine and a CAPTCHA solve will not " +
      "stick. Route through a proxy (PROXY_HOST/PROXY_PORT in the camofox env, which also aligns GeoIP) " +
      "or use a different source. Do not retry from here.",
  },
  {
    class: "login_wall",
    // Deliberately NOT a fixed verdict. Whether an agent may sign in is the
    // user's decision, so it resolves through policy: deny by default, ask or
    // allow only if they said so explicitly. Hardcoding "stop" here would be
    // substituting my judgement for theirs on their own accounts.
    capability: "loginWalls",
    // A password field on a short page is a login wall. The same field inside a
    // long page is usually a sign-in box in a header, which is not a wall.
    match: (s) => s.widgets.passwordField > 0 && s.phrases.signIn && s.isShort,
    why: "the page is asking for credentials",
    remedy:
      "Hand this back to the user. Never type credentials, request a 2FA code, or drive a password " +
      "manager on their behalf. If the site should already be authenticated, check " +
      "`camofox-import-cookies --stats` for this host — the session may simply not be covered.",
  },
  {
    class: "captcha_image",
    capability: "captchas",
    verdict: "escalate_vision",
    match: (s) => s.widgets.imageGrid > 0,
    why: "an image-selection challenge is on screen",
    remedy:
      "Take an annotated screenshot and solve it yourself: identify the matching tiles visually, then " +
      "click them by index. This is the case where your eyes are the right tool.",
  },
  {
    class: "captcha_checkbox",
    capability: "captchas",
    verdict: "escalate_vision",
    match: (s) =>
      s.widgets.recaptchaFrame > 0 || s.widgets.recaptchaDiv > 0 ||
      s.widgets.hcaptcha > 0 || (s.phrases.notARobot && s.isShort),
    why: "a checkbox CAPTCHA is present and may be one click away",
    remedy:
      "Screenshot it, locate the checkbox, click it by index, then re-read the page. If it escalates to " +
      "an image grid, solve that visually too. If it re-appears after a successful click, stop — that is " +
      "a reputation problem wearing a CAPTCHA costume.",
  },
  {
    class: "managed_challenge",
    verdict: "wait_retry",
    match: (s) =>
      s.widgets.turnstile > 0 || s.widgets.cfChallenge > 0 ||
      (s.phrases.checkingBrowser && s.isShort),
    why: "an interstitial is running its own check",
    remedy:
      "These usually clear themselves in a few seconds. Wait and re-read. If it has not cleared after a " +
      "couple of attempts it is gating on reputation, not on patience — stop and report it.",
  },
  {
    class: "rate_limited",
    verdict: "wait_retry",
    match: (s) => s.phrases.tooManyRequests && s.isShort,
    why: "the site is rate limiting",
    remedy: "Back off and slow down. If it persists, stop — hammering it makes the block longer, not shorter.",
  },
  {
    class: "access_denied",
    verdict: "stop",
    match: (s) => s.phrases.accessDenied && s.isShort,
    why: "the server refused the request outright",
    remedy: "Not something the browser can talk its way past. Report it and stop.",
  },
  {
    class: "consent_wall",
    verdict: "proceed",
    match: (s) => s.widgets.consentBanner > 0 && s.phrases.consentText,
    why: "a cookie/consent banner is present and probably covering content",
    remedy: "Usually just an element to click. Dismiss it, then continue — it is furniture, not a wall.",
  },
  {
    class: "empty_page",
    verdict: "wait_retry",
    match: (s) => s.readyState !== "complete" || s.textLength < 40,
    why: "the page has not rendered anything meaningful yet",
    remedy: "Give it another beat. If it stays empty, the URL or the render is broken — say which.",
  },
];

/**
 * Classify the page from probe signals.
 * @returns {{class:string, verdict:'proceed'|'wait_retry'|'escalate_vision'|'stop', why:string, remedy:string, evidence:object}}
 */
export function classify(signals, { interactiveCount = null, policies = {} } = {}) {
  for (const rule of RULES) {
    if (!rule.match(signals)) continue;

    let verdict = rule.verdict;
    let remedy = rule.remedy;
    let policy = null;

    if (rule.capability) {
      policy = policyFor(rule.capability, policies[rule.capability]);
      // deny -> stop outright. ask -> hand it to the caller to confirm with a
      // human. allow -> let the rule's own verdict stand (vision, usually).
      verdict = policy.mode === "deny" ? "stop"
        : policy.mode === "ask" ? "ask_user"
        : rule.verdict;
      remedy = [policy.message, rule.remedy].filter(Boolean).join(" ");
    }

    return {
      class: rule.class,
      verdict,
      why: rule.why,
      remedy,
      policy: policy ? { capability: policy.name, mode: policy.mode, source: policy.source } : null,
      evidence: evidenceFor(rule.class, signals),
    };
  }
  // No obstacle matched, but a page with nothing to click is not navigable
  // either — and saying "clear" about it would send the caller looking for
  // elements that are not there.
  if (interactiveCount === 0) {
    return {
      class: "no_interactive_elements",
      verdict: "wait_retry",
      why: "the page rendered but exposed nothing interactive",
      remedy:
        "Either it is still hydrating, or the content is inside an iframe or a canvas. Re-read once; if it " +
        "stays empty, extract what you need from the text instead of trying to click.",
      evidence: { textLength: signals.textLength, readyState: signals.readyState },
    };
  }
  return { class: "clear", verdict: "proceed", why: "nothing in the way", remedy: "", evidence: {} };
}

function evidenceFor(cls, s) {
  const hits = Object.entries(s.phrases).filter(([, v]) => v).map(([k]) => k);
  const widgets = Object.entries(s.widgets).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`);
  return {
    url: s.url,
    phrases: hits,
    widgets,
    // A quote from the page is what makes a verdict checkable instead of a
    // pronouncement the caller has to take on faith.
    quote: s.head.slice(0, 180),
  };
}

/**
 * Guard against the failure mode a step loop is most prone to: repeating an
 * action that changes nothing, forever. Tracks recent page fingerprints and
 * reports when the page has stopped responding to what we do.
 */
export class ProgressGuard {
  constructor({ stallLimit = 3, maxSteps = 40 } = {}) {
    this.stallLimit = stallLimit;
    this.maxSteps = maxSteps;
    this.steps = 0;
    this.recent = [];
  }

  /** @returns {{ok:boolean, reason?:string}} */
  record(fingerprint) {
    this.steps += 1;
    if (this.steps > this.maxSteps) {
      return { ok: false, reason: `step budget exhausted (${this.maxSteps}) — stopping instead of looping` };
    }
    this.recent.push(fingerprint);
    if (this.recent.length > this.stallLimit) this.recent.shift();
    if (
      this.recent.length === this.stallLimit &&
      this.recent.every((f) => f === this.recent[0])
    ) {
      return {
        ok: false,
        reason:
          `the page fingerprint has not changed across ${this.stallLimit} consecutive actions — ` +
          `whatever is being clicked is not doing anything. Re-read the element list; the indices may be stale.`,
      };
    }
    return { ok: true };
  }
}
