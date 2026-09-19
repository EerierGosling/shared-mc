'use strict'
// Some prismarine-viewer internals expect THREE on the global object.
global.THREE = require('three')

const THREE = global.THREE
const io = require('socket.io-client')
const { Viewer } = require('prismarine-viewer/viewer')
const { Hud } = require('./hud')
const InventoryUI = require('./inventory')
const setupInput = require('./input')

const canvas = document.getElementById('viewport')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)

const viewer = new Viewer(renderer)
const socket = io()
const hud = new Hud()
const inventoryUI = new InventoryUI(socket)

// Local camera angles. The server owns position; we own where we are looking,
// so mouse movement shows up on screen before the network round trip lands.
const camera = { yaw: 0, pitch: 0 }

const input = setupInput({ socket, viewer, camera, hud, inventoryUI, canvas })

const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 })
)
highlight.visible = false
viewer.scene.add(highlight)

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
  if (!viewer.setVersion(version)) {
    hud.setStatus('error', `this build cannot render Minecraft ${version}`)
    return
  }
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
})

socket.on('state', state => {
  hud.setState(state)
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

// --- latency readout --------------------------------------------------------
socket.on('latency:pong', sentAt => hud.setPing(Date.now() - sentAt))
setInterval(() => socket.emit('latency:ping', Date.now()), 2000)

// --- render loop ------------------------------------------------------------
function animate () {
  window.requestAnimationFrame(animate)
  viewer.update()
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
