'use strict'
const { blockAtCursor } = require('./raycast')

// Serverbound abilities carries one byte, and only the flying bit means
// anything coming from the client; the rest is the server's to decide.
const FLAG_FLYING = 0x02
// The same byte coming back down, as vanilla packs it.
const FLAG_MAY_FLY = 0x04
const FLAG_INSTABUILD = 0x08

// Blocks per tick, doubled while sprinting. Vanilla creative flight is about
// 10.9 blocks/s, and mineflayer's own creative.flyTo uses this same 0.5.
const FLY_SPEED = 0.5

// Every toggle writes an abilities packet to the Minecraft server, so a client
// holding the key down must not turn into a packet flood. Well under the time
// a double-tap takes, so it never swallows a real one.
const FLY_TOGGLE_MS = 200

const HOTBAR_START = 36
const HOTBAR_END = 45
const MAIN_START = 9

// Which merged keys the flight loop takes over. Sneak and sprint are not
// here: the server wants those poses either way, and they only change how
// fast this moves.
const FLIGHT_DRIVEN = new Set(['forward', 'back', 'left', 'right', 'jump'])

/**
 * Creative mode: the item catalogue and flight.
 *
 * Creative is a state the Minecraft server grants, never one this app can
 * assert. Both halves are read off the server rather than assumed:
 * `bot.game.gameMode` for the mode itself and the clientbound `abilities`
 * flags for what it actually permits. Nothing here is offered to a browser
 * until the server has said yes.
 *
 * That gate is protective, not cosmetic. Probed against a server that had not
 * granted flight (mayFly clear, allow-flight off), sending the flying bit and
 * climbing anyway got about twelve blocks up before the server kicked the bot
 * with `multiplayer.disconnect.flying` — which takes the whole session down,
 * not just the flight. A bot that cannot fly must be told no here.
 *
 * Flight writes `bot.entity.velocity` once per physics tick rather than
 * disabling physics outright, so prismarine-physics still resolves collisions
 * and the bot cannot drift through walls. Gravity is zeroed for the duration.
 * The movement keys are withheld from mineflayer while this is running (see
 * control.js) because prismarine-physics would otherwise accelerate against
 * the override.
 *
 * `emitter` is whatever the session speaks through — a socket for solo, the
 * room for a road trip — so only .emit() is ever called on it.
 */
class Creative {
  constructor (emitter, config, budget, chatLog) {
    this.emitter = emitter
    this.config = config
    this.budget = budget
    this.chatLog = chatLog
    this.bot = null
    this.Item = null
    this.listeners = []
    this.controls = {}
    this.flying = false
    this.mayFly = false
    this.instabuild = false
    this.normalGravity = null
    this.lastToggleAt = 0
    this.catalog = null
    this.lastPublished = null
    // control.js has to re-push the merged keys when this flips, since which
    // of them reach mineflayer depends on whether the flight loop is running.
    this.onFlyingChange = () => {}
  }

  setBot (bot) {
    this.clearBot()
    this.bot = bot
    this.Item = require('prismarine-item')(bot.registry)
    this.catalog = buildCatalog(bot.registry)

    this._listen(bot._client, 'abilities', packet => this._onAbilities(packet))
    this._listen(bot, 'game', () => this._publish())
    this._listen(bot, 'physicsTick', () => this._tick())
    // A dead or respawning bot is not flying, and the server's abilities are
    // resent on the way back in.
    this._listen(bot, 'death', () => this._land())
    this._listen(bot, 'respawn', () => this._land())
    this._publish()
  }

  clearBot () {
    for (const [emitter, event, fn] of this.listeners) emitter.removeListener(event, fn)
    this.listeners = []
    // Deliberately not restoring gravity: the bot object is gone, and the next
    // one arrives with its own physics.
    this.flying = false
    this.mayFly = false
    this.instabuild = false
    this.normalGravity = null
    this.bot = null
    this.Item = null
    this.lastPublished = null
    this._publish()
  }

  _listen (emitter, event, fn) {
    emitter.on(event, fn)
    this.listeners.push([emitter, event, fn])
  }

  register (socket) {
    socket.on('creative:fly', payload => this.setFlying(socket.id, Boolean(payload && payload.active)))
    socket.on('creative:give', payload => this.give(socket.id, payload))
    socket.on('creative:destroy', payload => this.destroy(socket.id, payload && payload.slot))
    socket.on('creative:pick', () => this.pickBlock(socket.id))
  }

  /** A browser that arrived mid-session still needs the state and the list. */
  sendTo (socket) {
    socket.emit('creative', this.state())
    if (this.available && this.catalog) socket.emit('creative:catalog', this.catalog)
  }

  /** Creative proper. Spectator also has mayFly, which is why they are separate. */
  get available () {
    return Boolean(this.bot && this.bot.game && this.bot.game.gameMode === 'creative')
  }

  state () {
    return {
      available: this.available,
      mayFly: this.mayFly,
      instabuild: this.instabuild,
      flying: this.flying,
      gameMode: (this.bot && this.bot.game && this.bot.game.gameMode) || null
    }
  }

  _publish () {
    const state = this.state()
    const serialized = JSON.stringify(state)
    if (serialized === this.lastPublished) return
    const wasAvailable = this.lastPublished && JSON.parse(this.lastPublished).available
    this.lastPublished = serialized
    this.emitter.emit('creative', state)
    // The catalogue is ~77 KB, so it goes out once when creative turns on
    // rather than riding along with every state change.
    if (state.available && !wasAvailable && this.catalog) {
      this.emitter.emit('creative:catalog', this.catalog)
    }
  }

  // --- flight ---------------------------------------------------------------

  /** The merged held keys, straight from control.js, flying or not. */
  setControls (controls) {
    this.controls = controls
  }

  setFlying (socketId, want) {
    const bot = this.bot
    if (!bot || want === this.flying) return
    if (want && !this.mayFly) {
      this.chatLog?.notice(socketId, '* flight needs creative mode, and the server has not granted it')
      return
    }
    const now = Date.now()
    if (now - this.lastToggleAt < FLY_TOGGLE_MS) return
    this.lastToggleAt = now
    this.flying = want
    if (want) {
      if (this.normalGravity === null) this.normalGravity = bot.physics.gravity
      bot.physics.gravity = 0
      bot.entity.velocity.set(0, 0, 0)
    } else {
      if (this.normalGravity !== null) bot.physics.gravity = this.normalGravity
      this.normalGravity = null
    }
    this._writeAbilities()
    this.onFlyingChange()
    this._publish()
  }

  /** Flight ended by something other than a browser asking for it. */
  _land () {
    if (!this.flying) return
    const bot = this.bot
    this.flying = false
    if (bot && this.normalGravity !== null) bot.physics.gravity = this.normalGravity
    this.normalGravity = null
    this.onFlyingChange()
    this._publish()
  }

  _writeAbilities () {
    try {
      this.bot._client.write('abilities', { flags: this.flying ? FLAG_FLYING : 0 })
    } catch (err) {
      // socket went away between the check and the write
    }
  }

  _onAbilities (packet) {
    const flags = Number(packet && packet.flags) | 0
    this.mayFly = Boolean(flags & FLAG_MAY_FLY)
    this.instabuild = Boolean(flags & FLAG_INSTABUILD)
    if (this.flying && !this.mayFly) {
      // The grant was taken away underneath us — keep climbing and the server
      // kicks the bot.
      this._land()
      this.chatLog?.system('* flight ended: the server withdrew creative mode')
    } else if (this.flying && !(flags & FLAG_FLYING)) {
      // A gamemode change resends abilities with flying cleared; say so again
      // rather than silently falling out of the sky.
      this._writeAbilities()
    }
    this._publish()
  }

  /**
   * Runs after prismarine-physics has simulated the tick, so what it writes is
   * the velocity the *next* tick starts from. Overwriting every tick is what
   * keeps drag and the leftover control acceleration from accumulating.
   */
  _tick () {
    if (!this.flying || !this.bot) return
    const c = this.controls
    let forward = 0
    let strafe = 0
    if (c.forward) forward += 1
    if (c.back) forward -= 1
    if (c.right) strafe += 1
    if (c.left) strafe -= 1
    let up = 0
    if (c.jump) up += 1
    if (c.sneak) up -= 1

    const speed = FLY_SPEED * (c.sprint ? 2 : 1)
    // mineflayer's yaw has forward at (-sin, -cos); right is that turned a
    // quarter clockwise, (cos, -sin).
    const yaw = this.bot.entity.yaw
    const sin = Math.sin(yaw)
    const cos = Math.cos(yaw)
    let x = forward * -sin + strafe * cos
    let z = forward * -cos + strafe * -sin
    const length = Math.hypot(x, z)
    if (length > 0) {
      x = (x / length) * speed
      z = (z / length) * speed
    }
    this.bot.entity.velocity.set(x, up * speed, z)
  }

  // --- the item list --------------------------------------------------------

  /**
   * Puts a stack in a slot. The browser may name the slot; left to us it goes
   * to the selected hotbar slot, then any empty one, and only overwrites the
   * selected slot when the whole inventory is full — which is what vanilla's
   * own "drag it out of the list" ends up doing.
   */
  async give (socketId, payload) {
    const bot = this.bot
    if (!bot || !this.available || !payload) return
    const info = bot.registry.itemsByName[String(payload.name)]
    if (!info) return
    if (!this._afford(socketId, 'give')) return

    const count = clamp(Number(payload.count) || 1, 1, info.stackSize || 64)
    const slot = Number.isInteger(payload.slot) && payload.slot >= 0 && payload.slot <= 44
      ? payload.slot
      : this._destinationSlot()
    await this._setSlot(slot, new this.Item(info.id, count))
  }

  async destroy (socketId, slot) {
    const bot = this.bot
    if (!bot || !this.available) return
    if (!Number.isInteger(slot) || slot < 0 || slot > 44) return
    await this._setSlot(slot, null)
  }

  /**
   * Vanilla's middle click: select the block already held if there is one,
   * otherwise put it in the selected slot. Blocks whose item has another name
   * (wheat, and anything with no item at all) are skipped rather than guessed.
   */
  async pickBlock (socketId) {
    const bot = this.bot
    if (!bot || !this.available) return
    const block = blockAtCursor(bot, this.config.reach)
    if (!block) return
    const info = bot.registry.itemsByName[block.name]
    if (!info) {
      this.chatLog?.notice(socketId, `* no item to pick for ${block.displayName || block.name}`)
      return
    }
    const slots = (bot.inventory && bot.inventory.slots) || []
    for (let i = HOTBAR_START; i < HOTBAR_END; i++) {
      if (slots[i] && slots[i].name === info.name) {
        try {
          bot.setQuickBarSlot(i - HOTBAR_START)
        } catch (err) {}
        return
      }
    }
    if (!this._afford(socketId, 'give')) return
    await this._setSlot(HOTBAR_START + (bot.quickBarSlot || 0), new this.Item(info.id, info.stackSize || 1))
  }

  async _setSlot (slot, item) {
    try {
      // mineflayer waits for the server's acknowledging set_slot here, so a
      // server that quietly ignores the packet surfaces as a rejection rather
      // than as a slot that never fills.
      await this.bot.creative.setInventorySlot(slot, item)
    } catch (err) {
      // Rejected, timed out, or the same slot was already in flight. The
      // inventory bridge pushes whatever the server actually did either way.
    }
  }

  _destinationSlot () {
    const bot = this.bot
    const slots = (bot.inventory && bot.inventory.slots) || []
    const selected = HOTBAR_START + (bot.quickBarSlot || 0)
    if (!slots[selected]) return selected
    for (let i = HOTBAR_START; i < HOTBAR_END; i++) if (!slots[i]) return i
    for (let i = MAIN_START; i < HOTBAR_START; i++) if (!slots[i]) return i
    return selected
  }

  /** Same budget rule as digging: refusals are reported, never swallowed. */
  _afford (socketId, kind) {
    if (this.budget.take(kind)) return true
    this.emitter.emit('action:refused', { kind, retryIn: this.budget.retryInSeconds() })
    return false
  }
}

/**
 * Every item the server knows, for the browser's picker. Vanilla groups these
 * into tabs, but minecraft-data carries no tab membership, so the browser gets
 * one searchable list — vanilla's Search tab, which is what anyone looking for
 * a particular block reaches for anyway.
 */
function buildCatalog (registry) {
  if (!registry || !registry.itemsArray) return null
  return registry.itemsArray
    .filter(item => item.name !== 'air')
    .map(item => ({
      name: item.name,
      displayName: item.displayName,
      stackSize: item.stackSize || 64
    }))
}

const clamp = (n, low, high) => Math.max(low, Math.min(high, n))

module.exports = Creative
module.exports.FLIGHT_DRIVEN = FLIGHT_DRIVEN
