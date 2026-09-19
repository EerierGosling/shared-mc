'use strict'

const HISTORY_SIZE = 50
// How long a relayed browser message stays eligible to swallow its own echo.
const ECHO_WINDOW_MS = 15000
const MAX_NAME_LENGTH = 16

/**
 * One chat log per session, shared by every browser in it.
 *
 * Two kinds of line flow through here. Minecraft lines (other players, death
 * messages, join/leave, command output) come off the bot's 'message' event and
 * are relayed to the session. Browser lines are relayed the moment the bot has
 * sent them, tagged with the viewer's name, because the Minecraft echo would
 * arrive seconds later (behind the chunk stream) and would name the bot rather
 * than the person who typed. That echo is then dropped, otherwise every
 * message would appear twice. Other Minecraft players still only ever see
 * "<bot> text"; the viewer name exists on the browser side alone.
 *
 * The last HISTORY_SIZE lines are kept so a browser that joins late sees the
 * same log as everyone else in the session.
 *
 * `emitter` is whatever the session speaks through (a socket or io.to(room));
 * only .emit() is ever called on it.
 */
class ChatLog {
  constructor (emitter) {
    this.emitter = emitter
    this.bot = null
    this.history = []
    this.sockets = new Map() // socket.id -> socket, for one-to-one notices
    this.names = new Map() // socket.id -> display name
    this.recentlySent = new Map() // text -> ts, for echo suppression
    this.listeners = []
  }

  /** `name` is what to call this browser; solo players are their own bot. */
  register (socket, name) {
    this.sockets.set(socket.id, socket)
    this.names.set(socket.id, name || 'web-' + socket.id.slice(0, 4).toLowerCase())
    socket.on('chat:name', payload => this.setName(socket, payload && payload.name))
    socket.emit('chat:history', this.history)
  }

  dropSocket (socketId) {
    this.sockets.delete(socketId)
    this.names.delete(socketId)
  }

  nameOf (socketId) {
    return this.names.get(socketId) || 'web'
  }

  setName (socket, name) {
    if (typeof name !== 'string') return
    const clean = name.replace(/[^\w-]/g, '').slice(0, MAX_NAME_LENGTH)
    if (!clean) return
    const before = this.nameOf(socket.id)
    this.names.set(socket.id, clean)
    this.system(`* ${before} is now known as ${clean}`)
  }

  /** A viewer's message, after the bot has actually sent it. */
  said (socketId, text) {
    this.recentlySent.set(text, Date.now())
    this._push({ kind: 'web', from: this.nameOf(socketId), text, ts: Date.now() })
  }

  /**
   * A line from this app rather than from Minecraft, e.g. "* the bot died".
   * Kept apart from Minecraft's own 'system' lines so the browser can colour
   * ours and leave theirs as vanilla would (white unless the message says).
   */
  system (text) {
    this._push({ kind: 'notice', text, ts: Date.now() })
  }

  /** A line for one browser only, not kept in history: rate limit hints etc. */
  notice (socketId, text) {
    const socket = this.sockets.get(socketId)
    if (socket) socket.emit('chat', { kind: 'notice', text, ts: Date.now() })
  }

  setBot (bot) {
    this.clearBot()
    this.bot = bot
    this._listen(bot, 'message', (message, position, sender) => {
      // game_info is the action bar ("Now entering ..."), not chat.
      if (position === 'game_info') return
      let text
      try {
        text = message.toString()
      } catch (err) {
        return // an undecodable component must not take the bot down
      }
      if (!text) return
      if (this._isOwnEcho(bot, sender, text)) return
      let motd = null
      try {
        motd = message.toMotd()
      } catch (err) {
        // plain text is fine
      }
      this._push({ kind: position === 'chat' ? 'chat' : 'system', text, motd, ts: Date.now() })
    })
  }

  clearBot () {
    for (const [emitter, event, fn] of this.listeners) emitter.removeListener(event, fn)
    this.listeners = []
    this.bot = null
  }

  _listen (emitter, event, fn) {
    emitter.on(event, fn)
    this.listeners.push([emitter, event, fn])
  }

  _isOwnEcho (bot, sender, text) {
    const uuid = bot._client && bot._client.uuid
    if (!uuid || sender !== uuid) return false
    const body = text.startsWith(`<${bot.username}> `) ? text.slice(bot.username.length + 3) : text
    const sentAt = this.recentlySent.get(body)
    if (sentAt === undefined) return false
    this.recentlySent.delete(body)
    return Date.now() - sentAt < ECHO_WINDOW_MS
  }

  _push (entry) {
    this.history.push(entry)
    while (this.history.length > HISTORY_SIZE) this.history.shift()
    const cutoff = Date.now() - ECHO_WINDOW_MS
    for (const [text, ts] of this.recentlySent) if (ts < cutoff) this.recentlySent.delete(text)
    this.emitter.emit('chat', entry)
  }
}

module.exports = ChatLog
