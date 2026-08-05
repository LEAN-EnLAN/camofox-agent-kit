#!/usr/bin/env bash
#
# camofox-agent-kit uninstaller
#
# Removes what install.sh added. Your config file and the ~1.3GB Camoufox binary
# cache are kept unless you pass --purge, because reinstalling otherwise means
# re-downloading the browser.
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ASSUME_YES=0
PURGE=0
KEEP_PACKAGES=0

usage() {
  cat <<'EOF'
Usage: ./uninstall.sh [options]

Options:
  -y, --yes            Assume yes for every prompt
      --purge          Also delete the config file and the Camoufox binary cache
      --keep-packages  Leave the npm global packages installed
  -h, --help           Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    --purge) PURGE=1 ;;
    --keep-packages) KEEP_PACKAGES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown option: $1"; echo; usage; exit 2 ;;
  esac
  shift
done
export ASSUME_YES

log "Service"
if [ -f "$KIT_UNIT_FILE" ]; then
  systemctl --user disable --now "$KIT_UNIT_NAME" >/dev/null 2>&1 || true
  rm -f "$KIT_UNIT_FILE"
  systemctl --user daemon-reload
  systemctl --user reset-failed "$KIT_UNIT_NAME" >/dev/null 2>&1 || true
  ok "service stopped and unit removed"
else
  info "no unit at $KIT_UNIT_FILE"
fi

log "Agent hosts"
if have node; then
  node "$SCRIPT_DIR/lib/register-mcp.mjs" --remove
else
  warn "node not found; remove the camofox-browser MCP entry from your host configs by hand"
fi

log "Agent skill"
SKILL_DEST="$HOME/.claude/skills/camofox-browser"
if [ -d "$SKILL_DEST" ]; then rm -rf "$SKILL_DEST"; ok "removed $SKILL_DEST"; else info "no skill installed"; fi
rm -f "$HOME/.local/bin/camofox-doctor" && ok "removed camofox-doctor"

if [ "$KEEP_PACKAGES" = "0" ]; then
  log "Packages"
  NPM_PREFIX="$(npm_prefix)"
  for pkg in "$CORE_PKG" "$MCP_PKG"; do
    if npm ls -g --prefix "$NPM_PREFIX" --depth 0 "$pkg" >/dev/null 2>&1; then
      npm uninstall -g --prefix "$NPM_PREFIX" "$pkg" >/dev/null 2>&1 && ok "uninstalled $pkg"
    else
      info "$pkg not installed under $NPM_PREFIX"
    fi
  done
  info "a pacman-installed camofox-browser is left alone; remove it with pacman"
fi

if [ "$PURGE" = "1" ]; then
  log "Purge"
  if confirm "Delete $KIT_CONFIG_DIR (config, including any keys)?"; then
    rm -rf "$KIT_CONFIG_DIR"; ok "config removed"
  fi
  if confirm "Delete $XDG_CACHE_HOME/camoufox (browser binary, ~1.3GB — reinstall re-downloads it)?"; then
    rm -rf "$XDG_CACHE_HOME/camoufox"; ok "binary cache removed"
  fi
  if confirm "Delete $HOME/.camofox (sessions, cookies, storage state)?"; then
    rm -rf "$HOME/.camofox"; ok "session data removed"
  fi
else
  info "kept: $KIT_CONFIG_DIR, $XDG_CACHE_HOME/camoufox, $HOME/.camofox (use --purge to remove)"
fi

echo
ok "Done. Restart your agent CLI so it drops the MCP server."
info "host config backups, if any: <config>.camofox-kit.bak"
