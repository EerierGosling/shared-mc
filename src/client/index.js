'use strict'
// Some prismarine-viewer internals expect THREE on the global object.
global.THREE = require('three')

const THREE = global.THREE
const io = require('socket.io-client')
const { Viewer } = require('prismarine-viewer/viewer')
const { supportedVersions } = require('prismarine-viewer/viewer/lib/version')
const { Hud } = require('./hud')
const InventoryUI = require('./inventory')
const AdvancementsUI = require('./advancements')
const CreativeUI = require('./creative')
const BlockLights = require('./lights')
const Minimap = require('./minimap')
const BreakingAnimation = require('./breaking')
const BlockParticles = require('./particles')
const PlacePrediction = require('./place')
const setupInput = require('./input')
const { createSky, applySkyForTime, setSubmerged, updateWaterFog } = require('./sky')
const { Entities } = require('./entities')
const { Hand } = require('./hand')
const { JoinScreen } = require('./join')
const { PhoneLink, buildPairingUI } = require('./phone-pairing')
const PauseMenu = require('./pause')
const setupSettings = require('./settings-panel')
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
viewer.entities = new Entities(viewer.scene, () => Object.values(viewer.world.sectionMeshs))
// Upstream's setFirstPersonCamera starts a new TWEEN per position packet —
// twenty tween allocations a second on a moving bot, the same churn
// entities.js dropped TWEEN for. Same fix here: a retargeted lerp stepped
// from the render loop, over the same 50ms window.
const CAMERA_SMOOTH_MS = 50
const camLerp = { at: 0 }
viewer.setFirstPersonCamera = (pos, yaw, pitch) => {
  if (pos) {
    camLerp.x0 = viewer.camera.position.x
    camLerp.y0 = viewer.camera.position.y
    camLerp.z0 = viewer.camera.position.z
    camLerp.x1 = pos.x
    camLerp.y1 = pos.y + viewer.playerHeight - (viewer.isSneaking ? 0.3 : 0)
    camLerp.z1 = pos.z
    camLerp.at = performance.now()
  }
  viewer.camera.rotation.set(pitch, yaw, 0, 'ZYX')
}
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
const advancementsUI = new AdvancementsUI()
// Hidden until the Minecraft server says the bot really is in creative.
const creative = new CreativeUI(socket)
creative.onState = state => hud.setCreative(state)
const minimap = new Minimap(viewer.entities)
const particles = new BlockParticles(viewer)
const breaking = new BreakingAnimation(viewer.scene, particles)
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
  inventoryUI.setSkin(identity.skin)
  hand.setVisible(true)
  pause.setServer(identity.server)
})

// A phone can pair from the join screen: the code is minted on this socket
// before login and stays valid through it, so the phone is connected by the
// time the game starts. Motion Controls renders the same link in game.
const phoneLink = new PhoneLink(socket)
document.getElementById('join-phone').append(buildPairingUI(phoneLink, {
  title: 'Connect a phone',
  pairedNote: 'Phone paired. Join the game, then enable player control under Motion Controls in the game menu.'
}))

// Escape's game menu. Quitting is a reload: the socket drops, the server
// tears the session down (or just this rider, in a road trip), and the page
// comes back at the join screen.
const pause = new PauseMenu({
  onResume: () => input.resume(),
  onQuit: () => window.location.reload(),
  onPage: page => {
    input.showMotion(page === 'motion')
    if (page === 'settings') settings.show()
    else settings.hide()
  },
  onAdvancements: () => advancementsUI.open()
})

// The Controls page of the game menu. It owns the live tuning object; input.js
// reads it through getControls so a slider lands on the next mouse move.
const settings = setupSettings({ mount: document.getElementById('pause'), onDone: () => pause.showPage('main') })

const input = setupInput({ socket, viewer, camera, hud, inventoryUI, advancementsUI, canvas, hand, join, creative, placePrediction, pause, phoneLink, getControls: settings.get })

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

socket.on('connect', () => {
  // socket.io reconnects with a new id, and the server dropped this socket's
  // membership (and a solo bot) at the disconnect. Left alone, the tab keeps
  // rendering its last frame while input goes to the lobby: the "cannot mine
  // or jump after a while" bug. The world is re-sent from scratch, so the
  // stale columns and entities go first.
  if (join.joined) {
    viewer.resetAll()
    hud.setStatus('connecting', 'reconnected — rejoining…')
    join.rejoin()
    return
  }
  hud.setStatus('connecting', 'connected to the stream')
})

socket.on('disconnect', () => {
  hud.setStatus('error', 'lost the stream — retrying…')
  input.releaseAll()
  // Reconnecting re-sends bot:death if the bot is still dead.
  hud.hideDeath()
})

socket.on('bot:status', status => {
  hud.setStatus(status.state, describeStatus(status), status.server)
  pause.setServer(status.server)
})

// The server ended this session (idle too long, or the bot could not stay
// on its server). Same exit as quitting from the pause menu — a reload back
// to the join screen — with the reason carried across so it can be shown.
socket.on('session:expired', ({ reason }) => {
  try { window.sessionStorage.setItem('join:notice', reason || '') } catch (err) { /* shown nowhere, then */ }
  window.location.reload()
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
socket.on('dig:stop', payload => breaking.stop(payload))

socket.on('state', state => {
  hud.setState(state)
  hand.setItem(state.heldItem)
  hand.setAimBlock(state.targetBlock)
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
    breaking.setTarget(state.targetBlock)
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
  advancementsUI.close()
  hud.showDeath(info, () => socket.emit('respawn'))
})
socket.on('bot:respawn', () => hud.hideDeath())

socket.on('lights', lights => blockLights.set(lights))

// The bot's advancement tree as deltas (full on join), and one event per
// advancement newly earned, for the toast.
socket.on('advancements', delta => advancementsUI.update(delta))
socket.on('advancement:earned', entry => advancementsUI.earned(entry))

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
  if (camLerp.at) {
    const t = Math.min(1, (now - camLerp.at) / CAMERA_SMOOTH_MS)
    viewer.camera.position.set(
      camLerp.x0 + (camLerp.x1 - camLerp.x0) * t,
      camLerp.y0 + (camLerp.y1 - camLerp.y0) * t,
      camLerp.z0 + (camLerp.z1 - camLerp.z0) * t
    )
    if (t === 1) camLerp.at = 0
  }
  breaking.update()
  particles.update(dt, renderer)
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
  if (status.state === 'gone') return `${status.message} — giving up`
  return status.message
}
