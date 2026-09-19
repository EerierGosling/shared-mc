'use strict'
// Drop-in replacement for prismarine-viewer's own Entities (viewer/lib/entities.js).
// That one silently falls back to a single flat magenta box whenever the mob
// has no bundled model — which upstream never added for anything past ~1.16
// (axolotl, goat, glow_squid, frog, tadpole, warden, allay, camel, sniffer,
// trader_llama all throw "Unknown entity" and hit the box path). We build a
// body+head placeholder instead so those mobs read as a creature, not a cube,
// and reuse the real per-mob model for everything upstream does cover.

const THREE = global.THREE || require('three')
const TWEEN = require('@tweenjs/tween.js')

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
const LIMB_BONE_NAMES = ['leftArm', 'rightArm', 'leftLeg', 'rightLeg']

function getPlayerLimbBones (mesh) {
  const skinned = mesh.children.find(c => c.isSkinnedMesh)
  if (!skinned) return null
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
  dispose3(o)
  for (const child of o.children || []) disposeDeep(child)
}

// Dropped items ("item" entities) have no model in prismarine-viewer's
// entities.json — Entity() throws "Unknown entity item" for them — and even
// if it didn't, mineflayer never tells us *which* item without reading
// getDroppedItem() server-side (see worldStream.js's extra 'itemName' field).
// Render them using the same items-then-blocks texture lookup the hotbar
// already relies on (hud.js) — but a dropped item's *shape* also depends on
// which of those two resolved: vanilla draws a dropped full block (dirt,
// sand, …) as a small floating cube, while non-full-cube blocks (torch,
// flowers, …) and genuine items (tools, ingots, gems, …) stay a flat sprite.
// minecraft-assets doesn't distinguish those first two cases by path, but
// the texture itself does: a full-cube block's PNG tiles all six faces and
// so is fully opaque, whereas a cross/sprite block's PNG carries the shape
// as real alpha transparency around it (verified: dirt/sand/stone/planks
// have no alpha channel at all; torch does). Sampling that beats hardcoding
// a block-name list.
const textureLoader = new THREE.TextureLoader()
const itemTextureCache = new Map()

function textureHasTransparency (image) {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true
  }
  return false
}

function loadItemTexture (name, onLoad) {
  const cached = itemTextureCache.get(name)
  if (cached) return onLoad(cached.texture, cached.renderAsCube)

  textureLoader.load(`/assets/items/${name}.png`, texture => {
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    itemTextureCache.set(name, { texture, renderAsCube: false })
    onLoad(texture, false)
  }, undefined, () => {
    textureLoader.load(`/assets/blocks/${name}.png`, texture => {
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      const renderAsCube = !textureHasTransparency(texture.image)
      itemTextureCache.set(name, { texture, renderAsCube })
      onLoad(texture, renderAsCube)
    }, undefined, () => {
      console.warn(`[entities] no texture found for dropped item "${name}"`)
    })
  })
}

function buildItemMesh () {
  const group = new THREE.Object3D()
  group.position.y += 0.15
  group.userData.isItemMesh = true
  return group
}

function buildFlatSprite (texture) {
  const geometry = new THREE.PlaneGeometry(0.25, 0.25)
  const material = new THREE.MeshLambertMaterial({ map: texture, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide })
  return new THREE.Mesh(geometry, material)
}

function buildBlockCube (texture) {
  const geometry = new THREE.BoxGeometry(0.25, 0.25, 0.25)
  const material = new THREE.MeshLambertMaterial({ map: texture })
  return new THREE.Mesh(geometry, material)
}

function setItemMeshTexture (mesh, itemName) {
  loadItemTexture(itemName, (texture, renderAsCube) => {
    while (mesh.children.length) mesh.remove(mesh.children[0])
    mesh.add(renderAsCube ? buildBlockCube(texture) : buildFlatSprite(texture))
  })
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

class Entities {
  constructor (scene) {
    this.scene = scene
    this.entities = {}
    // Player meshes by id, for the minimap. Move events don't repeat the
    // entity name, so membership is decided once here at spawn; the tweened
    // mesh position doubles as a smoothed map position for free.
    this.players = {}
    this.motion = {}
  }

  clear () {
    for (const mesh of Object.values(this.entities)) {
      this.scene.remove(mesh)
      disposeDeep(mesh)
    }
    this.entities = {}
    this.players = {}
    this.motion = {}
  }

  update (entity) {
    if (!this.entities[entity.id]) {
      const mesh = getEntityMesh(entity, this.scene)
      if (!mesh) return
      this.entities[entity.id] = mesh
      this.scene.add(mesh)
      if (entity.name === 'player') this.players[entity.id] = mesh
    }

    const e = this.entities[entity.id]

    if (entity.itemName && e.userData.isItemMesh) {
      setItemMeshTexture(e, entity.itemName)
    }

    if (entity.delete) {
      this.scene.remove(e)
      disposeDeep(e)
      delete this.entities[entity.id]
      delete this.players[entity.id]
      delete this.motion[entity.id]
    }

    if (entity.pos) {
      if (e.userData.limbs) this._trackMotion(entity.id, entity.pos)
      new TWEEN.Tween(e.position).to({ x: entity.pos.x, y: entity.pos.y, z: entity.pos.z }, 50).start()
    }
    if (entity.yaw) {
      const da = (entity.yaw - e.rotation.y) % (Math.PI * 2)
      const dy = 2 * da % (Math.PI * 2) - da
      new TWEEN.Tween(e.rotation).to({ y: e.rotation.y + dy }, 50).start()
    }
  }

  _trackMotion (id, pos) {
    const now = performance.now()
    const prev = this.motion[id]
    if (!prev) {
      this.motion[id] = { lastPos: pos, lastTime: now, speed: 0, phase: 0 }
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

  // Walk/run cycle for player limbs, driven by observed movement speed
  // rather than a server-sent animation state — mineflayer's entity packets
  // carry position and yaw only, nothing about the walk cycle itself.
  animate (dt) {
    const now = performance.now()
    for (const [id, mesh] of Object.entries(this.entities)) {
      const limbs = mesh.userData.limbs
      if (!limbs) continue

      const motion = this.motion[id]
      const stopped = !motion || (now - motion.lastTime) > STOP_AFTER_MS
      const speed = stopped ? 0 : motion.speed

      if (speed < WALK_SPEED_DEADZONE) {
        limbs.leftArm.rotation.x = 0
        limbs.rightArm.rotation.x = 0
        limbs.leftLeg.rotation.x = 0
        limbs.rightLeg.rotation.x = 0
        mesh.userData.walkPhase = 0
        continue
      }

      const amplitude = Math.min(speed / RUN_SPEED_FOR_FULL_SWING, 1) * MAX_SWING_ANGLE
      mesh.userData.walkPhase = (mesh.userData.walkPhase || 0) + dt * speed * 3
      const swing = Math.sin(mesh.userData.walkPhase) * amplitude

      limbs.rightArm.rotation.x = swing
      limbs.leftLeg.rotation.x = swing
      limbs.leftArm.rotation.x = -swing
      limbs.rightLeg.rotation.x = -swing
    }
  }
}

module.exports = { Entities }
