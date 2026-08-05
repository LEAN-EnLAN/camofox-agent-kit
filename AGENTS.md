# Instructions for the agent installing this repo

You were pointed at this repository to install it. This file is the contract.
Follow it top to bottom; do not improvise an alternative setup.

**What you are installing:** `camofox-browser` — an anti-detection browser
server — as a systemd user service, plus its MCP adapter registered in every
agent host on this machine, plus a skill that teaches agents to use it instead
of Playwright or Puppeteer.

**Target:** Arch Linux (or any systemd distro; the pacman dependency step is
skipped elsewhere). Requires Node >= 22.

## Install

```bash
git clone https://github.com/LEAN-EnLAN/camofox-agent-kit
cd camofox-agent-kit
./install.sh
```

Add `--yes` for a non-interactive run. The installer is idempotent — re-running
it is the correct way to repair or reconfigure an install.

It will:

1. Verify Node >= 22 and the Camoufox shared-library dependencies, offering to
   `pacman -S` anything missing (needs `sudo`).
2. `npm install -g` `@askjo/camofox-browser` and `@askjo/camofox-browser-mcp`,
   falling back to a `~/.local` prefix when the system prefix is not writable.
   First install downloads the ~300MB Camoufox binary into `~/.cache/camoufox`.
3. Write `~/.config/camofox-browser/camofox-browser.env`, **bound to 127.0.0.1**.
4. Install, enable and start `camofox-browser.service` as a systemd *user* unit,
   then wait for `/health`.
5. Register the MCP server in each detected host: Claude Code, Codex CLI, Cursor,
   opencode, Antigravity/agy.
6. Install the `camofox-browser` skill into `~/.claude/skills/`.
7. Install `camofox-doctor` into `~/.local/bin/`.

## Verify

```bash
camofox-doctor
```

Every line must be `✔`. Then **tell the user to restart their agent CLI** — MCP
servers are attached at session start, so the current session will not see the
tools. After restarting, `/mcp` should list `camofox-browser` with 11 tools.

## Rules for you, the installing agent

- **Do not** install Playwright, Puppeteer, Selenium, or `chromium` as part of
  this. Replacing them is the entire point.
- **Do not** widen `CAMOFOX_BIND_HOST` past `127.0.0.1`. The server has no auth
  by default; on a LAN address it hands anyone the user's logged-in sessions. If
  the user genuinely needs remote access, set `--access-key` as well and say so.
- **Do not** paste secrets into agent host config files by hand. Pass
  `--access-key` / `--api-key` to `install.sh`; it puts them in the env file
  (mode 600) and propagates them.
- **Do** report the `sudo` steps before running them: the pacman install and the
  optional `loginctl enable-linger`.
- If `install.sh` fails, run `camofox-doctor` and read
  `journalctl --user -u camofox-browser.service -n 50 --no-pager` before
  changing anything. Do not start editing the unit file.
- If the user is not on systemd, do not install the service. Use
  `./install.sh --no-service` and tell them to run `camofox-browser` themselves.

## After install, when browsing

Read `skills/camofox-browser/SKILL.md` — it is the operating manual for the
tools. The short version:

`camofox_create_tab` → `camofox_snapshot` → act on element refs (`e1`, `e2`) →
snapshot again → `camofox_close_tab`. Never guess a CSS selector; refs from
before a navigation are stale after it.

## Uninstall

```bash
./uninstall.sh          # keeps config + the 1.3GB browser cache
./uninstall.sh --purge  # removes those too
```
