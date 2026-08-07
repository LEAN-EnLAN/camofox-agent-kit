# agent-studio — a self-contained browser + capture environment.
#
# WHY A CONTAINER AND NOT JUST Xvfb ON THE HOST
#
# An X display number is claimed in three places: the filesystem socket
# (/tmp/.X11-unix/X<n>), the lock file (/tmp/.X<n>-lock), and the Linux
# ABSTRACT-namespace socket (@/tmp/.X11-unix/X<n>). On a wlroots desktop,
# Xwayland is started with -listenfd and only ever holds the FILESYSTEM socket —
# the abstract one stays unclaimed. Any Xvfb probing for a free display can bind
# that abstract socket, decide :0 is available, and take the display out from
# under the compositor. Observed on the host this image was written for: every
# X11 client, GPU-accelerated apps and games included, silently switched from a
# 5120x1080 Xwayland to a 1280x720 software Xvfb.
#
# A container fixes this by construction: the mount namespace gives it a private
# /tmp, and the NETWORK namespace gives it a private abstract socket namespace.
# Inside here, Xvfb owns :0 and the host cannot even see it.
#
# CRITICAL: this only holds without --network=host. Abstract sockets are scoped
# to the network namespace, NOT the mount namespace — run this with host
# networking and the collision comes straight back. bin/agent-studio refuses to.
#
# The display size is fixed by SCREEN at run time, so recordings are identical
# regardless of what monitors the host has plugged in.

FROM debian:trixie-slim

ARG DEBIAN_FRONTEND=noninteractive

# Grouped into one layer on purpose: each RUN is a layer, and the apt lists are
# deleted in the same layer that creates them or they stay in the image forever.
RUN apt-get update && apt-get install -y --no-install-recommends \
      # virtual display + X utilities the capture pipeline queries
      xvfb x11-utils x11-xserver-utils xdotool \
      # A window manager. The browser maps its own window without one, but with
      # no WM there is no maximise, no decorations and no focus management, so
      # anything with a dialog or a second window renders wrong. openbox is the
      # cheapest thing that makes a HEADED session behave like a real desktop.
      openbox \
      # Opt-in live viewing of the container's display, so the session can be
      # watched on demand without ever appearing on the host's screen. Reached
      # through a browser, which is what makes it work identically on Windows
      # and macOS where there is no X server to point a native viewer at.
      x11vnc novnc websockify \
      # capture, encoding, GIF conversion
      ffmpeg \
      # programmatic image editing (crop / frame / annotate)
      python3 python3-pil python3-pil.imagetk \
      # the browser being demoed
      firefox-esr \
      # fonts: drawtext and Pillow both need a real TTF, and a browser with no
      # fonts renders tofu boxes that look like a broken page
      fonts-dejavu-core fonts-liberation2 fonts-noto-core fonts-noto-color-emoji \
      fontconfig \
      # misc
      ca-certificates curl jq tini imagemagick \
  && rm -rf /var/lib/apt/lists/*

# Optional: bundle the Camoufox anti-detection browser instead of relying on
# stock Firefox. Off by default because it pulls ~300MB; turn it on with
#   docker build --build-arg WITH_CAMOUFOX=1
ARG WITH_CAMOUFOX=0
RUN if [ "$WITH_CAMOUFOX" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends nodejs npm && \
      npm install -g camoufox-js && \
      HOME=/opt/camoufox npx --yes camoufox-js fetch && \
      apt-get purge -y npm && apt-get autoremove -y && \
      rm -rf /var/lib/apt/lists/* /root/.npm ; \
    fi
ENV CAMOUFOX_HOME=/opt/camoufox

# Run as an unprivileged user whose uid the host can align with --user, so
# artifacts written to the /out bind mount are owned by the caller and not root.
RUN useradd --create-home --uid 1000 --shell /bin/bash studio \
 && mkdir -p /out /work /opt/camoufox \
 && chown -R studio:studio /out /work /opt/camoufox

COPY --chown=studio:studio entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chown=studio:studio tools/ /opt/studio/tools/
RUN chmod +x /usr/local/bin/entrypoint.sh && \
    find /opt/studio/tools -type f \( -name '*.sh' -o -name 'agent-demo' \) -exec chmod +x {} + 2>/dev/null || true

USER studio
WORKDIR /work

# Defaults; every one is overridable with -e at run time.
ENV SCREEN=1920x1080 \
    DEPTH=24 \
    DISPLAY=:0 \
    FPS=25 \
    OUT_DIR=/out \
    MOZ_ENABLE_WAYLAND=0 \
    GDK_BACKEND=x11 \
    QT_QPA_PLATFORM=xcb

# tini reaps the zombie processes a browser leaves behind; without it PID 1 is a
# shell that never reaps and the container accumulates defunct children.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["doctor"]
