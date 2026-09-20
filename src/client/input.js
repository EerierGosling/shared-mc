'use strict'

const setupCameraControls = require('./camera-controls')
const setupSpeech = require('./speech')

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
// A finger drag is in CSS pixels on a screen a fraction of the width, so it
// needs to turn further per pixel than the mouse does.
const TOUCH_SENSITIVITY = 0.006
const HALF_PI = Math.PI / 2
const DOUBLE_TAP_MS = 300
// Vanilla keeps placing every four ticks while right click is held.
const USE_REPEAT_MS = 200
const CHAT_HISTORY = 50

/**
 * Keyboard, mouse and touch capture.
 *
 * Mouse look is applied to the local camera immediately and only then sent to
 * the server, so aiming never waits for a round trip. Everything else is a
 * plain message; the bot stays authoritative over what actually happens.
 *
 * Touch devices get the same messages from on-screen buttons (see #touch in
 * index.html) and steer by dragging the canvas.
 */
function setupInput ({ socket, viewer, camera, hud, inventoryUI, advancementsUI, canvas, hand, join, creative, placePrediction, pause }) {
  const held = Object.create(null)
  let locked = false
  let cameraControls = null
  let gestureState = {}
  let digActive = false
  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches ||
    /[?&]touch\b/.test(window.location.search)
  if (isTouchDevice) document.body.classList.add('touch')
  // Once a finger has steered the camera this browser's angles win over the
  // server's, the same way pointer lock does for a mouse: there is no lock to
  // release on a phone, and snapping back between drags would be unusable.
  let touchLook = false
  let lastLookSent = 0
  let lookTimer = null
  let lastForwardTap = 0
  let lastJumpTap = 0
  let useRepeat = null
  const chatHistory = []
  let chatHistoryPos = 0
  let chatDraft = ''

  const uiOpen = () => join.isOpen || inventoryUI.isOpen || advancementsUI.isOpen || hud.chatOpen || hud.dead || pause.isOpen
  const ownsLook = () => locked || touchLook || Boolean(cameraControls?.active)

  const sendControls = () => {
    const payload = {}
    for (const key of CONTROL_KEYS) {
      payload[key] = key === 'sprint' ? Boolean(held.sprint || held.autoSprint) : Boolean(held[key] || gestureState[key])
    }
    socket.emit('input:state', payload)
  }

  const setControl = (control, on) => {
    if (Boolean(held[control]) === on) return
    held[control] = on
    if (control === 'forward' && !on) held.autoSprint = false
    sendControls()
  }

  const syncDig = () => {
    const active = Boolean(held.digging || gestureState.digging)
    if (active === digActive) return
    digActive = active
    socket.emit('action:dig', { active })
    if (active) hand.startSwinging()
    else hand.stopSwinging()
  }
  const startDig = () => { held.digging = true; syncDig() }
  const stopDig = () => { held.digging = false; syncDig() }

  // One use on press, then repeats while held: vanilla's hold-to-place. The
  // server treats repeats as place-only, so a chest under the crosshair is
  // not reopened every 200 ms.
  const startUse = () => {
    if (useRepeat) return
    socket.emit('action:use')
    hand.swing()
    useRepeat = setInterval(() => {
      socket.emit('action:use', { repeat: true })
      hand.swing()
    }, USE_REPEAT_MS)
  }

  const stopUse = () => {
    clearInterval(useRepeat)
    useRepeat = null
  }

  // Talk is held like mine and use, and only offered when the server has a
  // transcription key behind it.
  const speech = setupSpeech({ socket, hud, button: document.querySelector('#touch [data-action=talk]') })
  socket.on('join:options', options => document.body.classList.toggle('speech', Boolean(options.speech)))

  const releaseAll = () => {
    cameraControls?.reset()
    speech.stop()
    let changed = false
    for (const key of CONTROL_KEYS) {
      if (held[key]) { held[key] = false; changed = true }
    }
    if (held.autoSprint) { held.autoSprint = false; changed = true }
    stopDig()
    stopUse()
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

  const turn = (dx, dy, sensitivity) => {
    camera.yaw -= dx * sensitivity
    camera.pitch -= dy * sensitivity
    camera.pitch = Math.max(-HALF_PI, Math.min(HALF_PI, camera.pitch))
    viewer.setFirstPersonCamera(null, camera.yaw, camera.pitch)
    sendLook(false)
  }

  const selectSlot = slot => socket.emit('hotbar', { slot })

  cameraControls = setupCameraControls({
    socket,
    mount: document.getElementById('pause'),
    canPlay: () => socket.connected && join.joined && !uiOpen() && !document.hidden && document.hasFocus(),
    onStart: () => { releaseAll(); pause.close() },
    onDone: () => pause.showPage('main'),
    apply: (state, dt = 0) => {
      const changed = CONTROL_KEYS.some(key => Boolean(state[key]) !== Boolean(gestureState[key]))
      const startingDig = state.digging && !gestureState.digging
      const startingUse = state.use && !gestureState.use
      gestureState = state
      if (dt && (state.dx || state.dy)) turn(state.dx * dt, state.dy * dt, 1.8)
      if (startingDig || startingUse) flushLook()
      if (startingUse) { placePrediction.place(); socket.emit('action:use'); hand.swing() }
      syncDig()
      if (changed) sendControls()
    }
  })

  // --- pointer lock ---------------------------------------------------------

  canvas.addEventListener('mousedown', event => {
    if (uiOpen() || isTouchDevice || cameraControls.active) return
    if (!locked) {
      canvas.requestPointerLock()
      return
    }
    // Flush the freshest aim ahead of the action so the server raycasts
    // against where the browser is actually pointing.
    if (event.button === 0) {
      flushLook()
      startDig()
    } else if (event.button === 2) {
      flushLook()
      // Draw the assumed placement before the round trip; the server's
      // blockUpdate confirms or corrects it.
      placePrediction.place()
      startUse()
    } else if (event.button === 1) {
      // Vanilla's pick block. preventDefault stops the browser opening its
      // middle-click autoscroll instead.
      event.preventDefault()
      flushLook()
      socket.emit('creative:pick')
    }
  })

  window.addEventListener('mouseup', event => {
    if (event.button === 0) stopDig()
    else if (event.button === 2) stopUse()
  })

  canvas.addEventListener('contextmenu', event => event.preventDefault())

  // Escape is how the browser leaves pointer lock, and Chrome swallows that
  // keydown rather than delivering it, so losing the lock *is* the pause
  // signal, exactly as in vanilla. The other overlays (inventory, chat, the
  // death screen) drop the lock themselves and are already open by the time
  // this fires, which is what keeps them from also raising the menu.
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas
    if (locked) return
    releaseAll()
    if (join.joined && !uiOpen() && !isTouchDevice) pause.open()
  })

  // Back to Game: close the menu and take the mouse again. Chrome refuses a
  // lock for about a second after an Escape exit; if that happens the menu
  // simply comes back, rather than leaving a live HUD that ignores the mouse.
  const resume = () => {
    pause.close()
    if (isTouchDevice || cameraControls?.active) return
    let request
    try {
      request = canvas.requestPointerLock()
    } catch (err) {
      pause.open()
      return
    }
    if (request && typeof request.catch === 'function') request.catch(() => pause.open())
  }
  document.addEventListener('pointerlockerror', () => {
    if (join.joined && !uiOpen() && !isTouchDevice) pause.open()
  })

  document.addEventListener('mousemove', event => {
    if (!locked) return
    turn(event.movementX, event.movementY, SENSITIVITY)
  })

  // Scroll through the hotbar, wrapping at both ends as vanilla does.
  window.addEventListener('wheel', event => {
    if (!locked || uiOpen()) return
    const step = Math.sign(event.deltaY)
    if (!step) return
    const current = hud.lastState ? hud.lastState.quickBarSlot : 0
    selectSlot(((current + step) % 9 + 9) % 9)
  }, { passive: true })

  // --- touch ----------------------------------------------------------------

  // Dragging the canvas looks around. Only the first finger steers, so a
  // second one on a button does not yank the camera.
  let lookTouch = null
  canvas.addEventListener('touchstart', event => {
    if (lookTouch !== null || uiOpen()) return
    const touch = event.changedTouches[0]
    lookTouch = { id: touch.identifier, x: touch.clientX, y: touch.clientY }
  }, { passive: true })
  canvas.addEventListener('touchmove', event => {
    if (lookTouch === null) return
    for (const touch of event.changedTouches) {
      if (touch.identifier !== lookTouch.id) continue
      event.preventDefault()
      turn(touch.clientX - lookTouch.x, touch.clientY - lookTouch.y, TOUCH_SENSITIVITY)
      lookTouch.x = touch.clientX
      lookTouch.y = touch.clientY
      touchLook = true
    }
  }, { passive: false })
  const endLookTouch = event => {
    if (lookTouch === null) return
    for (const touch of event.changedTouches) {
      if (touch.identifier === lookTouch.id) lookTouch = null
    }
  }
  canvas.addEventListener('touchend', endLookTouch)
  canvas.addEventListener('touchcancel', endLookTouch)

  // The on-screen buttons. Movement keys are held; sneak toggles, since a
  // thumb cannot hold it and steer; mine, use and talk are held like mouse
  // buttons.
  for (const button of document.querySelectorAll('#touch button')) {
    const control = button.dataset.control
    const action = button.dataset.action
    const press = event => {
      event.preventDefault()
      if (uiOpen()) return
      button.setPointerCapture(event.pointerId)
      button.classList.add('down')
      if (control) setControl(control, true)
      else if (action === 'mine') startDig()
      else if (action === 'use') startUse()
      else if (action === 'talk') speech.start()
      else if (action === 'sneak') {
        const on = !held.sneak
        setControl('sneak', on)
        button.classList.toggle('on', on)
      } else if (action === 'chat') hud.openChat()
      else if (action === 'inventory') inventoryUI.toggle()
      else if (action === 'menu') pause.open()
    }
    const release = () => {
      button.classList.remove('down')
      if (control) setControl(control, false)
      else if (action === 'mine') stopDig()
      else if (action === 'use') stopUse()
      else if (action === 'talk') speech.stop()
    }
    button.addEventListener('pointerdown', press)
    button.addEventListener('pointerup', release)
    button.addEventListener('pointercancel', release)
    button.addEventListener('contextmenu', event => event.preventDefault())
  }

  // --- keyboard -------------------------------------------------------------

  window.addEventListener('keydown', event => {
    if (event.target.closest?.('#camera-controls')) return
    if (join.isOpen || hud.chatOpen) return

    // F3 toggles the coordinate readout, as in vanilla.
    if (event.code === 'F3') {
      event.preventDefault()
      hud.toggleDebug()
      return
    }

    if (pause.isOpen) {
      // Firefox delivers the Escape that released the lock as well, right
      // after pointerlockchange has opened the menu; a second press is what
      // closes it, so a fresh menu ignores the one that opened it.
      if (event.code === 'Escape' && !pause.justOpened) {
        if (pause.page === 'main') resume()
        else pause.showPage('main')
      }
      return
    }

    if (event.code === 'KeyE' && !hud.dead) {
      event.preventDefault()
      if (locked) document.exitPointerLock()
      inventoryUI.toggle()
      // Vanilla's creative screen opens with the search box already taking
      // keystrokes; nothing else on this overlay wants them.
      if (inventoryUI.isOpen) creative.focusSearch()
      return
    }
    if (event.code === 'KeyL' && !hud.dead) {
      event.preventDefault()
      if (inventoryUI.isOpen) return
      if (locked) document.exitPointerLock()
      advancementsUI.toggle()
      return
    }
    if (event.code === 'Escape') {
      if (inventoryUI.isOpen) inventoryUI.close()
      else if (advancementsUI.isOpen) advancementsUI.close()
      // Escape with nothing open and no lock held (say, after Esc closed
      // the inventory) opens the menu the way it does on desktop vanilla.
      else if (!locked && join.joined && !hud.dead && !isTouchDevice) pause.open()
      return
    }
    if (inventoryUI.isOpen || advancementsUI.isOpen) return

    if (event.code === 'KeyT' || event.code === 'Enter' || event.code === 'Slash') {
      event.preventDefault()
      if (locked) document.exitPointerLock()
      chatHistoryPos = chatHistory.length
      chatDraft = ''
      // '/' opens the chat with the command prefix already typed, as in vanilla.
      hud.openChat(event.code === 'Slash' ? '/' : '')
      return
    }
    // Dead players can still chat, and nothing else.
    if (hud.dead) return

    const digit = event.code.match(/^Digit([1-9])$/)
    if (digit) {
      selectSlot(Number(digit[1]) - 1)
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
    // Double-tapping space is how vanilla toggles creative flight. Asking for
    // it without the grant only earns a notice in chat: the server kicks a bot
    // that flies without permission, so the refusal lives on the server.
    if (control === 'jump') {
      const now = Date.now()
      if (now - lastJumpTap < DOUBLE_TAP_MS && creative.canFly) {
        socket.emit('creative:fly', { active: !creative.flying })
      }
      lastJumpTap = now
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
      if (text) {
        chatHistory.push(text)
        if (chatHistory.length > CHAT_HISTORY) chatHistory.shift()
      }
      // /nick is ours, not Minecraft's: it names this browser in the shared log.
      const nick = text.match(/^\/nick\s+(\S+)/)
      if (nick) socket.emit('chat:name', { name: nick[1] })
      else if (text) socket.emit('chat', { text })
      hud.closeChat()
    } else if (event.key === 'Escape') {
      hud.closeChat()
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      // Up walks back through what this browser sent; down returns, and past
      // the newest line restores whatever was being typed.
      event.preventDefault()
      if (chatHistoryPos === chatHistory.length) chatDraft = hud.chatInput.value
      const next = chatHistoryPos + (event.key === 'ArrowUp' ? -1 : 1)
      if (next < 0 || next > chatHistory.length) return
      chatHistoryPos = next
      hud.chatInput.value = next === chatHistory.length ? chatDraft : chatHistory[next]
      const end = hud.chatInput.value.length
      hud.chatInput.setSelectionRange(end, end)
    }
  })

  return {
    showMotion: on => on ? cameraControls.show() : cameraControls.hide(),
    ownsLook,
    releaseAll,
    resume
  }
}

module.exports = setupInput
