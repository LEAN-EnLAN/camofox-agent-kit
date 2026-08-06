#!/usr/bin/env bash
# Shared helpers for the camofox-agent-kit installer scripts.
# Sourced, never executed directly.

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

log()  { printf '%s==>%s %s\n' "$C_BLUE$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
info() { printf '%s   ·%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_YELLOW$C_BOLD" "$C_RESET" "$*" >&2; }
err()  { printf '%serr %s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }

# ---------------------------------------------------------------------------
# XDG paths
# ---------------------------------------------------------------------------
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

KIT_CONFIG_DIR="$XDG_CONFIG_HOME/camofox-browser"
KIT_ENV_FILE="$KIT_CONFIG_DIR/camofox-browser.env"
KIT_UNIT_DIR="$XDG_CONFIG_HOME/systemd/user"
KIT_UNIT_NAME="camofox-browser.service"
KIT_UNIT_FILE="$KIT_UNIT_DIR/$KIT_UNIT_NAME"

CORE_PKG="@askjo/camofox-browser"
MCP_PKG="@askjo/camofox-browser-mcp"
CORE_BIN="camofox-browser"
MCP_BIN="camofox-browser-mcp"
MCP_SERVER_NAME="camofox-browser"

# ---------------------------------------------------------------------------
# Environment probes
# ---------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

is_arch() { [ -f /etc/arch-release ] || have pacman; }

# systemd --user must be reachable; without it there is nothing to install into.
require_systemd_user() {
  have systemctl || die "systemctl not found. This kit installs a systemd user service."
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    die "no systemd user session (is DBUS_SESSION_BUS_ADDRESS set? are you in an ssh session without linger?)"
  fi
}

# Node >= 22 is a hard requirement of camofox-browser itself.
require_node() {
  have node || die "node not found. Install it first: sudo pacman -S nodejs npm"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 22 ] 2>/dev/null || die "node >= 22 required, found $(node -v)"
  have npm || die "npm not found. Install it first: sudo pacman -S npm"
}

# Absolute directory holding the active node binary. systemd user units get a
# minimal PATH that does NOT include nvm/fnm/volta shims, so the unit needs this
# injected explicitly or every `#!/usr/bin/env node` shebang fails to resolve.
node_bin_dir() { dirname "$(command -v node)"; }

# npm global prefix, falling back to a user-local prefix when the system one is
# not writable (the normal case on Arch, where /usr belongs to pacman).
npm_prefix() {
  local p
  p="$(npm prefix -g 2>/dev/null || true)"
  [ -n "$p" ] || p="/usr"
  if [ -w "$p/lib" ] || { [ ! -e "$p/lib" ] && [ -w "$p" ]; }; then
    printf '%s\n' "$p"
  else
    printf '%s\n' "$HOME/.local"
  fi
}

# Shared-library dependencies of the Camoufox (Firefox) binary. Missing these
# produces an opaque "browser failed to launch" at the first tab, not at install.
ARCH_RUNTIME_DEPS=(gtk3 alsa-lib nss nspr libxtst libxcomposite libxfixes libxrandr libxrender libxcursor libxi dbus-glib)

# Packages that make agent-capture work. Split from ARCH_RUNTIME_DEPS because
# these are about capturing a screen, not about launching the browser — a box
# that only needs headless page screenshots does not need any of them.
#   xorg-server-xvfb  the virtual display; without it there is NO headless capture
#   ffmpeg            records any X display, and converts to GIF
#   grim/slurp        Wayland screenshots and region select
#   wf-recorder       Wayland video
#   xdotool           synthetic input inside a virtual display
#   imagemagick       crop/annotate, and the blank-image check
#   xorg-xdpyinfo     display geometry (ffmpeg needs an explicit -video_size)
CAPTURE_DEPS=(xorg-server-xvfb ffmpeg grim slurp wf-recorder xdotool imagemagick xorg-xdpyinfo)

missing_capture_deps() {
  local missing=() p
  for p in "${CAPTURE_DEPS[@]}"; do
    pacman -Q "$p" >/dev/null 2>&1 || missing+=("$p")
  done
  [ "${#missing[@]}" -eq 0 ] && return 0
  printf '%s\n' "${missing[@]}"
}

missing_arch_deps() {
  local missing=() p
  for p in "${ARCH_RUNTIME_DEPS[@]}"; do
    pacman -Q "$p" >/dev/null 2>&1 || missing+=("$p")
  done
  # Print nothing at all when complete, so callers can use a plain line count.
  [ "${#missing[@]}" -eq 0 ] && return 0
  printf '%s\n' "${missing[@]}"
}

# pacman_install <pkg>... — install without ever aborting the caller.
# sudo may need a password that a non-interactive run cannot supply; that is a
# step the user can finish in one command, not a reason to abandon the install.
pacman_install() {
  [ $# -gt 0 ] || return 0
  if [ "$(id -u)" = "0" ]; then
    pacman -S --needed --noconfirm "$@" && return 0
    return 1
  fi
  have sudo || { warn "sudo not found"; return 1; }
  if sudo -n true 2>/dev/null; then
    sudo pacman -S --needed --noconfirm "$@" && return 0
    return 1
  fi
  if [ -t 0 ]; then
    sudo pacman -S --needed "$@" && return 0
    return 1
  fi
  warn "sudo needs a password and this shell is not interactive"
  return 1
}

# ---------------------------------------------------------------------------
# Interaction
# ---------------------------------------------------------------------------
# confirm <prompt> — honours ASSUME_YES and non-interactive stdin.
confirm() {
  if [ "${ASSUME_YES:-0}" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then
    warn "non-interactive shell and --yes not given; assuming NO for: $1"
    return 1
  fi
  local reply
  printf '%s%s%s [y/N] ' "$C_BOLD" "$1" "$C_RESET"
  read -r reply
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
# wait_for_health <base_url> <timeout_seconds>
wait_for_health() {
  local url="$1" timeout="${2:-45}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if curl -fsS --max-time 3 "$url/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}
