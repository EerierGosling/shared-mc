# Notes for anyone (human or agent) working on this

## Shape of the thing

One mineflayer bot, many browsers, all driving it at once. The browser is a real
client surface, not a video player: it receives world state and renders it, and
its input is replayed by the bot. `README.md` has the file-by-file map and the
full socket protocol — read that first.

## Things that will bite you

- **Static route order in `src/server/index.js` is load-bearing.** prismarine-viewer
  ships its own `index.html` inside the same `public/` folder we need for
  `/textures`, `/blocksStates` and `/worker.js`. Our page is registered first and
  our bundle is served from `/dist/bundle.js` — never name it `index.js`, and
  never mount the viewer's public folder above our own routes.
- **Keep `three` pinned at 0.128.0.** That is what prismarine-viewer builds
  against; bumping it breaks the renderer in non-obvious ways.
- **The client bundle needs Node shims** (`buffer`, `process`, `perf_hooks`, …)
  because `Viewer` pulls in the prismarine chunk/block/entity stack. They live in
  `webpack.config.js` and `src/client/shims/`. Adding a prismarine dep to the
  client usually means adding another fallback.
- **Free-for-all input is an OR merge, not last-write-wins** (`control.js`,
  `_applyEffective`). Per-socket desired state, merged across clients, recomputed
  on disconnect. Do not "simplify" it into a single shared control object — one
  person releasing a key would stop everyone.
- **Mouse look is applied locally first, then sent.** Never make the camera wait
  for the server round trip. `src/client/index.js` ignores the server's yaw/pitch
  while this client holds pointer lock, otherwise it rides along.
- **Server-side decisions stay server-side.** Dig/use/attack use
  `bot.blockAtCursor()` / `bot.entityAtCursor()` rather than a raycast supplied by
  the browser, so the bot stays authoritative.
- **`canvas` is shimmed on the client and avoided on the server.**
  prismarine-viewer requires node-canvas from `entities.js` (nametag textures,
  which really do run in the browser) and `atlas.js` (server-only, reads PNGs off
  disk). The browser gets `src/client/shims/canvas.js` via a webpack fallback. The
  server dodges it by importing `prismarine-viewer/viewer/lib/worldView` directly
  instead of the `prismarine-viewer/viewer` barrel — the barrel pulls in `Viewer`
  → `entities` → node-canvas and all of three.js, none of which the server needs.
  Do not "tidy" that deep import back into the barrel; it crashes startup with
  `Cannot find module 'canvas'`.
- **`MC_VERSION` is not the asset version.** prismarine-viewer only ships assets
  for the last release of each major, so `1.20.4` resolves to `1.20.1` via
  `getVersion()`. Looking for `/textures/1.20.4.png` will 404 and mean nothing.
- **Never raycast from an unchecked bot position.** If `bot.entity.position`
  goes NaN, prismarine-world's RaycastIterator never terminates — it stops on
  `Math.min(tMax…) > maxDistance`, and every NaN comparison is false — so
  `world.raycast` spins forever and one `state.js` tick wedges the whole server
  at 100% CPU, serving nothing further. mineflayer's guard only checks that
  `entity.position` exists, not that its components are numbers. Go through
  `src/server/raycast.js`, never `bot.blockAtCursor()` / `bot.entityAtCursor()`
  directly.
- **A protocol mismatch shows up as NaN, not as an error.** Forcing `MC_VERSION`
  at a server running something newer (ViaVersion will happily let you in) can
  decode position packets into NaN. The symptom is a wedged server or a camera
  that renders nothing, never a clean "wrong version" message.
- The bot object is **replaced** on reconnect. Anything holding a reference gets
  it through `setBot()` / `clearBot()` from the `BotHolder` events. Don't cache
  `bot` at module scope.

## Conventions

- Plain CommonJS, no TypeScript, no build step on the server.
- `standard`-ish style: no semicolons, 2-space indent, single quotes.
- Comments explain *why*, not what. The existing files are the reference.

## Status

It boots. `npm run dev` builds the bundle and the server comes up: our page is
served at `/`, the bundle at `/dist/bundle.js`, and the viewer's `/worker.js`,
`/textures/*` and `/blocksStates/*` all resolve. Verified against a dead
Minecraft port, so the HTTP surface and the reconnect backoff are what was
exercised — the bot half has not yet been driven against a live server.

Node is installed via nvm (v20, matching the Dockerfile), so it is only on
`PATH` in an interactive shell. Scripts that shell out non-interactively need
`. "$NVM_DIR/nvm.sh"` first.

Getting there took two fixes, both recorded above: the `canvas` shim and the
`worldView` deep import.
