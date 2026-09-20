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

// Right-arm cube plus its sleeve overlay — both straight out of entities.json,
// re-expressed relative to the arm's own shoulder pivot so the arm hangs from
// local (0, 0, 0) and rotating the pivot swings it from the shoulder, the way
// the bone would in the full skinned model. Without the sleeve cube (a copy
// of the arm box, inflated slightly and painted from a different UV region)
// the arm is just a block of plain skin tone with nothing that reads as
// "sleeve" — the sleeve overlay is what actually makes it look like the
// Minecraft arm on the reference skin.
const PIVOT = [-5, 22, 0]
const CUBES = [
  { origin: [-8, 12, -2], size: [4, 12, 4], uv: [40, 16], inflate: 0 },
  { origin: [-8, 12, -2], size: [4, 12, 4], uv: [40, 32], inflate: 0.25 }
]

const FACES = {
  up: { dir: [0, 1, 0], u0: [0, 0, 1], v0: [0, 0, 0], u1: [1, 0, 1], v1: [0, 0, 1], corners: [[0, 1, 1, 0, 0], [1, 1, 1, 1, 0], [0, 1, 0, 0, 1], [1, 1, 0, 1, 1]] },
  down: { dir: [0, -1, 0], u0: [1, 0, 1], v0: [0, 0, 0], u1: [2, 0, 1], v1: [0, 0, 1], corners: [[1, 0, 1, 0, 0], [0, 0, 1, 1, 0], [1, 0, 0, 0, 1], [0, 0, 0, 1, 1]] },
  east: { dir: [1, 0, 0], u0: [0, 0, 0], v0: [0, 0, 1], u1: [0, 0, 1], v1: [0, 1, 1], corners: [[1, 1, 1, 0, 0], [1, 0, 1, 0, 1], [1, 1, 0, 1, 0], [1, 0, 0, 1, 1]] },
  west: { dir: [-1, 0, 0], u0: [1, 0, 1], v0: [0, 0, 1], u1: [1, 0, 2], v1: [0, 1, 1], corners: [[0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 1, 1, 1, 0], [0, 0, 1, 1, 1]] },
  north: { dir: [0, 0, -1], u0: [0, 0, 1], v0: [0, 0, 1], u1: [1, 0, 1], v1: [0, 1, 1], corners: [[1, 0, 0, 0, 1], [0, 0, 0, 1, 1], [1, 1, 0, 0, 0], [0, 1, 0, 1, 0]] },
  south: { dir: [0, 0, 1], u0: [1, 0, 2], v0: [0, 0, 1], u1: [2, 0, 2], v1: [0, 1, 1], corners: [[0, 0, 1, 0, 1], [1, 0, 1, 1, 1], [0, 1, 1, 0, 0], [1, 1, 1, 1, 0]] }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function addCube (attr, cube) {
  const origin = [
    cube.origin[0] - PIVOT[0],
    cube.origin[1] - PIVOT[1],
    cube.origin[2] - PIVOT[2]
  ]
  const inflate = cube.inflate || 0

  for (const face of Object.values(FACES)) {
    const ndx = attr.positions.length / 3
    for (const [cx, cy, cz, uFlag, vFlag] of face.corners) {
      attr.positions.push(
        (origin[0] + cx * cube.size[0] + (cx ? inflate : -inflate)) / 16,
        (origin[1] + cy * cube.size[1] + (cy ? inflate : -inflate)) / 16,
        (origin[2] + cz * cube.size[2] + (cz ? inflate : -inflate)) / 16
      )
      attr.normals.push(...face.dir)
      attr.uvs.push(
        (cube.uv[0] + dot(uFlag ? face.u1 : face.u0, cube.size)) / TEXTURE_SIZE,
        (cube.uv[1] + dot(vFlag ? face.v1 : face.v0, cube.size)) / TEXTURE_SIZE
      )
    }
    attr.indices.push(ndx, ndx + 1, ndx + 2, ndx + 2, ndx + 1, ndx + 3)
  }
}

function buildArmGeometry () {
  const attr = { positions: [], normals: [], uvs: [], indices: [] }
  for (const cube of CUBES) addCube(attr, cube)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(attr.positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(attr.normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(attr.uvs, 2))
  geometry.setIndex(attr.indices)
  return geometry
}

// Tuning constants for where the arm sits and how far it swings. Positions
// are camera-local blocks, rotations are radians around the shoulder pivot.
//
// The position is vanilla's own numbers: Minecraft's ItemInHandRenderer
// (renderPlayerArm) translates the right arm by (0.64, -0.6, -0.72) before
// any swing/equip animation is applied, in the same eye-relative units we
// use here. The 45° base yaw is vanilla's too (`rotate(45, Y)` right after
// that translate) — it's what turns the arm to a 3/4 view instead of
// presenting a flat face to the camera.
const REST_POSITION = [0.64, -0.6, -0.72]
const REST_ROTATION = [0.25, Math.PI / 4, -0.1]
const SWING_ROTATION = [1.3, -0.1, -0.2]
// 3x the original swing speed.
const SWING_MS = 35
const RETURN_MS = 65

// The scene's directional light is fixed in world space (see index.js), so a
// mesh lit by it goes flat or blows out depending purely on which way the
// world camera happens to be pointed, with no relation to how it actually
// sits on screen. Real Minecraft's first-person hand doesn't have that
// problem — its shading is baked per-face, not relit by the world sun. We
// fake the same effect by keeping the hand off the world lights' layer and
// lighting it instead from a light that's parented to the camera, so the
// arm's shading direction is always the same relative to the screen.
const HAND_LIGHT_LAYER = 1

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
    mesh.layers.set(HAND_LIGHT_LAYER)

    this.pivot = new THREE.Group()
    this.pivot.position.set(...REST_POSITION)
    this.pivot.rotation.set(...REST_ROTATION)
    this.pivot.add(mesh)

    this.light = new THREE.DirectionalLight(0xffffff, 0.9)
    this.light.position.set(1, 1.5, 0.5)
    this.light.target.position.set(...REST_POSITION)
    this.light.layers.set(HAND_LIGHT_LAYER)

    // Fill light so the side of the arm facing away from `light` isn't pure
    // black — the world's own ambient light is on layer 0 and skips it.
    this.fill = new THREE.AmbientLight(0xffffff, 0.5)
    this.fill.layers.set(HAND_LIGHT_LAYER)

    this.swinging = false
    this.repeatTimer = null
  }

  // Nothing to hold before a bot is joined; the arm would float over the
  // join screen.
  setVisible (visible) {
    this.pivot.visible = visible
  }

  attachTo (camera) {
    camera.add(this.pivot)
    // The mesh only being on HAND_LIGHT_LAYER means the world's lights skip
    // it; the camera still needs that layer enabled to render it at all.
    camera.layers.enable(HAND_LIGHT_LAYER)
    camera.add(this.light)
    camera.add(this.light.target)
    camera.add(this.fill)
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
