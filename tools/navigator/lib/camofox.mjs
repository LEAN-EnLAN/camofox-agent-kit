// Thin client for the camofox REST server.
//
// Kept separate from everything else so the navigator's logic can be tested
// against a fake, and so the one place that knows the wire format is the one
// place that has to change when the server does.

const BASE = process.env.CAMOFOX_BASE_URL || "http://127.0.0.1:9377";
const ACCESS_KEY = process.env.CAMOFOX_ACCESS_KEY || "";
const auth = ACCESS_KEY ? { authorization: `Bearer ${ACCESS_KEY}` } : {};

export class CamofoxError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call(path, { method = "GET", body, raw = false } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...auth },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new CamofoxError(`camofox unreachable at ${BASE}: ${e.message}`, { status: 0 });
  }
  if (raw) {
    if (!res.ok) throw new CamofoxError(`${method} ${path} -> ${res.status}`, { status: res.status });
    return Buffer.from(await res.arrayBuffer());
  }
  const text = await res.text();
  if (!res.ok) throw new CamofoxError(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`, { status: res.status, body: text });
  try { return JSON.parse(text); } catch { return text; }
}

export const camofox = {
  base: BASE,

  health: () => call("/health"),

  // The service recycles its browser when a health probe fails and answers 503
  // for a few seconds while it does. Treating that window as "down" makes every
  // caller look flaky when the service is behaving correctly.
  async waitHealthy(timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let last = "never answered";
    while (Date.now() < deadline) {
      try {
        const h = await call("/health");
        if (h?.browserConnected) return h;
        last = `browserConnected=${h?.browserConnected}`;
      } catch (e) { last = e.message.slice(0, 100); }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new CamofoxError(`camofox never became healthy: ${last}`);
  },

  openTab: (url, userId, sessionKey = "default") =>
    call("/tabs", { method: "POST", body: { url, userId, sessionKey } }),

  closeTab: (tabId, userId) =>
    call(`/tabs/${tabId}?userId=${encodeURIComponent(userId)}`, { method: "DELETE" }),

  listTabs: (userId) => call(`/tabs?${new URLSearchParams({ userId })}`),

  navigate: (tabId, userId, body) =>
    call(`/tabs/${tabId}/navigate`, { method: "POST", body: { userId, ...body } }),

  // The page-context field is `expression`, not `script`. Getting that wrong
  // returns 400 "expression is required".
  evaluate: async (tabId, userId, expression) => {
    const out = await call(`/tabs/${tabId}/evaluate`, { method: "POST", body: { userId, expression } });
    return out?.result !== undefined ? out.result : out;
  },

  // Returns RAW PNG BYTES, not JSON carrying base64. Decoding the body as
  // base64 yields a file that looks written and is not an image.
  screenshotPng: (tabId, userId) =>
    call(`/tabs/${tabId}/screenshot?${new URLSearchParams({ userId })}`, { raw: true }),

  snapshot: (tabId, userId, { offset } = {}) => {
    const p = new URLSearchParams({ userId });
    if (offset != null) p.set("offset", String(offset));
    return call(`/tabs/${tabId}/snapshot?${p}`);
  },
};
