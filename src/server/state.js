'use strict'
const { describeItem } = require('./items')
const { blockAtCursor } = require('./raycast')
const { predictPlacement } = require('./placement')

const TICK_MS = 100

// Blocks that carry a full water fluid state without being 'water' themselves
// (vanilla's FluidTags.WATER covers them and any waterlogged block too).
const WATER_LIKE = new Set(['bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])

// The height of the water in a block, in the vanilla fluid sense: a source or
// a waterlogged block holds 8/9, flowing water holds (8 - level)/9, and
// falling water (level >= 8) counts as a full 8. 0 means no water at all.
function waterHeight (block) {
  if (!block) return 0
  if (block.name === 'water') {
    const level = Number(block.getProperties().level) || 0
    return (8 - Math.min(level, 8)) / 9
  }
  if (WATER_LIKE.has(block.name) || block.isWaterlogged) return 8 / 9
  return 0
}

// Vanilla's Entity.isEyeInFluid: the camera counts as submerged only once the
// eye is below the fluid surface of its block — and a block with water above
// it is treated as full, so a swimmer's head surfacing through a source
// block stops being underwater at the right height rather than a block later.
// Bubbles, fog and the overlay all key off this, not off being "in water",
// which mineflayer already tracks for physics and which is true while wading.
function eyeInWater (bot) {
  const pos = bot.entity.position
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return false
  const eye = pos.offset(0, bot.entity.eyeHeight || 1.62, 0)
  let height = waterHeight(bot.blockAt(eye))
  if (height === 0) return false
  if (waterHeight(bot.blockAt(eye.offset(0, 1, 0))) > 0) height = 1
  return eye.y < Math.floor(eye.y) + height
}

// mineflayer 4.39 sets bot.oxygenLevel from *every* entity_metadata packet
// carrying air_supply, not only the bot's own, so a player or squid drowning
// nearby overwrote it. Read the bot entity's own metadata instead, which
// mineflayer keeps per entity. The metadata index is fixed for a given
// registry, so it is resolved once per bot rather than per tick.
const MAX_AIR = 300
function airIndex (bot) {
  const keys = bot.registry && bot.registry.entitiesByName.player
    ? bot.registry.entitiesByName.player.metadataKeys
    : null
  return keys ? keys.indexOf('air_supply') : 1
}
function airSupply (bot, idx) {
  const value = bot.entity.metadata ? bot.entity.metadata[idx] : undefined
  return Number.isFinite(value) ? value : MAX_AIR
}

const FACTORS = [1, 10, 100, 1000, 10000]
const round = (n, places = 2) => {
  const factor = FACTORS[places] || Math.pow(10, places)
  return Math.round(n * factor) / factor
}

/**
 * Pushes a HUD snapshot to one browser, at most every TICK_MS and only when
 * something actually changed. One per visitor: this used to broadcast over the
 * server-wide emitter because every browser watched the same bot.
 */
class StatePusher {
  constructor (socket, config) {
    this.socket = socket
    this.config = config
    this.bot = null
    this.timer = null
    this.lastSerialized = null
    this.listeners = []
    this.airIndex = 1
    this.cursor = null // { key, targetBlock, placeTarget } last computed
    this.worldDirty = true // a block changed since the cursor last raycast
    this.sortedPlayers = null // cached while the tab list membership holds
  }

  // Chat and death lines used to be relayed from here; chat.js and respawn.js
  // own them now.
  setBot (bot) {
    this.clearBot()
    this.bot = bot
    this.airIndex = airIndex(bot)
    // The cursor raycast is only redone once the world has actually changed:
    // same aim over the same blocks hits the same block. A busy area just
    // degrades to computing every tick, as before.
    this._listen(bot, 'blockUpdate', () => { this.worldDirty = true })
    this._listen(bot, 'chunkColumnLoad', () => { this.worldDirty = true })
    this._listen(bot, 'chunkColumnUnload', () => { this.worldDirty = true })
    // The tab list is re-sorted on membership changes only; ping updates
    // arrive far more often and never reorder it.
    this._listen(bot, 'playerJoined', () => { this.sortedPlayers = null })
    this._listen(bot, 'playerLeft', () => { this.sortedPlayers = null })
  }

  clearBot () {
    for (const [emitter, event, fn] of this.listeners) emitter.removeListener(event, fn)
    this.listeners = []
    this.bot = null
    this.lastSerialized = null
    this.airIndex = 1
    this.cursor = null
    this.worldDirty = true
    this.sortedPlayers = null
  }

  _listen (emitter, event, fn) {
    emitter.on(event, fn)
    this.listeners.push([emitter, event, fn])
  }

  start () {
    if (this.timer) return
    this.timer = setInterval(() => this._tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop () {
    clearInterval(this.timer)
    this.timer = null
  }

  _tick () {
    const snapshot = this.snapshot()
    if (!snapshot) return
    const serialized = JSON.stringify(snapshot)
    if (serialized === this.lastSerialized) return
    this.lastSerialized = serialized
    this.socket.emit('state', snapshot)
  }

  /**
   * What the crosshair is over and what a right-click would place. The
   * raycast, the diggable check and the placement prediction are all
   * deterministic given the bot's pose, its held item and an unchanged
   * world, so the answer is reused until one of those moves. The snapshot
   * rounds position to two decimals anyway, so the key may as well.
   */
  _cursor (bot) {
    const p = bot.entity.position
    const held = bot.heldItem
    const key = [
      round(p.x, 3), round(p.y, 3), round(p.z, 3),
      round(bot.entity.yaw, 4), round(bot.entity.pitch, 4),
      bot.entity.eyeHeight || 1.62,
      bot.quickBarSlot,
      held ? held.name : ''
    ].join('|')
    if (this.cursor && this.cursor.key === key && !this.worldDirty) return this.cursor
    this.worldDirty = false

    let targetBlock = null
    let placeTarget = null
    const block = blockAtCursor(bot, this.config.reach)
    if (block) {
      try {
        targetBlock = {
          position: { x: block.position.x, y: block.position.y, z: block.position.z },
          name: block.name,
          displayName: block.displayName,
          // Which side the crosshair is on; the crack particles fly off it.
          face: block.face,
          diggable: bot.canDigBlock(block)
        }
        placeTarget = predictPlacement(bot, block)
      } catch (err) {
        targetBlock = null
        placeTarget = null
      }
    }
    this.cursor = { key, targetBlock, placeTarget }
    return this.cursor
  }

  /**
   * The Tab list: everyone the server reports, not just this site's visitors.
   * Capped like vanilla's own overlay, and sorted so a ping tick does not
   * reorder it. Membership only changes on playerJoined/playerLeft, which
   * null the cache; a codepoint compare is fine for ASCII usernames and much
   * cheaper than localeCompare.
   */
  _playerList (bot) {
    if (!this.sortedPlayers) {
      this.sortedPlayers = Object.values(bot.players || {})
        .filter(p => p && p.username)
        .sort((a, b) => a.username < b.username ? -1 : a.username > b.username ? 1 : 0)
        .slice(0, MAX_LISTED_PLAYERS)
    }
    // Pings change under the same membership, so the payload is still mapped
    // fresh each tick.
    return this.sortedPlayers
      .map(p => ({ username: p.username, ping: Number.isFinite(p.ping) ? p.ping : null }))
  }

  snapshot () {
    const bot = this.bot
    if (!bot || !bot.entity) return null

    const hotbar = []
    const slots = (bot.inventory && bot.inventory.slots) || []
    for (let i = 0; i < 9; i++) hotbar.push(describeItem(slots[36 + i]))

    const { targetBlock, placeTarget } = this._cursor(bot)

    return {
      username: bot.username,
      isAlive: bot.isAlive !== false,
      health: round(bot.health || 0, 1),
      food: bot.food,
      // 0-20, the 300-tick air supply scaled down by 15 like bot.oxygenLevel.
      oxygen: Math.round(airSupply(bot, this.airIndex) / 15),
      eyeInWater: eyeInWater(bot),
      xpLevel: bot.experience ? bot.experience.level : 0,
      xpProgress: bot.experience ? round(bot.experience.progress || 0, 3) : 0,
      // The camera dips while sneaking (Viewer.isSneaking); merged across the
      // session's members, so it has to come from here rather than the browser.
      sneaking: Boolean(bot.controlState && bot.controlState.sneak),
      position: {
        x: round(bot.entity.position.x),
        y: round(bot.entity.position.y),
        z: round(bot.entity.position.z)
      },
      yaw: round(bot.entity.yaw, 3),
      pitch: round(bot.entity.pitch, 3),
      quickBarSlot: bot.quickBarSlot,
      hotbar,
      heldItem: describeItem(bot.heldItem),
      targetBlock,
      // What a right-click would place, precomputed so the browser can draw
      // the block the instant it is clicked (see client/place.js).
      placeTarget,
      timeOfDay: bot.time ? bot.time.timeOfDay : 0,
      isRaining: Boolean(bot.isRaining),
      gameMode: bot.game ? bot.game.gameMode : null,
      dimension: bot.game ? bot.game.dimension : null,
      playerCount: Object.keys(bot.players || {}).length,
      players: this._playerList(bot)
    }
  }
}

// The Tab list is capped like vanilla's own overlay.
const MAX_LISTED_PLAYERS = 80

module.exports = StatePusher
