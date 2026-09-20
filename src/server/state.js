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

const round = (n, places = 2) => {
  const factor = Math.pow(10, places)
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
  }

  // Chat and death lines used to be relayed from here; chat.js and respawn.js
  // own them now.
  setBot (bot) {
    this.clearBot()
    this.bot = bot
  }

  clearBot () {
    for (const [emitter, event, fn] of this.listeners) emitter.removeListener(event, fn)
    this.listeners = []
    this.bot = null
    this.lastSerialized = null
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

  snapshot () {
    const bot = this.bot
    if (!bot || !bot.entity) return null

    const hotbar = []
    const slots = (bot.inventory && bot.inventory.slots) || []
    for (let i = 0; i < 9; i++) hotbar.push(describeItem(slots[36 + i]))

    let targetBlock = null
    let placeTarget = null
    const block = blockAtCursor(bot, this.config.reach)
    if (block) {
      try {
        targetBlock = {
          position: { x: block.position.x, y: block.position.y, z: block.position.z },
          name: block.name,
          displayName: block.displayName,
          diggable: bot.canDigBlock(block)
        }
        placeTarget = predictPlacement(bot, block)
      } catch (err) {
        targetBlock = null
        placeTarget = null
      }
    }

    return {
      username: bot.username,
      isAlive: bot.isAlive !== false,
      health: round(bot.health || 0, 1),
      food: bot.food,
      // 0-20; mineflayer scales the 300-tick air supply down by 15.
      oxygen: bot.oxygenLevel,
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
      players: playerList(bot)
    }
  }
}

// The Tab list: everyone the server reports, not just this site's visitors.
// Capped like vanilla's own overlay, and sorted so a ping tick does not
// reorder it.
const MAX_LISTED_PLAYERS = 80
function playerList (bot) {
  return Object.values(bot.players || {})
    .filter(p => p && p.username)
    .sort((a, b) => a.username.localeCompare(b.username))
    .slice(0, MAX_LISTED_PLAYERS)
    .map(p => ({ username: p.username, ping: Number.isFinite(p.ping) ? p.ping : null }))
}

module.exports = StatePusher
