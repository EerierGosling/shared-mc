'use strict'
// Some prismarine-viewer internals expect THREE on the global object.
global.THREE = require('three')

const THREE = global.THREE
const io = require('socket.io-client')
const { Viewer } = require('prismarine-viewer/viewer')
const { supportedVersions } = require('prismarine-viewer/viewer/lib/version')
const { Hud } = require('./hud')
const InventoryUI = require('./inventory')
const CreativeUI = require('./creative')
const BlockLights = require('./lights')
const Minimap = require('./minimap')
const BreakingAnimation = require('./breaking')
const PlacePrediction = require('./place')
const setupInput = require('./input')
const { createSky, applySkyForTime, setSubmerged, updateWaterFog } = require('./sky')
const { Entities } = require('./entities')
const { Hand } = require('./hand')
const { JoinScreen } = require('./join')
const PauseMenu = require('./pause')
const SkinPainter = require('./skins')
const icons = require('./icons')

const canvas = document.getElementById('viewport')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)

const viewer = new Viewer(renderer)
// Swap in our own entity manager before listen() wires it up — it renders the
// same real mob models but falls back to a body+head shape instead of a flat
// box for the mobs prismarine-viewer never got geometry for (see entities.js).
viewer.entities = new Entities(viewer.scene)
// Debug hook: lets a devtools console or a headless probe poke the scene.
window.__viewer = viewer
// Websocket first: the default polling-then-upgrade dance never completes
// here — the initial chunk dump saturates the polling transport so the
// upgrade probe starves, leaving the whole stream on long-polling (seconds
// of queueing). Polling stays as the fallback for proxies that block ws.
const socket = io({ transports: ['websocket', 'polling'] })
window.__socket = socket
const hud = new Hud()
const underwater = document.getElementById('underwater')
const inventoryUI = new InventoryUI(socket)
// Hidden until the Minecraft server says the bot really is in creative.
const creative = new CreativeUI(socket)
creative.onState = state => hud.setCreative(state)
const minimap = new Minimap(viewer.entities)
const breaking = new BreakingAnimation(viewer.scene)
const placePrediction = new PlacePrediction(viewer, socket)

// First-person hand viewmodel: its own scene and lights, drawn over the world
// as a second pass in the render loop. Swung from input.js while a dig/attack
// is held.
const hand = new Hand()
hand.setVisible(false)

// Local camera angles. The server owns position; we own where we are looking,
// so mouse movement shows up on screen before the network round trip lands.
const camera = { yaw: 0, pitch: 0 }

// Nothing is driveable until this visitor has a bot of their own, so input is
// wired only once the join is accepted. Until then the browser is just a page.
const skins = new SkinPainter(viewer)
const join = new JoinScreen(socket, identity => {
  hud.setStatus('connecting', `joining as ${identity.username}…`)
  hand.setVisible(true)
  pause.setServer(identity.server)
})

// Escape's game menu. Quitting is a reload: the socket drops, the server
// tears the session down (or just this rider, in a road trip), and the page
// comes back at the join screen.
const pause = new PauseMenu({
  onResume: () => input.resume(),
  onQuit: () => window.location.reload()
})

const input = setupInput({ socket, viewer, camera, hud, inventoryUI, canvas, hand, join, creative, placePrediction, pause })

const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 })
)
highlight.visible = false
viewer.scene.add(highlight)

const sky = createSky(viewer)
const blockLights = new BlockLights(viewer.scene)

let listening = false


socket.on('roster', roster => {
  skins.setRoster(roster)
  hud.setRoster(roster)
})

// The viewer consumes 'entity' itself; we watch the same stream to learn which
// entity id belongs to which player so their skin can be painted on.
socket.on('entity', entity => {
  skins.noteEntity(entity)
  skins.apply()
})

socket.on('action:refused', ({ kind, retryIn }) => {
  hud.addChat(`* too much ${kind} — wait ${retryIn}s`, 'system')
})

socket.on('connect', () => hud.setStatus('connecting', 'connected to the stream'))

socket.on('disconnect', () => {
  hud.setStatus('error', 'lost the stream — retrying…')
  input.releaseAll()
  // Reconnecting re-sends bot:death if the bot is still dead.
  hud.hideDeath()
})

socket.on('bot:status', status => {
  hud.setStatus(status.state, describeStatus(status))
  pause.setServer(status.server)
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
  icons.init(version, () => {
    hud.refreshHotbar()
    inventoryUI.refresh()
  })
  if (!listening) {
    // Wires loadChunk / unloadChunk / entity / blockUpdate straight off the socket.
    viewer.listen(socket)
    // Entity moves arrive merged per tick as one array (worldStream.js), so
    // the skin painter has to be fed from here as well as from 'entity'.
    socket.on('entities', list => {
      for (const e of list) {
        viewer.updateEntity(e)
        skins.noteEntity(e)
      }
      skins.apply()
    })
    listening = true
  }
})

let lastPos = null
socket.on('position', ({ pos, yaw, pitch }) => {
  // While we hold pointer lock our own angles win; otherwise ride along with
  // whoever is currently driving.
  if (!input.ownsLook()) {
    camera.yaw = yaw
    camera.pitch = pitch
  }
  lastPos = pos
  viewer.setFirstPersonCamera(pos, camera.yaw, camera.pitch)
  minimap.setCenter(pos)
})

socket.on('dig:start', payload => breaking.start(payload))
socket.on('dig:stop', () => breaking.stop())

socket.on('state', state => {
  hud.setState(state)
  placePrediction.setTarget(state.placeTarget)
  applySkyForTime(viewer, state.timeOfDay, sky)
  setSubmerged(viewer, sky, state.eyeInWater)
  underwater.classList.toggle('on', Boolean(state.eyeInWater))
  // The camera dips while sneaking. Viewer only applies the flag on the next
  // position packet, and a bot sneaking in place never sends one, so reapply
  // the last position ourselves.
  const sneaking = Boolean(state.sneaking)
  if (viewer.isSneaking !== sneaking) {
    viewer.isSneaking = sneaking
    if (lastPos) viewer.setFirstPersonCamera(lastPos, camera.yaw, camera.pitch)
  }
  if (state.targetBlock) {
    const { x, y, z } = state.targetBlock.position
    highlight.position.set(x + 0.5, y + 0.5, z + 0.5)
    highlight.visible = true
  } else {
    highlight.visible = false
  }
})

socket.on('chat', entry => hud.addChat(entry))
socket.on('chat:history', entries => hud.setChatHistory(entries))

// bot:death { diedAt, respawnAt, cause, score } arrives on death, again once
// the combat packet supplies the cause, and on connect while the bot is dead.
// The bot does not auto-respawn: 'respawn' from any browser, or respawnAt
// passing, puts it back and bot:respawn follows.
socket.on('bot:death', info => {
  // The button needs a real cursor, and held keys must not carry over into
  // the respawned bot.
  input.releaseAll()
  if (document.pointerLockElement) document.exitPointerLock()
  inventoryUI.close()
  hud.showDeath(info, () => socket.emit('respawn'))
})
socket.on('bot:respawn', () => hud.hideDeath())

socket.on('lights', lights => blockLights.set(lights))

// --- latency readout --------------------------------------------------------
socket.on('latency:pong', sentAt => hud.setPing(Date.now() - sentAt))
setInterval(() => socket.emit('latency:ping', Date.now()), 2000)

// --- render loop ------------------------------------------------------------
// Two passes share the frame (world, then the hand over it), so the clear is
// ours to do rather than render()'s.
renderer.autoClear = false
let lastFrameTime = performance.now()
function animate () {
  window.requestAnimationFrame(animate)
  const now = performance.now()
  const dt = (now - lastFrameTime) / 1000
  lastFrameTime = now
  viewer.update()
  breaking.update()
  viewer.entities.animate(dt)
  minimap.setYaw(camera.yaw)
  // The minimap looks down from well above the water, so it takes its pass
  // with the fog lifted; the ramp then runs for the first-person view.
  const fog = viewer.scene.fog
  viewer.scene.fog = null
  minimap.render(renderer, viewer.scene)
  viewer.scene.fog = fog
  updateWaterFog(viewer)
  if (underwater.classList.contains('on')) {
    // Vanilla scrolls the film by yaw/64 and pitch/64 tiles, in degrees.
    const tileX = THREE.MathUtils.radToDeg(camera.yaw) / 64
    const tileY = THREE.MathUtils.radToDeg(camera.pitch) / 64
    underwater.style.backgroundPosition = `${(tileX * 25).toFixed(2)}vw ${(tileY * 25).toFixed(2)}vh`
  }
  renderer.clear()
  renderer.render(viewer.scene, viewer.camera)
  hand.render(renderer, viewer.camera)
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
