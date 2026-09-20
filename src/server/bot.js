'use strict'
const EventEmitter = require('events')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')

const MAX_BACKOFF_MS = 30000
// Retries after a drop before the bot is declared gone: with the backoff
// below that is about a minute of trying. A bot retrying a dead server
// forever holds its session, and its visitor's attention, for nothing.
const MAX_ATTEMPTS = 5

// Kick reasons that no amount of retrying will change. Matched against the
// raw kick text, which is a translation key or a JSON chat component
// depending on the server.
const TERMINAL_KICKS = ['duplicate_login', 'banned', 'outdated_client', 'outdated_server',
  'not_whitelisted', 'incompatible', 'name_taken', 'server_full']

/**
 * Owns the mineflayer bot and keeps it alive across disconnects.
 *
 * Emits:
 *   'ready'  (bot)      - bot has spawned and is safe to use
 *   'down'   (reason)   - bot lost; every consumer must drop its reference
 *   'gone'   (reason)   - given up; the session should be torn down
 *   'log'    (message)
 */
class BotHolder extends EventEmitter {
  constructor (mcConfig) {
    super()
    this.mcConfig = mcConfig
    this.bot = null
    this.ready = false
    this.attempts = 0
    this.reconnectTimer = null
    this.stopped = false
    this.terminal = null
  }

  start () {
    this.stopped = false
    this._connect()
  }

  stop () {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    const bot = this.bot
    this.bot = null
    this.ready = false
    if (!bot) return
    // A visitor closing the tab mid-connect lands here before mineflayer has
    // finished attaching quit(), and this now runs on every disconnect rather
    // than only at shutdown — so an unguarded call takes the server down with
    // everyone else's bots on it. Fall back to cutting the socket.
    try {
      if (typeof bot.quit === 'function') bot.quit()
      else if (bot._client && typeof bot._client.end === 'function') bot._client.end('session closed')
    } catch (err) {
      this.emit('log', `while stopping: ${err.message}`)
    }
  }

  _connect () {
    const { host, port, username, version, auth, viewDistance } = this.mcConfig
    this.emit('log', `connecting to ${host}:${port} as ${username} (${version}, ${auth})`)

    // respawn: false so death reaches the browser as a screen with a button;
    // respawn.js still respawns unattended bots so nothing stays dead.
    // viewDistance is what the bot asks the server for, in chunks. mineflayer
    // defaults to 'far' (12), and every bot decodes and holds every chunk it is
    // sent, so with several solo bots up that is most of the process's memory
    // spent on terrain no browser is ever shown. WorldView streams only the
    // configured radius, so ask for exactly that.
    const bot = mineflayer.createBot({
      host, port, username, version, auth, respawn: false, viewDistance
    })
    this.bot = bot
    bot.loadPlugin(pathfinder)

    bot.once('spawn', () => {
      this.attempts = 0
      this.ready = true
      try {
        bot.pathfinder.setMovements(new Movements(bot))
      } catch (err) {
        this.emit('log', `pathfinder setup failed: ${err.message}`)
      }
      this.emit('log', `spawned as ${bot.username}`)
      this.emit('ready', bot)
    })

    // mineflayer re-emits 'error' as an EventEmitter error, which throws if
    // nothing is listening. Swallow it here and let 'end' drive reconnection.
    bot.on('error', err => this.emit('log', `bot error: ${err.message}`))
    bot.on('kicked', reason => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      this.emit('log', `kicked: ${text}`)
      if (TERMINAL_KICKS.some(key => text.includes(key))) this.terminal = text
    })
    bot.on('end', reason => this._handleEnd(bot, reason))
  }

  _handleEnd (bot, reason) {
    if (this.bot !== bot) return // a newer bot already took over
    const wasReady = this.ready
    this.ready = false
    this.bot = null
    if (wasReady || this.attempts === 0) this.emit('down', String(reason || 'disconnected'))
    if (this.stopped) return

    if (this.terminal) {
      this.emit('log', `not retrying: ${this.terminal}`)
      this.emit('gone', this.terminal)
      return
    }
    if (this.attempts >= MAX_ATTEMPTS) {
      this.emit('log', `giving up after ${this.attempts} attempts (${reason})`)
      this.emit('gone', String(reason || 'disconnected'))
      return
    }

    const delay = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, this.attempts))
    this.attempts += 1
    this.emit('log', `disconnected (${reason}); reconnecting in ${Math.round(delay / 1000)}s`)
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this._connect(), delay)
  }
}

module.exports = BotHolder
