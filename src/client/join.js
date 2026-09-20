'use strict'

// Must match SKIN_VARIANT in src/server/skins.js: the entity model geometry
// differs between wide and slim, and we only ship the wide one.
const SKIN_VARIANT = 'wide'

const skinUrl = skin => `/assets/entity/player/${SKIN_VARIANT}/${skin}.png`

const MODES = [
  {
    id: 'roadtrip',
    title: 'Road Trip',
    blurb: 'Everyone drives one character together.',
    icon: '/assets/gui/sprites/hud/heart/full.png'
  },
  {
    id: 'solo',
    title: 'Individual',
    blurb: 'Spawn a character of your own on the same world.',
    icon: '/assets/gui/sprites/hud/food_full.png'
  }
]

/**
 * The mode-and-identity screen shown before a visitor gets a bot.
 *
 * Laid out like Minecraft's world select: a list of rows you pick from, then a
 * button along the bottom. Choosing Road Trip needs nothing else, since that
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
    this.server = document.getElementById('join-server')
    this.build = document.getElementById('join-build')
    this.button = document.getElementById('join-button')

    this.mode = null
    this.skin = 'steve'
    this.options = null
    this.renderedSkins = false

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
    if (options.server) {
      const { host, port } = options.server
      this.server.textContent = port === 25565 ? host : `${host}:${port}`
    }
    if (options.commit) this.build.textContent = options.commit
    this.renderModes()
    if (!this.renderedSkins) {
      this.renderSkins(options.skins)
      this.renderedSkins = true
    }
    this.refreshHint()
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

      const icon = document.createElement('i')
      icon.style.backgroundImage = `url(${mode.icon})`
      row.appendChild(icon)

      const text = document.createElement('span')
      const title = document.createElement('b')
      title.textContent = mode.title
      const sub = document.createElement('small')
      sub.textContent = mode.id === 'roadtrip'
        ? `${mode.blurb} (${roadtripRiders} riding)`
        : full
          ? `All ${capacity} bots are in use.`
          : `${mode.blurb} (${capacity - botCount} free)`
      text.appendChild(title)
      text.appendChild(sub)
      row.appendChild(text)

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
      })
      this.skinList.appendChild(button)
    }
  }

  pick (mode) {
    this.mode = mode
    this.renderModes()
    // Only your own bot needs a name and a face; the shared one already has both.
    this.identity.classList.toggle('open', mode === 'solo')
    this.button.disabled = false
    this.button.textContent = mode === 'roadtrip' ? 'Join the road trip' : 'Play'
    if (mode === 'solo') this.nameInput.focus()
    this.refreshHint()
  }

  refreshHint () {
    if (!this.options) return
    if (!this.mode) {
      this.error.textContent = 'Choose how you want to play.'
      this.error.classList.remove('bad')
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
    const payload = { mode: this.mode }
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
