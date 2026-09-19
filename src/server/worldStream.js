'use strict'
// Deep require: the viewer barrel (prismarine-viewer/viewer) pulls in the
// THREE renderer and node-canvas, which only exist in the browser bundle.
// worldView.js itself is pure data streaming — safe on the server.
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView')

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

  const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, socket)
  worldView.init(bot.entity.position)
  worldView.listenToBot(bot)

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
  // burst of events per tick, per viewer. Coalesce to one packet per tick.
  let moved = false
  const onMove = () => { moved = true }
  const positionTimer = setInterval(() => {
    if (!moved) return
    moved = false
    sendPosition()
  }, 50)
  bot.on('move', onMove)
  sendPosition()

  let detached = false
  return () => {
    if (detached) return
    detached = true
    clearInterval(positionTimer)
    bot.removeListener('move', onMove)
    worldView.removeListenersFromBot(bot)
    worldView.removeAllListeners()
  }
}

module.exports = { attachWorldView }
