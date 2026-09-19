'use strict'
const { Vec3 } = require('vec3')
const { hasFinitePosition } = require('./raycast')

// One pixel per block, bot in the middle.
const SIZE = 64
const HALF = SIZE / 2

const TICK_MS = 500
// A still bot gets a refresh now and then anyway, so block changes show up
// without subscribing to every blockUpdate in the area.
const FORCE_MS = 5000

// Each column is scanned downward from just above the bot. The window is
// deliberately shallow: 64 levels over 64x64 columns is the whole CPU budget
// of a frame, and far outside it a surface map stops meaning anything.
const SCAN_UP = 20
const SCAN_DOWN = 44

const NO_HEIGHT = -32768

// Loose vanilla-map palette; first substring match wins, so red_sand must sit
// above sand. Misses fall back to stone gray, which is what most misses are.
const PALETTE = [
  ['grass_block', [127, 178, 56]],
  ['water', [64, 63, 252]],
  ['bubble_column', [64, 63, 252]],
  ['lava', [216, 100, 10]],
  ['snow', [249, 255, 254]],
  ['ice', [160, 160, 255]],
  ['red_sand', [216, 127, 51]],
  ['sand', [247, 233, 163]],
  ['leaves', [0, 124, 0]],
  ['podzol', [129, 86, 49]],
  ['mycelium', [111, 99, 105]],
  ['dirt', [151, 109, 77]],
  ['farmland', [151, 109, 77]],
  ['path', [148, 122, 65]],
  ['gravel', [136, 136, 136]],
  ['clay', [164, 168, 184]],
  ['deepslate', [80, 80, 80]],
  ['netherrack', [112, 2, 0]],
  ['planks', [143, 119, 72]],
  ['log', [102, 81, 50]],
  ['wood', [102, 81, 50]],
  ['terracotta', [152, 94, 67]],
  ['obsidian', [21, 20, 31]]
]
const FALLBACK = [112, 112, 112]

// boundingBox 'empty' normally means "scan through this" — air, torches,
// flowers, rails — but a few of those are exactly what a map is for.
const OPAQUE_ANYWAY = new Set(['water', 'lava', 'bubble_column', 'snow', 'powder_snow'])

function colorFor (block) {
  if (block.boundingBox === 'empty' && !OPAQUE_ANYWAY.has(block.name)) return null
  for (const [needle, rgb] of PALETTE) {
    if (block.name.includes(needle)) return rgb
  }
  return FALLBACK
}

// Vanilla maps read relief by brightening a column that stands above its
// northern neighbour and darkening one that sits below it.
function shade (colors, heights) {
  for (let i = SIZE; i < SIZE * SIZE; i++) {
    const h = heights[i]
    const north = heights[i - SIZE]
    if (h === NO_HEIGHT || north === NO_HEIGHT || h === north) continue
    const factor = h > north ? 1.16 : 0.7
    const o = i * 4
    colors[o] = Math.min(255, colors[o] * factor)
    colors[o + 1] = Math.min(255, colors[o + 1] * factor)
    colors[o + 2] = Math.min(255, colors[o + 2] * factor)
  }
}

/**
 * Renders a top-down color map of the terrain around the bot and pushes it to
 * every browser. Sampling happens here rather than in the client because the
 * meshed world lives inside the viewer's workers — the bot's world is the only
 * place a straight column scan is cheap, and it keeps the bot authoritative.
 */
class MinimapPusher {
  constructor (io) {
    this.io = io
    this.bot = null
    this.timer = null
    this.lastFrame = null
    this.lastRenderAt = 0
    this.colorCache = new Map() // block state id -> rgb | null, per bot version
  }

  setBot (bot) {
    this.bot = bot
    this.lastFrame = null
    this.lastRenderAt = 0
    // State ids are version-specific and the bot can reconnect to a different
    // server version, so the cache lives and dies with the bot.
    this.colorCache.clear()
  }

  clearBot () {
    this.bot = null
    this.lastFrame = null
  }

  sendTo (socket) {
    if (this.lastFrame) socket.emit('minimap', this.lastFrame)
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
    const bot = this.bot
    if (!bot || !hasFinitePosition(bot)) return
    const cx = Math.floor(bot.entity.position.x)
    const cz = Math.floor(bot.entity.position.z)
    const moved = !this.lastFrame || this.lastFrame.center.x !== cx || this.lastFrame.center.z !== cz
    if (!moved && Date.now() - this.lastRenderAt < FORCE_MS) return
    this.lastRenderAt = Date.now()

    const frame = this._render(bot, cx, cz)
    const unchanged = !moved && this.lastFrame && frame.colors.equals(this.lastFrame.colors)
    this.lastFrame = frame
    if (!unchanged) this.io.emit('minimap', frame)
  }

  _render (bot, cx, cz) {
    const world = bot.world
    const game = bot.game || {}
    const minY = Number.isFinite(game.minY) ? game.minY : 0
    const maxY = minY + (Number.isFinite(game.height) ? game.height : 256) - 1
    const botY = Math.floor(bot.entity.position.y)
    const yTop = Math.min(botY + SCAN_UP, maxY)
    const yBottom = Math.max(botY - SCAN_DOWN, minY)

    const colors = Buffer.alloc(SIZE * SIZE * 4) // transparent until painted
    const heights = new Int16Array(SIZE * SIZE).fill(NO_HEIGHT)
    const cursor = new Vec3(0, 0, 0) // chunk-local x/z, absolute y

    let column = null
    let colX = NaN
    let colZ = NaN

    for (let dz = 0; dz < SIZE; dz++) {
      const z = cz - HALF + dz
      for (let dx = 0; dx < SIZE; dx++) {
        const x = cx - HALF + dx
        const chunkX = x >> 4
        const chunkZ = z >> 4
        if (chunkX !== colX || chunkZ !== colZ) {
          colX = chunkX
          colZ = chunkZ
          column = world.getColumn(chunkX, chunkZ) || null
        }
        if (!column) continue // unloaded chunk stays transparent

        cursor.x = x & 15
        cursor.z = z & 15
        for (let y = yTop; y >= yBottom; y--) {
          cursor.y = y
          const rgb = this._color(bot.registry, column.getBlockStateId(cursor))
          if (!rgb) continue
          const i = dz * SIZE + dx
          heights[i] = y
          colors[i * 4] = rgb[0]
          colors[i * 4 + 1] = rgb[1]
          colors[i * 4 + 2] = rgb[2]
          colors[i * 4 + 3] = 255
          break
        }
      }
    }

    shade(colors, heights)
    return { size: SIZE, center: { x: cx, z: cz }, colors }
  }

  _color (registry, stateId) {
    let rgb = this.colorCache.get(stateId)
    if (rgb === undefined) {
      const block = registry.blocksByStateId[stateId]
      rgb = block ? colorFor(block) : null
      this.colorCache.set(stateId, rgb)
    }
    return rgb
  }
}

module.exports = MinimapPusher
