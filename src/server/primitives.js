'use strict'

/**
 * Debug shapes drawn into one viewer. The browser-side Viewer already
 * understands the 'primitive' message; the bookkeeping is so a reconnecting
 * client can be resent whatever is currently drawn.
 *
 * Per visitor, because the only primitive we draw is that bot's pathfinder
 * route, which is meaningless in anyone else's view.
 */
class Primitives {
  constructor (socket) {
    this.socket = socket
    this.items = new Map()
  }

  line (id, points, color = 0xff00ff) {
    const primitive = { type: 'line', id, points, color }
    this.items.set(id, primitive)
    this.socket.emit('primitive', primitive)
  }

  erase (id) {
    if (!this.items.delete(id)) return
    this.socket.emit('primitive', { id })
  }

  sendAll (socket) {
    for (const primitive of this.items.values()) socket.emit('primitive', primitive)
  }
}

module.exports = Primitives
