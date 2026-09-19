'use strict'

const THREE = global.THREE

// Must match MAX_LIGHTS in src/server/lights.js. The pool is fixed — unused
// lights sit at intensity 0 instead of leaving the scene — because three.js
// compiles one shader program per light count; adding and removing lights as
// torches come and go would recompile every material each time.
const POOL_SIZE = 16

// Vanilla block light is warm; distance tracks the emit level so a torch
// (14) reaches about as far as its real light would. No shadows: a real
// Minecraft torch floods light through a BFS that walls stop, a point light
// shines straight through them. Wrong in caves' edge cases, right everywhere
// it matters, and 16 shadow-casting lights would be unrenderable anyway.
const COLOR = 0xffb066

/**
 * Torch/glowstone/lava light. The mesher only bakes ambient occlusion — the
 * viewer never sees Minecraft's block light — so the server streams the
 * nearest emitting blocks (see 'lights' in the protocol) and each becomes a
 * THREE.PointLight the chunk meshes' Lambert material picks up per-vertex.
 */
class BlockLights {
  constructor (scene) {
    this.pool = []
    for (let i = 0; i < POOL_SIZE; i++) {
      const light = new THREE.PointLight(COLOR, 0, 16, 2)
      scene.add(light)
      this.pool.push(light)
    }
  }

  set (lights) {
    for (let i = 0; i < this.pool.length; i++) {
      const light = this.pool[i]
      const src = lights[i]
      if (!src) {
        light.intensity = 0
        continue
      }
      light.position.set(src.x, src.y, src.z)
      light.distance = src.level + 2
      light.intensity = src.level / 15
    }
  }
}

module.exports = BlockLights
