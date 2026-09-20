'use strict'
// Drop-in replacement for prismarine-viewer's own Entities (viewer/lib/entities.js).
// That one silently falls back to a single flat magenta box whenever the mob
// has no bundled model — which upstream never added for anything past ~1.16
// (axolotl, goat, glow_squid, frog, tadpole, warden, allay, camel, sniffer,
// trader_llama all throw "Unknown entity" and hit the box path). We build a
// body+head placeholder instead so those mobs read as a creature, not a cube,
// and reuse the real per-mob model for everything upstream does cover.

const THREE = global.THREE || require('three')

// Some of prismarine-viewer's bundled mob models declare a texture-atlas size
// that doesn't match the actual PNG (e.g. zombie/husk say 64x32 but the real
// skin is 64x64; sheep declares nothing, so it falls back to the 64x64
// default even though its skin is 64x32). addCube() divides UVs by these
// declared dimensions, so a wrong one samples the wrong rows of the skin —
// the mob still has real 3D geometry, it just looks like a garbled, flattened
// blob instead of a body. Patch the shared entities.json in place (only
// mutating properties, not the require-cached object itself) before Entity.js
// reads it, since it grabs its own reference to the same object.
const entitiesData = require('prismarine-viewer/viewer/lib/entity/entities.json')
const TEXTURE_SIZE_FIXES = {
  zombie: { default: [64, 64] },
  husk: { default: [64, 64] },
  sheep: { default: [64, 32], sheared: [64, 32] },
  llama_spit: { default: [64, 32] }
}
for (const [name, fixes] of Object.entries(TEXTURE_SIZE_FIXES)) {
  const def = entitiesData[name]
  if (!def) continue
  for (const [geoName, [width, height]] of Object.entries(fixes)) {
    const model = def.geometry && def.geometry[geoName]
    if (!model) continue
    model.texturewidth = width
    model.textureheight = height
  }
}

const Entity = require('prismarine-viewer/viewer/lib/entity/Entity')
const { dispose3 } = require('prismarine-viewer/viewer/lib/dispose')

const warnedMissing = new Set()

// Entity.js never names its THREE.Bone objects — it only keys them in a local
// object by jsonBone.name before handing the array off to THREE.Skeleton — so
// the only way back to "which bone is leftArm" is position: skeleton.bones[i]
// is built from Object.values() over that same object, which preserves
// insertion order, which is the order this array lists them in. That coupling
// to Entity.js's internals is already how this file patches entities.json
// above; this just extends it one step further to reach the bones themselves.
const PLAYER_BONE_ORDER = entitiesData.player.geometry.default.bones.map(b => b.name)
const LIMB_BONE_NAMES = ['head', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']

function wrapAngle (a) {
  return ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI
}

// Entity.js copies each bone's absolute pivot into bone.position, but a
// three.js bone's position is relative to its parent: body (pivot y 24) under
// waist (y 12) lands at y 36 and the head at y 60 model units. The bind pose
// hides that, since bind() inverts whatever the bones are, but every rotation
// afterwards turns around the displaced point — a head pitch swung the head
// around a spot two blocks above the shoulders, and the arms swung from the
// same height. Re-express the pivots parent-relative and rebind so the
// animation below rotates about the real joints.
const PLAYER_BONE_DEFS = entitiesData.player.geometry.default.bones
function fixPlayerRig (skinned) {
  const byName = {}
  for (const def of PLAYER_BONE_DEFS) byName[def.name] = def
  skinned.skeleton.bones.forEach((bone, i) => {
    const def = PLAYER_BONE_DEFS[i]
    const parent = def.parent && byName[def.parent]
    if (!parent) return
    const pivot = def.pivot || [0, 0, 0]
    const parentPivot = parent.pivot || [0, 0, 0]
    bone.position.set(pivot[0] - parentPivot[0], pivot[1] - parentPivot[1], pivot[2] - parentPivot[2])
  })
  skinned.bind(skinned.skeleton)
}

function getPlayerLimbBones (mesh) {
  const skinned = mesh.children.find(c => c.isSkinnedMesh)
  if (!skinned) return null
  fixPlayerRig(skinned)
  const bones = skinned.skeleton.bones
  const limbs = {}
  for (const name of LIMB_BONE_NAMES) {
    const index = PLAYER_BONE_ORDER.indexOf(name)
    if (index === -1) return null
    limbs[name] = bones[index]
  }
  return limbs
}

function disposeDeep (o) {
  if (o.userData.isItemMesh) {
    disposeItem(o)
    return
  }
  dispose3(o)
  for (const child of o.children || []) disposeDeep(child)
}

// The server position stays on the root; only the visual child bobs and spins.
const { createItem, disposeItem } = require('./item-model')

function buildItemMesh () {
  const group = new THREE.Group()
  const visual = new THREE.Group()
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.65, 0.65), new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { opacity: { value: 0.25 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec2 vUv; uniform float opacity; void main() { float a = 1.0 - smoothstep(0.1, 0.5, distance(vUv, vec2(0.5))); gl_FragColor = vec4(0.0, 0.0, 0.0, a * opacity); }'
  }))
  shadow.rotation.x = -Math.PI / 2
  shadow.renderOrder = 1
  shadow.visible = false
  group.add(visual, shadow)
  group.userData = { isItemMesh: true, visual, shadow, shadowAt: -Infinity }
  return group
}

function setItemMeshTexture (mesh, name) {
  if (mesh.userData.itemName === name) return
  disposeItem(mesh.userData.visual)
  mesh.userData.itemName = name
}

// Vanilla draws a nametag with its 8px font at 1/40 block per pixel: white
// text on a black box at 25% alpha with one pixel of padding around the glyphs.
const TAG_FONT_PX = 8
const TAG_BLOCKS_PER_PX = 1 / 40
const TAG_HEIGHT = TAG_FONT_PX + 2
// Monocraft is a vector font, so the canvas antialiases it at every size. Draw
// it 4x oversampled and threshold the alpha back to hard pixels; at 8px the
// smeared 1px strokes would not survive the threshold.
const TAG_OVERSAMPLE = 4
const TAG_FONT = `${TAG_FONT_PX * TAG_OVERSAMPLE}px Monocraft`

// Until the face is in, the canvas would silently fall back to a system font.
// Wait once; if the load fails draw anyway — a wrong font beats no tag.
const tagFontReady = document.fonts
  ? document.fonts.load(TAG_FONT).catch(() => {})
  : Promise.resolve()

// Returns the tag width in font pixels.
function drawNametag (canvas, text) {
  const ctx = canvas.getContext('2d')
  ctx.font = TAG_FONT
  const width = Math.ceil(ctx.measureText(text).width / TAG_OVERSAMPLE) + 2
  canvas.width = width * TAG_OVERSAMPLE
  canvas.height = TAG_HEIGHT * TAG_OVERSAMPLE
  // resizing the canvas reset the context
  ctx.font = TAG_FONT
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  // Monocraft sits 7px above the baseline and 1px below at 8px, so a baseline
  // on row 8 keeps the glyphs inside the one-pixel padding on both sides.
  ctx.fillText(text, TAG_OVERSAMPLE, TAG_FONT_PX * TAG_OVERSAMPLE)

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const glyph = d[i + 3] >= 128
    d[i] = d[i + 1] = d[i + 2] = glyph ? 255 : 0
    d[i + 3] = glyph ? 255 : 64
  }
  ctx.putImageData(img, 0, 0)
  return width
}

function attachNametag (mesh, entity) {
  if (entity.username === undefined) return

  const canvas = document.createElement('canvas')
  const tex = new THREE.Texture(canvas)
  // Sampled well above its native 1/40 block per pixel, so keep the pixels
  // square rather than letting mipmaps and linear magnification smear them.
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  // The chunk material is transparent too (alphaTest), so terrain and this
  // sprite share three's back-to-front transparent pass, sorted by object
  // origin — for a 16-block section that is its corner, so the wall right
  // behind a tag routinely sorts in front of it. In that order a depth-writing
  // sprite stamps its whole quad into the depth buffer and the wall fails the
  // depth test behind it: an x-ray hole. Without the depth write the wall just
  // paints over the tag instead. So draw tags after the world, testing depth
  // against it but never writing.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, alphaTest: 0.1 }))
  sprite.renderOrder = 1
  // Nothing to show until the font has been drawn; a blank 1x1 quad would
  // flash over the head in the meantime.
  sprite.visible = false
  sprite.position.y += (entity.height || 1.8) + 0.5
  mesh.add(sprite)

  tagFontReady.then(() => {
    const width = drawNametag(canvas, entity.username)
    tex.needsUpdate = true
    sprite.scale.set(width * TAG_BLOCKS_PER_PX, TAG_HEIGHT * TAG_BLOCKS_PER_PX, 1)
    sprite.visible = true
  })
}

function buildPlaceholderMesh (entity) {
  const width = entity.width || 0.6
  const height = entity.height || 1.8
  const material = new THREE.MeshLambertMaterial({ color: 0x9a9a8f })

  const group = new THREE.Object3D()

  const bodyHeight = height * 0.65
  const body = new THREE.Mesh(new THREE.BoxGeometry(width, bodyHeight, width * 0.6), material)
  body.position.y = bodyHeight / 2
  group.add(body)

  const headSize = Math.min(width, height - bodyHeight) * 0.9 || width * 0.7
  const head = new THREE.Mesh(new THREE.BoxGeometry(headSize, headSize, headSize), material)
  head.position.y = bodyHeight + headSize / 2
  group.add(head)

  return group
}

function getEntityMesh (entity, scene) {
  if (entity.name === 'item') {
    const mesh = buildItemMesh()
    if (entity.itemName) setItemMeshTexture(mesh, entity.itemName)
    return mesh
  }

  if (entity.name) {
    try {
      const e = new Entity('1.16.4', entity.name, scene)
      attachNametag(e.mesh, entity)
      if (entity.name === 'player') e.mesh.userData.limbs = getPlayerLimbBones(e.mesh)
      return e.mesh
    } catch (err) {
      if (!warnedMissing.has(entity.name)) {
        warnedMissing.add(entity.name)
        console.warn(`[entities] no model for "${entity.name}", using a placeholder shape (${err.message})`)
      }
    }
  }

  const mesh = buildPlaceholderMesh(entity)
  attachNametag(mesh, entity)
  return mesh
}

// How long a movement packet is smoothed over — matches the server's 50ms
// position cadence, so a moving entity is always mid-lerp into its last
// reported spot.
const SMOOTH_MS = 50
// Below this horizontal speed (blocks/s) a player reads as standing still —
// small server-correction jitter shouldn't twitch the limbs.
const WALK_SPEED_DEADZONE = 0.15
// Roughly vanilla's sprint speed; swing amplitude maxes out here rather than
// growing without bound off of a single burst of lag-catchup movement.
const RUN_SPEED_FOR_FULL_SWING = 5.6
const MAX_SWING_ANGLE = Math.PI / 3
// If no new position arrives for this long, treat the entity as stopped —
// the server only sends a move packet when something actually moved, so
// silence is the "not moving" signal, not a value to keep animating toward.
const STOP_AFTER_MS = 250
// How far the head can turn past the shoulders before the body gets dragged
// around to follow (vanilla lets you look ~50° over either shoulder).
const MAX_NECK = 0.9

class Entities {
  constructor (scene, terrain = () => []) {
    this.scene = scene
    this.terrain = terrain
    this.shadowRay = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 0, 4)
    this.entities = {}
    // Player meshes by id, for the minimap. Move events don't repeat the
    // entity name, so membership is decided once here at spawn; the smoothed
    // mesh position doubles as a smoothed map position for free.
    this.players = {}
    this.motion = {}
    // In-flight position/yaw lerps by id, stepped from animate(). Retargeted
    // lerps instead of tweens: the server relays thousands of entity moves
    // and allocating a TWEEN per packet (never stopped, briefly fighting its
    // predecessor over the same mesh) was measurable GC churn.
    this.lerps = {}
  }

  clear () {
    for (const mesh of Object.values(this.entities)) {
      this.scene.remove(mesh)
      disposeDeep(mesh)
    }
    this.entities = {}
    this.players = {}
    this.motion = {}
    this.lerps = {}
  }

  update (entity) {
    // Handled first so an unknown entity's delete doesn't build a mesh only
    // to throw it away, and nothing below runs against a removed mesh.
    if (entity.delete) {
      const e = this.entities[entity.id]
      if (!e) return
      this.scene.remove(e)
      disposeDeep(e)
      delete this.entities[entity.id]
      delete this.players[entity.id]
      delete this.motion[entity.id]
      delete this.lerps[entity.id]
      return
    }

    if (!this.entities[entity.id]) {
      const mesh = getEntityMesh(entity, this.scene)
      if (!mesh) return
      if (entity.pos) mesh.position.set(entity.pos.x, entity.pos.y, entity.pos.z)
      this.entities[entity.id] = mesh
      this.scene.add(mesh)
      if (entity.name === 'player') this.players[entity.id] = mesh
    }

    const e = this.entities[entity.id]

    if (entity.itemName && e.userData.isItemMesh) {
      setItemMeshTexture(e, entity.itemName)
    }

    if (entity.pos) {
      if (e.userData.limbs) this._trackMotion(entity.id, entity.pos)
      const l = this.lerps[entity.id] || (this.lerps[entity.id] = {})
      l.x0 = e.position.x
      l.y0 = e.position.y
      l.z0 = e.position.z
      l.x1 = entity.pos.x
      l.y1 = entity.pos.y
      l.z1 = entity.pos.z
      l.posAt = performance.now()
    }
    if (entity.yaw !== undefined && !e.userData.isItemMesh) {
      const m = e.userData.limbs && this.motion[entity.id]
      if (m) {
        // animate() owns a rigged mesh's yaw: the head takes the look packet
        // now, the body lags after it. A lerp here would fight that.
        m.targetYaw = entity.yaw
        if (m.bodyYaw === null) m.bodyYaw = entity.yaw
      } else {
        // Shortest arc, so the mesh never spins the long way round when yaw
        // wraps past ±π.
        const da = (entity.yaw - e.rotation.y) % (Math.PI * 2)
        const dy = 2 * da % (Math.PI * 2) - da
        const l = this.lerps[entity.id] || (this.lerps[entity.id] = {})
        l.yaw0 = e.rotation.y
        l.yaw1 = e.rotation.y + dy
        l.yawAt = performance.now()
      }
    }
    if (entity.pitch !== undefined) {
      const m = this.motion[entity.id]
      if (m) m.pitch = entity.pitch
    }
  }

  _trackMotion (id, pos) {
    const now = performance.now()
    const prev = this.motion[id]
    if (!prev) {
      this.motion[id] = { lastPos: pos, lastTime: now, speed: 0, phase: 0, pitch: 0, targetYaw: null, bodyYaw: null }
      return
    }
    const dt = (now - prev.lastTime) / 1000
    if (dt > 0) {
      const dx = pos.x - prev.lastPos.x
      const dz = pos.z - prev.lastPos.z
      const instantSpeed = Math.sqrt(dx * dx + dz * dz) / dt
      // Smoothed rather than instantaneous — a single coalesced/laggy packet
      // covering several ticks' worth of movement would otherwise read as a
      // speed spike and jerk the limbs for one frame.
      prev.speed = prev.speed * 0.6 + instantSpeed * 0.4
    }
    prev.lastPos = pos
    prev.lastTime = now
  }

  // Passive motion for player rigs, driven by observed movement and look
  // packets rather than a server-sent animation state — mineflayer's entity
  // packets carry position, yaw and pitch only, nothing about the walk cycle.
  animate (dt) {
    const now = performance.now()

    // Step the movement lerps before the walk cycle below, so the limbs and
    // the body render this frame's motion together.
    for (const id in this.lerps) {
      const l = this.lerps[id]
      const e = this.entities[id]
      if (!e) {
        delete this.lerps[id]
        continue
      }
      let done = true
      if (l.posAt) {
        const t = Math.min(1, (now - l.posAt) / SMOOTH_MS)
        e.position.set(
          l.x0 + (l.x1 - l.x0) * t,
          l.y0 + (l.y1 - l.y0) * t,
          l.z0 + (l.z1 - l.z0) * t
        )
        if (t < 1) done = false
        else l.posAt = 0
      }
      if (l.yawAt) {
        const t = Math.min(1, (now - l.yawAt) / SMOOTH_MS)
        e.rotation.y = l.yaw0 + (l.yaw1 - l.yaw0) * t
        if (t < 1) done = false
        else l.yawAt = 0
      }
      if (done) delete this.lerps[id]
    }

    for (const [id, mesh] of Object.entries(this.entities)) {
      if (mesh.userData.isItemMesh) {
        const data = mesh.userData
        if (data.itemName && !data.visual.children.length) {
          const model = createItem(data.itemName)
          if (model) {
            model.scale.setScalar(model.userData.block ? 0.3 : 0.45)
            data.visual.add(model)
          }
        }
        const phase = now / 1000 + Number(id) * 0.73
        data.visual.position.y = 0.25 + Math.sin(phase * 2) * 0.08
        data.visual.rotation.y = phase * 1.25
        // Project onto actual terrain (including slabs), never into midair.
        if (now - data.shadowAt > 250) {
          data.shadowAt = now
          this.shadowRay.ray.origin.copy(mesh.position).y += 0.2
          const hit = this.shadowRay.intersectObjects(this.terrain(), false)[0]
          data.groundY = hit ? hit.point.y : null
        }
        data.shadow.visible = data.groundY !== null && data.groundY !== undefined
        if (data.shadow.visible) {
          const height = Math.max(0, mesh.position.y - data.groundY + data.visual.position.y)
          data.shadow.position.y = data.groundY - mesh.position.y + 0.008
          data.shadow.material.uniforms.opacity.value = 0.28 / (1 + height * 2)
          data.shadow.scale.setScalar(1 + height * 0.3)
        }
        continue
      }
      const limbs = mesh.userData.limbs
      if (!limbs) continue

      const motion = this.motion[id]
      const stopped = !motion || (now - motion.lastTime) > STOP_AFTER_MS
      const speed = stopped ? 0 : motion.speed

      // Swing amplitude eases in and out, so stopping settles the limbs to
      // rest instead of freezing them mid-stride.
      const target = speed < WALK_SPEED_DEADZONE
        ? 0
        : Math.min(speed / RUN_SPEED_FOR_FULL_SWING, 1) * MAX_SWING_ANGLE
      let amplitude = (mesh.userData.swingAmplitude || 0)
      amplitude += (target - amplitude) * Math.min(1, dt * 10)
      if (target === 0 && amplitude < 0.01) {
        amplitude = 0
        mesh.userData.walkPhase = 0
      } else {
        mesh.userData.walkPhase = (mesh.userData.walkPhase || 0) + dt * speed * 3
      }
      mesh.userData.swingAmplitude = amplitude
      const swing = Math.sin(mesh.userData.walkPhase) * amplitude

      // Vanilla's idle "breathing": the arms hang slightly out from the body
      // and drift a few degrees, so a standing player never reads as a
      // statue. Phase-shifted by entity id so a crowd doesn't sway in step.
      const t = now / 1000 + (Number(id) % 16)
      const idleRoll = Math.cos(t * 1.8) * 0.05 + 0.05
      const idlePitch = Math.sin(t * 1.34) * 0.05

      limbs.rightArm.rotation.x = swing + idlePitch
      limbs.leftArm.rotation.x = -swing - idlePitch
      limbs.rightArm.rotation.z = -idleRoll
      limbs.leftArm.rotation.z = idleRoll
      limbs.leftLeg.rotation.x = swing
      limbs.rightLeg.rotation.x = -swing

      if (!motion) continue

      // Look pitch goes straight to the head (mineflayer pitch is positive
      // looking up, and so is bone +x with the model facing -z), lightly
      // smoothed since it only arrives per look packet.
      limbs.head.rotation.x += (motion.pitch - limbs.head.rotation.x) * Math.min(1, dt * 15)

      // The head takes the look yaw at once; the body chases it — eagerly
      // while walking, otherwise only when the neck runs out of travel.
      if (motion.targetYaw !== null) {
        const diff = wrapAngle(motion.targetYaw - motion.bodyYaw)
        if (amplitude > 0.05) {
          motion.bodyYaw += diff * Math.min(1, dt * 8)
        } else if (Math.abs(diff) > MAX_NECK) {
          motion.bodyYaw += (diff - Math.sign(diff) * MAX_NECK) * Math.min(1, dt * 8)
        }
        mesh.rotation.y = motion.bodyYaw
        limbs.head.rotation.y = Math.max(-MAX_NECK, Math.min(MAX_NECK, wrapAngle(motion.targetYaw - motion.bodyYaw)))
      }
    }
  }
}

module.exports = { Entities }
