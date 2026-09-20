'use strict'
const { describeItem } = require('./items')
const ChatMessage = require('prismarine-chat')

const UPDATE_THROTTLE_MS = 150

/**
 * Bridges mineflayer's window/inventory API to the browser overlay.
 *
 * Slot numbers are passed through untouched, so the browser talks the same slot
 * indices mineflayer does (player window: 5-8 armor, 9-35 main, 36-44 hotbar,
 * 45 offhand).
 */
class InventoryBridge {
  constructor (socket) {
    this.socket = socket
    this.bot = null
    this.listeners = []
    this.pending = null
  }

  setBot (bot) {
    this.clearBot()
    this.bot = bot

    this._listen(bot, 'windowOpen', window => {
      this.socket.emit('window:open', this.serializeWindow(window))
    })
    this._listen(bot, 'windowClose', () => this.socket.emit('window:close'))
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
    socket.on('window:drag', payload => this.drag(payload))
    socket.on('window:close', () => this.close())
  }

  _scheduleUpdate () {
    if (this.pending) return
    this.pending = setTimeout(() => {
      this.pending = null
      const payload = this.snapshot()
      if (payload) this.socket.emit('inventory', payload)
    }, UPDATE_THROTTLE_MS)
    this.pending.unref?.()
  }

  serializeWindow (window) {
    if (!window) return null
    return {
      id: window.id,
      type: window.type,
      title: this._windowTitle(window.title),
      slotCount: window.slots.length,
      // A chest window's own slots come before the player's inventory.
      inventoryStart: typeof window.inventoryStart === 'number' ? window.inventoryStart : null,
      slots: window.slots.map((item, index) => {
        const described = describeItem(item)
        return described ? { ...described, slot: index } : null
      })
    }
  }

  // mineflayer hands window titles through as raw chat components (e.g.
  // {"translate":"container.crafting"}), not plain strings - decode them the
  // same way chat messages are, or `String(...)`ing the object gives the
  // browser "[object Object]".
  _windowTitle (title) {
    if (typeof title === 'string') return title
    if (!title) return ''
    try {
      return new (ChatMessage(this.bot.version))(title).toString()
    } catch (err) {
      return ''
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
      quickBarSlot: bot.quickBarSlot,
      // The item picked up and following the cursor, if any - not part of any
      // slot, so it doesn't come through serializeWindow.
      cursorItem: describeItem(window.selectedItem)
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

  // Vanilla's real click-and-drag (protocol click mode 5) isn't implemented by
  // prismarine-windows for the versions this project talks - window.dragClick()
  // just throws "unimplemented", which bot.clickWindow() hits synchronously
  // before it ever writes a packet. So instead of that mode, this replays the
  // same end result with the single-item-placement click (mode 0, right
  // button) mineflayer already relies on elsewhere (see transfer()'s
  // one-by-one fallback in mineflayer/lib/plugins/inventory.js): pick up the
  // dragged-from slot if nothing is held yet, then hand out an equal share -
  // one item per click - to every other slot the drag passed over.
  async drag (payload) {
    const bot = this.bot
    if (!bot || !payload || !Array.isArray(payload.slots)) return
    const path = payload.slots.map(Number).filter(n => Number.isInteger(n) && n >= 0)
    if (path.length < 2) return
    const rightDrag = payload.mouseButton === 1
    const window = bot.currentWindow || bot.inventory

    try {
      let destinations = path
      if (!window.selectedItem) {
        // Nothing on the cursor yet: the slot the drag started from is the
        // pickup, not a destination.
        const [origin, ...rest] = path
        if (!window.slots[origin]) return
        await bot.clickWindow(origin, 0, 0)
        destinations = rest
      }
      if (!window.selectedItem || destinations.length === 0) return

      const held = window.selectedItem
      const targets = destinations.filter(slot => {
        const existing = window.slots[slot]
        return !existing || (existing.type === held.type && existing.metadata === held.metadata)
      })
      if (targets.length === 0) return

      // Left drag splits the held stack evenly, leaving any remainder on the
      // cursor, same as vanilla. Right drag always deals out one apiece.
      // Either way, dragging over more slots than there is to go around just
      // fills the first slots you dragged over, in that order, one each.
      const perSlot = rightDrag ? 1 : Math.floor(held.count / targets.length)
      const fillTargets = perSlot > 0 ? targets : targets.slice(0, held.count)
      const itemsPerSlot = perSlot > 0 ? perSlot : 1
      if (fillTargets.length === 0) return

      for (const slot of fillTargets) {
        for (let i = 0; i < itemsPerSlot; i++) {
          if (!window.selectedItem) break
          const existing = window.slots[slot]
          if (existing && (existing.type !== window.selectedItem.type || existing.metadata !== window.selectedItem.metadata)) break
          await bot.clickWindow(slot, 1, 0)
        }
      }
    } catch (err) {
    } finally {
      this._scheduleUpdate()
    }
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
