'use strict'

// Must match SKIN_VARIANT in src/server/skins.js: the entity model geometry
// differs between wide and slim, and we only ship the wide one.
const SKIN_VARIANT = 'wide'

const { modeBadge } = require('./badges')

const skinUrl = skin => `/assets/entity/player/${SKIN_VARIANT}/${skin}.png`

// The phone HUD is laid out for landscape. Android will only lock the
// orientation from fullscreen, and both need to happen inside a tap, so this
// runs from the join button rather than on the socket's accept. iOS has
// neither API; index.html shows a rotate prompt there instead.
const lockLandscape = async () => {
  if (!document.body.classList.contains('touch')) return
  const root = document.documentElement
  try {
    if (!document.fullscreenElement && root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' })
  } catch (err) { /* not offered, or refused: the rotate prompt covers it */ }
  try {
    if (window.screen.orientation && window.screen.orientation.lock) await window.screen.orientation.lock('landscape')
  } catch (err) { /* same */ }
}

// 'roadtrip' is the id the server and the socket protocol know it by; the
// page calls it Collaborative.
const MODES = [
  {
    id: 'solo',
    title: 'Solo',
    blurb: 'Control your own player.'
  },
  {
    id: 'roadtrip',
    title: 'Collaborative',
    blurb: 'Very chaotic. Control a player at the same time as everyone else.'
  }
]

// One is drawn at random each load, like the yellow line off the logo's corner
// on the real title screen. Keep them short: the font does not shrink to fit.
const SPLASHES = [
  'Also try the real thing!',
  'Runs in a browser tab!',
  'Nothing to install!',
  'Made at HackMIT!',
  'One player, many hands!',
  'Now with less latency!',
  'Bring a friend!',
  'Steve is shared!',
  'Look ma, no launcher!',
  'Pixels, all of them real!'
]

/**
 * The screen shown before a visitor gets a bot, laid out like the title
 * screen: the logo, a button per mode where Singleplayer and Multiplayer go,
 * and the controller link in the Realms slot. Picking a mode swaps the stack
 * for a world-select style panel with the server address and, for your own
 * bot, a name and skin; Collaborative needs neither, since that character is
 * shared and already named.
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
    this.noticeLine = document.getElementById('join-notice')
    this.hostInput = document.getElementById('join-host')
    this.portInput = document.getElementById('join-port')
    this.build = document.getElementById('join-build')
    this.button = document.getElementById('join-button')
    this.back = document.getElementById('join-back')
    this.doll = document.getElementById('join-doll')
    this.head = document.getElementById('join-head')
    this.modeTitle = document.getElementById('join-mode-title')
    this.modeBlurb = document.getElementById('join-mode-blurb')

    this.mode = null
    this.skin = 'steve'
    this.options = null
    this.renderedSkins = false
    this.setDoll(this.skin)
    document.getElementById('join-splash').textContent = SPLASHES[Math.floor(Math.random() * SPLASHES.length)]

    socket.on('join:options', options => this.setOptions(options))
    socket.on('join:rejected', ({ reason }) => this.reject(reason))
    socket.on('join:accepted', identity => this.accept(identity))

    this.form.addEventListener('submit', event => {
      event.preventDefault()
      this.submit()
    })
    this.back.addEventListener('click', () => this.unpick())
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
    // Where vanilla writes "Minecraft 1.20.4", the build that is serving,
    // the hash linking to its commit on GitHub.
    this.build.textContent = 'Minecraft (HackMIT Edition) '
    if (options.commit && options.commit !== 'unknown') {
      const link = document.createElement('a')
      link.href = `${options.repo}/commit/${options.commit}`
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = options.commit
      this.build.appendChild(link)
    } else {
      this.build.textContent += options.commit || ''
    }
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

  /* One vanilla button per mode, in the Singleplayer and Multiplayer slots. */
  renderModes () {
    const { roadtripRiders, botCount, capacity, soloAvailable } = this.options
    this.modeList.innerHTML = ''
    for (const mode of MODES) {
      const full = mode.id === 'solo' && !soloAvailable
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'mc-button'
      button.disabled = full
      button.title = full ? `All ${capacity} bots are in use.` : mode.blurb
      button.appendChild(document.createTextNode(mode.title))

      // Occupancy at the right end, in the button's own terms.
      const chip = document.createElement('em')
      chip.className = 'chip'
      chip.textContent = mode.id === 'roadtrip'
        ? `${roadtripRiders} playing`
        : full ? 'full' : `${capacity - botCount} free`
      button.appendChild(chip)

      button.addEventListener('click', () => this.pick(mode.id))
      this.modeList.appendChild(button)
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

  /* Swap the button stack for the setup panel, headed by what was picked. */
  pick (mode) {
    const chosen = MODES.find(m => m.id === mode)
    this.mode = mode
    this.notice = null
    this.root.dataset.mode = mode
    const old = this.head.querySelector('.badge')
    if (old) old.remove()
    this.head.prepend(modeBadge(mode))
    this.modeTitle.textContent = chosen.title
    this.modeBlurb.textContent = chosen.blurb
    // Only your own bot needs a name and a face; the shared one already has
    // both, so the right column just shows it.
    this.setDoll(mode === 'solo' ? this.skin : (this.options && this.options.skins && this.options.skins[0]) || 'steve')
    this.button.disabled = false
    this.button.textContent = mode === 'roadtrip' ? 'Join in' : 'Play'
    if (mode === 'solo') this.nameInput.focus()
    else this.hostInput.focus()
    this.refreshHint()
  }

  /* Back to the button stack; whatever was typed is kept for next time. */
  unpick () {
    this.mode = null
    delete this.root.dataset.mode
    this.error.textContent = ''
    this.error.classList.remove('bad')
    this.setDoll(this.skin)
    this.refreshHint()
  }

  refreshHint () {
    if (!this.options) return
    if (!this.mode) {
      // Stays until a mode is picked, so a join:options refresh from someone
      // else joining does not wipe it before it has been read.
      this.noticeLine.textContent = this.notice || ''
      return
    }
    this.noticeLine.textContent = ''
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
    this.payload = payload
    this.socket.emit('join', payload)
    lockLandscape()
  }

  /**
   * A reconnected socket is a stranger to the server: the disconnect tore the
   * membership (and a solo bot) down, so the same join is sent again. Without
   * this the tab keeps its last frame and every click goes to the lobby.
   */
  rejoin () {
    if (!this.joined || !this.payload) return false
    this.socket.emit('join', this.payload)
    return true
  }

  reject (reason) {
    // A refused rejoin (the server filled up meanwhile) lands back on the
    // join screen with the reason, the way an expired session does.
    if (this.joined) {
      this.joined = false
      document.body.classList.remove('joined')
      this.root.classList.add('open')
    }
    this.button.disabled = false
    this.error.textContent = reason
    this.error.classList.add('bad')
  }

  accept (identity) {
    this.joined = true
    this.root.classList.remove('open')
    document.body.classList.add('joined')
    this.button.disabled = false
    this.onJoined(identity)
  }
}

module.exports = { JoinScreen, skinUrl }
