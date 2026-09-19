'use strict'
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { blockAtCursor, entityAtCursor } = require('./raycast')

const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']

// prismarine's raycast reports the hit face as an index; placing a block needs
// the matching normal vector.
const FACE_VECTORS = [
  new Vec3(0, -1, 0),
  new Vec3(0, 1, 0),
  new Vec3(0, 0, -1),
  new Vec3(0, 0, 1),
  new Vec3(-1, 0, 0),
  new Vec3(1, 0, 0)
]

const INTERACTABLE = /chest|furnace|crafting_table|barrel|shulker_box|hopper|dispenser|dropper|anvil|enchanting_table|brewing_stand|beacon|lectern|loom|smoker|blast_furnace|cartography|grindstone|stonecutter|door|trapdoor|fence_gate|button|lever|bed$|note_block|jukebox|comparator|repeater|sign$/

const MAX_CHAT_LENGTH = 256

/**
 * Translates browser input into bot actions.
 *
 * Control is free-for-all: every connected browser drives the same bot. Held
 * keys are merged with OR across clients, so one person releasing W does not
 * stop the bot while someone else is still holding it. A client's contribution
 * is dropped when it disconnects. Look is last-write-wins.
 */
class Controller {
  constructor (config, primitives) {
    this.config = config
    this.primitives = primitives
    this.bot = null
    this.desired = new Map() // socket.id -> control state
    this.effective = {}
    this.lastLookAt = new Map() // socket.id -> timestamp
    this.lastChatAt = new Map()
    this.digHeld = false
    this.digging = false
    for (const key of CONTROL_KEYS) this.effective[key] = false
  }

  setBot (bot) {
    this.bot = bot
    this.digHeld = false
    this.digging = false
    this._applyEffective(true)
  }

  clearBot () {
    this.bot = null
    this.digHeld = false
    this.digging = false
  }

  register (socket) {
    socket.on('input:state', state => this.setInput(socket.id, state))
    socket.on('input:look', look => this.look(socket.id, look))
    socket.on('action:dig', payload => this.setDig(Boolean(payload && payload.active)))
    socket.on('action:use', () => this.use())
    socket.on('action:attack', () => this.attack())
    socket.on('hotbar', payload => this.setHotbar(payload && payload.slot))
    socket.on('drop', () => this.drop())
    socket.on('chat', payload => this.chat(socket.id, payload && payload.text))
    socket.on('goto', () => this.gotoCursor())
    socket.on('stop', () => this.stopEverything())
  }

  dropSocket (socketId) {
    this.desired.delete(socketId)
    this.lastLookAt.delete(socketId)
    this.lastChatAt.delete(socketId)
    this._applyEffective()
  }

  // --- movement ------------------------------------------------------------

  setInput (socketId, state) {
    const clean = {}
    for (const key of CONTROL_KEYS) clean[key] = Boolean(state && state[key])
    this.desired.set(socketId, clean)
    this._applyEffective()
  }

  _applyEffective (force = false) {
    const next = {}
    for (const key of CONTROL_KEYS) next[key] = false
    for (const state of this.desired.values()) {
      for (const key of CONTROL_KEYS) if (state[key]) next[key] = true
    }
    for (const key of CONTROL_KEYS) {
      if (!force && next[key] === this.effective[key]) continue
      this.effective[key] = next[key]
      if (!this.bot) continue
      try {
        this.bot.setControlState(key, next[key])
      } catch (err) {
        // bot went away between the check and the call
      }
    }
  }

  look (socketId, look) {
    if (!this.bot || !look) return
    const now = Date.now()
    if (now - (this.lastLookAt.get(socketId) || 0) < this.config.lookIntervalMs) return
    this.lastLookAt.set(socketId, now)

    const yaw = Number(look.yaw)
    const pitch = Number(look.pitch)
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return
    const clamped = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch))
    // force=true: the browser already applied this rotation locally, so any
    // server-side smoothing would just fight it.
    Promise.resolve(this.bot.look(yaw, clamped, true)).catch(() => {})
  }

  // --- world interaction ---------------------------------------------------

  targetBlock () {
    return blockAtCursor(this.bot, this.config.reach)
  }

  setDig (active) {
    if (active && this._entityAtCursor()) {
      this.attack()
      return
    }
    this.digHeld = active
    if (active) this._digLoop()
    else this._stopDigging()
  }

  _entityAtCursor () {
    return entityAtCursor(this.bot, this.config.reach)
  }

  async _digLoop () {
    if (this.digging) return
    this.digging = true
    try {
      while (this.digHeld && this.bot) {
        const block = this.targetBlock()
        if (!block || !this.bot.canDigBlock(block)) {
          await sleep(100)
          continue
        }
        try {
          // 'ignore' keeps the bot's head where the browser pointed it.
          await this.bot.dig(block, 'ignore')
        } catch (err) {
          await sleep(100)
        }
      }
    } finally {
      this.digging = false
    }
  }

  _stopDigging () {
    if (!this.bot) return
    try {
      this.bot.stopDigging()
    } catch (err) {
      // not currently digging
    }
  }

  async use () {
    const bot = this.bot
    if (!bot) return
    const block = this.targetBlock()
    const held = bot.heldItem

    if (block) {
      const sneaking = this.effective.sneak
      if (!sneaking && INTERACTABLE.test(block.name)) {
        try {
          await bot.activateBlock(block)
          return
        } catch (err) {
          // fall through to placing / using the held item
        }
      }
      if (held && this._isPlaceable(bot, held)) {
        const face = FACE_VECTORS[block.face] || new Vec3(0, 1, 0)
        try {
          await bot.placeBlock(block, face)
          return
        } catch (err) {
          // no valid placement; fall through
        }
      }
    }

    try {
      bot.activateItem()
      setTimeout(() => {
        try {
          bot.deactivateItem()
        } catch (err) {}
      }, 200)
    } catch (err) {}
  }

  _isPlaceable (bot, item) {
    const registry = bot.registry || bot.mcData
    if (!registry || !registry.blocksByName) return false
    return Boolean(registry.blocksByName[item.name])
  }

  attack () {
    const bot = this.bot
    if (!bot) return
    let entity = this._entityAtCursor()
    if (!entity) {
      entity = bot.nearestEntity(e =>
        e !== bot.entity &&
        e.position.distanceTo(bot.entity.position) <= this.config.reach)
    }
    if (!entity) {
      try {
        bot.swingArm('right')
      } catch (err) {}
      return
    }
    try {
      bot.attack(entity)
    } catch (err) {}
  }

  setHotbar (slot) {
    const index = Number(slot)
    if (!this.bot || !Number.isInteger(index) || index < 0 || index > 8) return
    try {
      this.bot.setQuickBarSlot(index)
    } catch (err) {}
  }

  drop () {
    const bot = this.bot
    if (!bot || !bot.heldItem) return
    Promise.resolve(bot.tossStack(bot.heldItem)).catch(() => {})
  }

  chat (socketId, text) {
    const bot = this.bot
    if (!bot || typeof text !== 'string') return
    const message = text.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_CHAT_LENGTH)
    if (!message) return
    const now = Date.now()
    if (now - (this.lastChatAt.get(socketId) || 0) < this.config.chatIntervalMs) return
    this.lastChatAt.set(socketId, now)
    try {
      bot.chat(message)
    } catch (err) {}
  }

  // --- click to walk -------------------------------------------------------

  gotoCursor () {
    const bot = this.bot
    if (!bot || !bot.pathfinder) return
    const block = this.targetBlock()
    if (!block) return
    const target = block.position.offset(0, 1, 0)
    try {
      bot.pathfinder.setGoal(new goals.GoalBlock(target.x, target.y, target.z))
    } catch (err) {}
  }

  attachPathfinderEvents (bot) {
    if (!bot.pathfinder) return
    bot.on('path_update', result => {
      const start = bot.entity.position.offset(0, 0.5, 0)
      const points = [start, ...result.path.map(move => new Vec3(move.x, move.y + 0.5, move.z))]
      this.primitives.line('path', points, 0xff00ff)
    })
    bot.on('goal_reached', () => this.primitives.erase('path'))
    bot.on('path_reset', () => this.primitives.erase('path'))
  }

  stopEverything () {
    this.digHeld = false
    this._stopDigging()
    this.desired.clear()
    this._applyEffective()
    if (this.bot && this.bot.pathfinder) {
      try {
        this.bot.pathfinder.setGoal(null)
      } catch (err) {}
    }
    this.primitives.erase('path')
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

module.exports = Controller
