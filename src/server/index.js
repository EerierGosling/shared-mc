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
const InventoryBridge = require('./inventory')
const { attachWorldView } = require('./worldStream')

const app = express()
const server = http.createServer(app)
const io = new Server(server, { maxHttpBufferSize: 1e8 })

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
app.use(express.static(viewerPublic))

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
const controller = new Controller(config, primitives)
const statePusher = new StatePusher(io, config)
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
  inventory.setBot(bot)
  for (const client of clients.values()) attach(client.socket)
  setStatus('connected', `playing as ${bot.username}`)
})

holder.on('down', reason => {
  controller.clearBot()
  statePusher.clearBot()
  inventory.clearBot()
  for (const client of clients.values()) detach(client)
  setStatus('reconnecting', reason)
})

statePusher.start()
holder.start()

server.listen(config.web.port, () => {
  console.log(`open http://localhost:${config.web.port}`)
})

const shutdown = () => {
  console.log('shutting down')
  holder.stop()
  statePusher.stop()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
