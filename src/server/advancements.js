'use strict'
const ChatMessage = require('prismarine-chat')

// Vanilla's frame ids on the wire.
const FRAMES = ['task', 'challenge', 'goal']

/**
 * The bot's advancements, kept per session and relayed to its browsers.
 *
 * Java Edition replaced achievements with advancements in 1.12; the server
 * pushes the whole tree at login (`reset: true`) and then only the deltas:
 * entries that changed, ids that were removed, and per-criterion progress.
 * mineflayer has no plugin for the packet, so it is read raw off the client
 * here, the way the death cause and the abilities are elsewhere.
 *
 * Only entries with display data are kept. The rest are the recipe-unlock
 * bookkeeping under `minecraft:recipes/`, roughly a thousand of them, and
 * vanilla never shows those either. Hidden advancements are relayed only
 * once earned, as vanilla draws them.
 *
 * A toast fires when an advancement flips to done on any packet after the
 * first: the login dump carries everything already earned, and vanilla does
 * not celebrate those again.
 *
 * `emitter` is whatever the session speaks through; only .emit() is called.
 */
class Advancements {
  constructor (emitter) {
    this.emitter = emitter
    this.bot = null
    this.entries = new Map() // id -> { id, parent, title, description, icon, frame, hidden, requirements }
    this.progress = new Map() // id -> Map(criterion -> achievedAt ms | null)
    this.primed = false // the login dump has arrived
    this.listeners = []
  }

  register (socket) {
    this.sendTo(socket)
  }

  /** Everything this session knows, for a browser that joined late. */
  sendTo (socket) {
    socket.emit('advancements', { reset: true, entries: this._visible(), removed: [] })
  }

  setBot (bot) {
    this.clearBot()
    this.bot = bot
    this._listen(bot._client, 'advancements', packet => this._onPacket(bot, packet))
  }

  clearBot () {
    for (const [emitter, event, fn] of this.listeners) emitter.removeListener(event, fn)
    this.listeners = []
    this.bot = null
    this.entries.clear()
    this.progress.clear()
    this.primed = false
  }

  _listen (emitter, event, fn) {
    emitter.on(event, fn)
    this.listeners.push([emitter, event, fn])
  }

  _onPacket (bot, packet) {
    const wasDone = new Map()
    for (const id of this.entries.keys()) wasDone.set(id, this._isDone(id))

    if (packet.reset) {
      this.entries.clear()
      this.progress.clear()
    }
    const touched = new Set()
    for (const { key, value } of packet.advancementMapping || []) {
      const entry = this._decode(bot, key, value)
      if (entry) this.entries.set(key, entry)
      else this.entries.delete(key)
      touched.add(key)
    }
    const removed = []
    for (const id of packet.identifiers || []) {
      if (this.entries.delete(id)) removed.push(id)
      this.progress.delete(id)
    }
    for (const { key, value } of packet.progressMapping || []) {
      const criteria = new Map()
      for (const { criterionIdentifier, criterionProgress } of value || []) {
        criteria.set(criterionIdentifier, criterionProgress == null ? null : Number(criterionProgress))
      }
      this.progress.set(key, criteria)
      touched.add(key)
    }

    const entries = []
    const earned = []
    for (const id of touched) {
      const entry = this.entries.get(id)
      if (!entry) continue
      const done = this._isDone(id)
      // Hidden entries stay off the browser until earned, and a hidden
      // entry that was never sent needs no removal either.
      if (entry.hidden && !done) continue
      entries.push(this._describe(entry, done))
      if (done && this.primed && !wasDone.get(id) && entry.showToast) earned.push(this._describe(entry, done))
    }
    if (packet.reset || entries.length || removed.length) {
      this.emitter.emit('advancements', { reset: Boolean(packet.reset), entries, removed })
    }
    for (const entry of earned) this.emitter.emit('advancement:earned', entry)
    this.primed = true
  }

  _decode (bot, id, value) {
    const display = value && value.displayData
    if (!display) return null
    const icon = display.icon
    const item = icon && icon.present ? bot.registry.items[icon.itemId] : null
    return {
      id,
      parent: value.parentId || null,
      title: this._text(bot, display.title),
      description: this._text(bot, display.description),
      icon: item ? item.name : null,
      frame: FRAMES[display.frameType] || 'task',
      hidden: Boolean(display.flags && display.flags.hidden),
      showToast: Boolean(display.flags && display.flags.show_toast),
      requirements: value.requirements || []
    }
  }

  // Titles are chat components (NBT since 1.20.3, JSON before); an
  // undecodable one must not take the bot down over a toast.
  _text (bot, component) {
    if (component == null) return ''
    try {
      return ChatMessage(bot.registry).fromNotch(component).toString()
    } catch (err) {
      return ''
    }
  }

  // Vanilla's rule: every requirement group needs one achieved criterion.
  // No progress record at all means the server has not started counting.
  _isDone (id) {
    const entry = this.entries.get(id)
    if (!entry) return false
    const criteria = this.progress.get(id)
    if (!criteria) return false
    return entry.requirements.every(group => group.some(criterion => criteria.get(criterion) != null))
  }

  _doneAt (id) {
    const criteria = this.progress.get(id)
    if (!criteria) return null
    let latest = null
    for (const at of criteria.values()) if (at != null && (latest === null || at > latest)) latest = at
    return latest
  }

  _describe (entry, done) {
    const { id, parent, title, description, icon, frame } = entry
    return { id, parent, title, description, icon, frame, done, doneAt: done ? this._doneAt(id) : null }
  }

  _visible () {
    const out = []
    for (const [id, entry] of this.entries) {
      const done = this._isDone(id)
      if (entry.hidden && !done) continue
      out.push(this._describe(entry, done))
    }
    return out
  }
}

module.exports = Advancements
