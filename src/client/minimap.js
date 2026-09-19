'use strict'

/**
 * Top-right minimap. The server samples the terrain colors (the meshed world
 * here lives inside the viewer's workers, out of reach); we just blit the RGBA
 * frame onto a canvas and spin the arrow with the local camera yaw, so it
 * turns with the mouse instead of waiting for the server round trip.
 */
class Minimap {
  constructor () {
    this.root = document.getElementById('minimap')
    this.canvas = document.getElementById('minimap-canvas')
    this.ctx = this.canvas.getContext('2d')
    this.arrow = document.getElementById('minimap-arrow')
    this.lastYaw = null
  }

  setFrame (frame) {
    const raw = frame.colors
    const bytes = ArrayBuffer.isView(raw)
      ? new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength)
      : new Uint8ClampedArray(raw)
    if (bytes.length !== frame.size * frame.size * 4) return
    if (this.canvas.width !== frame.size) {
      this.canvas.width = frame.size
      this.canvas.height = frame.size
    }
    this.ctx.putImageData(new ImageData(bytes, frame.size, frame.size), 0, 0)
    this.root.classList.add('live')
  }

  setYaw (yaw) {
    if (yaw === this.lastYaw) return
    this.lastYaw = yaw
    // The map is north-up. mineflayer yaw is 0 at north and grows towards
    // west; CSS rotation grows clockwise, so the arrow turns by the negative.
    this.arrow.style.transform = `translate(-50%, -50%) rotate(${-yaw}rad)`
  }
}

module.exports = Minimap
