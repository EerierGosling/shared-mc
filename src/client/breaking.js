'use strict'

const THREE = global.THREE

const STAGES = 10
// Vanilla chips one particle off the block every game tick while mining.
const CRACK_MS = 50

/**
 * Vanilla-style crack overlay for the shared dig. The server owns dig timing —
 * it knows the block and the held tool — so it announces how long the dig will
 * take and we animate the ten destroy stages across that span locally. Without
 * this a mined block just silently pops seconds after the click, which is
 * indistinguishable from lag.
 *
 * Also paces the crack particles (particles.js): one chip a tick off the face
 * under the crosshair for as long as the dig runs, and the burst when the
 * server says the block actually broke.
 */
class BreakingAnimation {
  constructor (scene, particles) {
    this.scene = scene
    this.particles = particles
    this.materials = null
    this.mesh = null
    this.active = null
  }

  setVersion (version) {
    // The bot can reconnect to a different server version; rebuild against the
    // matching texture set.
    if (this.mesh) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
    }
    const loader = new THREE.TextureLoader()
    this.materials = []
    for (let i = 0; i < STAGES; i++) {
      const texture = loader.load(`textures/${version}/blocks/destroy_stage_${i}.png`)
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      this.materials.push(new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false
      }))
    }
    // Slightly oversized so the cracks float in front of the block faces.
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1.004, 1.004, 1.004), this.materials[0])
    this.mesh.visible = false
    this.scene.add(this.mesh)
  }

  start (payload) {
    if (!this.mesh || !payload || !payload.position) return
    const { x, y, z } = payload.position
    const now = performance.now()
    this.active = {
      startedAt: now,
      ms: Math.max(50, Number(payload.ms) || 1000),
      position: { x, y, z },
      name: payload.name,
      face: payload.face,
      lastCrackAt: now
    }
    this.mesh.position.set(x + 0.5, y + 0.5, z + 0.5)
    this.mesh.material = this.materials[0]
    this.mesh.visible = true
  }

  /**
   * The crosshair can slide across the block mid-dig; the chips follow it to
   * whichever side it is on now. Ignored for any other block.
   */
  setTarget (target) {
    const active = this.active
    if (!active || !target || target.face === undefined) return
    const p = target.position
    if (p.x !== active.position.x || p.y !== active.position.y || p.z !== active.position.z) return
    active.face = target.face
  }

  /** `payload.broken` is the server confirming the block is gone. */
  stop (payload) {
    this.active = null
    if (this.mesh) this.mesh.visible = false
    if (payload && payload.broken && payload.position && this.particles) {
      this.particles.burst(payload.position, payload.name)
    }
  }

  update () {
    if (!this.active || !this.mesh) return
    const now = performance.now()
    const t = (now - this.active.startedAt) / this.active.ms
    // Well past the announced duration with no dig:stop — the dig was
    // interrupted and the stop got coalesced away; don't show cracks forever.
    if (t >= 1.5) {
      this.stop()
      return
    }
    this.mesh.material = this.materials[Math.min(STAGES - 1, Math.floor(t * STAGES))]
    if (!this.particles) return
    // Whole ticks since the last chip, capped so a stalled tab does not
    // dump a cloud on return.
    let due = Math.min(4, Math.floor((now - this.active.lastCrackAt) / CRACK_MS))
    if (due <= 0) return
    this.active.lastCrackAt = now
    const { position, face, name } = this.active
    while (due-- > 0) this.particles.crack(position, face, name)
  }
}

module.exports = BreakingAnimation
