'use strict'

const THREE = global.THREE

const STAGES = 10

/**
 * Vanilla-style crack overlay for the shared dig. The server owns dig timing —
 * it knows the block and the held tool — so it announces how long the dig will
 * take and we animate the ten destroy stages across that span locally. Without
 * this a mined block just silently pops seconds after the click, which is
 * indistinguishable from lag.
 */
class BreakingAnimation {
  constructor (scene) {
    this.scene = scene
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
    this.active = {
      startedAt: performance.now(),
      ms: Math.max(50, Number(payload.ms) || 1000)
    }
    this.mesh.position.set(x + 0.5, y + 0.5, z + 0.5)
    this.mesh.material = this.materials[0]
    this.mesh.visible = true
  }

  stop () {
    this.active = null
    if (this.mesh) this.mesh.visible = false
  }

  update () {
    if (!this.active || !this.mesh) return
    const t = (performance.now() - this.active.startedAt) / this.active.ms
    // Well past the announced duration with no dig:stop — the dig was
    // interrupted and the stop got coalesced away; don't show cracks forever.
    if (t >= 1.5) {
      this.stop()
      return
    }
    this.mesh.material = this.materials[Math.min(STAGES - 1, Math.floor(t * STAGES))]
  }
}

module.exports = BreakingAnimation
