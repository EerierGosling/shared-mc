'use strict'
const path = require('path')
const http = require('http')
const express = require('express')
const { Server } = require('socket.io')

const config = require('./config')
const BotHolder = require('./bot')
const Controller = require('./control')
const Primitives = require('./primitives')
const StatePusher = require('./state')
const MinimapPusher = require('./minimap')
const InventoryBridge = require('./inventory')
const { attachWorldView } = require('./worldStream')

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
// Order matters. prismarine-viewer ships its own index.html in the same public
// folder we need for /textures, /blocksStates and /worker.js, so our page is
// registered first and our bundle lives under /dist to avoid any collision.
const clientDir = path.join(__dirname, '..', 'client')
const distDir = path.join(__dirname, '..', '..', 'dist')
const viewerPublic = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public')

app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(clientDir, 'index.html')))
app.use('/dist', express.static(distDir))
app.use('/fonts', express.static(path.join(clientDir, 'fonts')))

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
    res.sendFile(path.join(viewerPublic, 'textures', `${assetVersion}.png`)))
  app.get(`/blocksStates/${config.mc.version}.json`, (req, res) =>
    res.sendFile(path.join(viewerPublic, 'blocksStates', `${assetVersion}.json`)))
  app.use(`/textures/${config.mc.version}`, express.static(path.join(viewerPublic, 'textures', assetVersion)))
}

app.use(express.static(viewerPublic))

function pickAssetVersion (version) {
  if (supportedVersions.includes(version)) return version
  const parse = v => v.split('.').map(n => parseInt(n, 10) || 0)
  const cmp = (a, b) => a[0] - b[0] || (a[1] || 0) - (b[1] || 0) || (a[2] || 0) - (b[2] || 0)
  const above = supportedVersions
    .filter(v => cmp(parse(v), parse(version)) > 0)
    .sort((a, b) => cmp(parse(a), parse(b)))
  return above[0] || getVersion(version)
}

// Item icons for the inventory overlay. Optional: if this version has no asset
// pack the UI falls back to text labels.
try {
  const assets = require('minecraft-assets')(config.mc.version)
  if (assets && assets.directory) app.use('/assets', express.static(assets.directory))
} catch (err) {
  console.warn(`no minecraft-assets for ${config.mc.version}; inventory will use text labels`)
}

// --- wiring ----------------------------------------------------------------
const primitives = new Primitives(io)
const controller = new Controller(config, primitives, io)
const statePusher = new StatePusher(io, config)
const minimapPusher = new MinimapPusher(io)
const inventory = new InventoryBridge(io)
const holder = new BotHolder(config.mc)

const clients = new Map() // socket.id -> { socket, detach }
let status = { state: 'connecting', message: 'connecting to the Minecraft server' }

function setStatus (state, message) {
  status = { state, message }
  io.emit('bot:status', status)
}

function attach (socket) {
  const client = clients.get(socket.id)
  if (!client || client.detach || !holder.ready) return
  client.detach = attachWorldView(holder.bot, socket, config.viewDistance)
}

function detach (client) {
  if (!client || !client.detach) return
  client.detach()
  client.detach = null
}

io.on('connection', socket => {
  clients.set(socket.id, { socket, detach: null })
  console.log(`browser connected (${clients.size} viewing)`)

  socket.emit('bot:status', status)
  socket.emit('config', { reach: config.reach, viewDistance: config.viewDistance })
  controller.register(socket)
  inventory.register(socket)
  primitives.sendAll(socket)
  minimapPusher.sendTo(socket)
  attach(socket)

  socket.on('latency:ping', sentAt => socket.emit('latency:pong', sentAt))

  socket.on('disconnect', () => {
    detach(clients.get(socket.id))
    clients.delete(socket.id)
    controller.dropSocket(socket.id)
    console.log(`browser disconnected (${clients.size} viewing)`)
  })
})

holder.on('log', message => console.log(`[bot] ${message}`))

holder.on('ready', bot => {
  controller.setBot(bot)
  controller.attachPathfinderEvents(bot)
  statePusher.setBot(bot)
  minimapPusher.setBot(bot)
  inventory.setBot(bot)
  for (const client of clients.values()) attach(client.socket)
  setStatus('connected', `playing as ${bot.username}`)
})

holder.on('down', reason => {
  controller.clearBot()
  statePusher.clearBot()
  minimapPusher.clearBot()
  inventory.clearBot()
  for (const client of clients.values()) detach(client)
  setStatus('reconnecting', reason)
})

statePusher.start()
minimapPusher.start()
holder.start()

server.listen(config.web.port, () => {
  console.log(`open http://localhost:${config.web.port}`)
})

const shutdown = () => {
  console.log('shutting down')
  holder.stop()
  statePusher.stop()
  minimapPusher.stop()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
