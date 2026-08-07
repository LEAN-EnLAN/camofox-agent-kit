#!/usr/bin/env bash
#
# camofox-agent-kit installer
#
# Turns camofox-browser into a first-class part of this machine:
#   1. verifies Node >= 22 and the Camoufox shared-library deps
#   2. installs the camofox-browser REST server + the standalone MCP adapter
#   3. installs and starts a systemd *user* service bound to loopback
#   4. registers the MCP server in every agent host it finds
#   5. installs the agent skill that tells agents to use it
#   6. offers to import your browser's login cookies, so agents land on the
#      sites you actually use already logged in
#
# Safe to re-run: every step is idempotent.
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# --- defaults --------------------------------------------------------------
PORT=9377
BIND_HOST=127.0.0.1
ACCESS_KEY=""
API_KEY=""
ASSUME_YES=0
DO_SERVICE=1
DO_MCP=1
DO_SKILL=1
DO_DEPS=1
DO_LINGER=1
DO_COOKIES=1
ALL_HOSTS=0
MCP_ONLY=0
COOKIE_BROWSERS=""
COOKIE_EXCLUDE=""

usage() {
  cat <<'EOF'
camofox-agent-kit installer

Usage: ./install.sh [options]

Options:
  -y, --yes              Assume yes for every prompt (non-interactive)
      --port N           REST server port (default: 9377)
      --host ADDR        Bind address (default: 127.0.0.1 — see SECURITY below)
      --access-key KEY   Gate every REST route behind a bearer token
      --api-key KEY      Enable cookie import with this key
      --mcp-only         Install just the MCP adapter + host registration.
                         Use when the REST server already runs elsewhere;
                         combine with --host to point at it.
      --no-service       Skip the systemd user service
      --no-mcp           Skip agent host registration
      --no-skill         Skip installing the agent skill
      --no-deps          Skip the pacman dependency check
      --no-linger        Don't offer to enable user lingering (skips a sudo call)
      --no-cookies       Skip the browser cookie import entirely
      --cookie-browser N Import from browser N instead of the most recently
                         used one. Repeatable. See --list on the importer.
      --cookie-exclude R Never import cookies whose host matches this regex
      --all-hosts        Write config for every known agent host, even ones
                         that are not installed
  -h, --help             Show this help

SECURITY
  camofox-browser defaults to an empty bind host, which makes it listen on
  every interface. This installer pins 127.0.0.1. If you widen --host, set
  --access-key too: an unauthenticated browser server on your LAN hands anyone
  your logged-in sessions.

  The cookie import copies live session tokens out of your browser into
  ~/.camofox/cookies/cookies.txt (mode 0600). Anything that can drive camofox
  can then act as you on those sites. It is opt-in at the prompt, and
  --cookie-exclude keeps chosen hosts out of it.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    --port) PORT="${2:?--port needs a value}"; shift ;;
    --host) BIND_HOST="${2:?--host needs a value}"; shift ;;
    --access-key) ACCESS_KEY="${2:?--access-key needs a value}"; shift ;;
    --api-key) API_KEY="${2:?--api-key needs a value}"; shift ;;
    --mcp-only) MCP_ONLY=1; DO_SERVICE=0; DO_DEPS=0 ;;
    --no-service) DO_SERVICE=0 ;;
    --no-mcp) DO_MCP=0 ;;
    --no-skill) DO_SKILL=0 ;;
    --no-deps) DO_DEPS=0 ;;
    --no-linger) DO_LINGER=0 ;;
    --no-cookies) DO_COOKIES=0 ;;
    --cookie-browser) COOKIE_BROWSERS="$COOKIE_BROWSERS ${2:?--cookie-browser needs a name}"; shift ;;
    --cookie-exclude) COOKIE_EXCLUDE="${2:?--cookie-exclude needs a regex}"; shift ;;
    --all-hosts) ALL_HOSTS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown option: $1"; echo; usage; exit 2 ;;
  esac
  shift
done
export ASSUME_YES

case "$PORT" in ''|*[!0-9]*) die "--port must be a number, got '$PORT'" ;; esac

BASE_URL="http://${BIND_HOST}:${PORT}"
CORE_BIN_PATH=""
MCP_BIN_PATH=""
CAPTURE_HINT=""
COOKIE_HINT=""

printf '%s\n' "${C_BOLD}camofox-agent-kit${C_RESET} — installing for $(whoami) on $(uname -sr)"
echo

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
log "Preflight"
require_node
ok "node $(node -v), npm $(npm -v)"

if ! is_arch; then
  warn "this kit is tuned for Arch Linux; the pacman dependency step will be skipped"
  DO_DEPS=0
fi

if [ "$DO_SERVICE" = "1" ]; then
  require_systemd_user
  ok "systemd user session reachable"
fi

if [ "$DO_DEPS" = "1" ]; then
  MISSING=()
  mapfile -t MISSING < <(missing_arch_deps)
  if [ "${#MISSING[@]}" -gt 0 ]; then
    warn "missing Camoufox runtime libraries: ${MISSING[*]}"
    info "without these the server starts fine but every tab fails to launch"
    if confirm "Install them with pacman now?"; then
      # Never fatal: sudo may need a password we cannot prompt for (non-interactive
      # run, no askpass). Aborting here would leave the user with nothing installed
      # over a step they can complete themselves in one command.
      if pacman_install "${MISSING[@]}"; then
        ok "runtime libraries installed"
      else
        warn "could not install them automatically — run this yourself:"
        warn "  sudo pacman -S --needed ${MISSING[*]}"
      fi
    else
      warn "continuing without them — expect 'browser failed to launch' on first use"
    fi
  else
    ok "Camoufox runtime libraries present"
  fi

  # agent-capture's dependencies. Optional by design: skipping them costs you
  # screen capture, not the browser. Xvfb is the one that matters — without it
  # there is no headless capture path at all.
  CAP_MISSING=()
  mapfile -t CAP_MISSING < <(missing_capture_deps)
  if [ "${#CAP_MISSING[@]}" -gt 0 ]; then
    warn "agent-capture is missing: ${CAP_MISSING[*]}"
    case " ${CAP_MISSING[*]} " in
      *" xorg-server-xvfb "*) info "without xorg-server-xvfb there is NO headless screenshot/recording path" ;;
    esac
    if confirm "Install the screen-capture dependencies with pacman?"; then
      if pacman_install "${CAP_MISSING[@]}"; then
        ok "capture dependencies installed"
      else
        warn "could not install them automatically — run this yourself:"
        warn "  sudo pacman -S --needed ${CAP_MISSING[*]}"
        CAPTURE_HINT="sudo pacman -S --needed ${CAP_MISSING[*]}"
      fi
    else
      warn "skipped — 'agent-capture doctor' will show what is still missing"
      CAPTURE_HINT="sudo pacman -S --needed ${CAP_MISSING[*]}"
    fi
  else
    ok "screen-capture dependencies present"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Packages
# ---------------------------------------------------------------------------
log "Packages"
NPM_PREFIX="$(npm_prefix)"
info "npm prefix: $NPM_PREFIX"

install_global() {
  local pkg="$1" bin="$2"
  if have "$bin"; then
    ok "$bin already on PATH ($(command -v "$bin"))"
    return 0
  fi
  if is_arch && pacman -Qo "$(command -v "$bin" 2>/dev/null || echo /nonexistent)" >/dev/null 2>&1; then
    ok "$bin provided by a pacman package — leaving it alone"
    return 0
  fi
  info "installing $pkg (first run downloads the ~300MB Camoufox binary)"
  npm install -g --prefix "$NPM_PREFIX" "$pkg"
  ok "$pkg installed"
}

if [ "$MCP_ONLY" = "0" ]; then
  install_global "$CORE_PKG" "$CORE_BIN"
fi
install_global "$MCP_PKG" "$MCP_BIN"

export PATH="$NPM_PREFIX/bin:$PATH"
hash -r 2>/dev/null || true

MCP_BIN_PATH="$(command -v "$MCP_BIN" || true)"
[ -n "$MCP_BIN_PATH" ] || die "$MCP_BIN not found after install; is $NPM_PREFIX/bin on your PATH?"

if [ "$MCP_ONLY" = "0" ]; then
  CORE_BIN_PATH="$(command -v "$CORE_BIN" || true)"
  [ -n "$CORE_BIN_PATH" ] || die "$CORE_BIN not found after install; is $NPM_PREFIX/bin on your PATH?"

  # The browser binary lives outside npm, in the user cache. The core package's
  # postinstall fetches it, but a pacman install or a skipped script leaves it out.
  if [ ! -d "$XDG_CACHE_HOME/camoufox/browsers" ] && [ ! -f "$XDG_CACHE_HOME/camoufox/version.json" ]; then
    info "Camoufox browser binary not in cache; fetching"
    npx --yes camoufox-js fetch || warn "fetch failed — run 'npx camoufox-js fetch' manually"
  fi
  ok "Camoufox binary cache: $XDG_CACHE_HOME/camoufox"
fi

case ":$PATH:" in
  *":$NPM_PREFIX/bin:"*) ;;
  *) warn "add $NPM_PREFIX/bin to your PATH in ~/.bashrc or ~/.zshrc" ;;
esac

# ---------------------------------------------------------------------------
# 3. Configuration
# ---------------------------------------------------------------------------
log "Configuration"
mkdir -p "$KIT_CONFIG_DIR"
chmod 700 "$KIT_CONFIG_DIR"

# set_env_kv KEY VALUE — upsert into the env file, keeping comments and order.
set_env_kv() {
  local key="$1" value="$2"
  if grep -qE "^#?${key}=" "$KIT_ENV_FILE" 2>/dev/null; then
    # Use | as the delimiter: values may contain / (URLs, paths).
    sed -i -E "s|^#?${key}=.*|${key}=${value}|" "$KIT_ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$KIT_ENV_FILE"
  fi
}

if [ -f "$KIT_ENV_FILE" ]; then
  ok "keeping existing $KIT_ENV_FILE"
else
  cp "$SCRIPT_DIR/systemd/camofox-browser.env.example" "$KIT_ENV_FILE"
  ok "wrote $KIT_ENV_FILE"
fi
chmod 600 "$KIT_ENV_FILE"

set_env_kv CAMOFOX_BIND_HOST "$BIND_HOST"
set_env_kv CAMOFOX_PORT "$PORT"
[ -n "$ACCESS_KEY" ] && set_env_kv CAMOFOX_ACCESS_KEY "$ACCESS_KEY"
[ -n "$API_KEY" ] && set_env_kv CAMOFOX_API_KEY "$API_KEY"
info "bind $BIND_HOST:$PORT"

if [ "$BIND_HOST" != "127.0.0.1" ] && [ "$BIND_HOST" != "localhost" ] && [ -z "$ACCESS_KEY" ]; then
  warn "binding to $BIND_HOST with no --access-key: anyone who can reach this port"
  warn "can drive your browser with your cookies. Set --access-key."
fi

# ---------------------------------------------------------------------------
# 4. Service
# ---------------------------------------------------------------------------
if [ "$DO_SERVICE" = "1" ]; then
  log "Service"
  mkdir -p "$KIT_UNIT_DIR"
  sed -e "s|__EXEC__|$CORE_BIN_PATH|g" \
      -e "s|__PATH__|$(node_bin_dir):$NPM_PREFIX/bin:/usr/local/bin:/usr/bin:/bin|g" \
      "$SCRIPT_DIR/systemd/$KIT_UNIT_NAME" > "$KIT_UNIT_FILE"
  ok "wrote $KIT_UNIT_FILE"

  systemctl --user daemon-reload
  systemctl --user enable "$KIT_UNIT_NAME" >/dev/null
  systemctl --user restart "$KIT_UNIT_NAME"
  ok "service enabled and started"

  if wait_for_health "$BASE_URL" 45; then
    ok "health check passed → $BASE_URL/health"
  else
    err "service did not become healthy within 45s"
    info "logs: journalctl --user -u $KIT_UNIT_NAME -n 50 --no-pager"
    exit 1
  fi

  # Without linger, the user manager is torn down on logout and the service dies
  # with it — surprising on a headless box or between tty sessions.
  if [ "$DO_LINGER" = "0" ]; then
    info "skipping the lingering check (--no-linger)"
  elif ! loginctl show-user "$(whoami)" -p Linger --value 2>/dev/null | grep -q yes; then
    info "the service stops when you log out unless user lingering is enabled"
    if confirm "Enable lingering so it survives logout? (sudo loginctl enable-linger)"; then
      sudo loginctl enable-linger "$(whoami)" && ok "lingering enabled"
    else
      info "skipped; enable later with: sudo loginctl enable-linger $(whoami)"
    fi
  else
    ok "user lingering already enabled"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Agent hosts
# ---------------------------------------------------------------------------
if [ "$DO_MCP" = "1" ]; then
  log "Agent hosts"
  REG_ARGS=(--bin "$MCP_BIN_PATH" --base-url "$BASE_URL")
  [ -n "$ACCESS_KEY" ] && REG_ARGS+=(--access-key "$ACCESS_KEY")
  [ -n "$API_KEY" ] && REG_ARGS+=(--api-key "$API_KEY")
  [ "$ALL_HOSTS" = "1" ] && REG_ARGS+=(--all)
  node "$SCRIPT_DIR/lib/register-mcp.mjs" "${REG_ARGS[@]}"
fi

# ---------------------------------------------------------------------------
# 6. Skills and subagents
# ---------------------------------------------------------------------------
if [ "$DO_SKILL" = "1" ]; then
  log "Agent skills"
  for skill_src in "$SCRIPT_DIR"/skills/*/SKILL.md; do
    [ -e "$skill_src" ] || continue
    skill_name="$(basename "$(dirname "$skill_src")")"
    skill_dest="$HOME/.claude/skills/$skill_name"
    mkdir -p "$skill_dest"
    # Placeholders let the installed copy name this machine's real endpoints
    # instead of telling agents to guess them.
    sed -e "s|__BASE_URL__|$BASE_URL|g" \
        -e "s|__UNIT__|$KIT_UNIT_NAME|g" \
        "$skill_src" > "$skill_dest/SKILL.md"
    ok "skill $skill_name → $skill_dest/SKILL.md"
  done

  # Subagent definitions. A delegated agent inherits none of the caller's
  # reasoning, so the tooling knowledge has to live in its own definition or it
  # will reach for Playwright like any uninformed agent would.
  if [ -d "$SCRIPT_DIR/agents" ]; then
    mkdir -p "$HOME/.claude/agents"
    for agent_src in "$SCRIPT_DIR"/agents/*.md; do
      [ -e "$agent_src" ] || continue
      install -Dm644 "$agent_src" "$HOME/.claude/agents/$(basename "$agent_src")"
      ok "subagent $(basename "$agent_src" .md) → ~/.claude/agents/"
    done
  fi
  info "other hosts: point their instruction file at AGENTS.md in this repo"
fi

# ---------------------------------------------------------------------------
# 7. Commands
# ---------------------------------------------------------------------------
log "Commands"
install -Dm755 "$SCRIPT_DIR/bin/camofox-doctor" "$HOME/.local/bin/camofox-doctor"
ok "camofox-doctor → ~/.local/bin/camofox-doctor"
install -Dm755 "$SCRIPT_DIR/bin/agent-capture" "$HOME/.local/bin/agent-capture"
ok "agent-capture → ~/.local/bin/agent-capture"
# Cross-platform containerised capture. Installed even without a container
# runtime present: `agent-studio doctor` is how the user finds out they need one.
install -Dm755 "$SCRIPT_DIR/bin/agent-studio" "$HOME/.local/bin/agent-studio"
ok "agent-studio → ~/.local/bin/agent-studio"
install -Dm755 "$SCRIPT_DIR/bin/camofox-import-cookies" "$HOME/.local/bin/camofox-import-cookies"
ok "camofox-import-cookies → ~/.local/bin/camofox-import-cookies"

# ---------------------------------------------------------------------------
# 8. Browser session import
# ---------------------------------------------------------------------------
# Without this, agents hit a login wall on nearly every site worth automating
# and the human has to log in again inside a browser they never see. With it,
# camofox starts every session holding the same cookies the human's browser
# holds.
if [ "$DO_COOKIES" = "1" ]; then
  log "Browser session"

  if ! have sqlite3; then
    warn "sqlite3 not found — the cookie importer needs it to read browser profiles"
    if is_arch && confirm "Install sqlite with pacman now?"; then
      pacman_install sqlite || warn "install it yourself: sudo pacman -S sqlite"
    fi
  fi

  if ! have sqlite3; then
    warn "skipping the cookie import until sqlite3 is available"
    COOKIE_HINT="sudo pacman -S sqlite && camofox-import-cookies"
  else
    FOUND_BROWSERS="$("$HOME/.local/bin/camofox-import-cookies" --list 2>/dev/null | tail -n +2 || true)"
    if [ -z "$FOUND_BROWSERS" ]; then
      info "no supported browser profile found — nothing to import"
      info "supported: Firefox, Zen, LibreWolf, Floorp, Waterfox, Chrome, Chromium, Brave, Edge, Vivaldi, Opera"
    else
      printf '%s\n' "$FOUND_BROWSERS" | while IFS= read -r line; do info "found $line"; done
      warn "this copies live session tokens into ~/.camofox/cookies/cookies.txt (mode 0600)."
      warn "anything that can drive camofox can then act as you on those sites."

      if confirm "Import your browser logins so agents start authenticated?"; then
        # Seed the config before the first run so a chosen --cookie-exclude also
        # applies to every later timer-driven refresh, not just this one.
        COOKIE_CONF="$KIT_CONFIG_DIR/cookie-import.conf"
        if [ ! -f "$COOKIE_CONF" ]; then
          cp "$SCRIPT_DIR/systemd/cookie-import.conf.example" "$COOKIE_CONF"
          ok "wrote $COOKIE_CONF"
        else
          ok "keeping existing $COOKIE_CONF"
        fi
        chmod 600 "$COOKIE_CONF"

        # Drop any existing definition (commented or live) and re-append.
        # Deliberately not sed -i: these values are regexes that routinely
        # contain the alternation bar, which would terminate any sed s|||
        # expression early and corrupt the config.
        set_conf_kv() {
          local key="$1" value="$2" tmp
          case "$value" in
            *"'"*) warn "$key contains a single quote; not written to the config"; return 1 ;;
          esac
          tmp="$(mktemp)"
          grep -vE "^#?${key}=" "$COOKIE_CONF" > "$tmp" 2>/dev/null || true
          printf "%s='%s'\n" "$key" "$value" >> "$tmp"
          cp "$tmp" "$COOKIE_CONF"
          rm -f "$tmp"
          chmod 600 "$COOKIE_CONF"
          ok "$key set in $(basename "$COOKIE_CONF")"
        }
        # shellcheck disable=SC2086
        [ -n "$COOKIE_BROWSERS" ] && set_conf_kv BROWSERS "$(echo $COOKIE_BROWSERS)"
        [ -n "$COOKIE_EXCLUDE" ] && set_conf_kv EXCLUDE_HOST_REGEX "$COOKIE_EXCLUDE"

        mkdir -p "$KIT_UNIT_DIR"
        install -Dm644 "$SCRIPT_DIR/systemd/camofox-import-cookies.service" \
          "$KIT_UNIT_DIR/camofox-import-cookies.service"
        install -Dm644 "$SCRIPT_DIR/systemd/camofox-import-cookies.timer" \
          "$KIT_UNIT_DIR/camofox-import-cookies.timer"
        systemctl --user daemon-reload

        # Import once now so the very next agent call is already authenticated,
        # then hand the refresh to the timer. Cookies rotate; a one-shot import
        # silently decays into logged-out sessions within days.
        if "$HOME/.local/bin/camofox-import-cookies"; then
          systemctl --user enable --now camofox-import-cookies.timer >/dev/null
          ok "cookies imported; refreshing every 10 minutes"
        else
          warn "the first import failed — the timer was not enabled"
          COOKIE_HINT="camofox-import-cookies --list"
        fi
      else
        info "skipped. Run 'camofox-import-cookies' any time to do it later."
      fi
    fi
  fi
fi

echo
printf '%s\n' "${C_GREEN}${C_BOLD}Done.${C_RESET}"
cat <<EOF

  REST server   $BASE_URL
  service       systemctl --user status $KIT_UNIT_NAME
  logs          journalctl --user -u $KIT_UNIT_NAME -f
  config        $KIT_ENV_FILE
  health check  camofox-doctor
  capture       agent-capture doctor
  browser login camofox-import-cookies --list

  Restart your agent CLI so it picks up the new MCP server, then confirm the
  11 camofox_* tools are listed (in Claude Code: /mcp).
EOF

if [ -n "$CAPTURE_HINT" ]; then
  echo
  warn "screen capture is incomplete. To finish it, run:"
  printf '    %s\n' "$CAPTURE_HINT"
  info "then verify with: agent-capture doctor"
fi

if [ -n "$COOKIE_HINT" ]; then
  echo
  warn "agents will hit login walls until the cookie import runs. To finish it:"
  printf '    %s\n' "$COOKIE_HINT"
fi
