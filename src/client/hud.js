'use strict'

// Vanilla keeps 100 lines and hides each one 10 s after it arrived unless
// the chat is open.
const MAX_CHAT_LINES = 100
const CHAT_LINE_MS = 10000

// The sixteen §-code colours, straight from vanilla's ChatFormatting.
const MC_COLOURS = {
  0: '#000000', 1: '#0000aa', 2: '#00aa00', 3: '#00aaaa', 4: '#aa0000', 5: '#aa00aa', 6: '#ffaa00', 7: '#aaaaaa',
  8: '#555555', 9: '#5555ff', a: '#55ff55', b: '#55ffff', c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff'
}

// Vanilla HUD sprites, served out of minecraft-assets. Health and hunger are
// both ten icons covering twenty points, so each icon is worth two.
const HUD = '/assets/gui/sprites/hud/'
const ICON_COUNT = 10
const HEART = { empty: HUD + 'heart/container.png', half: HUD + 'heart/half.png', full: HUD + 'heart/full.png' }
const FOOD = { empty: HUD + 'food_empty.png', half: HUD + 'food_half.png', full: HUD + 'food_full.png' }

const icons = require('./icons')

const el = id => document.getElementById(id)

/** Everything drawn in DOM on top of the canvas. */
class Hud {
  constructor () {
    this.status = el('status')
    this.stats = el('stats')
    this.health = el('health')
    this.food = el('food')
    this.hotbar = el('hotbar')
    this.chat = el('chat')
    this.chatLog = el('chat-log')
    this.chatInput = el('chat-input')
    this.players = el('players')
    this.death = el('death')
    this.deathCause = el('death-cause')
    this.deathScore = el('death-score')
    this.deathCountdown = el('death-countdown')
    this.respawnButton = el('respawn')
    this.respawnAt = 0
    this.ping = null
    this.lastState = null
    this.lastVitalsKey = null
    this.lastHotbarKey = null

    setInterval(() => this._expireChat(), 500)
    setInterval(() => this._tickDeath(), 250)

    this.slots = []
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement('div')
      slot.className = 'slot'
      this.hotbar.appendChild(slot)
      this.slots.push(slot)
    }

    this.hearts = iconRow(this.health)
    this.drumsticks = iconRow(this.food)
  }

  setStatus (state, message) {
    this.status.dataset.state = state
    this.status.textContent = message
  }

  /** Who else is here. Vanilla shows this on Tab; we keep it always visible. */
  setRoster (roster) {
    if (!this.players) return
    this.players.innerHTML = ''
    for (const { username, skin } of roster) {
      const row = document.createElement('div')
      row.className = 'player'
      const face = document.createElement('i')
      face.style.backgroundImage = `url(/assets/entity/player/wide/${skin}.png)`
      row.appendChild(face)
      row.appendChild(document.createTextNode(username))
      this.players.appendChild(row)
    }
  }

  setPing (ms) {
    this.ping = ms
    this.renderStats()
  }

  setState (state) {
    this.lastState = state
    this.renderStats()
    // The state packet fires whenever anything in it changes — timeOfDay and
    // position alone make that nearly every tick — so each section repaints
    // only when its own data moved, not whenever a sibling field did. The
    // hotbar one matters most: renderSlot rebuilds nine <img> nodes per call.
    const vitalsKey = `${state.health},${state.food}`
    if (vitalsKey !== this.lastVitalsKey) {
      this.lastVitalsKey = vitalsKey
      this.renderVitals(state)
    }
    const hotbarKey = `${state.quickBarSlot}|${JSON.stringify(state.hotbar)}`
    if (hotbarKey !== this.lastHotbarKey) {
      this.lastHotbarKey = hotbarKey
      this.renderHotbar(state)
    }
  }

  renderStats () {
    const state = this.lastState
    if (!state) return
    const { x, y, z } = state.position
    const target = state.targetBlock ? state.targetBlock.name : '—'
    const ping = this.ping === null ? '—' : `${this.ping}ms`
    this.stats.innerHTML =
      `<b>${escapeHtml(state.username || 'bot')}</b>  ${ping}\n` +
      `xyz  ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}\n` +
      `look ${escapeHtml(target)}\n` +
      `${state.playerCount} player(s) online`
  }

  renderVitals (state) {
    paintIcons(this.hearts, state.health, HEART)
    paintIcons(this.drumsticks, state.food, FOOD)
  }

  renderHotbar (state) {
    state.hotbar.forEach((item, index) => {
      const slot = this.slots[index]
      slot.classList.toggle('selected', index === state.quickBarSlot)
      renderSlot(slot, item)
    })
  }

  /** Repaint slots drawn before the icon data had loaded (see icons.js). */
  refreshHotbar () {
    this.lastHotbarKey = null
    if (this.lastState) this.renderHotbar(this.lastState)
  }

  /**
   * One line of the shared log. `entry` is what the server relays:
   * { kind: 'chat' | 'system' | 'notice' | 'web', text, motd?, from? }.
   * Minecraft lines carry their §-codes in `motd`; 'notice' is this app
   * talking; browser lines are prefixed with who typed them since Minecraft
   * would only ever credit the bot.
   */
  addChat (entry) {
    if (typeof entry === 'string') entry = { kind: 'notice', text: entry }
    const line = document.createElement('div')
    line.className = entry.kind || 'chat'
    line.dataset.at = String(Date.now())
    if (entry.kind === 'web') {
      const tag = document.createElement('span')
      tag.className = 'web-tag'
      tag.textContent = '[web] '
      line.appendChild(tag)
      line.appendChild(document.createTextNode(`<${entry.from}> ${entry.text}`))
    } else if (entry.motd) {
      renderMotd(line, entry.motd)
    } else {
      line.textContent = entry.text
    }
    this.chatLog.appendChild(line)
    while (this.chatLog.childElementCount > MAX_CHAT_LINES) {
      this.chatLog.removeChild(this.chatLog.firstChild)
    }
    this.chatLog.scrollTop = this.chatLog.scrollHeight
  }

  /** The server's ring buffer, sent on connect so late joiners see the same log. */
  setChatHistory (entries) {
    this.chatLog.innerHTML = ''
    for (const entry of entries) this.addChat(entry)
  }

  _expireChat () {
    const cutoff = Date.now() - CHAT_LINE_MS
    for (const line of this.chatLog.children) {
      if (Number(line.dataset.at) < cutoff) line.classList.add('faded')
    }
  }

  openChat () {
    this.chat.classList.add('open')
    this.chatInput.classList.add('open')
    this.chatInput.focus()
    this.chatLog.scrollTop = this.chatLog.scrollHeight
  }

  closeChat () {
    this.chatInput.value = ''
    this.chatInput.blur()
    this.chatInput.classList.remove('open')
    this.chat.classList.remove('open')
  }

  get chatOpen () {
    return this.chatInput.classList.contains('open')
  }

  // --- death screen ---------------------------------------------------------

  /**
   * info: { cause, score, respawnAt }. Arrives twice per death, the second
   * time with the cause once the combat packet has landed, so this must be
   * safe to call on an already-shown screen.
   */
  showDeath (info, onRespawn) {
    this.deathCause.textContent = info.cause || ''
    this.deathScore.innerHTML = `Score: <b>${Number(info.score) || 0}</b>`
    this.respawnAt = info.respawnAt || 0
    this.respawnButton.onclick = () => {
      this.respawnButton.disabled = true
      onRespawn()
    }
    this.respawnButton.disabled = false
    this.death.classList.add('open')
    document.body.classList.add('dead')
    this._tickDeath()
  }

  hideDeath () {
    this.death.classList.remove('open')
    document.body.classList.remove('dead')
  }

  get dead () {
    return this.death.classList.contains('open')
  }

  _tickDeath () {
    if (!this.dead) return
    const left = Math.max(0, Math.ceil((this.respawnAt - Date.now()) / 1000))
    this.deathCountdown.textContent = `Respawning automatically in ${left}s`
  }
}

/** Shared by the hotbar and the inventory overlay. */
function renderSlot (slot, item) {
  slot.innerHTML = ''
  if (!item) return

  // A flat item texture or a little 3D render of the block model (icons.js).
  // Null means the icon data is still loading or the item has no texture
  // anywhere; show the name as text, as vanilla shows missing models.
  const url = icons.iconFor(item.name)
  if (url) {
    const img = document.createElement('img')
    img.alt = ''
    // Native HTML drag-and-drop on this <img> would hijack our own mouse-based
    // slot dragging (stack splitting) before it ever sees a mouseenter.
    img.draggable = false
    img.src = url
    img.onerror = () => {
      slot.textContent = item.displayName || item.name
      if (item.count > 1) appendCount(slot, item.count)
    }
    slot.appendChild(img)
  } else {
    slot.textContent = item.displayName || item.name
  }
  if (item.count > 1) appendCount(slot, item.count)
  slot.title = `${item.displayName || item.name} x${item.count}`
}

function appendCount (slot, count) {
  const badge = document.createElement('span')
  badge.className = 'count'
  badge.textContent = String(count)
  slot.appendChild(badge)
}

function iconRow (parent) {
  const cells = []
  for (let i = 0; i < ICON_COUNT; i++) {
    const cell = document.createElement('i')
    parent.appendChild(cell)
    cells.push(cell)
  }
  return cells
}

/**
 * Paints one row of hearts or drumsticks. Vanilla always draws the empty
 * container first and layers the full or half icon over it, which is what the
 * two stacked background images are doing.
 */
function paintIcons (cells, value, sprites) {
  const points = Math.max(0, Math.round(value || 0))
  cells.forEach((cell, i) => {
    const remaining = points - i * 2
    const top = remaining >= 2 ? sprites.full : remaining === 1 ? sprites.half : null
    cell.style.backgroundImage = top
      ? `url(${top}), url(${sprites.empty})`
      : `url(${sprites.empty})`
  })
}

/**
 * Renders legacy §-formatted text as spans. A colour code resets the styles
 * that precede it, as in vanilla; §r resets everything. Obfuscated (§k) is
 * ignored rather than animated.
 */
function renderMotd (parent, motd) {
  const parts = motd.split(/§([0-9a-fk-or])/i)
  let colour = null
  const styles = new Set()
  const emit = text => {
    if (!text) return
    const span = document.createElement('span')
    if (colour) span.style.color = colour
    if (styles.has('l')) span.style.fontWeight = 'bold'
    if (styles.has('o')) span.style.fontStyle = 'italic'
    const lines = []
    if (styles.has('n')) lines.push('underline')
    if (styles.has('m')) lines.push('line-through')
    if (lines.length) span.style.textDecoration = lines.join(' ')
    span.textContent = text
    parent.appendChild(span)
  }
  emit(parts[0])
  for (let i = 1; i < parts.length; i += 2) {
    const code = parts[i].toLowerCase()
    if (code === 'r') {
      colour = null
      styles.clear()
    } else if (MC_COLOURS[code]) {
      colour = MC_COLOURS[code]
      styles.clear()
    } else {
      styles.add(code)
    }
    emit(parts[i + 1])
  }
}

function escapeHtml (text) {
  return String(text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

module.exports = { Hud, renderSlot }
