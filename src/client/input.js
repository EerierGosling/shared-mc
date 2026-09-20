'use strict'

const KEY_TO_CONTROL = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  Space: 'jump',
  ShiftLeft: 'sneak',
  ShiftRight: 'sneak',
  ControlLeft: 'sprint',
  ControlRight: 'sprint'
}

const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']
// Roughly once per frame. The traffic is one tiny message either way, and what
// the Minecraft server sees is unchanged (mineflayer snapshots yaw/pitch once
// per 50ms physics tick), so sending fresher samples only cuts aim latency.
const LOOK_SEND_MS = 16
const SENSITIVITY = 0.004
const HALF_PI = Math.PI / 2
const DOUBLE_TAP_MS = 300

/**
 * Keyboard + mouse capture.
 *
 * Mouse look is applied to the local camera immediately and only then sent to
 * the server, so aiming never waits for a round trip. Everything else is a
 * plain message; the bot stays authoritative over what actually happens.
 */
function setupInput ({ socket, viewer, camera, hud, inventoryUI, canvas, hand, join }) {
  const held = Object.create(null)
  let locked = false
  let lastLookSent = 0
  let lookTimer = null
  let lastForwardTap = 0

  const sendControls = () => {
    const payload = {}
    for (const key of CONTROL_KEYS) {
      payload[key] = key === 'sprint' ? Boolean(held.sprint || held.autoSprint) : Boolean(held[key])
    }
    socket.emit('input:state', payload)
  }

  const releaseAll = () => {
    let changed = false
    for (const key of CONTROL_KEYS) {
      if (held[key]) { held[key] = false; changed = true }
    }
    if (held.autoSprint) { held.autoSprint = false; changed = true }
    if (held.digging) {
      held.digging = false
      socket.emit('action:dig', { active: false })
      hand.stopSwinging()
    }
    if (changed) sendControls()
  }

  const emitLook = () => {
    lastLookSent = Date.now()
    socket.emit('input:look', { yaw: camera.yaw, pitch: camera.pitch })
  }

  const sendLook = () => {
    // A scheduled trailing send reads the camera when it fires, so it already
    // covers every sample between now and then. The old polling interval could
    // sit on the final sample of a flick for a full extra window.
    if (lookTimer) return
    const wait = LOOK_SEND_MS - (Date.now() - lastLookSent)
    if (wait <= 0) {
      emitLook()
      return
    }
    lookTimer = setTimeout(() => {
      lookTimer = null
      emitLook()
    }, wait)
  }

  // Dig/use/attack raycast server-side against the bot's current aim, so the
  // freshest angles must be on the wire ahead of the action message — socket.io
  // preserves per-connection order, which makes this exact rather than merely
  // likely.
  const flushLook = () => {
    if (lookTimer) {
      clearTimeout(lookTimer)
      lookTimer = null
    }
    emitLook()
  }

  // --- pointer lock ---------------------------------------------------------

  canvas.addEventListener('mousedown', event => {
    if (join.isOpen || inventoryUI.isOpen || hud.chatOpen || hud.dead) return
    if (!locked) {
      canvas.requestPointerLock()
      return
    }
    if (event.button === 0) {
      flushLook()
      held.digging = true
      socket.emit('action:dig', { active: true })
      hand.startSwinging()
    } else if (event.button === 2) {
      flushLook()
      socket.emit('action:use')
    }
  })

  window.addEventListener('mouseup', event => {
    if (event.button === 0 && held.digging) {
      held.digging = false
      socket.emit('action:dig', { active: false })
      hand.stopSwinging()
    }
  })

  canvas.addEventListener('contextmenu', event => event.preventDefault())

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas
    if (!locked) releaseAll()
  })

  document.addEventListener('mousemove', event => {
    if (!locked) return
    camera.yaw -= event.movementX * SENSITIVITY
    camera.pitch -= event.movementY * SENSITIVITY
    camera.pitch = Math.max(-HALF_PI, Math.min(HALF_PI, camera.pitch))
    viewer.setFirstPersonCamera(null, camera.yaw, camera.pitch)
    sendLook()
  })

  // --- keyboard -------------------------------------------------------------

  window.addEventListener('keydown', event => {
    if (join.isOpen || hud.chatOpen) return

    if (event.code === 'KeyE' && !hud.dead) {
      event.preventDefault()
      if (locked) document.exitPointerLock()
      inventoryUI.toggle()
      return
    }
    if (event.code === 'Escape') {
      if (inventoryUI.isOpen) inventoryUI.close()
      return
    }
    if (inventoryUI.isOpen) return

    if (event.code === 'KeyT' || event.code === 'Enter') {
      event.preventDefault()
      if (locked) document.exitPointerLock()
      hud.openChat()
      return
    }
    // Dead players can still chat, and nothing else.
    if (hud.dead) return

    const digit = event.code.match(/^Digit([1-9])$/)
    if (digit) {
      socket.emit('hotbar', { slot: Number(digit[1]) - 1 })
      return
    }

    if (event.code === 'KeyQ') { socket.emit('drop'); return }
    if (event.code === 'KeyG') { flushLook(); socket.emit('goto'); return }

    const control = KEY_TO_CONTROL[event.code]
    if (!control || held[control]) return
    if (event.code === 'Space') event.preventDefault()
    if (control === 'forward') {
      const now = Date.now()
      if (now - lastForwardTap < DOUBLE_TAP_MS) held.autoSprint = true
      lastForwardTap = now
    }
    held[control] = true
    sendControls()
  })

  window.addEventListener('keyup', event => {
    const control = KEY_TO_CONTROL[event.code]
    if (!control || !held[control]) return
    held[control] = false
    if (control === 'forward') held.autoSprint = false
    sendControls()
  })

  // A tab losing focus must not leave the bot sprinting into a ravine.
  window.addEventListener('blur', releaseAll)

  // --- chat -----------------------------------------------------------------

  hud.chatInput.addEventListener('keydown', event => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      const text = hud.chatInput.value.trim()
      // /nick is ours, not Minecraft's: it names this browser in the shared log.
      const nick = text.match(/^\/nick\s+(\S+)/)
      if (nick) socket.emit('chat:name', { name: nick[1] })
      else if (text) socket.emit('chat', { text })
      hud.closeChat()
    } else if (event.key === 'Escape') {
      hud.closeChat()
    }
  })

  return {
    ownsLook: () => locked,
    releaseAll
  }
}

module.exports = setupInput
