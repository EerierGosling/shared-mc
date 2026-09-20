'use strict'
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { blockAtCursor, entityAtCursor } = require('./raycast')
const { FLIGHT_DRIVEN } = require('./creative')
const { FACE_VECTORS, INTERACTABLE, isPlaceable } = require('./placement')

const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']

const MAX_CHAT_LENGTH = 256

// A dig that cannot proceed says so at most this often, so a held mouse button
// cannot flood the chat log.
const DIG_NOTICE_MS = 4000

// Vanilla places at most once every four ticks while the button is held.
const USE_COOLDOWN_MS = 200
// How often an in-flight dig checks that the crosshair is still on its block.
const DIG_WATCH_MS = 100

/**
 * Translates browser input into one bot's actions.
 *
 * A session owns one bot and one or more member browsers. Held keys are merged
 * across members with an OR rather than last-write-wins: in roadtrip mode one
 * person releasing W must not stop the bot while someone else is still holding
 * it. A solo session is that same merge over a single member, so one code path
 * serves both modes — do not "simplify" it back to a single held-key object.
 * A member's contribution is dropped when they disconnect. Look is
 * last-write-wins, rate limited per member.
 *
 * `emitter` is whatever the session speaks through: one socket for a solo
 * session, the room for a shared one.
 *
 * Destructive actions go through a Budget first. Visitors share one world, so
 * a refusal is reported rather than dropped — a silent cap is indistinguishable
 * from lag and gets reported as a bug.
 */
class Controller {
  constructor (emitter, config, primitives, budget, chatLog, creative) {
    this.emitter = emitter
    this.config = config
    this.primitives = primitives
    this.budget = budget
    this.chatLog = chatLog
    this.creative = creative
    this.bot = null
    this.desired = new Map() // socket.id -> that member's held keys
    this.effective = {} // the merge: what the members between them are holding
    this.applied = {} // what was last written to the bot, which flight changes
    this.lastLookAt = new Map() // socket.id -> timestamp of last applied look
    this.pendingLooks = new Map() // socket.id -> { yaw, pitch, timer }
    this.lastChatAt = new Map()
    this.diggers = new Set() // socket.ids currently holding the mouse button
    this.lastDigNoticeAt = 0
    this.lastUseAt = 0
    this.digHeld = false
    this.digging = false
    for (const key of CONTROL_KEYS) {
      this.effective[key] = false
      this.applied[key] = false
    }
  }

  setBot (bot) {
    this.bot = bot
    this.diggers.clear()
    this.digHeld = false
    this.digging = false
    this._applyEffective(true)
  }

  clearBot () {
    this.bot = null
    this.diggers.clear()
    this.digHeld = false
    this.digging = false
    for (const pending of this.pendingLooks.values()) clearTimeout(pending.timer)
    this.pendingLooks.clear()
  }

  register (socket) {
    socket.on('input:state', state => this.setInput(socket.id, state))
    socket.on('input:look', look => this.look(socket.id, look))
    // Cursor actions raycast against the bot's current aim, so a look still
    // waiting out its rate window is applied first — the click meant "there",
    // not wherever the bot pointed a window ago.
    socket.on('action:dig', payload => {
      this._flushLook(socket.id)
      this.setDig(socket.id, Boolean(payload && payload.active))
    })
    socket.on('action:use', payload => {
      this._flushLook(socket.id)
      this.use(Boolean(payload && payload.repeat))
    })
    socket.on('action:attack', () => {
      this._flushLook(socket.id)
      this.attack()
    })
    socket.on('creative:pick', () => {
      this._flushLook(socket.id)
      if (this.creative) this.creative.pickBlock(socket.id)
    })
    socket.on('hotbar', payload => this.setHotbar(payload && payload.slot))
    socket.on('drop', () => this.drop())
    socket.on('chat', payload => this.chat(socket.id, payload && payload.text))
    socket.on('goto', () => {
      this._flushLook(socket.id)
      this.gotoCursor()
    })
    socket.on('stop', () => this.stopEverything())
  }

  /** Forget a member who left, and recompute the merge without their keys. */
  dropSocket (socketId) {
    this.desired.delete(socketId)
    this.lastLookAt.delete(socketId)
    const pending = this.pendingLooks.get(socketId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingLooks.delete(socketId)
    }
    this.lastChatAt.delete(socketId)
    this._applyEffective()
    // A tab that vanishes mid-click must not leave the bot mining forever.
    this._setDigHeld(socketId, false)
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
    this.effective = next
    // The flight loop reads the merge whole, flying or not, so it is already
    // holding the right keys the moment flight starts.
    if (this.creative) this.creative.setControls(next)

    const flying = Boolean(this.creative && this.creative.flying)
    for (const key of CONTROL_KEYS) {
      // While flying, creative.js moves the body by writing velocity each tick;
      // leaving mineflayer's movement controls set would have
      // prismarine-physics accelerate against that override.
      const value = flying && FLIGHT_DRIVEN.has(key) ? false : next[key]
      if (!force && value === this.applied[key]) continue
      this.applied[key] = value
      if (!this.bot) continue
      try {
        this.bot.setControlState(key, value)
      } catch (err) {
        // bot went away between the check and the call
      }
    }
  }

  /** Flight starting or stopping changes which keys reach mineflayer. */
  refreshControls () {
    this._applyEffective(true)
  }

  look (socketId, look) {
    if (!this.bot || !look) return
    const yaw = Number(look.yaw)
    const pitch = Number(look.pitch)
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return
    const clamped = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch))

    const now = Date.now()
    const wait = this.config.lookIntervalMs - (now - (this.lastLookAt.get(socketId) || 0))
    if (wait <= 0) {
      this.lastLookAt.set(socketId, now)
      this._applyLook(yaw, clamped)
      return
    }
    // Inside the rate window: coalesce, never drop. Only the latest mouse
    // sample matters, and dropping the final message of a flick left the bot
    // aimed somewhere stale until the mouse moved again.
    const pending = this.pendingLooks.get(socketId)
    if (pending) {
      pending.yaw = yaw
      pending.pitch = clamped
      return
    }
    const entry = { yaw, pitch: clamped, timer: null }
    entry.timer = setTimeout(() => {
      this.pendingLooks.delete(socketId)
      this.lastLookAt.set(socketId, Date.now())
      this._applyLook(entry.yaw, entry.pitch)
    }, wait)
    entry.timer.unref?.()
    this.pendingLooks.set(socketId, entry)
  }

  _applyLook (yaw, pitch) {
    if (!this.bot) return
    // force=true: the browser already applied this rotation locally, so any
    // server-side smoothing would just fight it. No packet is written here
    // either way — mineflayer snapshots yaw/pitch once per 50ms physics tick,
    // which is what actually paces what the Minecraft server sees.
    Promise.resolve(this.bot.look(yaw, pitch, true)).catch(() => {})
  }

  /** Apply a member's pending look now; cursor actions must not aim into the past. */
  _flushLook (socketId) {
    const pending = this.pendingLooks.get(socketId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingLooks.delete(socketId)
    this.lastLookAt.set(socketId, Date.now())
    this._applyLook(pending.yaw, pending.pitch)
  }

  // --- world interaction ---------------------------------------------------

  targetBlock () {
    return blockAtCursor(this.bot, this.config.reach)
  }

  setDig (socketId, active) {
    if (active && this._entityAtCursor()) {
      this.attack()
      return
    }
    this._setDigHeld(socketId, active)
  }

  // Same OR merge as movement: the bot digs while anyone holds the button.
  _setDigHeld (socketId, active) {
    if (active) this.diggers.add(socketId)
    else this.diggers.delete(socketId)
    const held = this.diggers.size > 0
    if (held === this.digHeld) return
    this.digHeld = held
    if (held) this._digLoop()
    else this._stopDigging()
  }

  _entityAtCursor () {
    return entityAtCursor(this.bot, this.config.reach)
  }

  /**
   * Says why nothing is breaking. Without this the dig loop just sleeps, which
   * is indistinguishable from the server ignoring the click.
   */
  _digNotice (text) {
    const now = Date.now()
    if (now - this.lastDigNoticeAt < DIG_NOTICE_MS) return
    this.lastDigNoticeAt = now
    this.emitter.emit('chat', { text, position: 'system', ts: now })
  }

  /** Spends anti-grief budget, reporting rather than swallowing a refusal. */
  _afford (kind) {
    if (this.budget.take(kind)) return true
    this.emitter.emit('action:refused', { kind, retryIn: this.budget.retryInSeconds() })
    return false
  }

  async _digLoop () {
    if (this.digging) return
    this.digging = true
    try {
      while (this.digHeld && this.bot) {
        const block = this.targetBlock()
        if (!block) {
          this._digNotice('* nothing in reach to mine')
          await sleep(100)
          continue
        }
        if (!this.bot.canDigBlock(block)) {
          this._digNotice(`* cannot mine ${block.displayName || block.name} from here`)
          await sleep(100)
          continue
        }
        // Charged per block actually broken rather than per click, so holding
        // the button down is what the cap measures.
        if (!this._afford('dig')) {
          this.digHeld = false
          break
        }
        // Tell the viewers how long this dig will take so they can animate
        // crack stages locally — without it a block silently pops seconds
        // after the click, which reads as lag.
        let digMs = 1000
        try { digMs = this.bot.digTime(block) } catch (err) {}
        this.emitter.emit('dig:start', { position: block.position, ms: digMs })
        // Vanilla resets the dig the moment the crosshair leaves the block;
        // mineflayer would finish the one it started, so a player sweeping
        // across a wall would break blocks they had already moved off. Abort
        // when the target changes and let the loop pick up the new one.
        const watcher = setInterval(() => {
          const now = this.targetBlock()
          if (now && now.position.equals(block.position)) return
          try {
            this.bot.stopDigging()
          } catch (err) {}
        }, DIG_WATCH_MS)
        try {
          // 'ignore' keeps the bot's head where the browser pointed it.
          await this.bot.dig(block, 'ignore')
        } catch (err) {
          await sleep(100)
        } finally {
          clearInterval(watcher)
          this.emitter.emit('dig:stop')
        }
      }
    } finally {
      this.digging = false
    }
  }

  _stopDigging () {
    this.emitter.emit('dig:stop')
    if (!this.bot) return
    try {
      this.bot.stopDigging()
    } catch (err) {
      // not currently digging
    }
  }

  /**
   * Right click. `repeat` is the browser holding the button down, which
   * vanilla treats as "keep placing" and nothing else: no re-opening the
   * chest under the crosshair, no eating again.
   */
  async use (repeat = false) {
    const bot = this.bot
    if (!bot) return
    const now = Date.now()
    if (now - this.lastUseAt < USE_COOLDOWN_MS) return
    this.lastUseAt = now
    const block = this.targetBlock()
    const held = bot.heldItem

    if (block) {
      const sneaking = this.effective.sneak
      if (!repeat && !sneaking && INTERACTABLE.test(block.name)) {
        try {
          // Opening a chest changes nothing, so it costs no budget.
          await bot.activateBlock(block)
          return
        } catch (err) {
          // fall through to placing / using the held item
        }
      }
      if (held && isPlaceable(bot, held)) {
        if (!this._afford('place')) return
        const face = FACE_VECTORS[block.face] || new Vec3(0, 1, 0)
        // Where on the face the crosshair actually hit. Slabs, stairs and
        // trapdoors take their orientation from that point, so without it
        // every slab lands on the bottom half. 'ignore' keeps the head where
        // the browser pointed it, as dig() does — placeBlock() alone would
        // snap the bot's look at the block and fight the mouse.
        const delta = block.intersect ? block.intersect.minus(block.position) : undefined
        try {
          // 'ignore' skips placeBlock's smooth lookAt — several physics ticks
          // before the packet even leaves, on a head the browser has already
          // pointed at this block. Same reason the dig path passes it. `delta`
          // is the face point the ray hit, so slabs/stairs/trapdoors orient.
          await bot._placeBlockWithOptions(block, face, { delta, forceLook: 'ignore', swingArm: 'right' })
          return
        } catch (err) {
          // no valid placement; fall through
        }
      }
    }

    if (repeat) return
    try {
      bot.activateItem()
      setTimeout(() => {
        try {
          bot.deactivateItem()
        } catch (err) {}
      }, 200)
    } catch (err) {}
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
    if (!this._afford('attack')) return
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
    if (!this._afford('drop')) return
    Promise.resolve(bot.tossStack(bot.heldItem)).catch(() => {})
  }

  chat (socketId, text) {
    const bot = this.bot
    if (typeof text !== 'string') return
    // Vanilla kicks the sender for § or control characters
    // (multiplayer.disconnect.illegal_characters), and the sender here is the
    // shared bot, so one pasted colour code would drop everyone.
    const message = text
      .replace(/[\r\n]+/g, ' ')
      .replace(/[§\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MAX_CHAT_LENGTH)
    if (!message) return
    // A dropped message must say so; silence here reads as "chat is broken".
    if (!bot) {
      this.chatLog?.notice(socketId, '* not sent: the bot is not connected')
      return
    }
    const now = Date.now()
    if (now - (this.lastChatAt.get(socketId) || 0) < this.config.chatIntervalMs) {
      this.chatLog?.notice(socketId, '* not sent: one message per second')
      return
    }
    this.lastChatAt.set(socketId, now)
    try {
      bot.chat(message)
    } catch (err) {
      return
    }
    this.chatLog?.said(socketId, message)
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
    this.diggers.clear()
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
