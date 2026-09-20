'use strict'

const THREE = global.THREE

// 64 world blocks across, same window the old server-side scan used. Rendered
// at 128px so block textures keep a little detail.
const VIEW = 64
const SIZE = 128
const INTERVAL_MS = 100
// Clip everything above eye level + UP so being underground maps the cave
// level instead of the surface roof; the far plane bounds the drop below.
const UP = 20
const DOWN = 44

/**
 * Top-right minimap, rendered entirely client-side: an orthographic top-down
 * pass over the world the viewer has already meshed. The server used to scan
 * block columns for this, which stalled its event loop mid-dig; here the GPU
 * redraws geometry it already has, and the map gets real textures for free.
 */
class Minimap {
  constructor (entities) {
    this.entities = entities
    this.root = document.getElementById('minimap')
    this.canvas = document.getElementById('minimap-canvas')
    this.canvas.width = SIZE
    this.canvas.height = SIZE
    this.ctx = this.canvas.getContext('2d')
    this.arrow = document.getElementById('minimap-arrow')
    this.lastYaw = null
    this.center = null
    this.lastRenderAt = 0

    this.camera = new THREE.OrthographicCamera(-VIEW / 2, VIEW / 2, VIEW / 2, -VIEW / 2, 0, UP + DOWN)
    // Straight-down lookAt is parallel to the default up vector; -Z up keeps
    // the map north-up, matching the arrow's rotation convention.
    this.camera.up.set(0, 0, -1)
    this.target = new THREE.WebGLRenderTarget(SIZE, SIZE)
    this.pixels = new Uint8Array(SIZE * SIZE * 4)
    this.flipped = new Uint8ClampedArray(SIZE * SIZE * 4)
    // Async readback state (WebGL2 only): the pixel-pack buffer the GPU
    // writes into and the fence that says it has finished doing so.
    this.pbo = null
    this.fence = null
  }

  setCenter (pos) {
    this.center = pos
  }

  render (renderer, scene) {
    if (!this.center) return
    const gl = renderer.getContext()

    // A previous pass may still be crossing the GPU→CPU gap; collect it (or
    // keep waiting) before starting another. Never more than one in flight.
    if (this.fence) {
      this._collect(gl)
      if (this.fence) return
    }

    const now = performance.now()
    if (now - this.lastRenderAt < INTERVAL_MS) return
    this.lastRenderAt = now

    this.camera.position.set(this.center.x, this.center.y + UP, this.center.z)
    this.camera.lookAt(this.center.x, this.center.y - DOWN, this.center.z)

    // Transparent clear: unloaded terrain shows the HUD ring, not sky color.
    const background = scene.background
    scene.background = null
    renderer.setRenderTarget(this.target)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.render(scene, this.camera)

    if (renderer.capabilities.isWebGL2) {
      // Async readback: readPixels into a pixel-pack buffer returns
      // immediately, and a fence tells us when the GPU has actually written
      // it. The naive readRenderTargetPixels drains the whole pipeline every
      // pass — a full GPU sync per minimap frame, felt as a main-render
      // hitch. The map shows up a frame or two late, which is nothing at
      // 10 updates a second.
      if (!this.pbo) {
        this.pbo = gl.createBuffer()
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo)
        gl.bufferData(gl.PIXEL_PACK_BUFFER, this.pixels.byteLength, gl.STREAM_READ)
      } else {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo)
      }
      gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      gl.flush()
      renderer.setRenderTarget(null)
      scene.background = background
      return
    }

    renderer.setRenderTarget(null)
    scene.background = background
    // WebGL1 has no fences or pixel-pack buffers; eat the synchronous read.
    renderer.readRenderTargetPixels(this.target, 0, 0, SIZE, SIZE, this.pixels)
    this._blit()
  }

  _collect (gl) {
    const status = gl.clientWaitSync(this.fence, 0, 0)
    if (status === gl.TIMEOUT_EXPIRED) return
    gl.deleteSync(this.fence)
    this.fence = null
    if (status === gl.WAIT_FAILED) return
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixels)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    this._blit()
  }

  _blit () {
    // GL reads rows bottom-up; flip so north stays at the top of the canvas.
    const row = SIZE * 4
    for (let y = 0; y < SIZE; y++) {
      this.flipped.set(this.pixels.subarray((SIZE - 1 - y) * row, (SIZE - y) * row), y * row)
    }
    this.ctx.putImageData(new ImageData(this.flipped, SIZE, SIZE), 0, 0)
    this.drawPlayers()
    this.root.classList.add('live')
  }

  // Other players, as dots over the terrain. Their meshes sit in the scene the
  // ortho pass just rendered, but at 2px per block a player is sub-pixel noise;
  // a drawn marker stays readable. Off-map players pin to the frame edge so
  // the dot still points the way, like vanilla map markers.
  drawPlayers () {
    if (!this.entities) return
    const scale = SIZE / VIEW
    const max = SIZE / 2 - 3
    for (const mesh of Object.values(this.entities.players)) {
      const dx = Math.max(-max, Math.min(max, (mesh.position.x - this.center.x) * scale))
      const dz = Math.max(-max, Math.min(max, (mesh.position.z - this.center.z) * scale))
      const x = Math.round(SIZE / 2 + dx)
      const y = Math.round(SIZE / 2 + dz)
      // Rects, not arcs: the canvas is upscaled with image-rendering: pixelated,
      // so hard square edges match the rest of the HUD.
      this.ctx.fillStyle = '#000'
      this.ctx.fillRect(x - 3, y - 3, 6, 6)
      this.ctx.fillStyle = '#fff'
      this.ctx.fillRect(x - 2, y - 2, 4, 4)
    }
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
