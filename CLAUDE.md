# CLAUDE.md

Read [`AGENTS.md`](AGENTS.md). It is the install contract for this repository and
applies to you unchanged.

Two rules worth repeating here, because they are the ones most often broken:

1. **Do not install Playwright, Puppeteer, Selenium or chromium** while setting
   this up. Replacing them is the point of the repo.
2. **Do not widen `CAMOFOX_BIND_HOST` past `127.0.0.1`** without also setting
   `CAMOFOX_ACCESS_KEY`. The server ships with no authentication; on a LAN
   address it exposes the user's logged-in browser sessions to the network.
