'use strict'
const io = require('socket.io-client')
const setupPhoneControls = require('./phone-controls')
const setupSpeech = require('./speech')
const socket = io({ transports: ['websocket', 'polling'] })
const status = document.getElementById('pair-status')
const code = document.getElementById('pair-code')
const intro = document.getElementById('pair-intro')
const form = document.getElementById('pair-form')
const disconnect = document.getElementById('pair-disconnect')
const connect = document.getElementById('pair-connect')
const talk = document.getElementById('talk')
let paired = false
// iOS gates the accelerometer behind requestPermission inside a user gesture;
// elsewhere it just works, so there we arm thrust-mining the moment we pair.
const needsMotionGesture = Boolean(window.DeviceMotionEvent && typeof window.DeviceMotionEvent.requestPermission === 'function')
// Speech notices replace the pairing status line; the game page gets them as
// chat, which this page has none of.
const speech = setupSpeech({ socket, notify: text => { status.textContent = text.replace(/^\* /, '') } })
// The server says at join:options whether it can transcribe, and the button
// is pointless before pairing: the words have nowhere to go.
let speechEnabled = false
socket.on('join:options', options => {
  speechEnabled = Boolean(options.speech)
  talk.hidden = !(paired && speechEnabled)
})
let wakeLock = null
let wakeGeneration = 0
const hashCode = window.location.hash.slice(1)
let autoPair = /^(?:[a-hj-np-z2-9]{6}|[a-f0-9]{12})$/i.test(hashCode)
if (autoPair) code.value = hashCode.toUpperCase()
// Keep the single-use token out of browser history after the page has read it.
history.replaceState(null, '', window.location.pathname)

async function keepAwake () {
  const token = ++wakeGeneration
  try {
    const lock = await navigator.wakeLock?.request('screen')
    if (token !== wakeGeneration || !paired) { await lock?.release(); return }
    wakeLock = lock
  } catch { /* Visibility watchdog still releases input on sleep. */ }
}
function releaseWake () {
  wakeGeneration++
  wakeLock?.release().catch(() => {})
  wakeLock = null
}
const controls = setupPhoneControls({
  mount: document.getElementById('motion-mount'),
  canPlay: () => paired && socket.connected,
  onStart: () => { if (paired) keepAwake() },
  onStop: releaseWake,
  apply: state => {
    if (paired && socket.connected) socket.volatile.emit('motion:state', { digging: state.digging === true, use: state.use === true })
  }
})
function ended (message) {
  paired = false
  controls.stop()
  controls.hide()
  speech.stop()
  releaseWake()
  intro.hidden = false
  form.hidden = false
  disconnect.hidden = true
  talk.hidden = true
  connect.disabled = !socket.connected
  status.textContent = message
}
function pair () {
  if (!socket.connected) return
  connect.disabled = true
  socket.timeout(5000).emit('motion:pair', { code: code.value }, (error, result) => {
    if (error || result?.error || !result?.ok) {
      connect.disabled = false
      status.textContent = result?.error || 'Pairing timed out. Generate a new code on the game screen and retry.'
      return
    }
    paired = true
    code.value = ''
    status.textContent = 'Paired. Hold Mine or Place to act; enable Player Control on the game screen when ready.'
    intro.hidden = true
    form.hidden = true
    disconnect.hidden = false
    talk.hidden = !speechEnabled
    controls.show()
    // Arm the accelerometer straight away where no permission prompt stands in
    // the way; on iOS the first Mine press does it inside a user gesture.
    if (!needsMotionGesture) controls.start()
    document.getElementById('motion-mount').scrollIntoView({ block: 'center' })
  })
}
document.getElementById('pair-form').addEventListener('submit', event => {
  event.preventDefault()
  pair()
})
disconnect.addEventListener('click', () => { socket.emit('motion:unpair'); ended('Disconnected. Generate a new code to pair again.') })
// Held like the game's own mic button: the mic is open only while a finger
// is down, and anything that takes the finger away (a cancelled pointer, the
// page going hidden) releases it.
talk.addEventListener('pointerdown', event => {
  event.preventDefault()
  if (!paired) return
  talk.setPointerCapture(event.pointerId)
  speech.start()
})
for (const event of ['pointerup', 'pointercancel']) talk.addEventListener(event, () => speech.stop())
talk.addEventListener('contextmenu', event => event.preventDefault())
socket.on('connect', () => {
  connect.disabled = false
  status.textContent = 'Ready to pair. Enter a code and connect.'
  if (autoPair) {
    autoPair = false
    status.textContent = 'Pairing with your game…'
    pair()
  }
})
socket.on('motion:ended', () => ended('Pairing ended. Generate a new code on the game screen.'))
socket.on('disconnect', () => ended('Connection lost. Reconnect with a new pairing code.'))
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { releaseWake(); speech.stop() }
  else if (paired && controls.active) keepAwake()
})
window.addEventListener('pagehide', releaseWake)
