#!/usr/bin/env bash
#
# agent-studio container entrypoint.
#
# Brings up a virtual display that belongs to this container alone, then runs
# one of a few verbs against it. Because the container has its own mount AND
# network namespace, the Xvfb here owns :0 without any possibility of colliding
# with the host's compositor — the whole reason this runs in a container.
#
set -euo pipefail

SCREEN="${SCREEN:-1920x1080}"
DEPTH="${DEPTH:-24}"
DISPLAY="${DISPLAY:-:0}"
FPS="${FPS:-25}"
OUT_DIR="${OUT_DIR:-/out}"
export DISPLAY

log()  { printf '\033[34m==>\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m  ✔\033[0m %s\n' "$*" >&2; }
bad()  { printf '\033[31m  ✘\033[0m %s\n' "$*" >&2; }
die()  { bad "$*"; exit 1; }

XVFB_PID=""
REC_PID=""
APP_PID=""
WM_PID=""
VNC_PID=""
NOVNC_PID=""

cleanup() {
  # SIGINT, never SIGKILL: ffmpeg has to write the container trailer or the mp4
  # is unplayable. Same for anything muxing on exit.
  [ -n "$REC_PID" ] && kill -0 "$REC_PID" 2>/dev/null && { kill -INT "$REC_PID" 2>/dev/null || true; wait "$REC_PID" 2>/dev/null || true; }
  [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null && kill -TERM "$APP_PID" 2>/dev/null || true
  for p in "$NOVNC_PID" "$VNC_PID" "$WM_PID" "$XVFB_PID"; do
    [ -n "$p" ] && kill -0 "$p" 2>/dev/null && kill -TERM "$p" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

start_display() {
  # -displayfd is deliberately NOT used. It exists to let the server hunt for a
  # free number, which is precisely the behaviour that hijacks a desktop's :0.
  # In here the namespace guarantees :0 is ours, so pin it explicitly.
  Xvfb "$DISPLAY" -screen 0 "${SCREEN}x${DEPTH}" -nolisten tcp -ac \
       +extension GLX +extension RANDR +extension RENDER \
       >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!

  local waited=0
  while [ ! -e "/tmp/.X11-unix/X${DISPLAY#:}" ] && [ "$waited" -lt 100 ]; do
    sleep 0.1; waited=$((waited + 1))
  done
  [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ] || { cat /tmp/xvfb.log >&2; die "Xvfb failed to start"; }
  # A headed session with no window manager has no maximise, no decorations and
  # no focus handling; dialogs land unmapped in a corner. openbox is ~2MB and
  # makes the recording look like a real desktop instead of a floating widget.
  if command -v openbox >/dev/null 2>&1; then
    openbox --sm-disable >/tmp/openbox.log 2>&1 &
    WM_PID=$!
    sleep 0.6
  fi

  # The root window defaults to black, which reads as "something failed" in a
  # recording. A flat neutral backdrop makes a windowed capture look deliberate
  # and gives the post-processing something sane to composite against.
  command -v xsetroot >/dev/null 2>&1 && xsetroot -solid "${BACKDROP:-#1e1e2e}" 2>/dev/null || true
  ok "virtual display $DISPLAY at ${SCREEN}x${DEPTH} (container-private)"

  # Optional live viewer. Never on by default: it opens a port, and the whole
  # point of this container is that nothing shows up uninvited.
  if [ "${ENABLE_VNC:-0}" = "1" ]; then start_vnc; fi
}

start_vnc() {
  command -v x11vnc >/dev/null 2>&1 || { bad "x11vnc not in image"; return 1; }
  x11vnc -display "$DISPLAY" -forever -shared -nopw -quiet \
         -rfbport "${VNC_PORT:-5900}" >/tmp/x11vnc.log 2>&1 &
  VNC_PID=$!
  if [ -d /usr/share/novnc ]; then
    websockify --web=/usr/share/novnc "${NOVNC_PORT:-6080}" "localhost:${VNC_PORT:-5900}" \
      >/tmp/novnc.log 2>&1 &
    NOVNC_PID=$!
    ok "live view: http://localhost:${NOVNC_PORT:-6080}/vnc.html (published port required)"
  else
    ok "VNC on :${VNC_PORT:-5900}"
  fi
}

# A capture that is one flat colour is a failed render wearing a success badge.
assert_not_blank() {
  local f="$1" sd
  sd="$(magick "$f" -colorspace Gray -format '%[fx:standard_deviation]' info: 2>/dev/null || echo 1)"
  awk -v v="$sd" 'BEGIN{exit !(v < 0.01)}' && { bad "$f is blank (std-dev $sd)"; return 1; }
  return 0
}

# A relative output path resolves against /work, which is inside the container
# and vanishes when it exits — the caller sees a cheerful "✔ wrote 220K" and an
# empty output directory. Anchor anything relative to the bind-mounted /out.
resolve_out() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *)  printf '%s\n' "$OUT_DIR/$1" ;;
  esac
}

# Openbox maps a window at whatever size the app asks for, which leaves a
# recording with an arbitrary border. Pin it: maximized fills the screen,
# windowed insets it evenly so the backdrop frames it on purpose.
place_window() {
  command -v xdotool >/dev/null 2>&1 || return 0
  local mode="${WINDOW_MODE:-maximized}" w h inset wid=""
  w="${SCREEN%x*}"; h="${SCREEN#*x}"

  # Match the BROWSER's class, never a wildcard. openbox creates dozens of
  # internal frame/decoration windows with no WM_CLASS at all; a `search --class
  # '.*' | tail -1` picks one of those, and resizing an openbox frame to
  # fullscreen leaves the capture showing nothing but the backdrop. Observed
  # exactly that: a 1440x900 screenshot of an empty desktop while Firefox was
  # running fine underneath.
  local attempt=0
  while [ "$attempt" -lt 40 ]; do
    wid="$(xdotool search --onlyvisible --class '(firefox|camoufox|Navigator)' 2>/dev/null | head -1)" || true
    [ -n "$wid" ] && break
    sleep 0.25
    attempt=$((attempt + 1))
  done
  # Placement is cosmetic. If the window never turns up, capture anyway rather
  # than failing the run over a nicety.
  [ -n "$wid" ] || { bad "no browser window to place (capturing as-is)"; return 0; }

  if [ "$mode" = "windowed" ]; then
    inset="${WINDOW_INSET:-48}"
    xdotool windowsize "$wid" $((w - inset * 2)) $((h - inset * 2)) 2>/dev/null || true
    xdotool windowmove "$wid" "$inset" "$inset" 2>/dev/null || true
  else
    xdotool windowsize "$wid" "$w" "$h" 2>/dev/null || true
    xdotool windowmove "$wid" 0 0 2>/dev/null || true
  fi
  xdotool windowactivate "$wid" 2>/dev/null || true
}

# Firefox's first-run chrome ruins a recording: a translation offer covers the
# page, an "operating system security" notification bar eats a strip of the
# viewport, and the privacy tab steals focus. Seed the profile so the capture
# shows the site instead of the browser talking about itself.
seed_profile() {
  local profile="$1"
  mkdir -p "$profile"
  cat > "$profile/user.js" <<'PREFS'
user_pref("browser.translations.automaticallyPopup", false);
user_pref("browser.translations.enable", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.firstRunURL", "");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.download.useDownloadDir", true);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.contentblocking.report.hide_vpn_banner", true);
user_pref("browser.privatebrowsing.vpnpromourl", "");
user_pref("extensions.update.enabled", false);
user_pref("app.update.auto", false);
PREFS
}

browser_cmd() {
  # Prefer the bundled Camoufox when the image was built with it; fall back to
  # the stock Firefox that is always present.
  local profile="$1"; shift
  if [ -x "${CAMOUFOX_HOME:-/opt/camoufox}/camoufox" ]; then
    printf '%s\n' "${CAMOUFOX_HOME}/camoufox" --no-remote --profile "$profile" "$@"
  else
    printf '%s\n' firefox-esr --no-remote --profile "$profile" "$@"
  fi
}

verb_doctor() {
  echo "agent-studio container"
  echo "  screen      ${SCREEN}x${DEPTH}"
  echo "  display     $DISPLAY"
  echo "  out         $OUT_DIR ($( [ -w "$OUT_DIR" ] && echo writable || echo 'NOT WRITABLE'))"
  echo "  user        $(id -un) uid=$(id -u)"
  for t in Xvfb ffmpeg xdotool xdpyinfo magick python3 firefox-esr; do
    printf '  %-12s %s\n' "$t" "$(command -v "$t" || echo MISSING)"
  done
  printf '  %-12s %s\n' camoufox "$( [ -x "${CAMOUFOX_HOME:-/opt/camoufox}/camoufox" ] && echo "${CAMOUFOX_HOME}/camoufox" || echo 'not bundled (stock firefox-esr will be used)')"
  python3 -c 'import PIL; print("  Pillow       " + PIL.__version__)'
  # Proof of isolation: the host's sockets must be invisible from in here.
  echo "  X sockets visible in this namespace: $(ls /tmp/.X11-unix/ 2>/dev/null | tr '\n' ' ')"
  start_display
  xdpyinfo | grep -E 'dimensions|number of screens' | sed 's/^/  /'
  ok "container is ready"
}

verb_shot() {
  local url="${1:?usage: shot <url> [outfile]}" out
  out="$(resolve_out "${2:-shot.png}")"
  local profile; profile="$(mktemp -d /tmp/prof.XXXXXX)"
  seed_profile "$profile"
  start_display
  mapfile -t cmd < <(browser_cmd "$profile" "$url")
  "${cmd[@]}" >/tmp/browser.log 2>&1 &
  APP_PID=$!
  place_window
  sleep "${SETTLE:-12}"
  ffmpeg -loglevel error -y -f x11grab -video_size "$SCREEN" -i "$DISPLAY" -frames:v 1 "$out"
  assert_not_blank "$out" || die "captured nothing — see /tmp/browser.log"
  ok "$out ($(du -h "$out" | cut -f1))"
}

verb_record() {
  local url="${1:?usage: record <url> [outfile] }" out
  out="$(resolve_out "${2:-recording.mp4}")"
  local secs="${DURATION:-20}"
  local profile; profile="$(mktemp -d /tmp/prof.XXXXXX)"
  seed_profile "$profile"
  start_display
  ffmpeg -loglevel warning -y -f x11grab -framerate "$FPS" -video_size "$SCREEN" -i "$DISPLAY" \
         -c:v libx264 -preset ultrafast -pix_fmt yuv420p -movflags +faststart "$out" \
         >/tmp/rec.log 2>&1 &
  REC_PID=$!
  sleep 1
  kill -0 "$REC_PID" 2>/dev/null || { cat /tmp/rec.log >&2; die "recorder died at startup"; }
  mapfile -t cmd < <(browser_cmd "$profile" "$url")
  "${cmd[@]}" >/tmp/browser.log 2>&1 &
  APP_PID=$!
  place_window
  sleep "$secs"
  kill -INT "$REC_PID" 2>/dev/null || true
  wait "$REC_PID" 2>/dev/null || true
  REC_PID=""
  [ -s "$out" ] || die "no video produced — see /tmp/rec.log"
  ok "$out ($(du -h "$out" | cut -f1), ${secs}s @ ${FPS}fps)"
}

# Hold a headed session open so an agent can drive it over time, rather than
# one-shot capture. Pairs with ENABLE_VNC=1 to watch what it is doing.
verb_serve() {
  local url="${1:-about:blank}"
  local profile; profile="$(mktemp -d /tmp/prof.XXXXXX)"
  seed_profile "$profile"
  start_display
  mapfile -t cmd < <(browser_cmd "$profile" "$url")
  "${cmd[@]}" >/tmp/browser.log 2>&1 &
  APP_PID=$!
  place_window
  ok "headed session running; Ctrl-C or docker stop to end it"
  wait "$APP_PID"
}

# Escape hatch: run any command against the container's display.
verb_exec() {
  start_display
  "$@"
}

case "${1:-doctor}" in
  doctor) shift; verb_doctor "$@" ;;
  shot)   shift; verb_shot "$@" ;;
  record) shift; verb_record "$@" ;;
  serve)  shift; verb_serve "$@" ;;
  exec)   shift; verb_exec "$@" ;;
  *)      die "unknown verb: $1 (doctor|shot|record|serve|exec)" ;;
esac
