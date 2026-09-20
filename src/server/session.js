'use strict'
const BotHolder = require('./bot')
const Controller = require('./control')
const Primitives = require('./primitives')
const StatePusher = require('./state')
const LightTracker = require('./lights')
const InventoryBridge = require('./inventory')
const ChatLog = require('./chat')
const Respawner = require('./respawn')
const Creative = require('./creative')
const Advancements = require('./advancements')
const { Budget } = require('./limits')
const { attachWorldView } = require('./worldStream')

/**
 * One bot and the browsers watching it.
 *
 * Both modes are this same class:
 *
 *   solo     — one member, one bot of their own, emitter is that socket.
 *   roadtrip — many members sharing one bot, character and inventory, emitter
 *              is the socket.io room they all sit in.
 *
 * The only structural difference is how many members it has and what it
 * speaks through, which is why the Controller merges held keys either way.
 *
 * The bot is owned by a BotHolder, so reconnects swap it out through
 * setBot/clearBot rather than anything caching it.
 */
class Session {
  constructor ({ mode, identity, server, config, emitter, io, onPlayers, onGone }) {
    this.mode = mode // 'solo' | 'roadtrip'
    this.identity = identity // { username, skin }
    this.server = server // { host, port } this bot logs into
    this.serverKey = `${server.host}:${server.port}`
    this.onPlayers = onPlayers || (() => {}) // the server's tab list changed
    this.onGone = onGone || (() => {}) // the bot gave up; tear this session down
    this.config = config
    this.emitter = emitter
    this.io = io
    this.members = new Set() // socket ids
    this.socketsById = new Map()
    // One world stream per bot, shared by every member (see worldStream.js).
    this.stream = null
    this.address = null
    this.status = { state: 'connecting', message: 'joining the server', server: { ...server, address: null } }

    this.primitives = new Primitives(emitter)
    this.budget = new Budget(config.limits)
    // Chat history and the death screen are per session: a solo player's are
    // theirs alone, road trip riders share both.
    this.chatLog = new ChatLog(emitter)
    this.respawner = new Respawner(emitter, this.chatLog, () => this.size)
    // Creative is built before the controller because the controller has to
    // ask it whether flight is running before deciding which held keys
    // mineflayer is allowed to see.
    this.creative = new Creative(emitter, config, this.budget, this.chatLog)
    this.controller = new Controller(emitter, config, this.primitives, this.budget, this.chatLog, this.creative)
    this.creative.onFlyingChange = () => this.controller.refreshControls()
    this.statePusher = new StatePusher(emitter, config)
    this.lights = new LightTracker(emitter)
    this.inventory = new InventoryBridge(emitter)
    // Per session like the chat log: solo players earn their own, road trip
    // riders all share the one character's progress.
    this.advancements = new Advancements(emitter)

    this.holder = new BotHolder({
      ...config.mc,
      host: server.host,
      port: server.port,
      username: identity.username,
      // One chunk past what WorldView streams: its ring is exclusive, and the
      // pathfinder and the cursor raycast both like a little margin.
      viewDistance: Math.max(2, config.viewDistance + 1)
    })
    this.holder.on('log', message => console.log(`[${identity.username}@${this.serverKey}] ${message}`))
    this.holder.on('ready', bot => this._onReady(bot))
    this.holder.on('down', reason => this._onDown(reason))
    this.holder.on('gone', reason => this._onGone(reason))
  }

  get size () {
    return this.members.size
  }

  get bot () {
    return this.holder.ready ? this.holder.bot : null
  }

  /** When a member last did anything, for reclaiming idle bots. */
  get lastInputAt () {
    return this.controller.lastInputAt
  }

  start () {
    this.statePusher.start()
    this.lights.start()
    this.holder.start()
  }

  addMember (socket) {
    this.members.add(socket.id)
    this.socketsById.set(socket.id, socket)
    this.controller.register(socket)
    this.inventory.register(socket)
    // A solo player is their own bot, so their chat lines carry that name.
    this.chatLog.register(socket, this.mode === 'solo' ? this.identity.username : null)
    this.respawner.register(socket)
    this.creative.register(socket)
    this.advancements.register(socket)
    this.primitives.sendAll(socket)
    this.lights.sendTo(socket)
    this.creative.sendTo(socket)
    socket.emit('bot:status', this.status)
    // The stream is already talking to the room; this member has missed the
    // columns and entities it sent so far and gets them one to one.
    if (this.stream) this.stream.catchUp(socket)
  }

  removeMember (socket) {
    this.members.delete(socket.id)
    this.socketsById.delete(socket.id)
    this.controller.dropSocket(socket.id)
    this.chatLog.dropSocket(socket.id)
    this.respawner.viewersChanged()
  }

  _detachStream () {
    if (!this.stream) return
    this.stream.detach()
    this.stream = null
  }

  _setStatus (state, message) {
    // The pause menu shows where this bot actually is: the address the
    // visitor typed, and the IP its socket resolved to, which is only known
    // once a bot is up and can differ between reconnects (round-robin DNS).
    this.status = { state, message, server: { ...this.server, address: this.address || null } }
    this.emitter.emit('bot:status', this.status)
  }

  _onReady (bot) {
    this.chatLog.setBot(bot)
    this.respawner.setBot(bot)
    this.creative.setBot(bot)
    this.controller.setBot(bot)
    this.controller.attachPathfinderEvents(bot)
    this.statePusher.setBot(bot)
    this.lights.setBot(bot)
    this.inventory.setBot(bot)
    this.advancements.setBot(bot)
    // The roster lists everyone on the server, not just our bots, and this
    // bot's tab list is where that comes from. Listeners die with the bot.
    bot.on('playerJoined', () => this.onPlayers())
    bot.on('playerLeft', () => this.onPlayers())
    this._detachStream()
    // Speaks to the whole session, so every member present gets the initial
    // load from here; nobody needs a catch-up for a stream that just started.
    this.stream = attachWorldView(bot, this.emitter, this.config.viewDistance)
    const tcp = bot._client && bot._client.socket
    this.address = (tcp && tcp.remoteAddress) || null
    this._setStatus('connected', `playing as ${bot.username}`)
    // The tab list arrived before spawn, so the listeners above missed it:
    // the roster sent at join knew nobody but us until someone else moved.
    this.onPlayers()
  }

  _onDown (reason) {
    this.creative.clearBot()
    this.controller.clearBot()
    this.statePusher.clearBot()
    this.lights.clearBot()
    this.inventory.clearBot()
    this.advancements.clearBot()
    this.chatLog.clearBot()
    this.respawner.clearBot()
    this._detachStream()
    this._setStatus('reconnecting', reason)
    this.onPlayers()
  }

  _onGone (reason) {
    this._setStatus('gone', `could not stay on ${this.server.host}`)
    this.onGone(reason)
  }

  /** Must leave no bot behind: this now runs whenever the last member goes. */
  destroy () {
    this._detachStream()
    this.creative.clearBot()
    this.controller.clearBot()
    this.statePusher.stop()
    this.statePusher.clearBot()
    this.lights.stop()
    this.lights.clearBot()
    this.inventory.clearBot()
    this.advancements.clearBot()
    this.chatLog.clearBot()
    this.respawner.clearBot()
    this.holder.removeAllListeners()
    this.holder.stop()
  }
}

module.exports = Session
