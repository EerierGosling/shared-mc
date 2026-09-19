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
  disk). The browser gets `src/client/shims/canvas.js` through `resolve.alias`,
  deliberately not `resolve.fallback`: a fallback only fires when resolution
  *fails*, so the day something installs `canvas` for real, node-canvas would be
  bundled into the browser build. The
  server dodges it by importing `prismarine-viewer/viewer/lib/worldView` directly
  instead of the `prismarine-viewer/viewer` barrel — the barrel pulls in `Viewer`
  → `entities` → node-canvas and all of three.js, none of which the server needs.
  Do not "tidy" that deep import back into the barrel; it crashes startup with
  `Cannot find module 'canvas'`.
- **The bundle must get `utils.web.js`, never `viewer/lib/utils.js`.** The Node
  build of that file takes `loadImage` from `node-canvas-webgl` via a
  `safeRequire` that returns `{}` when the native module is absent — so the
  symptom is not a build error but a blank canvas and
  `loadImage is not a function` at runtime. `webpack.config.js` swaps it with a
  `NormalModuleReplacementPlugin`, exactly as upstream's own web config does.
  Removing that plugin silently breaks rendering; it also happens to be what
  keeps the build warning-free.
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
- **Keep mineflayer current, and suspect packet field renames first.** 1.20.3
  repacked `entity_velocity` from flat `velocityX/Y/Z` into one `vec3i16`
  `velocity`. mineflayer 4.25 still read the old names, so every knockback
  produced `undefined / 8000` -> NaN velocity -> NaN position, and the vanilla
  server kicked the bot with `invalid_player_movement` the moment anything hit
  it. A stale field name does not throw; it quietly yields undefined.
- **The HUD is real game textures, not CSS lookalikes.** `minecraft-assets`
  ships the vanilla sprites and they are already served at `/assets`, so the
  hotbar, selection frame, hearts, drumsticks and crosshair are the actual
  files under `/assets/gui/sprites/hud/`. Every measurement in `index.html` is
  written as texture pixels times `--px`, vanilla's GUI scale, so the whole
  interface resizes from that one variable — keep new HUD work in those units
  rather than hardcoding px. Sprites need `image-rendering: pixelated`, and the
  pixel font needs antialiasing off, or both go soft.
- The bot object is **replaced** on reconnect. Anything holding a reference gets
  it through `setBot()` / `clearBot()` from the `BotHolder` events. Don't cache
  `bot` at module scope.

## Conventions

- Plain CommonJS, no TypeScript, no build step on the server.
- `standard`-ish style: no semicolons, 2-space indent, single quotes.
- Comments explain *why*, not what. The existing files are the reference.

## Toolchain

Node 22 via nvm, pinned in `.nvmrc`, so `nvm use` with no argument picks it up.
It is therefore only on `PATH` in an interactive shell — anything shelling out
non-interactively needs `. "$NVM_DIR/nvm.sh"` first, which is easy to trip over
in scripts and hooks.

v22 is a floor, not a taste: minecraft-protocol 1.68 declares `node >=22`.
`.npmrc` sets `engine-strict`, so an older runtime fails at install rather than
halfway through a session — this project genuinely spent one running on 20 with
nothing but a warning.

Install with `npm ci`, not `npm install`. The lockfile is committed and the
Dockerfile uses `ci` too. This is not pedantry: `npm install` is how the project
ended up on mineflayer 4.25 when `^4.20.1` had always permitted the 4.39 that
fixes the knockback kick, which cost an afternoon.

## Where things stand

It runs, and it has been driven against a live server rather than only a dead
port. Verified: the bundle builds warning-free; the server boots and serves `/`,
`/dist/bundle.js`, `/fonts/*` and `/assets/*`; the bot joins, streams ~121
chunks and thousands of entity updates to a browser; `targetBlock` comes back
with real block names, which is the proof the raycast reads loaded chunks rather
than walking off into nothing.

**Not verified: the HUD, visually.** It was built from the real texture
dimensions and confirmed by asset resolution, but nobody has looked at it in a
browser. Proportions and layering are arithmetic, not observation. Look at it
before trusting it.

**Open, and the best next lead:** `prismarine-viewer/public/worker.js` is 63 MB
and `new Viewer(renderer)` spawns four workers, each loading it — roughly 250 MB
to fetch and parse before a single chunk can mesh. If first render is slow,
blank, or the tab dies, start there. `WorldRenderer` takes a `numWorkers`
argument; `Viewer` just never passes it.

## Handoff notes

- **PR #1** carries the client render fix, the mineflayer upgrade and the HUD.
  It is `MERGEABLE / CLEAN` and fast-forwards. Nothing else is in flight.
- **Two people are working this repo and have already fixed the same bug twice
  independently** (the canvas shim, the `worldView` deep import). Before
  starting anything non-trivial, fetch and read what landed on `main` — it moved
  twice in a single afternoon, both times onto files already being edited here.
- **The Minecraft server is someone else's.** `mc.manitej.com` changed version
  underneath this project mid-session, from a 26.x build down to 1.20.4. When
  something breaks suddenly and the code did not change, ping the server and
  check its version before debugging anything else. `minecraft-protocol`'s
  `ping()` is the fastest way.
- **Debugging a wedged server:** `kill -USR1 <pid>` opens the inspector on a
  running process, and V8 services it even while the event loop is blocked, so a
  CPU profile and a `Debugger.pause` will still tell you where it is stuck. That
  is how the NaN raycast loop was found. Note that a JS `SIGTERM` handler cannot
  run in that state — a wedged process needs `SIGKILL`.
- **Commit style:** short conventional subject, body only terse conventional
  lines for other sub-changes, no narrative, and no AI attribution trailers.
