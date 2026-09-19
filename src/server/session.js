'use strict'
const BotHolder = require('./bot')
const Controller = require('./control')
const Primitives = require('./primitives')
const StatePusher = require('./state')
const LightTracker = require('./lights')
const InventoryBridge = require('./inventory')
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
  constructor ({ mode, identity, config, emitter, io }) {
    this.mode = mode // 'solo' | 'roadtrip'
    this.identity = identity // { username, skin }
    this.config = config
    this.emitter = emitter
    this.io = io
    this.members = new Set() // socket ids
    this.detachByMember = new Map() // socket.id -> detach fn
    this.socketsById = new Map()
    this.status = { state: 'connecting', message: 'joining the server' }

    this.primitives = new Primitives(emitter)
    this.budget = new Budget(config.limits)
    this.controller = new Controller(emitter, config, this.primitives, this.budget)
    this.statePusher = new StatePusher(emitter, config)
    this.lights = new LightTracker(emitter)
    this.inventory = new InventoryBridge(emitter)

    this.holder = new BotHolder({ ...config.mc, username: identity.username })
    this.holder.on('log', message => console.log(`[${identity.username}] ${message}`))
    this.holder.on('ready', bot => this._onReady(bot))
    this.holder.on('down', reason => this._onDown(reason))
  }

  get size () {
    return this.members.size
  }

  get bot () {
    return this.holder.ready ? this.holder.bot : null
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
    this.primitives.sendAll(socket)
    this.lights.sendTo(socket)
    socket.emit('bot:status', this.status)
    // Each member needs their own world view: prismarine's WorldView tracks
    // which chunks that particular client has been sent.
    if (this.bot) this._attachMember(socket)
  }

  removeMember (socket) {
    this.members.delete(socket.id)
    this.socketsById.delete(socket.id)
    this.controller.dropSocket(socket.id)
    const detach = this.detachByMember.get(socket.id)
    if (detach) {
      detach()
      this.detachByMember.delete(socket.id)
    }
  }

  _attachMember (socket) {
    const existing = this.detachByMember.get(socket.id)
    if (existing) existing()
    this.detachByMember.set(socket.id, attachWorldView(this.bot, socket, this.config.viewDistance))
  }

  _detachAll () {
    for (const detach of this.detachByMember.values()) detach()
    this.detachByMember.clear()
  }

  _setStatus (state, message) {
    this.status = { state, message }
    this.emitter.emit('bot:status', this.status)
  }

  _onReady (bot) {
    this.controller.setBot(bot)
    this.controller.attachPathfinderEvents(bot)
    this.statePusher.setBot(bot)
    this.lights.setBot(bot)
    this.inventory.setBot(bot)
    this._detachAll()
    for (const socket of this.socketsById.values()) this._attachMember(socket)
    this._setStatus('connected', `playing as ${bot.username}`)
  }

  _onDown (reason) {
    this.controller.clearBot()
    this.statePusher.clearBot()
    this.lights.clearBot()
    this.inventory.clearBot()
    this._detachAll()
    this._setStatus('reconnecting', reason)
  }

  /** Must leave no bot behind: this now runs whenever the last member goes. */
  destroy () {
    this._detachAll()
    this.controller.clearBot()
    this.statePusher.stop()
    this.statePusher.clearBot()
    this.lights.stop()
    this.lights.clearBot()
    this.inventory.clearBot()
    this.holder.removeAllListeners()
    this.holder.stop()
  }
}

module.exports = Session
