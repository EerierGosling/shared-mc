# Notes for anyone (human or agent) working on this

## Shape of the thing

Two ways to play the same Minecraft server, chosen on the way in:

- **road trip** — everyone who picks it shares one bot, one character and one
  inventory, the way the project started. The page calls this *Collaborative*;
  `roadtrip` is still its id in the code, the socket protocol and the CSS.
- **solo** — that visitor gets a bot of their own.

The browser is a real client surface, not a video player: it receives world
state and renders it, and its input is replayed by whichever bot it drives.
`README.md` has the file-by-file map and the full socket protocol.

A browser gets nothing until it joins. The visitor names the server: `MC_HOST`
is only a placeholder and a fallback for a blank field, and sessions are
grouped by `host:port` (one road trip bot per server, rosters per server).
`src/server/sessions.js` vets the address and the mode (and, for solo, a name
and skin), `index.js` pings the address before spending a login, then `src/server/session.js` builds the bot,
controller, state pusher, inventory bridge and world views. **Both modes are
the same Session class** — the only differences are how many member sockets it
has and what it speaks through: one socket for solo, a socket.io room for the
road trip.

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
- **Held keys are OR-merged across a session's members, not last-write-wins**
  (`control.js`, `_applyEffective`). In road trip mode one person releasing W
  must not stop the bot while someone else still holds it. A solo session is
  the same merge over exactly one member, which is why one code path serves
  both modes — do not "simplify" it into a single held-key object.
- **Only solo visitors cost a login.** Road trip riders share one bot, so they
  are uncapped; solo bots are capped by the Minecraft server's own player
  limit. `sessions.js` pings the default server at startup (if `MC_HOST` is
  set) and lowers its cap to `max-players` minus `playerSlotsReserved`, never
  raising it; a server the visitor typed is pinged at join and refused when
  its player count is already at its max. Skipping that would let the page
  lock real players out.
- **A session's emitter is not always a socket.** Solo sessions speak through
  the member's socket; road trip sessions speak through `io.to(room)`. Anything
  taking that emitter must only ever call `.emit()` on it — `state.js`,
  `inventory.js` and `primitives.js` all rely on that. World views are the
  exception and stay per-member, since prismarine's WorldView tracks which
  chunks that particular client has been sent.
- **Destructive actions are budgeted per visitor** (`limits.js`). Dig, place,
  attack and drop each get an allowance per rolling window, and exceeding it
  emits `action:refused` rather than dropping the action. Keep it that way: a
  silent cap is indistinguishable from lag and gets reported as a bug.
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
- **Creative is granted by the Minecraft server, never asserted by us**
  (`creative.js`). Both halves are read back off the wire: `bot.game.gameMode`
  for the mode and the clientbound `abilities` flags for what it permits
  (`mayFly` 0x04, `instabuild` 0x08). The gate is protective, not cosmetic —
  probed against `mc.manitej.com`, sending the flying bit without `mayFly`
  bought about twelve blocks of climb and then
  `multiplayer.disconnect.flying`, which kills the whole session, not just the
  flight. mineflayer has no abilities plugin, so that packet is ours to read.
- **Flight overwrites velocity, it does not disable physics.** `bot.physicsEnabled
  = false` would skip `simulatePlayer` and let the bot drift through walls, so
  instead gravity is zeroed and `bot.entity.velocity` is rewritten on every
  `physicsTick` — prismarine-physics still resolves collisions, and rewriting
  each tick is what stops drag and leftover control acceleration accumulating.
  The movement keys are withheld from mineflayer for the duration
  (`control.js`, `FLIGHT_DRIVEN`) because `applyHeading` would otherwise
  accelerate against the override; sneak and sprint still go through, since the
  server wants those poses and they only scale the flight loop. The heading
  formula is `applyHeading`'s own, and is checked against it at eight yaws.
- **`bot.physics` is per bot**, so zeroing gravity for one session cannot reach
  another. Verified rather than assumed — `Physics()` returns a fresh object per
  `inject`.
- **Underwater is decided by the eye, not the body.** `state.js` sends
  `eyeInWater` from vanilla's `isEyeInFluid` rule (eye below the fluid
  surface of its block, with water above counting as full) rather than
  mineflayer's `isInWater`, which is true while wading and would fog the
  screen at knee depth. The browser keys the bubble row, the tiled
  `misc/underwater.png` film and the fog off it; the fog lives in `sky.js`
  because the sky dome has no fog term and has to be painted the fog colour
  by hand, and it is lifted around the minimap pass, which looks down from
  above the water. `oxygen` is mineflayer's air supply over 15, so the
  bubbles multiply it back before applying vanilla's ceil arithmetic.
- **Right click held is place-only.** The browser sends `action:use` once on
  press and then `{ repeat: true }` every 200 ms while held; the server treats
  repeats as "keep placing" and skips opening containers and using items, so a
  held button cannot reopen a chest or eat twice. Placement goes through
  `_placeBlockWithOptions` with the face point the ray hit (slabs, stairs and
  trapdoors orient from it) and `forceLook: 'ignore'`, because `placeBlock()`
  alone snaps the bot's head at the block and fights the mouse.
- **A dig is aborted the moment the crosshair leaves its block.** mineflayer
  would finish the one it started; `control.js` watches the target during
  the dig and calls `stopDigging()` so a sweep across a wall does not break
  blocks the player already moved off.
- **The bot's own view distance follows `VIEW_DISTANCE`.** mineflayer's
  default is 'far' and every bot decodes and holds every chunk it is sent,
  which with several solo bots up was most of the process's memory spent on
  terrain no browser is shown. `session.js` asks for the streamed radius
  plus one.
- **`compression()` only covers HTTP.** The socket has its own deflate
  (`perMessageDeflate` in `index.js`); the middleware is for the block-state
  JSON, the bundle and the 21 MB worker, which gzips to about 2 MB.
- **Touch controls are gated on `(pointer: coarse)`**, plus `?touch` on the URL
  to force them on a desktop for testing. They speak the same messages as the
  keyboard; a finger dragging the canvas owns the camera the way pointer lock
  does for a mouse (`ownsLook()` in `input.js`).
- **three.js layers do not isolate lights.** A light is collected whenever
  the *camera's* layers include it, then applied to every mesh drawn. The
  hand viewmodel once sat on layer 1 with its own two lights and they lit the
  whole world, blowing snow out to a flat sheet. Anything that needs its own
  lighting gets its own scene and a second `renderer.render()` pass
  (`hand.js`), which is also why `renderer.autoClear` is off in `index.js`.
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

**Creative mode (inventory + flight) is in, and gated.** The refusal path is
verified end to end against the live server: a solo bot asks to fly, is told no
in chat, and is still connected fifteen seconds later. The *granted* path is
covered by a stubbed suite (25 checks: heading against `applyHeading`, the
withheld keys, a withdrawn grant landing the bot, give/destroy slot choice,
budgets) but **has never run against a server that actually grants creative** —
`mc.manitej.com` does not. A non-op there gets `me help list msg tell w random
teammsg tm trigger` and nothing else, so `/gamemode` is not available; op the
bot and the creative UI appears by itself. Skipped deliberately: the 5-block
creative reach, because of the `REACH` clamp note above, and vanilla's hotbar
presets.

**Not verified: the HUD, visually.** It was built from the real texture
dimensions and confirmed by asset resolution, but nobody has looked at it in a
browser. Proportions and layering are arithmetic, not observation. Look at it
before trusting it. That now includes the XP bar, the damage blink and
low-health jitter on the hearts, the held-item name popup, the ping bars
in the player list and the touch buttons.

**prismarine-web-client has been mined.** It runs mineflayer *inside* the
browser over a TCP-over-websocket proxy, so most of it (lit HUD components
bound to the bot object, chat parsed off raw packets, the cursor calling
`bot.dig` directly, VR, the service worker) does not transplant. What did:
gzip and cache headers, vanilla placement and hold-to-place, dig retargeting,
wheel hotbar, chat history and `/`, the F3 toggle, ping bars, XP bar, heart
animations, sneak camera dip, touch controls. Its panorama title background
was tried and dropped: minecraft-assets ships those PNGs as 1x1 placeholders.

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
