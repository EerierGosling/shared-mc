'use strict'

// Must match SKIN_VARIANT in src/server/skins.js: the entity model geometry
// differs between wide and slim, and we only ship the wide one.
const SKIN_VARIANT = 'wide'

const { modeBadge } = require('./badges')

const skinUrl = skin => `/assets/entity/player/${SKIN_VARIANT}/${skin}.png`

// 'roadtrip' is the id the server and the socket protocol know it by; the
// page calls it Collaborative.
const MODES = [
  {
    id: 'roadtrip',
    title: 'Collaborative',
    blurb: 'Very chaotic. Control a player at the same time as everyone else.'
  },
  {
    id: 'solo',
    title: 'Solo',
    blurb: 'Control your own player.'
  }
]

/**
 * The mode-and-identity screen shown before a visitor gets a bot.
 *
 * Laid out like Minecraft's world select: the server address, a list of rows
 * you pick from, then a button along the bottom. Choosing Collaborative needs
 * nothing else, since that
 * character is shared and already named; choosing your own bot reveals the
 * name and skin fields.
 *
 * Nothing touches the Minecraft server until this resolves — a browser sitting
 * on this screen costs no player slot.
 */
class JoinScreen {
  constructor (socket, onJoined) {
    this.socket = socket
    this.onJoined = onJoined
    this.root = document.getElementById('join')
    this.form = document.getElementById('join-panel')
    this.modeList = document.getElementById('join-modes')
    this.identity = document.getElementById('join-identity')
    this.nameInput = document.getElementById('join-name')
    this.skinList = document.getElementById('join-skins')
    this.error = document.getElementById('join-error')
    this.hostInput = document.getElementById('join-host')
    this.portInput = document.getElementById('join-port')
    this.build = document.getElementById('join-build')
    this.button = document.getElementById('join-button')
    this.doll = document.getElementById('join-doll')

    this.mode = null
    this.skin = 'steve'
    this.options = null
    this.renderedSkins = false
    this.setDoll(this.skin)

    socket.on('join:options', options => this.setOptions(options))
    socket.on('join:rejected', ({ reason }) => this.reject(reason))
    socket.on('join:accepted', identity => this.accept(identity))

    this.form.addEventListener('submit', event => {
      event.preventDefault()
      this.submit()
    })
  }

  get isOpen () {
    return this.root.classList.contains('open')
  }

  setOptions (options) {
    this.options = options
    if (!this.isOpen && !this.joined) this.root.classList.add('open')
    // The configured server, if any, is only a placeholder: a blank field
    // means "that one", and typing over it goes somewhere else.
    const { host, port } = options.defaultServer || {}
    this.hostInput.placeholder = host || 'server address'
    this.portInput.placeholder = port || '25565'
    if (!this.restoredServer) {
      this.restoredServer = true
      try {
        const last = JSON.parse(window.localStorage.getItem('server') || 'null')
        if (last && last.host) {
          this.hostInput.value = last.host
          this.portInput.value = last.port || ''
        }
      } catch (err) { /* no storage; the placeholder stands */ }
    }
    if (options.commit) this.build.textContent = options.commit
    this.renderModes()
    if (!this.renderedSkins) {
      this.renderSkins(options.skins)
      this.renderedSkins = true
    }
    this.refreshHint()
    // Why the last session ended, left by index.js before it reloaded the
    // page; shown once, in the same slot a refused join uses.
    if (this.notice === undefined) {
      this.notice = null
      try {
        this.notice = window.sessionStorage.getItem('join:notice') || null
        window.sessionStorage.removeItem('join:notice')
      } catch (err) { /* no storage; nothing to show */ }
      this.refreshHint()
    }
  }

  renderModes () {
    const { roadtripRiders, botCount, capacity, soloAvailable } = this.options
    this.modeList.innerHTML = ''
    for (const mode of MODES) {
      const full = mode.id === 'solo' && !soloAvailable
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'mode-row' + (this.mode === mode.id ? ' selected' : '') + (full ? ' full' : '')
      row.disabled = full

      row.appendChild(modeBadge(mode.id))

      const text = document.createElement('span')
      const title = document.createElement('b')
      title.textContent = mode.title
      const sub = document.createElement('small')
      sub.textContent = full ? `All ${capacity} bots are in use.` : mode.blurb
      text.appendChild(title)
      text.appendChild(sub)
      row.appendChild(text)

      // Occupancy on the right edge, in the row's own terms.
      const chip = document.createElement('em')
      chip.className = 'chip'
      chip.textContent = mode.id === 'roadtrip'
        ? `${roadtripRiders} playing`
        : full ? 'full' : `${capacity - botCount} free`
      row.appendChild(chip)

      row.addEventListener('click', () => this.pick(mode.id))
      this.modeList.appendChild(row)
    }
  }

  renderSkins (skins) {
    this.skinList.innerHTML = ''
    for (const skin of skins) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'skin' + (skin === this.skin ? ' selected' : '')
      button.title = skin
      button.style.backgroundImage = `url(${skinUrl(skin)})`
      button.addEventListener('click', () => {
        this.skin = skin
        for (const el of this.skinList.children) el.classList.remove('selected')
        button.classList.add('selected')
        this.setDoll(skin)
      })
      this.skinList.appendChild(button)
    }
  }

  /** The player figure wears `skin`; CSS cuts the sheet up into limbs. */
  setDoll (skin) {
    this.doll.style.setProperty('--skin', `url(${skinUrl(skin)})`)
  }

  pick (mode) {
    this.mode = mode
    this.notice = null
    this.renderModes()
    // Only your own bot needs a name and a face; the shared one already has
    // both, so the right column just shows it.
    this.root.dataset.mode = mode
    this.setDoll(mode === 'solo' ? this.skin : (this.options && this.options.skins && this.options.skins[0]) || 'steve')
    this.button.disabled = false
    this.button.textContent = mode === 'roadtrip' ? 'Join in' : 'Play'
    if (mode === 'solo') this.nameInput.focus()
    this.refreshHint()
  }

  refreshHint () {
    if (!this.options) return
    if (!this.mode) {
      // Stays until a mode is picked, so a join:options refresh from someone
      // else joining does not wipe it before it has been read.
      this.error.textContent = this.notice || 'Choose how you want to play.'
      this.error.classList.toggle('bad', Boolean(this.notice))
      this.button.disabled = true
      return
    }
    this.error.textContent = `${this.options.botCount} of ${this.options.capacity} bots in use`
    this.error.classList.remove('bad')
  }

  submit () {
    if (!this.mode) {
      this.reject('Choose how you want to play.')
      return
    }
    const host = this.hostInput.value.trim()
    const port = this.portInput.value.trim()
    const fallback = this.options && this.options.defaultServer && this.options.defaultServer.host
    if (!host && !fallback) {
      this.reject('Enter a server address.')
      this.hostInput.focus()
      return
    }
    try { window.localStorage.setItem('server', JSON.stringify({ host, port })) } catch (err) { /* per-visitor nicety only */ }
    const payload = { mode: this.mode, host, port }
    if (this.mode === 'solo') {
      const username = this.nameInput.value.trim()
      if (!username) {
        this.reject('Pick a name first.')
        return
      }
      payload.username = username
      payload.skin = this.skin
    }
    this.button.disabled = true
    this.error.textContent = 'joining…'
    this.error.classList.remove('bad')
    this.socket.emit('join', payload)
  }

  reject (reason) {
    this.button.disabled = false
    this.error.textContent = reason
    this.error.classList.add('bad')
  }

  accept (identity) {
    this.joined = true
    this.root.classList.remove('open')
    this.button.disabled = false
    this.onJoined(identity)
  }
}

module.exports = { JoinScreen, skinUrl }
