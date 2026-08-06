---
name: agent-capture
description: Take screenshots and record video of a screen, including on machines with NO display at all (headless servers, CI, dev containers, SSH sessions). USE THIS whenever you need visual evidence of something outside a browser page — a desktop app, an Electron app, a TUI, a window, a full desktop, a demo recording, a GIF for a PR or issue, a before/after comparison, or a repro of a visual bug. Also use when a screenshot came back black or blank and you need to know why, or when you are about to tell a user "I can't take screenshots here" — you probably can.
---

# agent-capture

One command that works in three environments that normally need three different
tools:

| Environment | Screenshot | Video |
|---|---|---|
| Headed Wayland (Hyprland, Sway, GNOME) | `grim` | `wf-recorder` |
| Headed X11 / Xwayland | `ffmpeg x11grab` | `ffmpeg x11grab` |
| **No display at all** | virtual display (`Xvfb`) + `ffmpeg` | same |

`agent-capture` picks the backend. You do not.

**Check first, always:**

```bash
agent-capture doctor
```

It prints what works here and the exact `pacman -S` line for anything missing.
Run it before concluding that capture is impossible on a machine.

## For a browser page, use camofox instead

If the thing you want a picture of is a **web page**, use `camofox_screenshot`
or `camofox_snapshot` from the [camofox-browser](../camofox-browser/SKILL.md)
skill. It is faster, needs no display, and gives you element refs alongside the
image.

Reach for `agent-capture` when the target is *not* a page: a native app, a
terminal UI, a whole desktop, or a video of any of them.

## Screenshots

```bash
agent-capture shot                          # current screen → screenshot-<ts>.png
agent-capture shot -o docs/before.png       # explicit path
agent-capture shot --region                 # drag a region (Wayland, interactive)
```

Then **look at what you captured** with your image-capable read tool. Do not
report a screenshot as done without opening it.

`shot` exits non-zero if the result is a flat single-colour image, so a black
frame fails instead of silently passing as success.

## Recording

```bash
agent-capture rec start -o demo.mp4         # starts in the background
# ... do the thing ...
agent-capture rec stop                      # finalizes and prints the path
agent-capture rec status                    # is one running?
```

Only one recording at a time. `rec stop` sends SIGINT so the container trailer
gets written — never `kill -9` the recorder yourself, that leaves an unplayable
file.

```bash
agent-capture gif demo.mp4 -o demo.gif --width 800 --fps 10
```

GIF for anywhere a video will not play: GitHub issues, PR comments, markdown.

## Headless — the part that matters

On a box with no screen, `shot` and `rec` have nothing to grab. `run` creates a
throwaway virtual display, runs your command inside it, captures, and cleans up:

```bash
# screenshot a GUI app on a server with no monitor
agent-capture run --shot out.png -- firefox --new-window https://example.com

# record a whole session
agent-capture run --record demo.mp4 --size 1920x1080 -- ./my-electron-app

# keep the display up to interact with it further
agent-capture run --keep --size 1280x800 -- some-app
```

No compositor, no logged-in user, no physical screen required. This is the
answer to "there's no display on this machine".

Options: `--size WxH` (default 1280x800), `--settle N` seconds before the
screenshot (raise it when the app is slow to paint), `--fps N`, `--keep`.

## Gotchas that will waste your time

- **A black screenshot on a Wayland session.** Grabbing X11 `:0` under a Wayland
  compositor captures Xwayland's root window, not the composited desktop — you
  get black plus a cursor. Verified on Hyprland. Drop `--display` so `grim`
  handles it, or use `run` for a display you control. `agent-capture` warns and
  fails on this instead of handing you the black frame.
- **An empty screenshot from `run`.** The app had not painted yet. Raise
  `--settle 5`. Some apps also need a window manager; if a window never maps,
  install one (`openbox`, `i3`) and launch it inside the display first.
- **`Xvfb: command not found`.** `sudo pacman -S xorg-server-xvfb`. Without it
  there is no headless path at all — `doctor` says so plainly.
- **Video is 0 bytes.** The recorder died at startup. Read
  `$XDG_RUNTIME_DIR/agent-capture/rec.log`.
- **`--region` does nothing on X11.** It is Wayland-only (`slurp`). Crop
  afterwards with ImageMagick instead.
- **Synthetic clicks/typing.** `agent-capture` captures; it does not drive input.
  Inside a virtual display use `xdotool`; on headed Wayland use `wtype`. For web
  pages use camofox's `camofox_click` / `camofox_type` — far more reliable than
  synthetic input.

## Teaching this to a subagent

A subagent does not inherit your reasoning, only its own instructions. When you
delegate visual work, put the concrete commands in the prompt — do not assume
the subagent will discover them:

> Run `agent-capture doctor` first. On this machine there is no display, so use
> `agent-capture run --shot <file> -- <command>`; do not use `shot` directly.
> Open every PNG you produce and describe what you see. If a capture comes back
> flat/black, say so instead of reporting success.

For recurring browser + evidence work, delegate to the `web-operator` subagent
that ships with this kit — it already knows both this skill and camofox.

## Boundaries

- Screen captures can contain anything on screen: tokens, private messages,
  customer data. Save them under the project or a temp dir, never somewhere they
  get committed by accident, and say what a capture contains before sharing it.
- Recording a user's real desktop is a surveillance-shaped action. On a headed
  machine, ask before starting a recording of their screen. A virtual display you
  created with `run` is yours — no need to ask.
