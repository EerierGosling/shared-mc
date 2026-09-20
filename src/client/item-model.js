'use strict'

const THREE = global.THREE || require('three')
const icons = require('./icons')
const { modelForIcon } = require('../shared/blockIcon')
const textures = new Map()
let atlasTexture

// Resources belong to each model; textures are shared for the session.
function disposeItem (group) {
  group.traverse(child => {
    child.geometry?.dispose()
    if (Array.isArray(child.material)) new Set(child.material).forEach(material => material.dispose())
    else child.material?.dispose()
  })
  group.clear()
}

function pixelTexture (image) {
  const texture = new THREE.Texture(image)
  texture.magFilter = texture.minFilter = THREE.NearestFilter
  texture.needsUpdate = true
  return texture
}

// Return null while inventory assets load. Callers retry without issuing
// duplicate requests, and never attach an asynchronous result to a stale item.
function createItem (name) {
  const { kinds, atlas } = icons.itemAssets()
  if (!kinds) return null
  const group = new THREE.Group()
  const block = kinds[name] === 'block' && modelForIcon(icons.blockState(name))
  if (kinds[name] === 'block' && (!block || !atlas)) return null
  if (block) {
    if (!atlasTexture) atlasTexture = pixelTexture(atlas)
    for (const element of block.elements) {
      const size = element.to.map((v, i) => (v - element.from[i]) / 16)
      const geometry = new THREE.BoxGeometry(...size)
      const uv = geometry.attributes.uv
      const colors = []
      const directions = ['east', 'west', 'up', 'down', 'south', 'north']
      directions.forEach((dir, faceIndex) => {
        const face = element.faces[dir]
        if (!face?.texture) {
          geometry.groups[faceIndex].count = 0
          for (let j = 0; j < 4; j++) colors.push(1, 1, 1)
          return
        }
        const t = face.texture
        const tint = face.tintindex === undefined ? [1, 1, 1]
          : name.includes('leaves') ? [119 / 255, 171 / 255, 47 / 255] : [145 / 255, 189 / 255, 89 / 255]
        for (let j = 0; j < 4; j++) {
          const index = faceIndex * 4 + j
          let u = uv.getX(index); let v = 1 - uv.getY(index)
          for (let turn = 0; turn < (face.rotation || 0) / 90; turn++) [u, v] = [v, 1 - u]
          uv.setXY(index, t.u + u * t.su, 1 - (t.v + v * t.sv))
          colors.push(...tint)
        }
      })
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
      const material = new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true, alphaTest: 0.1, side: THREE.DoubleSide })
      // Preserve per-face groups, all sharing one material.
      const mesh = new THREE.Mesh(geometry, Array(6).fill(material))
      mesh.position.set(...element.to.map((v, i) => (v + element.from[i]) / 32 - 0.5))
      group.add(mesh)
    }
  } else {
    let entry = textures.get(name)
    if (!entry) {
      entry = { texture: null }
      textures.set(name, entry)
      new THREE.TextureLoader().load(`/icons/item/${name}.png`, texture => {
        texture.magFilter = texture.minFilter = THREE.NearestFilter
        entry.texture = texture
      }, undefined, () => { entry.failed = true })
    }
    if (!entry.texture) return null
    const image = entry.texture.image
    const canvas = document.createElement('canvas')
    canvas.width = image.width; canvas.height = image.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data
    // Thin pixel voxels keep tools visible edge-on during their rotation.
    const positions = []; const normals = []; const uvs = []
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (pixels[(y * image.width + x) * 4 + 3] < 26) continue
        const source = new THREE.BoxGeometry(1 / image.width, 1 / image.height, 1 / 16)
        const box = source.toNonIndexed()
        source.dispose()
        box.translate((x + 0.5) / image.width - 0.5, 0.5 - (y + 0.5) / image.height, 0)
        positions.push(...box.attributes.position.array)
        normals.push(...box.attributes.normal.array)
        for (let i = 0; i < box.attributes.position.count; i++) uvs.push((x + 0.5) / image.width, 1 - (y + 0.5) / image.height)
        box.dispose()
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    group.add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ map: entry.texture, alphaTest: 0.1 })))
  }
  group.userData.block = !!block
  return group
}

module.exports = { createItem, disposeItem }
