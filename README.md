# shared-mc
Minecraft in the browser!

## Running it

```bash
cp .env.example .env      # point MC_HOST/MC_PORT at your server
npm ci                    # npm install instead would drift off the lockfile
npm run dev               # builds the client bundle, then starts the server
# open http://localhost:3000
```


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
