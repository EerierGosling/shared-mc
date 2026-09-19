# shared-mc

A live Minecraft stream you can actually play, in a browser tab.

A [mineflayer](https://github.com/PrismarineJS/mineflayer) bot joins a real
Minecraft server. Its surroundings are streamed to the browser as **world state**
(chunks, entities, block updates) and rendered with three.js via
[prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer). Input in
the browser — movement, mouse look, mining, placing, inventory, chat — is sent
back and performed by the bot, so the world genuinely changes and every other
viewer (and any vanilla player on the server) sees it.

It is not a video feed. Nothing is encoded; the browser gets block data and draws
it, which is why it can raycast, highlight and interact locally.

**Control is free-for-all.** Everyone with the page open drives the same bot.
Held keys are merged with OR across clients, so one person letting go of `W`
doesn't stop the bot while someone else is still holding it.

## Running it

```bash
cp .env.example .env      # point MC_HOST/MC_PORT at your server
npm install
npm run dev               # builds the client bundle, then starts the server
# open http://localhost:3000
```

Needs Node 18+. The bot joins in **offline mode** by default, so the Minecraft
server must have `online-mode=false`. Set `MC_AUTH=microsoft` for a real account.

No Minecraft server handy? `docker compose up` brings up a vanilla 1.20.4 server
with online mode off, plus this app, in one go.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `MC_HOST` / `MC_PORT` | `localhost` / `25565` | Minecraft server to join |
| `MC_VERSION` | `1.20.4` | must be in prismarine-viewer's 1.8.8–1.21.4 range |
| `MC_USERNAME` | `StreamBot` | the bot's name |
| `MC_AUTH` | `offline` | or `microsoft` |
| `PORT` | `3000` | web server |
| `VIEW_DISTANCE` | `6` | chunk radius streamed per browser |
| `REACH` | `5` | block reach for dig/place/interact |

## Controls

| | |
|---|---|
| click | capture the mouse (Esc releases) |
| `WASD` / `Space` / `Shift` / `Ctrl` | move / jump / sneak / sprint |
| left mouse | mine the block in the crosshair, or attack the entity in it |
| right mouse | use, place, or open the container in the crosshair |
| `1`–`9` | hotbar |
| `E` | inventory (and open containers) |
| `T` / `Enter` | chat |
| `Q` | drop held stack |
| `G` | pathfind to the block in the crosshair |

## How it fits together

```
Minecraft server ──▶ mineflayer bot ──▶ WorldView ──▶ socket.io ──▶ three.js Viewer
                          ▲                                              │
                          └────────────── control events ◀───────────────┘
```

`src/server/`

| file | job |
|---|---|
| `index.js` | express + socket.io, static asset wiring, ties everything together |
| `bot.js` | creates the bot, loads pathfinder, reconnects with backoff |
| `worldStream.js` | one `WorldView` per browser + the per-tick camera packet |
| `control.js` | input → bot actions, incl. the free-for-all key merge |
| `state.js` | 10 Hz HUD snapshot, pushed only when something changed |
| `inventory.js` | window open/close/click bridge |
| `primitives.js` | debug lines (currently the pathfinder route) |

`src/client/`

| file | job |
|---|---|
| `index.js` | renderer, `Viewer`, socket wiring, camera, render loop |
| `input.js` | pointer lock, keyboard, mouse, local look prediction |
| `hud.js` | crosshair, hotbar, vitals, chat, stats |
| `inventory.js` | inventory / container overlay |

### Socket protocol

Browser → server: `input:state`, `input:look`, `action:dig`, `action:use`,
`action:attack`, `hotbar`, `drop`, `chat`, `goto`, `stop`, `inventory:get`,
`window:click`, `window:move`, `window:close`, `latency:ping`.

Server → browser: `version`, `position`, `state`, `chat`, `bot:status`,
`config`, `inventory`, `window:open`, `window:close`, `latency:pong`, plus
`loadChunk` / `unloadChunk` / `entity` / `blockUpdate` / `primitive` emitted by
prismarine-viewer's `WorldView` and consumed by `viewer.listen(socket)`.

## Known limits

- prismarine-viewer's rendering is coarse: no smooth lighting, shadows or sky,
  simplified entity models, no block entities. It reads as Minecraft, not as
  vanilla-quality Minecraft.
- One bot means one pair of eyes — every viewer shares the same camera.
- Each browser gets its own full chunk stream. A handful of viewers is fine;
  dozens would want a shared broadcast world view.
- **There is no auth on the control channel.** That is the point locally, but it
  must be addressed before this is exposed publicly.
