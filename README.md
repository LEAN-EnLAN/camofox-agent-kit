<div align="center">
  <h1>camofox-agent-kit</h1>
  <p><strong>Give every agent on your Arch Linux box a real browser that websites don't block.</strong></p>
  <p>One command. A systemd service, an MCP server in every agent host, and a skill that stops agents from reaching for Playwright.</p>
</div>

---

## Install

Point your agent at this repo:

> Install this repo, it has a browser tool I want you to use:
> `https://github.com/LEAN-EnLAN/camofox-agent-kit`

The agent reads [`AGENTS.md`](AGENTS.md) and takes it from there. Or do it yourself:

```bash
git clone https://github.com/LEAN-EnLAN/camofox-agent-kit
cd camofox-agent-kit
./install.sh          # add --yes for non-interactive
camofox-doctor        # verify the whole chain
```

Then **restart your agent CLI** — MCP servers attach at session start.

To prove the whole chain actually works, not just that each piece exists:

```bash
node test/mcp-e2e.mjs     # stdio MCP → REST → Camoufox → a real page
```

## What you get

| | |
|---|---|
| **A service** | `camofox-browser.service`, systemd *user* unit, bound to `127.0.0.1`, restarts on failure, idles down to ~40MB and relaunches the browser lazily |
| **MCP everywhere** | Registered in Claude Code, Codex CLI, Cursor, opencode and Antigravity/agy — whichever it finds |
| **A skill** | Tells agents to use `camofox_*` instead of installing Playwright, and how to drive it without wasting loops |
| **A doctor** | `camofox-doctor` walks binary → service → port → health → registration and tells you which link is broken |
| **An Arch package** | [`packaging/aur/PKGBUILD`](packaging/aur/PKGBUILD) for pacman-managed lifecycle |

## Why not Playwright or Puppeteer

Agents need to browse the actual web, and the actual web fights back. Headless
Chrome is fingerprinted on sight; stealth plugins patch the JS surface, and
those patches *become* the fingerprint.

[Camoufox](https://camoufox.com) is a Firefox fork that spoofs at the **C++
level** — `navigator.hardwareConcurrency`, WebGL renderer strings, AudioContext,
screen geometry, WebRTC — before JavaScript can observe anything.
[camofox-browser](https://github.com/jo-inc/camofox-browser) wraps it in a REST
API built for agents: accessibility snapshots instead of raw HTML (~90% fewer
tokens), stable element refs (`e1`, `e2`) instead of brittle CSS selectors, and
per-session cookie isolation.

This kit is the part nobody ships: making it a permanent, safe, discoverable
service on your machine instead of a `npm start` you forget to run.

Keep Playwright for testing your own app in CI. That's a different problem.

## Architecture

```
agent (Claude Code / Codex / Cursor / opencode / agy)
  │  stdio, one per session
  ▼
camofox-browser-mcp          @askjo/camofox-browser-mcp — thin proxy, 11 tools
  │  HTTP to 127.0.0.1:9377
  ▼
camofox-browser.service      systemd user unit → @askjo/camofox-browser
  │  Playwright/Juggler
  ▼
Camoufox (Firefox fork)      ~/.cache/camoufox, launched lazily
```

The MCP adapter carries no browser dependencies — it is a stdio-to-REST
translator. One server process serves every agent session, so the ~300MB browser
is launched once, not once per agent.

## Configure

Everything lives in `~/.config/camofox-browser/camofox-browser.env` (mode 600).
It is a systemd `EnvironmentFile`: plain `KEY=VALUE`, no `export`, no expansion.

```bash
$EDITOR ~/.config/camofox-browser/camofox-browser.env
systemctl --user restart camofox-browser
```

Common knobs — the full annotated list is in
[`systemd/camofox-browser.env.example`](systemd/camofox-browser.env.example):

| Variable | Default here | Purpose |
|---|---|---|
| `CAMOFOX_BIND_HOST` | `127.0.0.1` | Listen address. **See the warning below.** |
| `CAMOFOX_PORT` | `9377` | REST port |
| `BROWSER_IDLE_TIMEOUT_MS` | `300000` | Close the browser after idle; server stays up |
| `CAMOFOX_ACCESS_KEY` | unset | Bearer token gating every route |
| `CAMOFOX_API_KEY` | unset | Gates cookie import |
| `ENABLE_VNC` | unset | Interactive login in a real window |

> [!WARNING]
> **camofox-browser's own default bind host is empty**, which makes express
> listen on every interface (`server.js`: `app.listen(PORT, bindHost || undefined)`).
> For a service that is always up, that is a browser holding your logged-in
> sessions, reachable from your whole network, with no authentication. This kit
> pins `127.0.0.1`. If you need remote access, set `CAMOFOX_ACCESS_KEY` at the
> same time — `install.sh --host 0.0.0.0 --access-key <key>` does both.

## Common operations

```bash
camofox-doctor                                            # what's broken?
systemctl --user status  camofox-browser
systemctl --user restart camofox-browser
journalctl --user -u camofox-browser -f
curl -fsS http://127.0.0.1:9377/health
./install.sh --yes                                        # repair / reconfigure (idempotent)
```

## Installer flags

| Flag | Effect |
|---|---|
| `-y, --yes` | Non-interactive |
| `--port N` / `--host ADDR` | Listen address |
| `--access-key K` / `--api-key K` | Auth, propagated to every host config |
| `--mcp-only` | Just the adapter + registration, for a REST server running elsewhere |
| `--no-service` / `--no-mcp` / `--no-skill` / `--no-deps` | Skip a step |
| `--all-hosts` | Write config even for agent hosts that aren't installed |

Host configs are backed up once as `<config>.camofox-kit.bak` before the first edit.

## Uninstall

```bash
./uninstall.sh            # keeps config + the ~1.3GB browser cache
./uninstall.sh --purge    # removes those, and session data
```

## Arch packaging

`packaging/aur/PKGBUILD` builds `camofox-browser-service`: the systemd unit, the
env template, `camofox-doctor`, `camofox-kit-register` and the skill. It
deliberately does **not** repackage the server or the 1.3GB browser binary —
that is [`camofox-browser-bin`](https://aur.archlinux.org/packages/camofox-browser-bin)'s
job, or npm's. Neither of those ships any systemd integration, which is the gap
this fills.

```bash
cd packaging/aur && makepkg -si
```

## Docs

- [`AGENTS.md`](AGENTS.md) — the install contract an agent follows
- [`skills/camofox-browser/SKILL.md`](skills/camofox-browser/SKILL.md) — how agents should drive the browser
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — symptom → cause → fix

## Credits

This kit is packaging and integration. The hard parts belong to others:

- [Camoufox](https://camoufox.com) by [@daijro](https://github.com/daijro) — the C++-level fingerprint spoofing
- [camofox-browser](https://github.com/jo-inc/camofox-browser) by [Jo Inc](https://askjo.ai) — the agent-facing REST API, and the MCP adapter this kit registers

MIT.
