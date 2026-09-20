'use strict'
// Deep require: the viewer barrel (prismarine-viewer/viewer) pulls in the
// THREE renderer and node-canvas, which only exist in the browser bundle.
// worldView.js itself is pure data streaming — safe on the server.
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView')
const { spiral, chunkPos } = require('prismarine-viewer/viewer/lib/simpleUtils')
const { Vec3 } = require('vec3')
const { EventEmitter } = require('events')
const { counters } = require('./metrics')

// One physics tick; entity moves are merged per entity within it.
const ENTITY_FLUSH_MS = 50
// Same tick, for the camera position stream.
const POSITION_MS = 50
// A late joiner's catch-up sends this many cached columns per tick, the same
// pace WorldView paces its own initial load.
const CATCH_UP_SLICE = 5

/**
 * The emitter WorldView writes to. Everything passes straight through to the
 * session except 'entity', which WorldView fires once per entityMoved: on a
 * busy server that measured ~250 messages a second, a third of them yaw/pitch
 * only. Moves are merged per entity and flushed as one 'entities' array per
 * tick; the client fans them back out to viewer.updateEntity.
 *
 * `target` is whatever the session speaks through and only ever sees emit().
 */
function createStreamEmitter (target) {
  const emitter = new EventEmitter()
  let batch = []
  const pending = new Map()

  emitter.emit = (event, payload) => {
    if (event === 'loadChunk') {
      counters.columnsSent += 1
      counters.chunkBytes += payload.chunk.length
    }
    if (event !== 'entity') return target.emit(event, payload)
    const current = pending.get(payload.id)
    // A spawn or a removal starts a fresh record, so a delete followed by a
    // respawn of the same id keeps its order; plain moves fold into it.
    if (current && !payload.delete && payload.name === undefined) {
      Object.assign(current, payload)
    } else {
      pending.set(payload.id, payload)
      batch.push(payload)
    }
    return true
  }

  const timer = setInterval(() => {
    if (batch.length === 0) return
    target.emit('entities', batch)
    batch = []
    pending.clear()
  }, ENTITY_FLUSH_MS)

  return {
    emitter,
    stop () {
      clearInterval(timer)
    }
  }
}

const columnKey = (x, z) => `${x},${z}`

function entitySpawn (e) {
  const record = { id: e.id, name: e.name, pos: e.position, width: e.width, height: e.height, username: e.username }
  if (e.name === 'item') {
    try {
      const item = e.getDroppedItem && e.getDroppedItem()
      if (item) record.itemName = item.name
    } catch (err) {
      // metadata mineflayer cannot decode; the mob-model fallback is still fine
    }
  }
  return record
}

/**
 * Streams the world around the bot to everyone in its session.
 *
 * One per bot, not one per browser. prismarine's WorldView tracks which
 * chunks "the client" has been sent, and every member of a session watches
 * the same bot from the same place, so the session is the client: columns
 * are serialised once and the entity firehose is batched once, however many
 * riders there are. A member who joins after the stream is up gets a
 * catch-up of the cached columns rather than a second WorldView.
 *
 * WorldView does the heavy lifting: it emits 'loadChunk' / 'unloadChunk' /
 * 'entity' / 'blockUpdate' onto the emitter. We add the column cache, the
 * per-tick camera position packet and the catch-up.
 *
 * Returns { detach, catchUp(socket) }.
 */
function attachWorldView (bot, target, viewDistance) {
  target.emit('version', bot.version)

  const stream = createStreamEmitter(target)
  const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, stream.emitter)

  // column.toJson() is the expensive half of streaming a chunk — tens of
  // kilobytes of palette and light data per column — and it is the same
  // string for every member. Cached by column until the world says otherwise.
  const columns = new Map() // 'x,z' (block coords) -> JSON string

  const serialize = async pos => {
    const key = columnKey(pos.x, pos.z)
    let chunk = columns.get(key)
    if (chunk !== undefined) return chunk
    const column = await bot.world.getColumnAt(pos)
    if (!column) return null
    chunk = column.toJson()
    counters.columnsSerialized += 1
    columns.set(key, chunk)
    return chunk
  }

  // Same rule as upstream's loadChunk, with the cache in front of toJson().
  worldView.loadChunk = async function (pos) {
    const [botX, botZ] = chunkPos(this.lastPos)
    const dx = Math.abs(botX - Math.floor(pos.x / 16))
    const dz = Math.abs(botZ - Math.floor(pos.z / 16))
    if (dx >= this.viewDistance || dz >= this.viewDistance) return
    const chunk = await serialize(pos)
    if (chunk === null) return
    this.emitter.emit('loadChunk', { x: pos.x, z: pos.z, chunk })
    this.loadedChunks[columnKey(pos.x, pos.z)] = true
  }
  const unloadChunk = worldView.unloadChunk.bind(worldView)
  worldView.unloadChunk = pos => {
    columns.delete(columnKey(pos.x, pos.z))
    unloadChunk(pos)
  }

  // Registered before listenToBot so they run first: a column that changed
  // is forgotten before WorldView re-sends it.
  const invalidateBlock = (oldBlock, newBlock) => {
    const p = (newBlock && newBlock.position) || (oldBlock && oldBlock.position)
    if (p) columns.delete(columnKey((p.x >> 4) * 16, (p.z >> 4) * 16))
  }
  const invalidateColumn = pos => columns.delete(columnKey(pos.x, pos.z))
  bot.on('blockUpdate', invalidateBlock)
  bot.on('chunkColumnLoad', invalidateColumn)
  bot.on('chunkColumnUnload', invalidateColumn)

  worldView.init(bot.entity.position)
  worldView.listenToBot(bot)

  // WorldView's own entitySpawn handler forwards only id/name/pos/width/height/
  // username, so a dropped-item entity ("item") carries no clue which item it
  // is — that only lives in raw metadata, which mineflayer decodes for us via
  // entity.getDroppedItem(). Send it as a second, merged 'entity' update; the
  // client keys off itemName to draw that item's real texture instead of
  // falling back to prismarine-viewer's mob-model path (which has no "item"
  // model and would otherwise throw "Unknown entity item"). It goes through
  // the stream emitter so it folds into the spawn record it belongs to rather
  // than overtaking it on the socket.
  //
  // Must listen on 'itemDrop', not 'entitySpawn': on modern protocol versions
  // item entities spawn via spawn_entity, which carries no metadata at all —
  // the item stack only arrives later on a separate entity_metadata packet.
  // getDroppedItem() reads entity.metadata directly, so calling it during
  // entitySpawn hits Item.fromNotch(undefined) and throws. mineflayer emits
  // 'itemDrop' precisely once that metadata packet has landed.
  const sendDroppedItem = (entity) => {
    if (entity.name !== 'item') return
    // fromNotch inside getDroppedItem throws on metadata shapes it doesn't
    // know; a weird stack must not take the whole server down.
    let item = null
    try {
      item = entity.getDroppedItem && entity.getDroppedItem()
    } catch (err) {
      return
    }
    if (!item) return
    stream.emitter.emit('entity', { id: entity.id, itemName: item.name })
  }
  bot.on('itemDrop', sendDroppedItem)

  const positionPacket = () => ({
    pos: bot.entity.position,
    yaw: bot.entity.yaw,
    pitch: bot.entity.pitch,
    addMesh: true
  })
  const sendPosition = () => {
    target.emit('position', positionPacket())
    worldView.updatePosition(bot.entity.position)
  }

  // 'move' fires for every physics correction — on a busy server that's a
  // burst of events per tick. Still one packet per 50ms window, but on the
  // window's leading edge: the old interval poll cost every camera update the
  // remainder of its tick (~25ms on average) before anyone saw it. The
  // trailing timer still puts the resting position on the wire.
  let lastPositionAt = 0
  let positionTimer = null
  const sendPositionNow = () => {
    lastPositionAt = Date.now()
    sendPosition()
  }
  const onMove = () => {
    if (positionTimer) return
    const wait = POSITION_MS - (Date.now() - lastPositionAt)
    if (wait <= 0) {
      sendPositionNow()
      return
    }
    positionTimer = setTimeout(() => {
      positionTimer = null
      sendPositionNow()
    }, wait)
    positionTimer.unref?.()
  }
  bot.on('move', onMove)
  sendPosition()

  let detached = false
  const catchUps = new Set()

  /**
   * Everything a browser that joined after the stream started has missed:
   * the columns in view, the entities around, and where the camera is.
   * Sent to that socket alone; the live stream keeps going to the room.
   */
  const catchUp = socket => {
    socket.emit('version', bot.version)
    const [botX, botZ] = chunkPos(worldView.lastPos)
    const positions = []
    spiral(viewDistance * 2, viewDistance * 2, (x, z) => {
      const p = new Vec3((botX + x) * 16, 0, (botZ + z) * 16)
      if (worldView.loadedChunks[columnKey(p.x, p.z)]) positions.push(p)
    })
    let i = 0
    const step = async () => {
      if (detached || !socket.connected) {
        catchUps.delete(step)
        return
      }
      const slice = positions.slice(i, i + CATCH_UP_SLICE)
      i += CATCH_UP_SLICE
      for (const p of slice) {
        const chunk = await serialize(p)
        if (chunk === null || !socket.connected) continue
        counters.columnsSent += 1
        counters.chunkBytes += chunk.length
        socket.emit('loadChunk', { x: p.x, z: p.z, chunk })
      }
      if (i < positions.length) {
        setTimeout(step, 0)
        return
      }
      catchUps.delete(step)
      for (const id in bot.entities) {
        const e = bot.entities[id]
        if (e && e !== bot.entity) socket.emit('entity', entitySpawn(e))
      }
      socket.emit('position', positionPacket())
    }
    catchUps.add(step)
    step()
  }

  const detach = () => {
    if (detached) return
    detached = true
    catchUps.clear()
    clearTimeout(positionTimer)
    stream.stop()
    columns.clear()
    bot.removeListener('move', onMove)
    bot.removeListener('itemDrop', sendDroppedItem)
    bot.removeListener('blockUpdate', invalidateBlock)
    bot.removeListener('chunkColumnLoad', invalidateColumn)
    bot.removeListener('chunkColumnUnload', invalidateColumn)
    worldView.removeListenersFromBot(bot)
    worldView.removeAllListeners()
  }

  return { detach, catchUp }
}

module.exports = { attachWorldView }
