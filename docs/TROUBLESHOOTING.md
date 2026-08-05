# Troubleshooting

Start with `camofox-doctor`. It walks the same chain a tool call travels —
binary → service → port → health → MCP registration — and marks the broken link.

---

## The agent doesn't see any `camofox_*` tools

**MCP servers attach at session start.** Restart the agent CLI. If it still
doesn't, check that registration landed:

```bash
camofox-doctor | tail -12
```

If your host shows "not installed", its config directory didn't exist when the
installer ran (a fresh Cursor install, say). Re-run `./install.sh`, or force it:

```bash
node lib/register-mcp.mjs --bin "$(command -v camofox-browser-mcp)" \
  --base-url http://127.0.0.1:9377 --all
```

## `camofox-browser-mcp: command not found`

The npm prefix isn't on your PATH. The installer falls back to `~/.local` when
`/usr` isn't writable:

```bash
npm prefix -g            # where npm thinks it installs
ls ~/.local/bin/camofox-browser-mcp
```

Add the right `bin` directory to your PATH in `~/.bashrc` / `~/.zshrc`. Note that
**agent hosts don't necessarily inherit your shell PATH** — the installer writes
the absolute path into each host config precisely to avoid this.

## The service won't start

```bash
systemctl --user status camofox-browser
journalctl --user -u camofox-browser -n 50 --no-pager
```

| In the log | Cause |
|---|---|
| `/usr/bin/env: 'node': No such file or directory` | The unit's `Environment=PATH=` doesn't include your node. Re-run `./install.sh` — it resolves this at install time. Common after switching nvm/fnm versions. |
| `EADDRINUSE` | Port 9377 is taken. `ss -ltnp \| rg 9377`, then `./install.sh --port 9378`. |
| `Cannot find module` | Partial npm install. `npm install -g @askjo/camofox-browser --force`. |
| Exits immediately, no message | `EnvironmentFile` syntax. It is **not** a shell script — no `export`, no `$VAR`, no command substitution. |

## The service dies when I log out

systemd tears down the user manager at logout unless lingering is on:

```bash
sudo loginctl enable-linger "$USER"
```

## Tabs fail: "browser failed to launch"

The server is fine; the Firefox binary can't start. Two causes.

**Missing shared libraries** — `camofox-doctor` lists them. Install with pacman.
This is the usual one on a minimal Arch install.

**Missing browser binary:**

```bash
ls ~/.cache/camoufox/browsers
npx camoufox-js fetch          # ~300MB
```

Diagnose by hand — the launch error is much clearer outside systemd:

```bash
systemctl --user stop camofox-browser
set -a; . ~/.config/camofox-browser/camofox-browser.env; set +a
camofox-browser
```

## `503 session_expired` / "tab create timed out"

The browser process died, usually after an earlier call destabilized it. The REST
server survives, so it keeps answering while every tab fails.

```bash
systemctl --user restart camofox-browser
```

If it recurs, cap memory pressure — `BROWSER_RSS_RESTART_THRESHOLD_MB=2048` in
the env file recycles the browser before it degrades.

## `401` / `403` on every tool call

The server has `CAMOFOX_ACCESS_KEY` set and the MCP adapter doesn't have the same
value. Don't hand-edit host configs; propagate it:

```bash
./install.sh --access-key "$(grep '^CAMOFOX_ACCESS_KEY=' \
  ~/.config/camofox-browser/camofox-browser.env | cut -d= -f2-)"
```

`403` on `camofox_import_cookies` only means `CAMOFOX_API_KEY` — same fix with
`--api-key`.

## `422 strict mode violation ... resolved to N elements`

Your CSS selector matched more than one element. This is the tool refusing to
guess, not a bug. Re-snapshot and click the element **ref** (`e7`) instead.

## `camofox_scroll` says ok but the page doesn't move

Expected on lazy-load and virtual-scroll pages, where the underlying
`mouse.wheel` no-ops. Use `camofox_evaluate`:

```js
window.scrollTo(0, document.body.scrollHeight)
```

## Snapshots are truncated

Large pages paginate. The response carries a truncation marker — request the next
offset rather than assuming you saw the whole page. If you only need one value,
`camofox_evaluate` is cheaper than paging through a snapshot.

## I want to undo the host config edits

Each host config was backed up once before the first edit:

```bash
ls ~/.claude.json.camofox-kit.bak ~/.cursor/mcp.json.camofox-kit.bak 2>/dev/null
node lib/register-mcp.mjs --remove       # or just remove our entry
```

## It's not Arch

The service, MCP registration and skill work on any systemd distro — only the
`pacman` dependency check is Arch-specific, and the installer skips it
automatically. Install the Firefox runtime libraries with your own package
manager; `camofox-doctor` won't check them for you.

Without systemd: `./install.sh --no-service` and run `camofox-browser` yourself.
