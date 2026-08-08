// What the navigator is allowed to do without asking.
//
// The default answer to anything with consequences is NO. Not because the user
// cannot decide — it is their machine, their accounts, their call — but because
// the decision has to be theirs *explicitly*, made once, on purpose, rather than
// inherited by accident from a default nobody chose.
//
// So each sensitive capability is a three-state switch:
//
//   deny  (default)  the navigator stops and explains how to opt in
//   ask              the navigator surfaces it and the caller must get a human
//                    to confirm before proceeding
//   allow            the navigator proceeds, still warning on every occurrence
//
// Precedence, most specific first: per-run argument, environment variable,
// config file, built-in default. A per-run argument is deliberately the strongest
// so a caller can loosen one operation without leaving the machine loosened.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "camofox-browser",
  "navigator.conf",
);

const CAPABILITIES = {
  // Filling a sign-in form on the user's behalf. Default deny: a wrong guess
  // here can lock an account, trip a fraud check, or hand credentials to a
  // phishing page that merely looked like the real one.
  loginWalls: {
    env: "CAMOFOX_NAV_LOGIN_POLICY",
    key: "login_walls",
    default: "deny",
    denyMessage:
      "Signing in is disabled by default — it is the user's call, not the agent's. Hand this back to them. " +
      "If the site should already be authenticated, check `camofox-import-cookies --stats` for this host " +
      "first: the session may simply not be covered, which is a different problem. To allow it, the USER " +
      "sets login_walls=ask (confirm each time) or login_walls=allow in " +
      CONFIG_PATH +
      ", or exports CAMOFOX_NAV_LOGIN_POLICY.",
    askMessage:
      "A sign-in form is in the way and policy is 'ask'. Show the user what you are about to submit and " +
      "get an explicit yes for THIS site before typing anything. Never request or enter a 2FA code, and " +
      "never open a password manager.",
    allowMessage:
      "Policy allows signing in. Even so: only use credentials the user has already supplied for this " +
      "specific site, verify the origin is the real one before typing (a login wall is the classic phishing " +
      "shape), never touch 2FA, and stop at the first sign the form is not what it claims. Anything you " +
      "type into a password field is redacted from the run journal.",
  },

  // Attempting a CAPTCHA visually. Default allow: it is the user's own browser
  // solving a challenge aimed at a human sitting at it, and the cost of getting
  // it wrong is a failed page rather than a compromised account.
  captchas: {
    env: "CAMOFOX_NAV_CAPTCHA_POLICY",
    key: "captchas",
    default: "allow",
    denyMessage:
      "Solving challenges is disabled by policy. Report the obstacle and stop.",
    askMessage:
      "A challenge is in the way and policy is 'ask'. Confirm with the user before attempting it.",
    allowMessage: "",
  },

  // Anything that spends money or sends a message — form submissions that are
  // not searches, checkouts, posts. Default deny, and irreversible by nature.
  sideEffects: {
    env: "CAMOFOX_NAV_SIDE_EFFECT_POLICY",
    key: "side_effects",
    default: "deny",
    denyMessage:
      "Actions that publish, send, or spend are disabled by default because they cannot be undone by " +
      "reloading. Describe what you would submit and let the user decide. To allow, the user sets " +
      "side_effects=ask or side_effects=allow.",
    askMessage:
      "This action leaves the page and cannot be taken back. Show the user exactly what will be submitted " +
      "and get an explicit yes before doing it.",
    allowMessage:
      "Policy allows irreversible actions. State plainly what you are about to do before doing it.",
  },
};

const VALID = new Set(["deny", "ask", "allow"]);

function fromFile() {
  if (!existsSync(CONFIG_PATH)) return {};
  const out = {};
  try {
    for (const line of readFileSync(CONFIG_PATH, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const [k, v] = t.split("=").map((x) => x?.trim());
      if (k && v) out[k] = v.toLowerCase();
    }
  } catch {
    // An unreadable config must not silently loosen anything, so it is ignored
    // and the built-in defaults (deny) stand.
  }
  return out;
}

let fileCache = null;

/**
 * Resolve one capability.
 * @param {keyof CAPABILITIES} name
 * @param {string|undefined} override per-run value
 * @returns {{name:string, mode:'deny'|'ask'|'allow', source:string, message:string}}
 */
export function policyFor(name, override) {
  const cap = CAPABILITIES[name];
  if (!cap) throw new Error(`unknown capability: ${name}`);
  if (fileCache === null) fileCache = fromFile();

  const candidates = [
    [override && String(override).toLowerCase(), "per-run argument"],
    [process.env[cap.env] && String(process.env[cap.env]).toLowerCase(), `$${cap.env}`],
    [fileCache[cap.key], CONFIG_PATH],
    [cap.default, "built-in default"],
  ];

  for (const [value, source] of candidates) {
    if (value && VALID.has(value)) {
      return {
        name,
        mode: value,
        source,
        message: value === "deny" ? cap.denyMessage : value === "ask" ? cap.askMessage : cap.allowMessage,
      };
    }
    // A value that is set but nonsense ("yes", "true", "1") must not fall
    // through to something more permissive by accident.
    if (value && !VALID.has(value)) {
      return {
        name,
        mode: cap.default,
        source: `${source} had invalid value ${JSON.stringify(value)} — using ${cap.default}`,
        message: cap.default === "deny" ? cap.denyMessage : cap.allowMessage,
      };
    }
  }
  return { name, mode: cap.default, source: "built-in default", message: cap.denyMessage };
}

/** Everything, for a doctor/status view. */
export const allPolicies = (overrides = {}) =>
  Object.fromEntries(Object.keys(CAPABILITIES).map((k) => [k, policyFor(k, overrides[k])]));

export const POLICY_CONFIG_PATH = CONFIG_PATH;

/**
 * Redact anything that must never reach a log, a journal, or a tool result.
 *
 * This exists because the moment signing in is permitted at all, the navigator
 * is handling secrets — and a run journal is exactly the sort of file that gets
 * pasted into an issue. Redaction happens at the boundary where the value is
 * recorded, not at the point it is used, so no future code path can forget.
 */
export function redactValue(value, { isSecret = false } = {}) {
  if (!isSecret) return value;
  if (value == null) return value;
  const len = String(value).length;
  return `«redacted ${len} chars»`;
}

/** Whether a target element should be treated as secret-bearing. */
export const isSecretField = (el) =>
  !!el &&
  (el.type === "password" ||
    /password|passwd|pwd|otp|2fa|mfa|cvv|card|secret|token/i.test(`${el.label || ""} ${el.name || ""}`));
