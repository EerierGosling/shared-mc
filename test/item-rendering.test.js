'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const THREE = require('three')
global.THREE = THREE
global.document = { fonts: { load: () => Promise.resolve() } }
const icons = require('../src/client/icons')
const rect = { u: 0, v: 0, su: 1, sv: 1 }
icons.itemAssets = () => ({ kinds: { stone: 'block' }, atlas: { width: 16, height: 16 } })
icons.blockState = () => ({ variants: { '': { model: { elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(['east', 'west', 'up', 'down', 'south', 'north'].map(dir => [dir, { texture: rect }])) }] } } } })
const { Entities } = require('../src/client/entities')
const { createItem, disposeItem } = require('../src/client/item-model')

test('block items have all six textured faces and release owned resources', () => {
  const model = createItem('stone')
  assert.equal(model.userData.block, true)
  const mesh = model.children[0]
  assert.equal(mesh.geometry.groups.length, 6)
  assert.ok([...mesh.geometry.attributes.uv.array].every(Number.isFinite))
  let disposed = 0
  mesh.material[0].addEventListener('dispose', () => disposed++)
  disposeItem(model)
  assert.equal(disposed, 1)
  assert.equal(model.children.length, 0)
})

test('drops spawn at their position and animate without movement packets', () => {
  const entities = new Entities(new THREE.Scene())
  entities.update({ id: 7, name: 'item', pos: { x: 100, y: 64, z: 100 } })
  const mesh = entities.entities[7]
  assert.equal(mesh.position.x, 100)
  entities.update({ id: 7, itemName: 'stone' })
  entities.animate(0.016)
  const model = mesh.userData.visual.children[0]
  assert.ok(model)
  const yaw = mesh.userData.visual.rotation.y
  entities.update({ id: 7, itemName: 'stone', yaw: 3 })
  entities.animate(0.016)
  assert.equal(mesh.userData.visual.children[0], model)
  assert.ok(mesh.userData.visual.rotation.y > yaw)
  assert.ok(mesh.userData.visual.position.y > 0.15)
  assert.equal(mesh.rotation.y, 0)
  assert.equal(mesh.userData.shadow.visible, false)
  let released = false
  model.children[0].geometry.addEventListener('dispose', () => { released = true })
  entities.update({ id: 7, delete: true })
  assert.equal(entities.entities[7], undefined)
  assert.equal(released, true)
})


test('hand switches held items and recovers when assets arrive late', () => {
  const originalLoad = THREE.TextureLoader.prototype.load
  THREE.TextureLoader.prototype.load = () => {}
  try {
    const { Hand } = require('../src/client/hand')
    const hand = new Hand()
    const camera = new THREE.PerspectiveCamera()
    const renderer = { clearDepth () {}, render () {} }
    const assets = icons.itemAssets
    icons.itemAssets = () => ({ kinds: null })
    hand.setItem({ name: 'stone' })
    hand.render(renderer, camera)
    assert.equal(hand.item.children.length, 0)
    icons.itemAssets = assets
    hand.render(renderer, camera)
    assert.equal(hand.item.children.length, 1)
    assert.equal(hand.arm.visible, true)
    hand.setItem(null)
    assert.equal(hand.item.children.length, 0)
    assert.equal(hand.arm.visible, true)
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad
  }
})

test('drop shadows land on terrain below the item', () => {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial())
  floor.rotation.x = -Math.PI / 2
  floor.position.y = 0.5
  floor.updateMatrixWorld(true)
  const entities = new Entities(new THREE.Scene(), () => [floor])
  entities.update({ id: 2, name: 'item', pos: { x: 0, y: 1, z: 0 }, itemName: 'stone' })
  entities.animate(0.016)
  const mesh = entities.entities[2]
  assert.equal(mesh.userData.shadow.visible, true)
  assert.ok(Math.abs(mesh.position.y + mesh.userData.shadow.position.y - 0.508) < 0.001)
})
