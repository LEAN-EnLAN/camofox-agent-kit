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

cleanup() {
  # SIGINT, never SIGKILL: ffmpeg has to write the container trailer or the mp4
  # is unplayable. Same for anything muxing on exit.
  [ -n "$REC_PID" ] && kill -0 "$REC_PID" 2>/dev/null && { kill -INT "$REC_PID" 2>/dev/null || true; wait "$REC_PID" 2>/dev/null || true; }
  [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null && kill -TERM "$APP_PID" 2>/dev/null || true
  [ -n "$XVFB_PID" ] && kill -0 "$XVFB_PID" 2>/dev/null && kill -TERM "$XVFB_PID" 2>/dev/null || true
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
  ok "virtual display $DISPLAY at ${SCREEN}x${DEPTH} (container-private)"
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
  start_display
  mapfile -t cmd < <(browser_cmd "$profile" "$url")
  "${cmd[@]}" >/tmp/browser.log 2>&1 &
  APP_PID=$!
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
  sleep "$secs"
  kill -INT "$REC_PID" 2>/dev/null || true
  wait "$REC_PID" 2>/dev/null || true
  REC_PID=""
  [ -s "$out" ] || die "no video produced — see /tmp/rec.log"
  ok "$out ($(du -h "$out" | cut -f1), ${secs}s @ ${FPS}fps)"
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
  exec)   shift; verb_exec "$@" ;;
  *)      die "unknown verb: $1 (doctor|shot|record|exec)" ;;
esac
