# shared-mc
Play Minecraft in the browser! Works with any offline mode servers, but also has an instance running at `mc.manitej.com` that you can join from a normal client.

Optional: 
- '~~collaborative~~ chaos mode; control the same player with as a bajillion other people at the same time
- grass touching mode; punch trees irl with motion-tracking and phone pairing

## Running it

```bash
cp .env.example .env      # point MC_HOST/MC_PORT at the server you want to be prefilled + your deepgram api key for voice to text
npm ci                   
npm run dev              
# open http://localhost:3000
```


### Environment

| Variable | Default | Meaning |
|---|---|---|
| `MC_HOST` / `MC_PORT` | `localhost` / `25565` | Minecraft server to join |
| `MC_VERSION` | `1.20.4` | must be in prismarine-viewer's 1.8.8–1.21.4 range |
| `MC_AUTH` | `offline` | or `microsoft` |
| `PORT` | `3000` | web server |
| `VIEW_DISTANCE` | `6` | chunk radius streamed per browser |
| `REACH` | `5` | block reach for dig/place/interact |
| `DEEPGRAM_API_KEY` | unset | enables the push-to-talk button on touch devices |
