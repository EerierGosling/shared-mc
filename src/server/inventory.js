'use strict'
const { describeItem } = require('./items')

const UPDATE_THROTTLE_MS = 150

/**
 * Bridges mineflayer's window/inventory API to the browser overlay.
 *
 * Slot numbers are passed through untouched, so the browser talks the same slot
 * indices mineflayer does (player window: 5-8 armor, 9-35 main, 36-44 hotbar,
 * 45 offhand).
 */
class InventoryBridge {
  constructor (io) {
    this.io = io
    this.bot = null
    this.listeners = []
    this.pending = null
  }

  setBot (bot) {
    this.clearBot()
    this.bot = bot

    this._listen(bot, 'windowOpen', window => {
      this.io.emit('window:open', this.serializeWindow(window))
    })
    this._listen(bot, 'windowClose', () => this.io.emit('window:close'))
    if (bot.inventory) {
      this._listen(bot.inventory, 'updateSlot', () => this._scheduleUpdate())
    }
  }

  clearBot () {
    for (const [emitter, event, fn] of this.listeners) emitter.removeListener(event, fn)
    this.listeners = []
    clearTimeout(this.pending)
    this.pending = null
    this.bot = null
  }

  _listen (emitter, event, fn) {
    emitter.on(event, fn)
    this.listeners.push([emitter, event, fn])
  }

  register (socket) {
    socket.on('inventory:get', () => {
      const payload = this.snapshot()
      if (payload) socket.emit('inventory', payload)
    })
    socket.on('window:click', payload => this.click(payload))
    socket.on('window:move', payload => this.move(payload))
    socket.on('window:close', () => this.close())
  }

  _scheduleUpdate () {
    if (this.pending) return
    this.pending = setTimeout(() => {
      this.pending = null
      const payload = this.snapshot()
      if (payload) this.io.emit('inventory', payload)
    }, UPDATE_THROTTLE_MS)
    this.pending.unref?.()
  }

  serializeWindow (window) {
    if (!window) return null
    return {
      id: window.id,
      type: window.type,
      title: typeof window.title === 'string' ? window.title : String(window.title || ''),
      slotCount: window.slots.length,
      // A chest window's own slots come before the player's inventory.
      inventoryStart: typeof window.inventoryStart === 'number' ? window.inventoryStart : null,
      slots: window.slots.map((item, index) => {
        const described = describeItem(item)
        return described ? { ...described, slot: index } : null
      })
    }
  }

  snapshot () {
    const bot = this.bot
    if (!bot) return null
    const window = bot.currentWindow || bot.inventory
    if (!window) return null
    return {
      window: this.serializeWindow(window),
      isContainer: Boolean(bot.currentWindow),
      quickBarSlot: bot.quickBarSlot
    }
  }

  click (payload) {
    const bot = this.bot
    if (!bot || !payload) return
    const slot = Number(payload.slot)
    if (!Number.isInteger(slot) || slot < 0) return
    const mouseButton = payload.mouseButton === 1 ? 1 : 0
    const mode = Number.isInteger(payload.mode) ? payload.mode : 0
    Promise.resolve(bot.clickWindow(slot, mouseButton, mode))
      .then(() => this._scheduleUpdate())
      .catch(() => {})
  }

  move (payload) {
    const bot = this.bot
    if (!bot || !payload) return
    const from = Number(payload.from)
    const to = Number(payload.to)
    if (!Number.isInteger(from) || !Number.isInteger(to)) return
    Promise.resolve(bot.moveSlotItem(from, to))
      .then(() => this._scheduleUpdate())
      .catch(() => {})
  }

  close () {
    const bot = this.bot
    if (!bot || !bot.currentWindow) return
    try {
      bot.closeWindow(bot.currentWindow)
    } catch (err) {}
  }
}

module.exports = InventoryBridge
