'use strict'
// Some prismarine-viewer internals expect THREE on the global object.
global.THREE = require('three')

const THREE = global.THREE
const io = require('socket.io-client')
const { Viewer } = require('prismarine-viewer/viewer')
const { supportedVersions } = require('prismarine-viewer/viewer/lib/version')
const { Hud } = require('./hud')
const InventoryUI = require('./inventory')
const BlockLights = require('./lights')
const Minimap = require('./minimap')
const BreakingAnimation = require('./breaking')
const setupInput = require('./input')
const { createSky, applySkyForTime } = require('./sky')
const { Entities } = require('./entities')
const { Hand } = require('./hand')

const canvas = document.getElementById('viewport')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)

const viewer = new Viewer(renderer)
// Swap in our own entity manager before listen() wires it up — it renders the
// same real mob models but falls back to a body+head shape instead of a flat
// box for the mobs prismarine-viewer never got geometry for (see entities.js).
viewer.entities = new Entities(viewer.scene)
// Websocket first: the default polling-then-upgrade dance never completes
// here — the initial chunk dump saturates the polling transport so the
// upgrade probe starves, leaving the whole stream on long-polling (seconds
// of queueing). Polling stays as the fallback for proxies that block ws.
const socket = io({ transports: ['websocket', 'polling'] })
const hud = new Hud()
const inventoryUI = new InventoryUI(socket)
const minimap = new Minimap()
const breaking = new BreakingAnimation(viewer.scene)

// First-person hand viewmodel, parented to the camera so it rides along with
// look direction for free. Swung from input.js while a dig/attack is held.
const hand = new Hand()
hand.attachTo(viewer.camera)

// Local camera angles. The server owns position; we own where we are looking,
// so mouse movement shows up on screen before the network round trip lands.
const camera = { yaw: 0, pitch: 0 }

const input = setupInput({ socket, viewer, camera, hud, inventoryUI, canvas, hand })

const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 })
)
highlight.visible = false
viewer.scene.add(highlight)

const sky = createSky(viewer)
const blockLights = new BlockLights(viewer.scene)

let listening = false

socket.on('connect', () => hud.setStatus('connecting', 'connected to the stream, waiting for the bot…'))

socket.on('disconnect', () => {
  hud.setStatus('error', 'lost the stream — retrying…')
  input.releaseAll()
})

socket.on('bot:status', status => {
  hud.setStatus(status.state, describeStatus(status))
})

socket.on('version', version => {
  // The server serves /textures/<version>* and /blocksStates/<version>.json
  // for whatever it runs (aliasing a shipped atlas when needed), so take the
  // version as-is — letting the viewer round down to the previous atlas
  // strips every block added after it.
  if (!supportedVersions.includes(version)) supportedVersions.push(version)
  if (!viewer.setVersion(version)) {
    hud.setStatus('error', `this build cannot render Minecraft ${version}`)
    return
  }
  breaking.setVersion(version)
  if (!listening) {
    // Wires loadChunk / unloadChunk / entity / blockUpdate straight off the socket.
    viewer.listen(socket)
    listening = true
  }
})

socket.on('position', ({ pos, yaw, pitch }) => {
  // While we hold pointer lock our own angles win; otherwise ride along with
  // whoever is currently driving.
  if (!input.ownsLook()) {
    camera.yaw = yaw
    camera.pitch = pitch
  }
  viewer.setFirstPersonCamera(pos, camera.yaw, camera.pitch)
  minimap.setCenter(pos)
})

socket.on('dig:start', payload => breaking.start(payload))
socket.on('dig:stop', () => breaking.stop())

socket.on('state', state => {
  hud.setState(state)
  applySkyForTime(viewer, state.timeOfDay, sky)
  if (state.targetBlock) {
    const { x, y, z } = state.targetBlock.position
    highlight.position.set(x + 0.5, y + 0.5, z + 0.5)
    highlight.visible = true
  } else {
    highlight.visible = false
  }
})

socket.on('chat', message => {
  hud.addChat(message.text, message.position === 'system' ? 'system' : null)
})

socket.on('lights', lights => blockLights.set(lights))

// --- latency readout --------------------------------------------------------
socket.on('latency:pong', sentAt => hud.setPing(Date.now() - sentAt))
setInterval(() => socket.emit('latency:ping', Date.now()), 2000)

// --- render loop ------------------------------------------------------------
function animate () {
  window.requestAnimationFrame(animate)
  viewer.update()
  breaking.update()
  minimap.setYaw(camera.yaw)
  minimap.render(renderer, viewer.scene)
  renderer.render(viewer.scene, viewer.camera)
}
animate()

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  viewer.camera.aspect = window.innerWidth / window.innerHeight
  viewer.camera.updateProjectionMatrix()
})

function describeStatus (status) {
  if (status.state === 'connected') return status.message
  if (status.state === 'reconnecting') return `bot disconnected (${status.message}) — reconnecting…`
  return status.message
}
