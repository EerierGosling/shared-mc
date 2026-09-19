/* global postMessage self */
'use strict'
// Our build of prismarine-viewer's mesher worker (viewer/lib/worker.js in
// 1.33.0), bundled by webpack.config.js into dist/worker.js instead of using
// the 63 MB prebuilt public/worker.js. Structure follows upstream so a bump can
// be diffed against it; the departures are marked "differs from upstream".
//
// The Node / worker_threads shim at the top of upstream's file is dropped:
// this bundle only ever runs in a browser Worker.

const { Vec3 } = require('vec3')
const { World } = require('prismarine-viewer/viewer/lib/world')
const { getSectionGeometry } = require('prismarine-viewer/viewer/lib/models')

let blocksStates = null
let world = null

function sectionKey (x, y, z) {
  return `${x},${y},${z}`
}

// differs from upstream: prismarine-chunk indexes sections from the world
// floor, which is -64 on 1.18+ and absent (0) on older formats. Upstream does
// chunk.sections[y / 16], which points at the wrong section on 1.18+ and at
// nothing at all for negative y, so caves and anything below y=0 never meshed.
function getSection (chunk, y) {
  return chunk.sections[(y - (chunk.minY || 0)) >> 4]
}

const dirtySections = {}

function setSectionDirty (pos, value = true) {
  const x = Math.floor(pos.x / 16) * 16
  const y = Math.floor(pos.y / 16) * 16
  const z = Math.floor(pos.z / 16) * 16
  const chunk = world.getColumn(x, z)
  const key = sectionKey(x, y, z)
  if (!value) {
    delete dirtySections[key]
    postMessage({ type: 'sectionFinished', key })
  } else if (chunk && getSection(chunk, y)) {
    dirtySections[key] = value
  } else {
    postMessage({ type: 'sectionFinished', key })
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'version') {
    world = new World(data.version)
  } else if (data.type === 'blockStates') {
    blocksStates = data.json
  } else if (data.type === 'dirty') {
    const loc = new Vec3(data.x, data.y, data.z)
    setSectionDirty(loc, data.value)
  } else if (data.type === 'chunk') {
    world.addColumn(data.x, data.z, data.chunk)
  } else if (data.type === 'unloadChunk') {
    world.removeColumn(data.x, data.z)
  } else if (data.type === 'blockUpdate') {
    const loc = new Vec3(data.pos.x, data.pos.y, data.pos.z).floored()
    world.setBlockStateId(loc, data.stateId)
  } else if (data.type === 'reset') {
    world = null
    blocksStates = null
  }
}

setInterval(() => {
  if (world === null || blocksStates === null) return
  const sections = Object.keys(dirtySections)

  if (sections.length === 0) return

  for (const key of sections) {
    let [x, y, z] = key.split(',')
    x = parseInt(x, 10)
    y = parseInt(y, 10)
    z = parseInt(z, 10)
    const chunk = world.getColumn(x, z)
    const section = chunk && getSection(chunk, y)
    if (section) {
      delete dirtySections[key]
      // differs from upstream: most of a 24-section column is air, and walking
      // 4096 blocks to emit no faces is where the initial mesh time went.
      // A null geometry still tells the renderer to drop any stale mesh.
      if (section.solidBlockCount === 0) {
        postMessage({ type: 'geometry', key, geometry: null })
      } else {
        const geometry = getSectionGeometry(x, y, z, world, blocksStates)
        const transferable = [geometry.positions.buffer, geometry.normals.buffer, geometry.colors.buffer, geometry.uvs.buffer]
        postMessage({ type: 'geometry', key, geometry }, transferable)
      }
    }
    postMessage({ type: 'sectionFinished', key })
  }
}, 50)
