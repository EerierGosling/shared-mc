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
const LOOK_SEND_MS = 50
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
function setupInput ({ socket, viewer, camera, hud, inventoryUI, canvas, hand, join, creative }) {
  const held = Object.create(null)
  let locked = false
  // Once a finger has steered the camera this browser's angles win over the
  // server's, the same way pointer lock does for a mouse: there is no lock to
  // release on a phone, and snapping back between drags would be unusable.
  let touchLook = false
  let lastLookSent = 0
  let lookPending = false
  let lastForwardTap = 0
  let lastJumpTap = 0
  let useRepeat = null
  const chatHistory = []
  let chatHistoryPos = 0
  let chatDraft = ''

  const uiOpen = () => join.isOpen || inventoryUI.isOpen || hud.chatOpen || hud.dead
  const ownsLook = () => locked || touchLook

  const sendControls = () => {
    const payload = {}
    for (const key of CONTROL_KEYS) {
      payload[key] = key === 'sprint' ? Boolean(held.sprint || held.autoSprint) : Boolean(held[key])
    }
    socket.emit('input:state', payload)
  }

  const setControl = (control, on) => {
    if (Boolean(held[control]) === on) return
    held[control] = on
    if (control === 'forward' && !on) held.autoSprint = false
    sendControls()
  }

  const startDig = () => {
    if (held.digging) return
    held.digging = true
    socket.emit('action:dig', { active: true })
    hand.startSwinging()
  }

  const stopDig = () => {
    if (!held.digging) return
    held.digging = false
    socket.emit('action:dig', { active: false })
    hand.stopSwinging()
  }

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

  const releaseAll = () => {
    let changed = false
    for (const key of CONTROL_KEYS) {
      if (held[key]) { held[key] = false; changed = true }
    }
    if (held.autoSprint) { held.autoSprint = false; changed = true }
    stopDig()
    stopUse()
    if (changed) sendControls()
  }

  const sendLook = force => {
    const now = Date.now()
    if (!force && now - lastLookSent < LOOK_SEND_MS) {
      lookPending = true
      return
    }
    lastLookSent = now
    lookPending = false
    socket.emit('input:look', { yaw: camera.yaw, pitch: camera.pitch })
  }

  setInterval(() => { if (lookPending) sendLook(true) }, LOOK_SEND_MS)

  const turn = (dx, dy, sensitivity) => {
    camera.yaw -= dx * sensitivity
    camera.pitch -= dy * sensitivity
    camera.pitch = Math.max(-HALF_PI, Math.min(HALF_PI, camera.pitch))
    viewer.setFirstPersonCamera(null, camera.yaw, camera.pitch)
    sendLook(false)
  }

  const selectSlot = slot => socket.emit('hotbar', { slot })

  // --- pointer lock ---------------------------------------------------------

  canvas.addEventListener('mousedown', event => {
    if (uiOpen() || isTouchDevice) return
    if (!locked) {
      canvas.requestPointerLock()
      return
    }
    if (event.button === 0) startDig()
    else if (event.button === 2) startUse()
    else if (event.button === 1) {
      // Vanilla's pick block. preventDefault stops the browser opening its
      // middle-click autoscroll instead.
      event.preventDefault()
      socket.emit('creative:pick')
    }
  })

  window.addEventListener('mouseup', event => {
    if (event.button === 0) stopDig()
    else if (event.button === 2) stopUse()
  })

  canvas.addEventListener('contextmenu', event => event.preventDefault())

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas
    if (!locked) releaseAll()
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

  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches ||
    /[?&]touch\b/.test(window.location.search)
  if (isTouchDevice) document.body.classList.add('touch')

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
  // thumb cannot hold it and steer; mine and use are held like mouse buttons.
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
      else if (action === 'sneak') {
        const on = !held.sneak
        setControl('sneak', on)
        button.classList.toggle('on', on)
      } else if (action === 'chat') hud.openChat()
      else if (action === 'inventory') inventoryUI.toggle()
    }
    const release = () => {
      button.classList.remove('down')
      if (control) setControl(control, false)
      else if (action === 'mine') stopDig()
      else if (action === 'use') stopUse()
    }
    button.addEventListener('pointerdown', press)
    button.addEventListener('pointerup', release)
    button.addEventListener('pointercancel', release)
    button.addEventListener('contextmenu', event => event.preventDefault())
  }

  // --- keyboard -------------------------------------------------------------

  window.addEventListener('keydown', event => {
    if (join.isOpen || hud.chatOpen) return

    // F3 toggles the coordinate readout, as in vanilla.
    if (event.code === 'F3') {
      event.preventDefault()
      hud.toggleDebug()
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
    if (event.code === 'Escape') {
      if (inventoryUI.isOpen) inventoryUI.close()
      return
    }
    if (inventoryUI.isOpen) return

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
    if (event.code === 'KeyG') { socket.emit('goto'); return }

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
    ownsLook,
    releaseAll
  }
}

module.exports = setupInput
