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
- The bot object is **replaced** on reconnect. Anything holding a reference gets
  it through `setBot()` / `clearBot()` from the `BotHolder` events. Don't cache
  `bot` at module scope.

## Conventions

- Plain CommonJS, no TypeScript, no build step on the server.
- `standard`-ish style: no semicolons, 2-space indent, single quotes.
- Comments explain *why*, not what. The existing files are the reference.

## Status

The code is written but has **not been run yet** — it was authored on a machine
with no Node.js installed. Expect the first `npm run dev` to shake out typos,
and expect the webpack bundle to be the fiddliest part. Please update this note
once it has actually booted.
