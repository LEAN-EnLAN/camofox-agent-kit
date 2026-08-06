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
ALL_HOSTS=0
MCP_ONLY=0

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
      --all-hosts        Write config for every known agent host, even ones
                         that are not installed
  -h, --help             Show this help

SECURITY
  camofox-browser defaults to an empty bind host, which makes it listen on
  every interface. This installer pins 127.0.0.1. If you widen --host, set
  --access-key too: an unauthenticated browser server on your LAN hands anyone
  your logged-in sessions.
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

echo
printf '%s\n' "${C_GREEN}${C_BOLD}Done.${C_RESET}"
cat <<EOF

  REST server   $BASE_URL
  service       systemctl --user status $KIT_UNIT_NAME
  logs          journalctl --user -u $KIT_UNIT_NAME -f
  config        $KIT_ENV_FILE
  health check  camofox-doctor
  capture       agent-capture doctor

  Restart your agent CLI so it picks up the new MCP server, then confirm the
  11 camofox_* tools are listed (in Claude Code: /mcp).
EOF

if [ -n "$CAPTURE_HINT" ]; then
  echo
  warn "screen capture is incomplete. To finish it, run:"
  printf '    %s\n' "$CAPTURE_HINT"
  info "then verify with: agent-capture doctor"
fi
