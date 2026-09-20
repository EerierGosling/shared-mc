'use strict'
// First-person hand viewmodel. The right-arm cube from prismarine-viewer's
// bundled player model (viewer/lib/entity/entities.json, player.geometry.default
// .bones.rightArm) — built as a standalone unskinned mesh rather than through
// Entity.js/skinning, since all we want is one cube we can swing as a plain
// pivot rotation. The face UV math below is copied from that file's addCube(),
// which lays out Minecraft's classic six-face "cross" skin unwrap.
//
// There are two hands, but only one shows at rest: the familiar right hand,
// holding the item and throwing the mining punch (swing()). The left is the
// very same arm and rest pose reflected across the screen's centre by a parent
// group scaled -1 on X (see the Hand constructor), and it stays hidden until a
// block is placed — push() puts both hands out together for that one motion,
// then the left retracts again.
//
// The mesh is parented directly to the camera, so its position/rotation are
// always in camera-local space (-Z forward, +X right, +Y up) no matter how the
// world camera is currently aimed.

const THREE = global.THREE || require('three')
const TWEEN = require('@tweenjs/tween.js')
const { createItem, disposeItem } = require('./item-model')

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
// Vanilla's own ItemInHandRenderer numbers (translate ~(0.64, -0.6, -0.72),
// then rotate 45° around Y) don't transfer directly: vanilla draws the hand
// through its own narrow, fixed-FOV projection, independent of the world
// camera's FOV/aspect. We share one camera (viewer.camera, vertical FOV 75°)
// for both, so a shoulder placed at vanilla's y=-0.6 at that distance falls
// outside our frustum's bottom edge and the whole arm renders off-screen.
// SCALE shrinks the arm (and, since it hangs off the same pivot, the held
// item) around REST_POSITION so it reads at a similar apparent size without
// needing to sit so far down/out that it clips.
const SCALE = 0.8
const REST_POSITION = [0.6, -0.6, -0.55]
// X here is the arm's pitch: how far it's raised off a straight hang, which
// is what actually reads as "the arm" rather than a floating block — 35°
// up, the vanilla-ish raised-fist angle.
const REST_ROTATION = [.4*Math.PI - Math.PI / 5, -.3+2*Math.PI / 4, Math.PI / 2]
// Roll around the arm's own shoulder-to-hand axis. This has to land on the
// mesh's local Y before REST_ROTATION is applied — at that point the mesh's
// local Y *is* the shoulder-to-hand line (addCube built it relative to
// PIVOT), where REST_ROTATION's own Y term no longer is, since by then X has
// already tilted the arm out of Y and Y rotates it in world-space instead.
// Positive Y is counter-clockwise looking from the shoulder down at the
// hand, so clockwise from that view is negative.
const ARM_TWIST = -20 * Math.PI / 180

// Where the arm's hand end sits in the pivot's local space: bottom-center of
// the base arm cube (addCube already made that relative to PIVOT), rotated
// by ARM_TWIST the same way the mesh geometry is, since the mesh itself has
// no position offset of its own. A held block is anchored here so swapping
// the arm out for the item doesn't jump the hand to a different spot.
const HAND_X = (CUBES[0].origin[0] - PIVOT[0] + CUBES[0].size[0] / 2) / 16
const HAND_Y = (CUBES[0].origin[1] - PIVOT[1]) / 16
const HAND_Z = (CUBES[0].origin[2] - PIVOT[2] + CUBES[0].size[2] / 2) / 16
const ARM_BOTTOM = [
  HAND_X * Math.cos(ARM_TWIST) + HAND_Z * Math.sin(ARM_TWIST),
  HAND_Y,
  -HAND_X * Math.sin(ARM_TWIST) + HAND_Z * Math.cos(ARM_TWIST)
]
const SWING_ROTATION = [1.3, -0.1, -0.2]
// One full strike-and-return every SWING_MS + RETURN_MS, which is how often
// startSwinging()'s timer throws the next punch while mining is held. ~250 ms
// (≈4/s) matches vanilla's mining cadence; a quick out, a slower ease back.
// Cranking these down (an earlier pass ran the whole cycle in 100 ms) reads as
// a frantic twitch rather than a swing.
const SWING_MS = 100
const RETURN_MS = 150

// Placing is a two-handed jab toward the crosshair: the left hand (hidden the
// rest of the time) is put out alongside the right for one forward thrust and
// then retracts. The pivot moves in (toward screen centre), up a touch and
// forward (-Z), with extra shoulder pitch to extend the forearm. It is authored
// in the right hand's local space; the left mirrors it for free (its pivot lives
// under a -1 X scale), so both hands converge symmetrically. The whole thrust
// fits inside USE_REPEAT_MS (input.js, 200 ms) so hold-to-place reads as one
// clean jab per block rather than the left hand flickering mid-motion.
const PUSH_POSITION = [0.28, -0.36, -0.8]
const PUSH_ROTATION = [REST_ROTATION[0] + 0.35, REST_ROTATION[1], REST_ROTATION[2]]
const PUSH_MS = 75
const PUSH_RETURN_MS = 120

// The scene's directional light is fixed in world space (see index.js), so a
// mesh lit by it goes flat or blows out depending purely on which way the
// world camera happens to be pointed, with no relation to how it actually
// sits on screen. Real Minecraft's first-person hand doesn't have that
// problem — its shading is baked per-face, not relit by the world sun. So
// the arm lives in a scene of its own with its own two lights, drawn as a
// second pass over the world each frame (render() below).
//
// It used to sit in the world scene on a separate layer, on the assumption
// that layers keep lights apart. They do not: three.js collects a light
// whenever the *camera's* layers include it (WebGLRenderer.projectObject)
// and then applies every collected light to every mesh, so the arm's white
// fill and 0.9 key light were shining on the whole world. A snowfield at
// noon summed to well over 2x white and clipped to a shapeless sheet.
//
// The second pass clears depth first, which also keeps the arm from cutting
// into a wall the player stands against, the way vanilla draws it.
class Hand {
  constructor () {
    // DoubleSide is what lets the left arm show at all: it hangs under a group
    // scaled -1 on X (this.mirror), which reverses its triangle winding, and
    // with the default FrontSide every reflected face would be culled. Lambert
    // flips the normal per-face for back-facing fragments, so the reflected arm
    // still lights the right way.
    const material = new THREE.MeshLambertMaterial({ transparent: true, alphaTest: 0.1, side: THREE.DoubleSide })
    new THREE.TextureLoader().load(TEXTURE_URL, texture => {
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      texture.flipY = false
      material.map = texture
      material.needsUpdate = true
    })

    // One arm geometry and one material, shared by both hands.
    const geometry = buildArmGeometry()

    // Right (main) hand: holds the block and throws the mining punch.
    this.right = new THREE.Mesh(geometry, material)
    this.right.rotation.y = ARM_TWIST
    this.rightPivot = new THREE.Group()
    this.rightPivot.position.set(...REST_POSITION)
    this.rightPivot.rotation.set(...REST_ROTATION)
    this.rightPivot.scale.setScalar(SCALE)
    this.rightPivot.add(this.right)
    this.item = new THREE.Group()
    this.rightPivot.add(this.item)
    this.itemName = null

    // Left hand: the same arm and the same rest pose, reflected across the
    // screen's vertical centre by a parent scaled -1 on X. Building it as a
    // reflection — rather than as its own mirrored geometry and hand-derived
    // Euler angles — is what makes the two-handed place cheap: any pose copied
    // verbatim from the right pivot comes out symmetric for free (see push()).
    this.left = new THREE.Mesh(geometry, material)
    this.left.rotation.y = ARM_TWIST
    this.leftPivot = new THREE.Group()
    this.leftPivot.position.set(...REST_POSITION)
    this.leftPivot.rotation.set(...REST_ROTATION)
    this.leftPivot.scale.setScalar(SCALE)
    this.leftPivot.add(this.left)
    this.mirror = new THREE.Group()
    this.mirror.scale.x = -1
    this.mirror.add(this.leftPivot)
    // The left hand is only put out for a placement (push()); the rest of the
    // time the view is the familiar single right hand.
    this.left.visible = false

    this.light = new THREE.DirectionalLight(0xffffff, 0.9)
    this.light.position.set(1, 1.5, 0.5)
    this.light.target.position.set(...REST_POSITION)

    // Fill so the side of the arm facing away from `light` isn't pure black.
    this.fill = new THREE.AmbientLight(0xffffff, 0.5)

    // `root` stands in for the camera: its matrix is copied from the camera's
    // every frame, so everything under it is in camera-local space (-Z
    // forward, +X right, +Y up) exactly as if parented to the camera.
    this.root = new THREE.Group()
    this.root.matrixAutoUpdate = false
    this.root.add(this.rightPivot, this.mirror, this.light, this.light.target, this.fill)
    this.scene = new THREE.Scene()
    this.scene.add(this.root)

    this.shown = false
    this.swinging = false
    this.pushing = false
    this.looping = false
  }

  /** Draw over the finished world frame. Assumes renderer.autoClear is off. */
  render (renderer, camera) {
    if (!this.shown) return
    if (this.itemName && !this.item.children.length) {
      const model = createItem(this.itemName)
      if (model) {
        if (model.userData.block) {
          // Half the previous 0.48, anchored where the arm's hand was.
          model.scale.setScalar(0.24)
          this.item.position.set(...ARM_BOTTOM)
          // Z here is the block's own face-on spin, before the pivot's
          // rotation carries it into view — positive is counter-clockwise
          // as held up and looked at, same convention as ARM_TWIST. 90°
          // CCW from where it sat (Z=0).
          this.item.rotation.set(-0.25, -0.45, Math.PI / 2)
        } else {
          model.scale.setScalar(0.75)
          this.item.position.set(...ARM_BOTTOM)
          this.item.rotation.set(-0.25, -0.45, -0.25)
        }
        this.item.add(model)
      }
    }
    this.root.matrix.copy(camera.matrixWorld)

    // The item shares the arm's own local space closely enough (it's
    // anchored at the arm's hand end) that it ends up partly or fully
    // inside the arm's geometry — drawn together, the arm's depth values
    // bury it. Draw them as two passes with the depth buffer cleared
    // between, same idea as clearing depth before this scene draws over the
    // world: whichever draws second wins, regardless of who's "really" in
    // front in that shared local space.
    const showingItem = this.item.children.length > 0
    if (showingItem) this.item.visible = false
    renderer.clearDepth()
    renderer.render(this.scene, camera)
    if (showingItem) {
      this.item.visible = true
      const rightWas = this.right.visible
      const leftWas = this.left.visible
      this.right.visible = false
      this.left.visible = false
      renderer.clearDepth()
      renderer.render(this.scene, camera)
      this.right.visible = rightWas
      this.left.visible = leftWas
    }
  }

  setItem (item) {
    const name = item?.name || null
    if (name === this.itemName) return
    this.itemName = name
    disposeItem(this.item)
  }

  // Nothing to hold before a bot is joined; the arms would float over the
  // join screen.
  setVisible (visible) {
    this.shown = visible
  }

  // Punch-and-return, right hand only (mining/attack). Calls while a swing is
  // already in flight are dropped, so a stray one-shot swing() can't stack a
  // second tween on top of the held mining loop.
  swing () {
    if (this.swinging) return
    this.swinging = true
    new TWEEN.Tween(this.rightPivot.rotation)
      .to({ x: SWING_ROTATION[0], y: SWING_ROTATION[1], z: SWING_ROTATION[2] }, SWING_MS)
      .easing(TWEEN.Easing.Quadratic.Out)
      .chain(
        new TWEEN.Tween(this.rightPivot.rotation)
          .to({ x: REST_ROTATION[0], y: REST_ROTATION[1], z: REST_ROTATION[2] }, RETURN_MS)
          .easing(TWEEN.Easing.Quadratic.In)
          .onComplete(() => {
            this.swinging = false
            // Kick the next thrust off this one's completion rather than a
            // parallel timer. A setInterval equal to the swing duration races
            // the tween's own onComplete (stepped a frame later than the timer
            // fires) and drops every other thrust, halving and stuttering the
            // rate. Chaining guarantees back-to-back thrusts with no gap.
            if (this.looping) this.swing()
          })
      )
      .start()
  }

  // Placing: a single two-handed thrust toward the crosshair and back — one shot
  // per placement, not the held punch loop mining uses. Only the right pivot is
  // tweened (position and shoulder pitch together); the left copies it every
  // frame, so the reflection stays exact through the whole motion. Overlapping
  // calls are dropped, so hold-to-place fires a clean push per block rather than
  // stacking tweens.
  push () {
    if (this.pushing) return
    this.pushing = true
    // Put the second hand out for the motion; retract it when the thrust returns.
    this.left.visible = true
    const sync = () => {
      this.leftPivot.position.copy(this.rightPivot.position)
      this.leftPivot.rotation.copy(this.rightPivot.rotation)
    }
    new TWEEN.Tween(this.rightPivot.position)
      .to({ x: PUSH_POSITION[0], y: PUSH_POSITION[1], z: PUSH_POSITION[2] }, PUSH_MS)
      .easing(TWEEN.Easing.Quadratic.Out)
      .onUpdate(sync)
      .chain(
        new TWEEN.Tween(this.rightPivot.position)
          .to({ x: REST_POSITION[0], y: REST_POSITION[1], z: REST_POSITION[2] }, PUSH_RETURN_MS)
          .easing(TWEEN.Easing.Quadratic.In)
          .onUpdate(sync)
      )
      .start()
    new TWEEN.Tween(this.rightPivot.rotation)
      .to({ x: PUSH_ROTATION[0], y: PUSH_ROTATION[1], z: PUSH_ROTATION[2] }, PUSH_MS)
      .easing(TWEEN.Easing.Quadratic.Out)
      .onUpdate(sync)
      .chain(
        new TWEEN.Tween(this.rightPivot.rotation)
          .to({ x: REST_ROTATION[0], y: REST_ROTATION[1], z: REST_ROTATION[2] }, PUSH_RETURN_MS)
          .easing(TWEEN.Easing.Quadratic.In)
          .onUpdate(sync)
          .onComplete(() => { this.pushing = false; this.left.visible = false })
      )
      .start()
  }

  // Keeps punching for as long as a dig/attack is held down, the way vanilla
  // keeps swinging the arm while mining rather than throwing one punch. The
  // in-flight swing loops itself; stopSwinging just lets the current one finish
  // its return and settle at rest.
  startSwinging () {
    if (this.looping) return
    this.looping = true
    this.swing()
  }

  stopSwinging () {
    this.looping = false
  }
}

module.exports = { Hand }
