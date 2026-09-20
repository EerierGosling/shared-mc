'use strict'
const io = require('socket.io-client')
const setupPhoneControls = require('./phone-controls')
const socket = io({ transports: ['websocket', 'polling'] })
const status = document.getElementById('pair-status')
const code = document.getElementById('pair-code')
const disconnect = document.getElementById('pair-disconnect')
const connect = document.getElementById('pair-connect')
const show = document.getElementById('show-controls')
let paired = false
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
    if (paired && socket.connected) socket.volatile.emit('motion:state', state)
  }
})
function ended (message) {
  paired = false
  controls.stop()
  releaseWake()
  disconnect.hidden = true
  show.hidden = true
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
    status.textContent = 'Paired. Tap Start Mining to allow motion access and start tracking. Enable Player Control on the game screen when ready.'
    disconnect.hidden = false
    show.hidden = false
    controls.show()
    document.querySelector('[data-action=motion]').scrollIntoView({ block: 'center' })
  })
}
document.getElementById('pair-form').addEventListener('submit', event => {
  event.preventDefault()
  pair()
})
disconnect.addEventListener('click', () => { socket.emit('motion:unpair'); ended('Disconnected. Generate a new code to pair again.') })
show.addEventListener('click', () => controls.show())
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
  if (document.hidden) releaseWake()
  else if (paired && controls.active) keepAwake()
})
window.addEventListener('pagehide', releaseWake)
