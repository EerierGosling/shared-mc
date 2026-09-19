'use strict'

const MAX_CHAT_LINES = 40

// Vanilla HUD sprites, served out of minecraft-assets. Health and hunger are
// both ten icons covering twenty points, so each icon is worth two.
const HUD = '/assets/gui/sprites/hud/'
const ICON_COUNT = 10
const HEART = { empty: HUD + 'heart/container.png', half: HUD + 'heart/half.png', full: HUD + 'heart/full.png' }
const FOOD = { empty: HUD + 'food_empty.png', half: HUD + 'food_half.png', full: HUD + 'food_full.png' }

const el = id => document.getElementById(id)

/** Everything drawn in DOM on top of the canvas. */
class Hud {
  constructor () {
    this.status = el('status')
    this.stats = el('stats')
    this.health = el('health')
    this.food = el('food')
    this.hotbar = el('hotbar')
    this.chatLog = el('chat-log')
    this.chatInput = el('chat-input')
    this.ping = null
    this.lastState = null

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

  setPing (ms) {
    this.ping = ms
    this.renderStats()
  }

  setState (state) {
    this.lastState = state
    this.renderStats()
    this.renderVitals(state)
    this.renderHotbar(state)
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

  addChat (text, kind) {
    const line = document.createElement('div')
    if (kind) line.className = kind
    line.textContent = text
    this.chatLog.appendChild(line)
    while (this.chatLog.childElementCount > MAX_CHAT_LINES) {
      this.chatLog.removeChild(this.chatLog.firstChild)
    }
  }

  openChat () {
    this.chatInput.classList.add('open')
    this.chatInput.focus()
  }

  closeChat () {
    this.chatInput.value = ''
    this.chatInput.blur()
    this.chatInput.classList.remove('open')
  }

  get chatOpen () {
    return this.chatInput.classList.contains('open')
  }
}

/** Shared by the hotbar and the inventory overlay. */
function renderSlot (slot, item) {
  slot.innerHTML = ''
  if (!item) return

  const img = document.createElement('img')
  img.alt = ''
  // minecraft-assets splits textures between items/ and blocks/; try both
  // before giving up and showing the item name as text.
  img.src = `/assets/items/${item.name}.png`
  img.onerror = () => {
    if (img.dataset.retried) {
      slot.textContent = item.displayName || item.name
      if (item.count > 1) appendCount(slot, item.count)
      return
    }
    img.dataset.retried = '1'
    img.src = `/assets/blocks/${item.name}.png`
  }
  slot.appendChild(img)
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

function escapeHtml (text) {
  return String(text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

module.exports = { Hud, renderSlot }
