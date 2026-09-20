'use strict'

const THREE = global.THREE
const icons = require('./icons')

// Live particles at once. A break is 64, a dig adds 20 a second, and one
// lives at most two seconds, so this is several blocks breaking together.
const CAPACITY = 1024
// Vanilla particle physics runs on the 20 Hz game tick; the constants below
// are per tick, so the simulation steps at that rate whatever the framerate.
const TICK_MS = 50
// Particles sit on layer 1 so the minimap's orthographic pass never sees
// them — point sprites are sized for a perspective camera.
const LAYER = 1

// down, up, north, south, west, east — prismarine's face index order.
const FACE_OFFSETS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]

// A face with a tintindex takes a biome colour in-game; particles get the
// plains palette, matching icons.js.
const GRASS_TINT = [145 / 255, 189 / 255, 89 / 255]
const FOLIAGE_TINT = [119 / 255, 171 / 255, 47 / 255]

// Scratch for the per-frame point-size uniform, which otherwise allocated a
// Vector2 every frame.
const _size = new THREE.Vector2()

const VERTEX = `
attribute vec4 uvRect;
attribute float size;
attribute vec3 tint;
uniform float scale;
varying vec4 vRect;
varying vec3 vTint;
void main () {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * scale / -mv.z;
  gl_Position = projectionMatrix * mv;
  vRect = uvRect;
  vTint = tint;
}`

const FRAGMENT = `
uniform sampler2D map;
uniform float brightness;
varying vec4 vRect;
varying vec3 vTint;
void main () {
  vec4 c = texture2D(map, vRect.xy + gl_PointCoord * vRect.zw);
  if (c.a < 0.1) discard;
  gl_FragColor = vec4(c.rgb * vTint * brightness, c.a);
}`

/**
 * Vanilla's block particles: the chips that fly off a block while it is being
 * mined and the burst when it breaks. Each is a camera-facing quad showing a
 * random quarter of the block's `particle` texture — the same rect the block
 * models carry for exactly this purpose — sampled straight from the world
 * atlas, so a block chips in its own colours without a second texture load.
 *
 * Sizes, lifetimes, velocities, gravity and drag are vanilla's numbers. The
 * browser has no block data to collide against (the mesher's chunks live in
 * the workers), so a particle lands on a flat floor guessed at spawn: the
 * top of the block for chips off its top face, the block's own base for
 * everything else, on the assumption that whatever it is standing on is
 * solid. When the block breaks, chips resting on its top drop to its base.
 */
class BlockParticles {
  constructor (viewer) {
    this.viewer = viewer
    this.live = []
    this.accumulator = 0
    // block name -> its particle texture rect; finding one walks the whole
    // resolved model (every element, every face), so it is done once per
    // name rather than per chip.
    this.textures = new Map()

    const geometry = new THREE.BufferGeometry()
    this.positions = new Float32Array(CAPACITY * 3)
    this.rects = new Float32Array(CAPACITY * 4)
    this.sizes = new Float32Array(CAPACITY)
    this.tints = new Float32Array(CAPACITY * 3)
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setAttribute('uvRect', new THREE.BufferAttribute(this.rects, 4).setUsage(THREE.DynamicDrawUsage))
    geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage))
    geometry.setAttribute('tint', new THREE.BufferAttribute(this.tints, 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setDrawRange(0, 0)

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null },
        scale: { value: 1 },
        brightness: { value: 0.6 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false
    })
    this.points = new THREE.Points(geometry, this.material)
    // Positions are written each frame; culling against a stale bound would
    // blink the whole set out at the edge of the view.
    this.points.frustumCulled = false
    this.points.layers.set(LAYER)
    viewer.scene.add(this.points)
    viewer.camera.layers.enable(LAYER)
  }

  /** One chip off `face` of the block at `pos`, vanilla's `crack`. */
  crack (pos, face, name) {
    const texture = this._texture(name)
    if (!texture) return
    let x = pos.x + Math.random() * 0.8 + 0.1
    let y = pos.y + Math.random() * 0.8 + 0.1
    let z = pos.z + Math.random() * 0.8 + 0.1
    const offset = FACE_OFFSETS[face] || FACE_OFFSETS[1]
    if (offset[0]) x = pos.x + (offset[0] < 0 ? -0.1 : 1.1)
    if (offset[1]) y = pos.y + (offset[1] < 0 ? -0.1 : 1.1)
    if (offset[2]) z = pos.z + (offset[2] < 0 ? -0.1 : 1.1)
    const p = this._spawn(texture, x, y, z, 0, 0, 0)
    // setPower(0.2): mostly still, a little lift.
    p.vx *= 0.2
    p.vy = (p.vy - 0.1) * 0.2 + 0.1
    p.vz *= 0.2
    p.size *= 0.6
    p.floor = offset[1] > 0 ? pos.y + 1 : offset[1] < 0 ? -Infinity : pos.y
  }

  /** The 4×4×4 burst of a block breaking, vanilla's `destroy`. */
  burst (pos, name) {
    const texture = this._texture(name)
    if (!texture) return
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        for (let k = 0; k < 4; k++) {
          const x = pos.x + (i + 0.5) / 4
          const y = pos.y + (j + 0.5) / 4
          const z = pos.z + (k + 0.5) / 4
          const p = this._spawn(texture, x, y, z, x - pos.x - 0.5, y - pos.y - 0.5, z - pos.z - 0.5)
          p.floor = pos.y
        }
      }
    }
    // Chips that were resting on top of this block lose their footing.
    for (const p of this.live) {
      if (p.floor === pos.y + 1 && Math.abs(p.x - pos.x - 0.5) < 1 && Math.abs(p.z - pos.z - 0.5) < 1) {
        p.floor = pos.y
      }
    }
  }

  _texture (name) {
    const cached = this.textures.get(name)
    if (cached !== undefined) return cached
    const texture = this._findTexture(name)
    // Only cache once the block models have loaded: a null before then is
    // "not yet", not "none", and must not be remembered.
    if (texture || icons.blockState(name)) this.textures.set(name, texture)
    return texture
  }

  _findTexture (name) {
    const state = icons.blockState(name)
    if (!state) return null
    let entry = null
    if (state.variants) {
      const keys = Object.keys(state.variants)
      entry = keys.length ? state.variants[keys[0]] : null
    } else if (state.multipart && state.multipart.length) {
      entry = state.multipart[0].apply
    }
    if (Array.isArray(entry)) entry = entry[0]
    const model = entry && entry.model
    const particle = model && model.textures && model.textures.particle
    if (!particle) return null
    // Vanilla tints every tinted block's chips except grass, whose particle
    // texture is the untinted dirt underneath.
    let tint = null
    if (name !== 'grass_block' && model.elements && model.elements.some(hasTint)) {
      tint = name.includes('leaves') ? FOLIAGE_TINT : GRASS_TINT
    }
    return { u: particle.u, v: particle.v, su: Math.abs(particle.su), sv: Math.abs(particle.sv), tint }
  }

  // Vanilla's Particle constructor: the given velocity plus noise, normalised
  // to a random speed, with a little upward kick. Sizes are the terrain
  // particle's (half the base), lifetime 4–40 ticks.
  _spawn (texture, x, y, z, ax, ay, az) {
    if (this.live.length >= CAPACITY) this.live.shift()
    let vx = ax + (Math.random() * 2 - 1) * 0.4
    let vy = ay + (Math.random() * 2 - 1) * 0.4
    let vz = az + (Math.random() * 2 - 1) * 0.4
    const speed = (Math.random() + Math.random() + 1) * 0.15
    const len = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1
    vx = vx / len * speed * 0.4
    vy = vy / len * speed * 0.4 + 0.1
    vz = vz / len * speed * 0.4
    // A random quarter of the sprite, so neighbouring chips differ.
    const uo = Math.random() * 3 / 4
    const vo = Math.random() * 3 / 4
    const p = {
      x, y, z, vx, vy, vz,
      floor: -Infinity,
      onGround: false,
      age: 0,
      lifetime: Math.floor(4 / (Math.random() * 0.9 + 0.1)),
      // Quad width in blocks: twice vanilla's quadSize.
      size: 0.1 * (Math.random() * 0.5 + 0.5),
      u: texture.u + uo * texture.su,
      v: texture.v + vo * texture.sv,
      su: texture.su / 4,
      sv: texture.sv / 4,
      tint: texture.tint
    }
    this.live.push(p)
    return p
  }

  _tick () {
    const live = this.live
    let n = 0
    for (let i = 0; i < live.length; i++) {
      const p = live[i]
      if (++p.age >= p.lifetime) continue
      p.vy -= 0.04
      p.x += p.vx
      p.z += p.vz
      if (p.y + p.vy <= p.floor) {
        p.y = p.floor
        p.vy = 0
        p.onGround = true
      } else {
        p.y += p.vy
      }
      p.vx *= 0.98
      p.vy *= 0.98
      p.vz *= 0.98
      if (p.onGround) {
        p.vx *= 0.7
        p.vz *= 0.7
      }
      live[n++] = p
    }
    live.length = n
  }

  update (dt, renderer) {
    const geometry = this.points.geometry
    if (!this.live.length) {
      this.accumulator = 0
      geometry.setDrawRange(0, 0)
      return
    }
    // Catch up in whole ticks; a background tab returning does not get to
    // replay seconds of physics in one frame.
    this.accumulator = Math.min(this.accumulator + dt * 1000, TICK_MS * 10)
    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS
      this._tick()
    }

    const viewer = this.viewer
    const worldMap = viewer.world.material.map
    if (this.material.uniforms.map.value !== worldMap) this.material.uniforms.map.value = worldMap
    // Pixels per block at unit depth: the point size is world-sized.
    const camera = viewer.camera
    const height = renderer.getSize(_size).y * renderer.getPixelRatio()
    this.material.uniforms.scale.value = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
    // Vanilla draws chips at 0.6 of full light; follow the sky so they do not
    // glow at night. The world's Lambert gets ambient plus a sun term.
    const light = viewer.ambientLight.intensity + 0.6 * viewer.directionalLight.intensity
    this.material.uniforms.brightness.value = 0.6 * Math.min(1, light)

    const n = this.live.length
    for (let i = 0; i < n; i++) {
      const p = this.live[i]
      this.positions[i * 3] = p.x
      this.positions[i * 3 + 1] = p.y
      this.positions[i * 3 + 2] = p.z
      this.rects[i * 4] = p.u
      this.rects[i * 4 + 1] = p.v
      this.rects[i * 4 + 2] = p.su
      this.rects[i * 4 + 3] = p.sv
      this.sizes[i] = p.size
      const tint = p.tint
      this.tints[i * 3] = tint ? tint[0] : 1
      this.tints[i * 3 + 1] = tint ? tint[1] : 1
      this.tints[i * 3 + 2] = tint ? tint[2] : 1
    }
    for (const name of ['position', 'uvRect', 'size', 'tint']) {
      geometry.attributes[name].needsUpdate = true
    }
    geometry.setDrawRange(0, n)
  }
}

function hasTint (element) {
  const faces = element.faces || {}
  return Object.keys(faces).some(dir => faces[dir] && faces[dir].tintindex !== undefined)
}

module.exports = BlockParticles
