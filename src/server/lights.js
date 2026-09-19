'use strict'
const { hasFinitePosition } = require('./raycast')

const TICK_MS = 250
// Point lights fade to nothing well inside this; anything further is wasted
// wire and wasted per-vertex shading in the browser.
const RADIUS = 48
// Must match the light pool in src/client/lights.js — the client's pool is
// fixed so three.js compiles its shaders once, so extras would be dropped.
const MAX_LIGHTS = 16
// Emitters in chunks this far out are dropped even if we never saw the unload
// event, so the map cannot grow without bound on a long walk.
const PRUNE_RADIUS = 192
// Re-sort the nearest set when the bot has moved this far since the last one.
const MOVE_EPSILON = 2

/**
 * Tracks light-emitting blocks (torches, glowstone, lava, …) around the bot
 * and streams the nearest few to every browser.
 *
 * This exists because the viewer has no use for Minecraft's real light data:
 * its mesher bakes only ambient occlusion, and the prebuilt worker.js can't be
 * taught block light without rebuilding it. Night is a scene-wide dimming from
 * sky.js, so a placed torch changed nothing. The browsers turn these packets
 * into THREE.PointLights, which the world's Lambert material does respond to.
 *
 * Emitters are found from block state ids, not light values, so this never
 * depends on the server's light packets: a scan of each loaded chunk (skipping
 * sections whose palette holds no emitter — nearly all of them), then kept
 * current from blockUpdate events.
 */
class LightTracker {
  constructor (io) {
    this.io = io
    this.bot = null
    this.timer = null
    this.listeners = []
    this.emitters = new Map() // 'x,y,z' -> { x, y, z, level }
    this.emitCache = new Map() // block state id -> emitLight level
    this.dirty = false
    this.lastSerialized = null
    this.lastPayload = null
    this.lastPos = null
  }

  setBot (bot) {
    this.clearBot()
    this.bot = bot
    // State ids are version-specific and reconnects can land on a different
    // server version, so the cache lives and dies with the bot.
    this.emitCache.clear()

    this._listen(bot, 'chunkColumnLoad', pos => {
      this._scanColumn(bot, pos.x >> 4, pos.z >> 4)
    })
    this._listen(bot, 'chunkColumnUnload', pos => {
      this._dropChunk(pos.x >> 4, pos.z >> 4)
    })
    this._listen(bot, 'blockUpdate', (oldBlock, newBlock) => {
      if (!newBlock || !newBlock.position) return
      const { x, y, z } = newBlock.position
      this._setEmitter(x, y, z, this._emitLevel(bot.registry, newBlock.stateId))
    })

    // Chunks that loaded before the bot was handed to us.
    for (const { chunkX, chunkZ } of bot.world.getColumns()) {
      this._scanColumn(bot, Number(chunkX), Number(chunkZ))
    }
  }

  clearBot () {
    for (const [emitter, event, fn] of this.listeners) emitter.removeListener(event, fn)
    this.listeners = []
    this.bot = null
    this.emitters.clear()
    this.dirty = false
    this.lastSerialized = null
    this.lastPayload = null
    this.lastPos = null
  }

  sendTo (socket) {
    if (this.lastPayload) socket.emit('lights', this.lastPayload)
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

  _listen (emitter, event, fn) {
    emitter.on(event, fn)
    this.listeners.push([emitter, event, fn])
  }

  _emitLevel (registry, stateId) {
    let level = this.emitCache.get(stateId)
    if (level === undefined) {
      const block = registry.blocksByStateId[stateId]
      level = (block && block.emitLight) || 0
      this.emitCache.set(stateId, level)
    }
    return level
  }

  _setEmitter (x, y, z, level) {
    const key = `${x},${y},${z}`
    if (level > 0) {
      const known = this.emitters.get(key)
      if (known && known.level === level) return
      this.emitters.set(key, { x, y, z, level })
      this.dirty = true
    } else if (this.emitters.delete(key)) {
      this.dirty = true
    }
  }

  _dropChunk (chunkX, chunkZ) {
    for (const [key, e] of this.emitters) {
      if (e.x >> 4 === chunkX && e.z >> 4 === chunkZ) {
        this.emitters.delete(key)
        this.dirty = true
      }
    }
  }

  _scanColumn (bot, chunkX, chunkZ) {
    const column = bot.world.getColumn(chunkX, chunkZ)
    if (!column || !Array.isArray(column.sections)) return
    const minY = Number.isFinite(column.minY) ? column.minY : 0

    for (let s = 0; s < column.sections.length; s++) {
      const section = column.sections[s]
      if (!section) continue
      const palette = sectionPalette(section)
      // A palette that names no emitter clears the whole 16^3 in one pass —
      // that's almost every section. No palette (direct/global encoding, or an
      // old format) means we have to look at the blocks.
      if (palette && !palette.some(id => this._emitLevel(bot.registry, id) > 0)) continue

      const baseY = minY + s * 16
      const pos = { x: 0, y: 0, z: 0 }
      for (let dy = 0; dy < 16; dy++) {
        pos.y = baseY + dy
        for (let dz = 0; dz < 16; dz++) {
          pos.z = dz
          for (let dx = 0; dx < 16; dx++) {
            pos.x = dx
            const level = this._emitLevel(bot.registry, column.getBlockStateId(pos))
            if (level > 0) this._setEmitter(chunkX * 16 + dx, pos.y, chunkZ * 16 + dz, level)
          }
        }
      }
    }
  }

  _tick () {
    const bot = this.bot
    if (!bot || !hasFinitePosition(bot)) return
    const pos = bot.entity.position
    const moved = !this.lastPos || pos.distanceTo(this.lastPos) > MOVE_EPSILON
    if (!this.dirty && !moved) return
    this.dirty = false
    this.lastPos = pos.clone()

    const nearest = []
    for (const [key, e] of this.emitters) {
      const dx = e.x + 0.5 - pos.x
      const dy = e.y + 0.5 - pos.y
      const dz = e.z + 0.5 - pos.z
      const distSq = dx * dx + dy * dy + dz * dz
      if (distSq > PRUNE_RADIUS * PRUNE_RADIUS) {
        this.emitters.delete(key)
      } else if (distSq <= RADIUS * RADIUS) {
        nearest.push({ distSq, e })
      }
    }
    nearest.sort((a, b) => a.distSq - b.distSq)

    const payload = nearest.slice(0, MAX_LIGHTS).map(({ e }) => ({
      x: e.x + 0.5, y: e.y + 0.5, z: e.z + 0.5, level: e.level
    }))
    const serialized = JSON.stringify(payload)
    if (serialized === this.lastSerialized) return
    this.lastSerialized = serialized
    this.lastPayload = payload
    this.io.emit('lights', payload)
  }
}

function sectionPalette (section) {
  const data = section.data
  if (data) {
    if (Array.isArray(data.palette)) return data.palette // indirect palette
    if (typeof data.value === 'number') return [data.value] // single-value section
    return null // direct encoding: every distinct state, must scan
  }
  return Array.isArray(section.palette) ? section.palette : null // pre-1.18 formats
}

module.exports = LightTracker
