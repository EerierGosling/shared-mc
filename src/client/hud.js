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
const HEART = {
  empty: HUD + 'heart/container.png',
  half: HUD + 'heart/half.png',
  full: HUD + 'heart/full.png',
  // The white variants vanilla flashes for a second after taking damage.
  emptyBlink: HUD + 'heart/container_blinking.png',
  halfBlink: HUD + 'heart/half_blinking.png',
  fullBlink: HUD + 'heart/full_blinking.png'
}
const FOOD = { empty: HUD + 'food_empty.png', half: HUD + 'food_half.png', full: HUD + 'food_full.png' }
// Air is ten bubbles over a 300-tick supply, and unlike hearts there is no
// container: spent bubbles are simply not drawn. The last bubble about to go
// is drawn already bursting.
const AIR = { full: HUD + 'air.png', bursting: HUD + 'air_bursting.png' }
const MAX_AIR_TICKS = 300
// mineflayer hands us the supply divided by 15 (0-20), so undo that here.
const OXYGEN_TO_TICKS = 15
// Vanilla: a second of blinking after a hit, in three-tick on/off phases.
const BLINK_MS = 1000
const BLINK_PHASE_MS = 150
// Hearts start jittering at two hearts left.
const LOW_HEALTH = 4
// The player list's connection bars, thresholds straight from vanilla.
const PING_BARS = [[150, 5], [300, 4], [600, 3], [1000, 2], [Infinity, 1]]

const icons = require('./icons')

const { modeBadge } = require('./badges')

const el = id => document.getElementById(id)

/** Everything drawn in DOM on top of the canvas. */
class Hud {
  constructor () {
    this.status = el('status')
    this.stats = el('stats')
    this.health = el('health')
    this.food = el('food')
    this.air = el('air')
    this.hotbar = el('hotbar')
    this.heldName = el('held-name')
    this.xpFill = el('xp-fill')
    this.xpLevel = el('xp-level')
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
    this.creative = { available: false, flying: false }
    this.lastVitalsKey = null
    this.lastHotbarKey = null
    this.pingByName = new Map() // username -> its bars element
    this.lastPingsKey = null
    this.lastHeldKey = null
    // Health before the hit that started the current blink, so the hearts
    // that were just lost can flash white the way vanilla's do.
    this.blink = null // { until, from }
    this.blinkTimer = null

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
    this.bubbles = iconRow(this.air)
  }

  setStatus (state, message) {
    this.status.dataset.state = state
    this.status.textContent = message
  }

  /**
   * Who else is here. Vanilla shows this on Tab; we keep it always visible.
   * Each row is badged by how that name got onto the server — a real Minecraft
   * client, a solo bot from this page, or the shared collaborative bot — with
   * the same glyphs the join screen uses to describe the modes (badges.js). Pings
   * come separately, off the state stream, since they change every tick and
   * the roster only on joins and leaves.
   */
  setRoster (roster) {
    if (!this.players) return
    this.players.innerHTML = ''
    this.pingByName.clear()
    for (const { username, skin, mode } of roster) {
      const row = document.createElement('div')
      row.className = 'player'
      row.dataset.mode = mode
      const face = document.createElement('i')
      face.className = 'face'
      // A real player's skin is not ours to know; show the default face.
      face.style.backgroundImage = `url(/assets/entity/player/wide/${skin || 'steve'}.png)`
      const bars = document.createElement('i')
      bars.className = 'ping'
      row.append(face, document.createTextNode(username), bars, modeBadge(mode))
      this.players.appendChild(row)
      this.pingByName.set(username, bars)
    }
    this.lastPingsKey = null
    this.renderPings()
  }

  /** Vanilla's connection bars, next to each name. */
  renderPings () {
    const list = (this.lastState && this.lastState.players) || []
    const key = JSON.stringify(list)
    if (key === this.lastPingsKey) return
    this.lastPingsKey = key
    for (const { username, ping } of list) {
      const bars = this.pingByName.get(username)
      if (!bars) continue
      bars.style.backgroundImage = `url(/assets/gui/sprites/icon/${pingSprite(ping)}.png)`
      bars.title = ping === null ? 'unknown' : `${ping}ms`
    }
  }

  /** F3: the coordinate readout. */
  toggleDebug () {
    this.stats.classList.toggle('hidden')
  }

  setPing (ms) {
    this.ping = ms
    this.renderStats()
  }

  /**
   * What the Minecraft server has granted, straight from creative.js. The
   * body class is what reveals the creative lines in the controls hint, so
   * nobody is told about flight on a server that will not allow it.
   */
  setCreative (state) {
    this.creative = state || { available: false, flying: false }
    document.body.classList.toggle('creative', Boolean(this.creative.available))
    document.body.classList.toggle('can-fly', Boolean(this.creative.mayFly))
    this.renderStats()
  }

  setState (state) {
    const previous = this.lastState
    this.lastState = state
    // Vanilla draws no hearts, hunger or XP in creative.
    document.body.dataset.gamemode = state.gameMode || ''
    if (previous && state.health < previous.health) this._startBlink(previous.health)
    this.renderStats()
    // The state packet fires whenever anything in it changes — timeOfDay and
    // position alone make that nearly every tick — so each section repaints
    // only when its own data moved, not whenever a sibling field did. The
    // hotbar one matters most: renderSlot rebuilds nine <img> nodes per call.
    const vitalsKey = `${state.health},${state.food},${state.oxygen},${state.eyeInWater}`
    if (vitalsKey !== this.lastVitalsKey) {
      this.lastVitalsKey = vitalsKey
      this.renderVitals(state)
    }
    const hotbarKey = `${state.quickBarSlot}|${JSON.stringify(state.hotbar)}`
    if (hotbarKey !== this.lastHotbarKey) {
      this.lastHotbarKey = hotbarKey
      this.renderHotbar(state)
    }
    this.renderPings()
  }

  _startBlink (from) {
    // A second hit mid-blink keeps the earlier "before" so all the lost
    // hearts flash, not only the latest.
    this.blink = { until: Date.now() + BLINK_MS, from: this.blink ? this.blink.from : from }
    if (this.blinkTimer) return
    this.blinkTimer = setInterval(() => {
      if (this.blink && Date.now() < this.blink.until) {
        if (this.lastState) this.renderVitals(this.lastState)
        return
      }
      clearInterval(this.blinkTimer)
      this.blinkTimer = null
      this.blink = null
      if (this.lastState) this.renderVitals(this.lastState)
    }, BLINK_PHASE_MS / 3)
  }

  renderStats () {
    const state = this.lastState
    if (!state) return
    const { x, y, z } = state.position
    const target = state.targetBlock ? state.targetBlock.name : '—'
    const ping = this.ping === null ? '—' : `${this.ping}ms`
    // The game mode is worth a line of its own: creative is granted by the
    // Minecraft server, so when the creative UI is missing this says why.
    const mode = state.gameMode
      ? `mode ${escapeHtml(state.gameMode)}${this.creative.flying ? ' · flying' : ''}\n`
      : ''
    this.stats.innerHTML =
      `<b>${escapeHtml(state.username || 'bot')}</b>  ${ping}\n` +
      `xyz  ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}\n` +
      `look ${escapeHtml(target)}\n` +
      mode +
      `${state.playerCount} player(s) online`
  }

  renderVitals (state) {
    let blink = null
    if (this.blink) {
      const left = this.blink.until - Date.now()
      blink = { on: Math.floor(left / BLINK_PHASE_MS) % 2 === 1, from: this.blink.from }
    }
    paintIcons(this.hearts, state.health, HEART, blink)
    this.health.classList.toggle('low', state.health <= LOW_HEALTH)
    paintIcons(this.drumsticks, state.food, FOOD)
    paintBubbles(this.bubbles, state)

    const progress = Math.max(0, Math.min(1, Number(state.xpProgress) || 0))
    this.xpFill.style.width = `calc(${(182 * progress).toFixed(1)} * var(--u))`
    this.xpLevel.textContent = state.xpLevel > 0 ? String(state.xpLevel) : ''
  }

  renderHotbar (state) {
    state.hotbar.forEach((item, index) => {
      const slot = this.slots[index]
      slot.classList.toggle('selected', index === state.quickBarSlot)
      renderSlot(slot, item)
    })

    // The held item's name pops up over the hotbar when the selection
    // changes and fades a couple of seconds later, as in vanilla. Not on the
    // first snapshot: that is a page load, not a change.
    const held = state.heldItem
    const key = `${state.quickBarSlot}:${held ? held.name : ''}`
    if (key === this.lastHeldKey) return
    const first = this.lastHeldKey === null
    this.lastHeldKey = key
    if (first) return
    if (!held) {
      this.heldName.classList.remove('show')
      return
    }
    this.heldName.textContent = held.displayName || held.name
    this.heldName.classList.remove('fade')
    this.heldName.classList.add('show')
    // Force a layout so the removed transition restarts from fully visible.
    this.heldName.getBoundingClientRect()
    this.heldName.classList.add('fade')
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

  openChat (prefill = '') {
    this.chat.classList.add('open')
    this.chatInput.classList.add('open')
    this.chatInput.value = prefill
    this.chatInput.focus()
    const end = prefill.length
    this.chatInput.setSelectionRange(end, end)
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
 * stacked background images are doing.
 *
 * While `blink` is on, the containers go white and the hearts the last hit
 * took away are drawn white underneath the ones still there, so the loss
 * flashes rather than simply vanishing.
 */
function paintIcons (cells, value, sprites, blink = null) {
  const points = Math.max(0, Math.round(value || 0))
  const on = Boolean(blink && blink.on)
  const before = on ? Math.max(0, Math.round(blink.from || 0)) : 0
  cells.forEach((cell, i) => {
    const layers = []
    const remaining = points - i * 2
    if (remaining >= 2) layers.push(sprites.full)
    else if (remaining === 1) layers.push(sprites.half)
    if (on) {
      const lost = before - i * 2
      if (lost >= 2) layers.push(sprites.fullBlink)
      else if (lost === 1) layers.push(sprites.halfBlink)
    }
    layers.push(on ? sprites.emptyBlink : sprites.empty)
    cell.style.backgroundImage = layers.map(url => `url(${url})`).join(', ')
  })
}

/**
 * The air row, straight from vanilla's Gui.renderPlayerHealth: shown while the
 * eyes are underwater or the supply is still refilling, with
 * ceil((air - 2) * 10 / 300) whole bubbles and one bursting bubble for the
 * remainder. The row goes right-to-left like hunger, so the first bubble to
 * pop is the leftmost one.
 */
function paintBubbles (cells, state) {
  const oxygen = Number.isFinite(state.oxygen) ? state.oxygen : MAX_AIR_TICKS / OXYGEN_TO_TICKS
  const air = Math.min(MAX_AIR_TICKS, Math.max(0, oxygen * OXYGEN_TO_TICKS))
  const show = state.eyeInWater || air < MAX_AIR_TICKS
  const full = show ? Math.max(0, Math.ceil((air - 2) * ICON_COUNT / MAX_AIR_TICKS)) : 0
  const bursting = show ? Math.ceil(air * ICON_COUNT / MAX_AIR_TICKS) - full : 0
  cells.forEach((cell, i) => {
    const sprite = i < full ? AIR.full : i < full + bursting ? AIR.bursting : null
    cell.style.backgroundImage = sprite ? `url(${sprite})` : 'none'
  })
}

function pingSprite (ping) {
  if (ping === null || ping === undefined || ping < 0) return 'ping_unknown'
  for (const [limit, bars] of PING_BARS) if (ping < limit) return `ping_${bars}`
  return 'ping_1'
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
