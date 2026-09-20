'use strict'

// Nobody clicking within this long respawns the bot anyway, so an unattended
// tab cannot leave it lying dead on the server.
const AUTO_RESPAWN_MS = 30000
// With no browser open there is nobody to click; respawn almost at once.
const UNATTENDED_RESPAWN_MS = 2000

/**
 * Owns a session's dead/alive state and its "Respawn" button.
 *
 * mineflayer is created with respawn: false so death is visible in the
 * browser; this is what puts it back. A solo player's death is theirs alone;
 * road trip riders all see the same screen, and any of them may click. The
 * vanilla death message comes off the combat packet rather than by sniffing
 * system chat.
 *
 * `emitter` is whatever the session speaks through; only .emit() is called.
 */
class Respawner {
  constructor (emitter, chatLog, viewerCount) {
    this.emitter = emitter
    this.chatLog = chatLog
    this.viewerCount = viewerCount
    this.bot = null
    this.dead = null // { diedAt, respawnAt, cause, score } while dead
    this.timer = null
    this.listeners = []
  }

  register (socket) {
    socket.on('respawn', () => this.respawn())
    if (this.dead) socket.emit('bot:death', this.dead)
  }

  /** Called when a browser leaves: a dead bot with no viewers should not wait. */
  viewersChanged () {
    if (this.dead && this.viewerCount() === 0) this._schedule(UNATTENDED_RESPAWN_MS)
  }

  respawn () {
    if (!this.bot || !this.dead) return
    try {
      this.bot.respawn()
    } catch (err) {
      // bot went away; clearBot will tidy up
    }
  }

  setBot (bot) {
    this.clearBot()
    this.bot = bot
    this._listen(bot, 'death', () => this._onDeath(bot))
    this._listen(bot, 'spawn', () => this._onSpawn())
    this._listen(bot._client, 'death_combat_event', packet => this._onCause(bot, packet))
  }

  clearBot () {
    for (const [emitter, event, fn] of this.listeners) emitter.removeListener(event, fn)
    this.listeners = []
    this.bot = null
    clearTimeout(this.timer)
    this.timer = null
    if (this.dead) {
      this.dead = null
      this.emitter.emit('bot:respawn')
    }
  }

  _listen (emitter, event, fn) {
    emitter.on(event, fn)
    this.listeners.push([emitter, event, fn])
  }

  _onDeath (bot) {
    const now = Date.now()
    const wait = this.viewerCount() === 0 ? UNATTENDED_RESPAWN_MS : AUTO_RESPAWN_MS
    this.dead = {
      diedAt: now,
      respawnAt: now + wait,
      cause: null,
      score: bot.experience ? bot.experience.points : 0
    }
    this._schedule(wait)
    this.chatLog.system('* the bot died')
    this.emitter.emit('bot:death', this.dead)
  }

  _onCause (bot, packet) {
    if (!this.dead || !packet || !packet.message) return
    try {
      const ChatMessage = require('prismarine-chat')(bot.registry)
      this.dead.cause = ChatMessage.fromNotch(packet.message).toString()
    } catch (err) {
      return
    }
    // The combat packet lands right after the health update, so this is a
    // second, fuller bot:death for the same death.
    this.emitter.emit('bot:death', this.dead)
  }

  _onSpawn () {
    if (!this.dead) return
    this.dead = null
    clearTimeout(this.timer)
    this.timer = null
    this.chatLog.system('* the bot respawned')
    this.emitter.emit('bot:respawn')
  }

  _schedule (ms) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.respawn(), ms)
    this.timer.unref?.()
    if (this.dead) this.dead.respawnAt = Date.now() + ms
  }
}

module.exports = Respawner
