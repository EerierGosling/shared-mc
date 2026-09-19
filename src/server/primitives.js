'use strict'

/**
 * Debug shapes drawn into every connected viewer. The browser-side Viewer
 * already understands the 'primitive' message, so this is just bookkeeping so
 * late joiners see what is currently drawn.
 */
class Primitives {
  constructor (io) {
    this.io = io
    this.items = new Map()
  }

  line (id, points, color = 0xff00ff) {
    const primitive = { type: 'line', id, points, color }
    this.items.set(id, primitive)
    this.io.emit('primitive', primitive)
  }

  erase (id) {
    if (!this.items.delete(id)) return
    this.io.emit('primitive', { id })
  }

  sendAll (socket) {
    for (const primitive of this.items.values()) socket.emit('primitive', primitive)
  }
}

module.exports = Primitives
