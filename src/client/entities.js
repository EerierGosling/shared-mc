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

function disposeDeep (o) {
  dispose3(o)
  for (const child of o.children || []) disposeDeep(child)
}

// Dropped items ("item" entities) have no model in prismarine-viewer's
// entities.json — Entity() throws "Unknown entity item" for them — and even
// if it didn't, mineflayer never tells us *which* item without reading
// getDroppedItem() server-side (see worldStream.js's extra 'itemName' field).
// Render them as a simple textured billboard instead, using the same
// items-then-blocks texture lookup the hotbar already relies on (hud.js).
const textureLoader = new THREE.TextureLoader()
const itemTextureCache = new Map()

function loadItemTexture (name, onLoad) {
  const cached = itemTextureCache.get(name)
  if (cached) return onLoad(cached)

  textureLoader.load(`/assets/items/${name}.png`, texture => {
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    itemTextureCache.set(name, texture)
    onLoad(texture)
  }, undefined, () => {
    textureLoader.load(`/assets/blocks/${name}.png`, texture => {
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      itemTextureCache.set(name, texture)
      onLoad(texture)
    }, undefined, () => {
      console.warn(`[entities] no texture found for dropped item "${name}"`)
    })
  })
}

function buildItemMesh () {
  const geometry = new THREE.PlaneGeometry(0.25, 0.25)
  const material = new THREE.MeshLambertMaterial({ transparent: true, alphaTest: 0.1, side: THREE.DoubleSide })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.y += 0.15
  mesh.userData.isItemMesh = true
  return mesh
}

function setItemMeshTexture (mesh, itemName) {
  loadItemTexture(itemName, texture => {
    mesh.material.map = texture
    mesh.material.needsUpdate = true
  })
}

function attachNametag (mesh, entity) {
  if (entity.username === undefined) return

  const canvas = document.createElement('canvas')
  canvas.width = 500
  canvas.height = 100
  const ctx = canvas.getContext('2d')
  ctx.font = '50pt Arial'
  ctx.fillStyle = '#000000'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(entity.username, 100, 0)

  const tex = new THREE.Texture(canvas)
  tex.needsUpdate = true
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }))
  sprite.position.y += (entity.height || 1.8) + 0.6
  mesh.add(sprite)
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

class Entities {
  constructor (scene) {
    this.scene = scene
    this.entities = {}
    // Player meshes by id, for the minimap. Move events don't repeat the
    // entity name, so membership is decided once here at spawn; the tweened
    // mesh position doubles as a smoothed map position for free.
    this.players = {}
  }

  clear () {
    for (const mesh of Object.values(this.entities)) {
      this.scene.remove(mesh)
      disposeDeep(mesh)
    }
    this.entities = {}
    this.players = {}
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
    }

    if (entity.pos) {
      new TWEEN.Tween(e.position).to({ x: entity.pos.x, y: entity.pos.y, z: entity.pos.z }, 50).start()
    }
    if (entity.yaw) {
      const da = (entity.yaw - e.rotation.y) % (Math.PI * 2)
      const dy = 2 * da % (Math.PI * 2) - da
      new TWEEN.Tween(e.rotation).to({ y: e.rotation.y + dy }, 50).start()
    }
  }
}

module.exports = { Entities }
