'use strict'
// Deep require: the viewer barrel (prismarine-viewer/viewer) pulls in the
// THREE renderer and node-canvas, which only exist in the browser bundle.
// worldView.js itself is pure data streaming — safe on the server.
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView')
const { EventEmitter } = require('events')

// One physics tick; entity moves are merged per entity within it.
const ENTITY_FLUSH_MS = 50
// Same tick, for the camera position stream.
const POSITION_MS = 50

/**
 * The emitter WorldView writes to. Everything passes straight through to the
 * socket except 'entity', which WorldView fires once per entityMoved: on a
 * busy server that measured ~250 messages a second per viewer, a third of them
 * yaw/pitch only. Moves are merged per entity and flushed as one 'entities'
 * array per tick; the client fans them back out to viewer.updateEntity.
 */
function createStreamEmitter (socket) {
  const emitter = new EventEmitter()
  const emitLocal = emitter.emit.bind(emitter)
  let batch = []
  const pending = new Map()

  emitter.emit = (event, payload) => {
    if (event !== 'entity') return socket.emit(event, payload)
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

  // WorldView listens on its emitter for the click raycast the browser sends.
  const onClick = click => emitLocal('mouseClick', click)
  socket.on('mouseClick', onClick)

  const timer = setInterval(() => {
    if (batch.length === 0) return
    socket.emit('entities', batch)
    batch = []
    pending.clear()
  }, ENTITY_FLUSH_MS)

  return {
    emitter,
    stop () {
      clearInterval(timer)
      socket.removeListener('mouseClick', onClick)
    }
  }
}

/**
 * Streams the world around the bot to one browser socket.
 *
 * WorldView does the heavy lifting: it emits 'loadChunk' / 'unloadChunk' /
 * 'entity' / 'blockUpdate' onto the socket, and it listens for a 'mouseClick'
 * message which it raycasts against the real world and re-emits to us as
 * 'blockClicked'. We only add the per-tick camera position packet.
 *
 * Returns a detach function.
 */
function attachWorldView (bot, socket, viewDistance, onBlockClicked) {
  socket.emit('version', bot.version)

  const stream = createStreamEmitter(socket)
  const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, stream.emitter)
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

  if (onBlockClicked) {
    worldView.on('blockClicked', (block, face, button) => onBlockClicked(block, face, button))
  }

  const sendPosition = () => {
    socket.emit('position', {
      pos: bot.entity.position,
      yaw: bot.entity.yaw,
      pitch: bot.entity.pitch,
      addMesh: true
    })
    worldView.updatePosition(bot.entity.position)
  }

  // 'move' fires for every physics correction — on a busy server that's a
  // burst of events per tick, per viewer. Still one packet per 50ms window,
  // but on the window's leading edge: the old interval poll cost every camera
  // update the remainder of its tick (~25ms on average) before anyone saw it.
  // The trailing timer still puts the resting position on the wire.
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
  return () => {
    if (detached) return
    detached = true
    clearTimeout(positionTimer)
    stream.stop()
    bot.removeListener('move', onMove)
    bot.removeListener('itemDrop', sendDroppedItem)
    worldView.removeListenersFromBot(bot)
    worldView.removeAllListeners()
  }
}

module.exports = { attachWorldView }
