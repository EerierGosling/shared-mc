'use strict'
const fs = require('fs')
const path = require('path')
const http = require('http')
const express = require('express')
const compression = require('compression')
const { Server } = require('socket.io')

const config = require('./config')
const Sessions = require('./sessions')
const { MotionPairing } = require('./motion-pairing')
const { Speech } = require('./speech')
const Load = require('./load')
const metrics = require('./metrics')
const { precompress, precompressed } = require('./static')

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  // The browser sends nothing bigger than a quarter second of Opus (speech.js
  // drops anything over 64 KB); the default 1 MB is plenty and a larger
  // allowance is just memory a stranger can make us hold.
  maxHttpBufferSize: 1e5,
  // Chunk JSON compresses ~10x and each viewer downloads the whole view
  // distance on connect. The threshold keeps the 20Hz position/state
  // stream out of zlib.
  perMessageDeflate: { threshold: 16384 }
})

// --- static assets ---------------------------------------------------------
// Order matters. prismarine-viewer ships its own index.html in the same public
// folder we need for /textures, /blocksStates and /worker.js, so our page is
// registered first and our bundle lives under /dist to avoid any collision.
const clientDir = path.join(__dirname, '..', 'client')
const distDir = path.join(__dirname, '..', '..', 'dist')
const viewerPublic = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public')

// The bundles and the block atlas JSON are compressed once, at build or at
// boot, and served as .br/.gz siblings (static.js). This middleware is only
// for what is left: the page itself and whatever the viewer's folder holds
// that nobody precompressed. It skips responses already carrying an encoding.
app.use(compression())

// Everything under a version or package number is immutable for as long as
// that number holds, so browsers may keep it. The bundles carry a content
// hash in their names, so they can be kept for good.
const CACHED = { maxAge: '1d' }
const FOREVER = { maxAge: '1y', immutable: true }

// The built bundle names, with their hashes, found rather than configured so
// a rebuild needs no restart of anything but the page. Missing bundles are a
// build problem and are reported as such rather than guessed around.
function findBundle (prefix) {
  let names = []
  try { names = fs.readdirSync(distDir) } catch (err) { /* no build yet */ }
  const match = names.find(n => new RegExp(`^${prefix}\\.[0-9a-f]+\\.js$`).test(n)) || names.find(n => n === `${prefix}.js`)
  if (!match) console.warn(`dist/${prefix}.*.js not found; run npm run build`)
  return match ? `/dist/${match}` : `/dist/${prefix}.js`
}
const assets = { bundle: findBundle('bundle'), worker: findBundle('worker'), controller: findBundle('controller') }
// The page names the hashed bundle and hands the worker's name to it.
const page = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf8')
  .replace('<script src="/dist/bundle.js"></script>',
    `<script>window.__ASSETS__ = ${JSON.stringify(assets)}</script>\n  <script src="${assets.bundle}"></script>`)

app.get(['/', '/index.html'], (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.set('Cache-Control', 'no-cache')
  res.send(page)
})
const controllerPage = fs.readFileSync(path.join(clientDir, 'controller.html'), 'utf8')
  .replace('/dist/controller.js', assets.controller)
app.get(['/controller', '/p'], (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.set('Cache-Control', 'no-cache')
  res.send(controllerPage)
})
for (const sheet of ['ui.css', 'motion.css']) app.get(`/${sheet}`, (req, res) => res.sendFile(path.join(clientDir, sheet)))
app.use('/dist', precompressed(distDir, FOREVER))
app.use('/fonts', express.static(path.join(clientDir, 'fonts'), { maxAge: '7d' }))
// The title screen's backdrop; minecraft-assets ships the panorama as 1x1s.
app.use('/title', express.static(path.join(clientDir, 'title'), { maxAge: '7d' }))

// prismarine-viewer only ships atlases for some versions (…, 1.20.1, 1.21.1,
// …). Rounding DOWN to the previous atlas loses every block added since —
// 1.20.4 (pack format 22) rendered with 1.20.1 (format 15) has no
// short_grass and friends. The next atlas UP is a name superset (verified:
// all 1058 blocks of 1.20.4 exist in the 1.21.1 states), so serve that one
// under our version's URLs. The browser worker still decodes chunks with the
// real version, so block state ids stay correct.
const { getVersion, supportedVersions } = require('prismarine-viewer/viewer/lib/version')
const assetVersion = pickAssetVersion(config.mc.version)
if (!assetVersion) {
  console.warn(`no viewer atlas at or above ${config.mc.version}; the browser render will be broken until prismarine-viewer ships one`)
}
if (assetVersion && assetVersion !== config.mc.version) {
  console.log(`viewer assets: serving ${assetVersion} atlas as ${config.mc.version}`)
  app.get(`/textures/${config.mc.version}.png`, (req, res) =>
    res.sendFile(path.join(viewerPublic, 'textures', `${assetVersion}.png`), CACHED))
  app.use(`/textures/${config.mc.version}`, express.static(path.join(viewerPublic, 'textures', assetVersion), CACHED))
}

// The block states JSON is 11 MB that every visitor fetches once. It is
// copied under our version's name into dist/ and compressed there at boot,
// off the main thread; until that finishes requests fall through to the
// viewer's own copy and the gzip middleware above.
if (assetVersion) {
  const statesDir = path.join(distDir, 'blocksStates')
  const ours = path.join(statesDir, `${config.mc.version}.json`)
  const theirs = path.join(viewerPublic, 'blocksStates', `${assetVersion}.json`)
  app.use('/blocksStates', precompressed(statesDir, CACHED))
  fs.promises.mkdir(statesDir, { recursive: true })
    .then(() => fs.promises.copyFile(theirs, ours))
    .then(() => precompress(ours))
    .then(() => console.log(`blocksStates/${config.mc.version}.json precompressed`))
    .catch(err => console.warn(`could not precompress block states: ${err.message}`))
}

app.use(express.static(viewerPublic, CACHED))

function pickAssetVersion (version) {
  if (supportedVersions.includes(version)) return version
  const parse = v => v.split('.').map(n => parseInt(n, 10) || 0)
  const cmp = (a, b) => a[0] - b[0] || (a[1] || 0) - (b[1] || 0) || (a[2] || 0) - (b[2] || 0)
  const above = supportedVersions
    .filter(v => cmp(parse(v), parse(version)) > 0)
    .sort((a, b) => cmp(parse(a), parse(b)))
  return above[0] || getVersion(version)
}

// HUD sprites and the player skins the join screen offers. Optional: without
// an asset pack the HUD chrome just goes missing.
try {
  const mcAssets = require('minecraft-assets')(config.mc.version)
  if (mcAssets && mcAssets.directory) app.use('/assets', express.static(mcAssets.directory, CACHED))
} catch (err) {
  console.warn(`no minecraft-assets for ${config.mc.version}; HUD sprites will 404`)
}

// Item icons, classified and served out of the same asset set as the atlas —
// minecraft-assets' loose texture folders are too incomplete to guess from
// (see src/server/icons.js).
if (assetVersion) require('./icons')(app, viewerPublic, assetVersion)

// --- wiring ----------------------------------------------------------------
// Two ways to play: ride the shared bot with everyone else, or drive one of
// your own. Sessions owns both; nothing crosses between them but the roster.
const load = new Load(config.load)
const sessions = new Sessions(config, io, load)
const motionPairing = new MotionPairing(id => sessions.modeBySocket.has(id))
const speech = new Speech({
  apiKey: config.speech.apiKey,
  playerFor: socket => sessions.modeBySocket.has(socket.id) ? socket : motionPairing.hostOf(socket.id),
  onTranscript: (socket, text) => sessions.say(socket, text)
})
metrics.install(app, sessions, io, load)

// Rosters are per server, so only the browsers on that server hear about a
// change there. The join screen shows live occupancy, so anyone still
// choosing sees the bot count move as they go.
function broadcastRoster (key) {
  if (key) io.to(Sessions.serverRoom(key)).emit('roster', sessions.roster(key))
  io.to(Sessions.LOBBY).emit('join:options', sessions.options())
}
sessions.onChange = key => broadcastRoster(key)

io.on('connection', socket => {
  motionPairing.register(socket)
  speech.register(socket)
  // No bot yet: the visitor picks a mode first, and only a vetted join creates
  // a login on the Minecraft server.
  socket.join(Sessions.LOBBY)
  socket.emit('join:options', sessions.options())

  let joining = false
  socket.on('join', async payload => {
    if (joining || sessions.modeBySocket.has(socket.id)) return // already playing
    // The address is the visitor's own, so it is pinged before a login is
    // spent: a typo would otherwise become a bot retrying nothing, forever,
    // with the browser stuck on "reconnecting".
    joining = true
    let result
    try {
      result = await sessions.tryJoin(socket, payload)
    } finally {
      joining = false
    }
    if (!socket.connected) return
    if (!result.ok) {
      socket.emit('join:rejected', { reason: result.reason })
      return
    }
    const { mode, identity, server } = result
    socket.emit('join:accepted', { mode, server, ...identity })
    console.log(`${identity.username} joined ${mode} on ${server.host}:${server.port} (${sessions.botCount}/${sessions.capacity} bots, ${sessions.roadtripRiders} riding)`)
    broadcastRoster(`${server.host}:${server.port}`)
  })

  socket.on('latency:ping', sentAt => socket.emit('latency:pong', sentAt))

  socket.on('disconnect', () => {
    const key = sessions.serverBySocket.get(socket.id)
    const left = sessions.leave(socket)
    if (left) {
      console.log(`a ${left.mode} visitor left (${sessions.botCount}/${sessions.capacity} bots, ${sessions.roadtripRiders} riding)`)
      broadcastRoster(key)
    }
  })
})

// The default server, if there is one, is worth a look at boot: it warms the
// ping cache and puts its player limit in the log next to our own ceiling.
if (config.mc.host) {
  sessions.checkRoom({ host: config.mc.host, port: config.mc.port }).then(room => {
    if (!room.ok) console.warn(`${config.mc.host}: ${room.reason}; capacity here is ${sessions.capacity} bots`)
    else console.log(`${config.mc.host} has ${room.online}/${room.max} players; capacity here is ${sessions.capacity} bots`)
  })
} else {
  console.log(`no MC_HOST set; visitors choose a server (capacity ${sessions.capacity} bots)`)
}

server.listen(config.web.port, () => {
  console.log(`open http://localhost:${config.web.port}`)
})

const shutdown = () => {
  console.log('shutting down')
  motionPairing.destroy()
  sessions.destroyAll()
  load.stop()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
