'use strict'
const path = require('path')
const http = require('http')
const express = require('express')
const compression = require('compression')
const { Server } = require('socket.io')
const mc = require('minecraft-protocol')

const config = require('./config')
const Sessions = require('./sessions')

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  maxHttpBufferSize: 1e8,
  // Chunk JSON compresses ~10x and each viewer downloads the whole view
  // distance on connect. The threshold keeps the 20Hz position/state
  // stream out of zlib.
  perMessageDeflate: { threshold: 16384 }
})

// --- static assets ---------------------------------------------------------
// Gzip everything text-shaped before any route sees the response: the two
// webpack bundles are a couple of MB of javascript each and the blocksStates
// JSON runs to megabytes, all of which compress several-fold. PNGs are
// skipped automatically (already compressed) and socket.io traffic has its
// own perMessageDeflate.
app.use(compression())

// Order matters. prismarine-viewer ships its own index.html in the same public
// folder we need for /textures, /blocksStates and /worker.js, so our page is
// registered first and our bundle lives under /dist to avoid any collision.
const clientDir = path.join(__dirname, '..', 'client')
const distDir = path.join(__dirname, '..', '..', 'dist')
const viewerPublic = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public')

// gzip for everything below. The block atlas JSON and the client bundle are
// megabytes of highly repetitive text and shrink several times over; the
// socket has its own deflate and is untouched by this.
app.use(compression())

// Everything under a version or package number is immutable for as long as
// that number holds, so browsers may keep it; the bundle changes on every
// build and stays on plain ETag revalidation.
const CACHED = { maxAge: '1d' }

app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(clientDir, 'index.html')))
app.use('/dist', express.static(distDir))
app.use('/fonts', express.static(path.join(clientDir, 'fonts'), { maxAge: '7d' }))

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
  app.get(`/blocksStates/${config.mc.version}.json`, (req, res) =>
    res.sendFile(path.join(viewerPublic, 'blocksStates', `${assetVersion}.json`), CACHED))
  app.use(`/textures/${config.mc.version}`, express.static(path.join(viewerPublic, 'textures', assetVersion), CACHED))
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
  const assets = require('minecraft-assets')(config.mc.version)
  if (assets && assets.directory) app.use('/assets', express.static(assets.directory, CACHED))
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
const sessions = new Sessions(config, io)
sessions.onChange = () => broadcastRoster()

function broadcastRoster () {
  io.emit('roster', sessions.roster())
  // The join screen shows live occupancy, so anyone still choosing sees the
  // solo slots fill up as they go.
  io.emit('join:options', sessions.options())
}

io.on('connection', socket => {
  // No bot yet: the visitor picks a mode first, and only a vetted join creates
  // a login on the Minecraft server.
  socket.emit('join:options', sessions.options())

  socket.on('join', payload => {
    if (sessions.modeBySocket.has(socket.id)) return // already playing
    const vetted = sessions.vet(payload)
    if (!vetted.ok) {
      socket.emit('join:rejected', { reason: vetted.reason })
      return
    }
    sessions.join(socket, vetted.mode, vetted.identity)
    socket.emit('join:accepted', { mode: vetted.mode, ...vetted.identity })
    console.log(`${vetted.identity.username} joined ${vetted.mode} (${sessions.botCount}/${sessions.capacity} bots, ${sessions.roadtripRiders} riding)`)
    broadcastRoster()
  })

  socket.on('latency:ping', sentAt => socket.emit('latency:pong', sentAt))

  socket.on('disconnect', () => {
    const left = sessions.leave(socket)
    if (left) {
      console.log(`a ${left.mode} visitor left (${sessions.botCount}/${sessions.capacity} bots, ${sessions.roadtripRiders} riding)`)
      broadcastRoster()
    }
  })
})

// Solo visitors each cost a real login, so the Minecraft server's own player
// cap is the ceiling. Ask it rather than guessing; on failure keep the
// configured cap.
mc.ping({ host: config.mc.host, port: config.mc.port }, (err, result) => {
  if (err || !result || !result.players) {
    console.warn(`could not read max-players (${err ? err.message : 'no response'}); capacity stays ${sessions.capacity}`)
    return
  }
  sessions.applyServerCapacity(result.players.max)
  console.log(`server allows ${result.players.max} players; capacity ${sessions.capacity}`)
})

server.listen(config.web.port, () => {
  console.log(`open http://localhost:${config.web.port}`)
})

const shutdown = () => {
  console.log('shutting down')
  sessions.destroyAll()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
