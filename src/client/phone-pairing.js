'use strict'
const QRCode = require('qrcode')
const { idle } = require('./gestures')

// The host half of motion:* phone pairing, kept apart from the screens that
// render it: one pairing exists per socket, so the join screen and the
// motion-controls panel show the same state. The server accepts a pairing
// before the browser joins and only relays the phone's input once the host
// is a player (src/server/motion-pairing.js), so a phone connected on the
// join screen is simply quiet until the game starts.
class PhoneLink {
  constructor (socket) {
    this.socket = socket
    this.paired = false
    this.code = null
    this.expires = 0
    this.remote = idle()
    this.remoteAt = -Infinity
    this.handlers = { paired: [], stale: [], ended: [] }
    const reset = () => {
      const had = this.paired || this.code
      this.paired = false
      this.code = null
      this.remote = idle()
      this.remoteAt = -Infinity
      if (had) this.emit('ended')
    }
    socket.on('motion:paired', () => {
      this.paired = true
      this.code = null
      this.emit('paired')
    })
    socket.on('motion:state', state => {
      if (!this.paired) return
      this.remote = state
      this.remoteAt = performance.now()
    })
    socket.on('motion:stale', () => { this.remote = idle(); this.emit('stale') })
    socket.on('motion:ended', reset)
    // A reconnect is a new socket id; the pairing died with the old one.
    socket.on('disconnect', reset)
  }

  on (event, fn) { this.handlers[event].push(fn) }
  emit (event) { for (const fn of this.handlers[event]) fn() }

  // The phone's latest input, or idle once a packet is older than the server's
  // own staleness window.
  fresh (now = performance.now()) {
    return this.paired && now - this.remoteAt < 350 ? this.remote : idle()
  }

  requestCode (reply) { this.socket.timeout(5000).emit('motion:create', reply) }
  unpair () { this.socket.emit('motion:unpair') }
}

// The expandable pairing block: "Generate QR Code" mints a code and draws it,
// the code itself is shown large for typing by hand, and the address field
// exists because localhost on a phone points at the phone. Mounted on the
// join screen and inside Motion Controls; both render the one PhoneLink.
function buildPairingUI (link, {
  title = 'Phone',
  pairedNote = 'Phone paired. Enable player control here and on the phone when ready.'
} = {}) {
  const socket = link.socket
  const details = document.createElement('details')
  details.className = 'phone-pair'
  details.dataset.role = 'pairing'
  details.innerHTML = `<summary class="mc-button">${title}</summary>
    <p>Open <a href="/controller" target="_blank" rel="noopener">the phone controller</a> on your phone and enter the code, or scan it. Both devices must reach this site over HTTPS.</p>
    <div class="motion-buttons">
      <button type="button" class="mc-button" data-action="pair">Generate QR Code</button>
      <button type="button" class="mc-button" data-action="unpair">Disconnect Phone</button>
    </div>
    <canvas data-role="pair-qr" tabindex="-1" role="img" aria-label="Scan to open the phone controller with the pairing code" hidden></canvas>
    <strong data-role="pair-code"></strong><a data-role="pair-link" target="_blank" rel="noopener"></a>
    <p data-role="pair-status">No phone connected. Codes expire after five minutes and work once.</p>
    <label class="motion-field">Site address reachable from your phone <input type="text" class="mc-text" data-role="pair-origin" aria-label="Phone-accessible HTTPS site address"></label>
    <small>Use this server's HTTPS address. localhost on your phone points to the phone, not your computer.</small>
    <small>The phone uses its accelerometer for mining. Pairing does not create another player.</small>`
  const $ = selector => details.querySelector(selector)
  const pairStatus = $('[data-role=pair-status]')
  const pairButton = $('[data-action=pair]')
  const origin = $('[data-role=pair-origin]')
  origin.value = window.location.origin
  // On the join screen this block sits inside the join form; Enter in the
  // address field must not become a join.
  origin.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault() })
  const clearCode = () => {
    $('[data-role=pair-qr]').hidden = true
    $('[data-role=pair-code]').textContent = ''
    const anchor = $('[data-role=pair-link]')
    anchor.removeAttribute('href')
    anchor.textContent = ''
  }
  const readTarget = () => {
    try {
      const target = new URL('/p', origin.value)
      if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('address')
      return target
    } catch {
      pairStatus.textContent = 'Enter a valid HTTPS address for this game server.'
      return null
    }
  }
  const showCode = async (code, target) => {
    target.hash = code
    $('[data-role=pair-code]').textContent = code
    const anchor = $('[data-role=pair-link]')
    anchor.href = target.href
    anchor.textContent = 'Open phone controller'
    pairStatus.textContent = 'Scan this QR code with your phone to connect automatically. Code expires in five minutes.'
    if (target.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) pairStatus.textContent += ' This address will not provide camera/motion access on a separate phone; use a phone-accessible HTTPS address.'
    const qr = $('[data-role=pair-qr]')
    qr.hidden = true
    try {
      await QRCode.toCanvas(qr, target.href, { width: 240, margin: 4, errorCorrectionLevel: 'M' })
      // A newer code or a completed pairing can land while the QR renders.
      if ($('[data-role=pair-code]').textContent === code && link.code === code) {
        details.open = true
        qr.hidden = false
        qr.focus({ preventScroll: true })
        qr.scrollIntoView({ block: 'center' })
      }
    } catch { pairStatus.textContent += ' QR generation failed; enter the code manually.' }
  }
  pairButton.addEventListener('click', async () => {
    if (pairButton.disabled) return
    details.open = true
    if (!socket.connected) { pairStatus.textContent = 'Connect to the game first.'; return }
    const target = readTarget()
    if (!target) return
    pairButton.disabled = true
    pairStatus.textContent = 'Creating phone pairing QR code…'
    link.requestCode(async (error, result) => {
      if (error || result?.error || !/^(?:[A-HJ-NP-Z2-9]{6}|[A-F0-9]{12})$/.test(result?.code || '')) {
        pairButton.disabled = false
        pairStatus.textContent = result?.error || 'Pairing request failed or timed out. Retry.'
        pairStatus.scrollIntoView({ block: 'nearest' })
        return
      }
      link.code = result.code
      link.expires = result.expires
      try { await showCode(result.code, target) } finally { pairButton.disabled = false }
    })
  })
  // Opening the block asks for a code; a still-valid one is re-shown instead,
  // so the other screen can display the same pairing.
  details.addEventListener('toggle', () => {
    if (!details.open || link.paired) return
    if (link.code && link.expires > Date.now()) {
      const target = readTarget()
      if (target) showCode(link.code, target)
    } else {
      pairButton.click()
    }
  })
  $('[data-action=unpair]').addEventListener('click', () => link.unpair())
  link.on('paired', () => { clearCode(); pairStatus.textContent = pairedNote })
  link.on('stale', () => { pairStatus.textContent = 'Phone input timed out — keep its page visible and awake.' })
  link.on('ended', () => { clearCode(); pairStatus.textContent = 'Phone disconnected or code expired. Generate a code to pair again.' })
  // The pairing can already exist when this block mounts, made on the other
  // screen; reflect it instead of reporting "no phone".
  if (link.paired) pairStatus.textContent = pairedNote
  return details
}

module.exports = { PhoneLink, buildPairingUI }
