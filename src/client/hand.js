'use strict'
// First-person hand viewmodel. Just the right-arm cube from prismarine-viewer's
// bundled player model (viewer/lib/entity/entities.json, player.geometry.default
// .bones.rightArm) — built as a standalone unskinned mesh rather than through
// Entity.js/skinning, since all we want is one cube we can swing as a plain
// pivot rotation. The face UV math below is copied from that file's addCube(),
// which lays out Minecraft's classic six-face "cross" skin unwrap.
//
// The mesh is parented directly to the camera, so its position/rotation are
// always in camera-local space (-Z forward, +X right, +Y up) no matter how the
// world camera is currently aimed.

const THREE = global.THREE || require('three')
const TWEEN = require('@tweenjs/tween.js')

// Same texture prismarine-viewer's mob models use for players in this project
// (see entities.js) — hardcoded to 1.16.4's asset set rather than whatever
// MC_VERSION resolves to, matching that existing convention.
const TEXTURE_URL = 'textures/1.16.4/entity/steve.png'
const TEXTURE_SIZE = 64

// Right-arm cube, re-expressed relative to its own shoulder pivot so the arm
// hangs from local (0, 0, 0) and rotating the pivot swings it from the
// shoulder, the way the bone would in the full skinned model.
const PIVOT = [-5, 22, 0]
const CUBE_ORIGIN = [-8 - PIVOT[0], 12 - PIVOT[1], -2 - PIVOT[2]]
const CUBE_SIZE = [4, 12, 4]
const CUBE_UV = [40, 16]

const FACES = {
  up: { dir: [0, 1, 0], u0: [0, 0, 1], v0: [0, 0, 0], u1: [1, 0, 1], v1: [0, 0, 1], corners: [[0, 1, 1, 0, 0], [1, 1, 1, 1, 0], [0, 1, 0, 0, 1], [1, 1, 0, 1, 1]] },
  down: { dir: [0, -1, 0], u0: [1, 0, 1], v0: [0, 0, 0], u1: [2, 0, 1], v1: [0, 0, 1], corners: [[1, 0, 1, 0, 0], [0, 0, 1, 1, 0], [1, 0, 0, 0, 1], [0, 0, 0, 1, 1]] },
  east: { dir: [1, 0, 0], u0: [0, 0, 0], v0: [0, 0, 1], u1: [0, 0, 1], v1: [0, 1, 1], corners: [[1, 1, 1, 0, 0], [1, 0, 1, 0, 1], [1, 1, 0, 1, 0], [1, 0, 0, 1, 1]] },
  west: { dir: [-1, 0, 0], u0: [1, 0, 1], v0: [0, 0, 1], u1: [1, 0, 2], v1: [0, 1, 1], corners: [[0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 1, 1, 1, 0], [0, 0, 1, 1, 1]] },
  north: { dir: [0, 0, -1], u0: [0, 0, 1], v0: [0, 0, 1], u1: [1, 0, 1], v1: [0, 1, 1], corners: [[1, 0, 0, 0, 1], [0, 0, 0, 1, 1], [1, 1, 0, 0, 0], [0, 1, 0, 1, 0]] },
  south: { dir: [0, 0, 1], u0: [1, 0, 2], v0: [0, 0, 1], u1: [2, 0, 2], v1: [0, 1, 1], corners: [[0, 0, 1, 0, 1], [1, 0, 1, 1, 1], [0, 1, 1, 0, 0], [1, 1, 1, 1, 0]] }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function buildArmGeometry () {
  const positions = []
  const normals = []
  const uvs = []
  const indices = []

  for (const face of Object.values(FACES)) {
    const ndx = positions.length / 3
    for (const [cx, cy, cz, uFlag, vFlag] of face.corners) {
      positions.push(
        (CUBE_ORIGIN[0] + cx * CUBE_SIZE[0]) / 16,
        (CUBE_ORIGIN[1] + cy * CUBE_SIZE[1]) / 16,
        (CUBE_ORIGIN[2] + cz * CUBE_SIZE[2]) / 16
      )
      normals.push(...face.dir)
      uvs.push(
        (CUBE_UV[0] + dot(uFlag ? face.u1 : face.u0, CUBE_SIZE)) / TEXTURE_SIZE,
        (CUBE_UV[1] + dot(vFlag ? face.v1 : face.v0, CUBE_SIZE)) / TEXTURE_SIZE
      )
    }
    indices.push(ndx, ndx + 1, ndx + 2, ndx + 2, ndx + 1, ndx + 3)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return geometry
}

// Tuning constants for where the arm sits and how far it swings. Positions
// are camera-local blocks, rotations are radians around the shoulder pivot.
// Not yet confirmed in a browser — nudge these if the arm looks mispositioned
// or the swing doesn't read as a punch.
const REST_POSITION = [0.55, -0.45, -0.4]
const REST_ROTATION = [0.3, 0.5, -0.1]
const SWING_ROTATION = [1.4, 0.2, -0.2]
const SWING_MS = 110
const RETURN_MS = 190

class Hand {
  constructor () {
    const material = new THREE.MeshLambertMaterial({ transparent: true, alphaTest: 0.1 })
    new THREE.TextureLoader().load(TEXTURE_URL, texture => {
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      texture.flipY = false
      material.map = texture
      material.needsUpdate = true
    })

    const mesh = new THREE.Mesh(buildArmGeometry(), material)

    this.pivot = new THREE.Group()
    this.pivot.position.set(...REST_POSITION)
    this.pivot.rotation.set(...REST_ROTATION)
    this.pivot.add(mesh)

    this.swinging = false
    this.repeatTimer = null
  }

  attachTo (camera) {
    camera.add(this.pivot)
  }

  // Punch-and-return. Calls while a swing is already in flight are dropped, so
  // startSwinging()'s repeat interval can just fire on a steady clock without
  // stacking tweens on top of each other.
  swing () {
    if (this.swinging) return
    this.swinging = true
    new TWEEN.Tween(this.pivot.rotation)
      .to({ x: SWING_ROTATION[0], y: SWING_ROTATION[1], z: SWING_ROTATION[2] }, SWING_MS)
      .easing(TWEEN.Easing.Quadratic.Out)
      .chain(
        new TWEEN.Tween(this.pivot.rotation)
          .to({ x: REST_ROTATION[0], y: REST_ROTATION[1], z: REST_ROTATION[2] }, RETURN_MS)
          .easing(TWEEN.Easing.Quadratic.In)
          .onComplete(() => { this.swinging = false })
      )
      .start()
  }

  // Keeps punching for as long as a dig/attack is held down, the way vanilla
  // keeps swinging the arm while mining rather than throwing one punch.
  startSwinging () {
    if (this.repeatTimer) return
    this.swing()
    this.repeatTimer = setInterval(() => this.swing(), SWING_MS + RETURN_MS)
  }

  stopSwinging () {
    clearInterval(this.repeatTimer)
    this.repeatTimer = null
  }
}

module.exports = { Hand }
