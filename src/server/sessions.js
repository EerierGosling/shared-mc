'use strict'
const Session = require('./session')
const { SKINS } = require('./skins')

const MAX_NAME = 16
// Minecraft usernames: letters, digits and underscore only. Anything else and
// the login is rejected by the Minecraft server rather than by us, which reads
// as the site being broken.
const LEGAL_NAME = /^[A-Za-z0-9_]{3,16}$/

// Everyone in roadtrip mode shares one bot, so they all sit in one room and a
// single login covers the lot of them.
const ROADTRIP_ROOM = 'roadtrip'
const MODES = ['roadtrip', 'solo']

/**
 * Every session, and the rules about who may have one.
 *
 * Solo visitors each cost a real login, so they are capped by the Minecraft
 * server's own player limit. Roadtrip visitors cost nothing after the first —
 * they share one bot — so they are not capped at all.
 */
class Sessions {
  constructor (config, io) {
    this.config = config
    this.io = io
    this.solo = new Map() // socket.id -> Session
    this.roadtrip = null // one Session, built on demand
    this.modeBySocket = new Map() // socket.id -> 'solo' | 'roadtrip'
    this.capacity = config.maxBots
    // Called whenever who-is-online changes for a reason other than a visitor
    // joining or leaving here: real players coming and going on the server.
    this.onChange = null
    this.changeTimer = null
  }

  /**
   * Every bot hears the same tab-list update, and a fresh login hears one per
   * player already there, so bursts are folded into a single broadcast.
   */
  _playersChanged () {
    if (this.changeTimer || !this.onChange) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      this.onChange()
    }, 100)
  }

  /** Lower the cap to what the server can actually take, never raise it. */
  applyServerCapacity (maxPlayers) {
    if (!Number.isFinite(maxPlayers)) return
    const room = Math.max(1, maxPlayers - this.config.playerSlotsReserved)
    this.capacity = Math.min(this.capacity, room)
  }

  /** Logins in use: every solo visitor, plus one if anyone is on the roadtrip. */
  get botCount () {
    return this.solo.size + (this.roadtrip ? 1 : 0)
  }

  get roadtripRiders () {
    return this.roadtrip ? this.roadtrip.size : 0
  }

  // Includes real players: on an offline-mode server a second login under an
  // online name kicks the first, so a visitor could knock a real player off.
  nameTaken (username) {
    const wanted = username.toLowerCase()
    return this.roster().some(r => r.username.toLowerCase() === wanted)
  }

  /**
   * Validates a join. Returns { ok: true, mode, identity } or
   * { ok: false, reason } — the reason is shown to the visitor, so it reads as
   * a sentence rather than a code.
   */
  vet (payload) {
    const mode = MODES.includes(payload && payload.mode) ? payload.mode : null
    if (!mode) return { ok: false, reason: 'Pick a mode first.' }

    // Riding along costs no extra login and uses the shared character, so
    // there is nothing to name or dress.
    if (mode === 'roadtrip') {
      if (!this.roadtrip && this.botCount >= this.capacity) {
        return { ok: false, reason: 'The server is full right now. Try again shortly.' }
      }
      return { ok: true, mode, identity: { username: this.config.mc.username, skin: SKINS[0] } }
    }

    // Not truncated: silently renaming someone to a 16-character stub is worse
    // than telling them the name is too long.
    const username = String((payload && payload.username) || '').trim()
    // Clamped to the known list here, not later: this identity is broadcast in
    // the roster and every browser turns it into a texture URL.
    const requested = String((payload && payload.skin) || '').trim()
    const skin = SKINS.includes(requested) ? requested : SKINS[0]

    if (username.length > MAX_NAME) {
      return { ok: false, reason: `Names are at most ${MAX_NAME} characters.` }
    }
    if (!LEGAL_NAME.test(username)) {
      return { ok: false, reason: 'Names are 3-16 characters, letters, numbers and underscores only.' }
    }
    if (this.nameTaken(username)) {
      return { ok: false, reason: `Someone is already playing as ${username}.` }
    }
    if (this.botCount >= this.capacity) {
      return { ok: false, reason: `All ${this.capacity} bots are in use. Join the road trip instead.` }
    }
    return { ok: true, mode, identity: { username, skin } }
  }

  join (socket, mode, identity) {
    this.modeBySocket.set(socket.id, mode)

    if (mode === 'roadtrip') {
      socket.join(ROADTRIP_ROOM)
      if (!this.roadtrip) {
        this.roadtrip = new Session({
          mode,
          identity,
          config: this.config,
          emitter: this.io.to(ROADTRIP_ROOM),
          io: this.io,
          onPlayers: () => this._playersChanged()
        })
        this.roadtrip.start()
      }
      this.roadtrip.addMember(socket)
      return this.roadtrip
    }

    const session = new Session({
      mode,
      identity,
      config: this.config,
      emitter: socket,
      io: this.io,
      onPlayers: () => this._playersChanged()
    })
    this.solo.set(socket.id, session)
    session.start()
    session.addMember(socket)
    return session
  }

  leave (socket) {
    const mode = this.modeBySocket.get(socket.id)
    if (!mode) return null
    this.modeBySocket.delete(socket.id)

    if (mode === 'roadtrip') {
      if (!this.roadtrip) return null
      this.roadtrip.removeMember(socket)
      // The shared bot stays logged in only while somebody is watching it.
      if (this.roadtrip.size === 0) {
        this.roadtrip.destroy()
        this.roadtrip = null
      }
      return { mode, identity: null }
    }

    const session = this.solo.get(socket.id)
    if (!session) return null
    this.solo.delete(socket.id)
    session.removeMember(socket)
    session.destroy()
    return { mode, identity: session.identity }
  }

  destroyAll () {
    clearTimeout(this.changeTimer)
    for (const session of this.solo.values()) session.destroy()
    this.solo.clear()
    if (this.roadtrip) this.roadtrip.destroy()
    this.roadtrip = null
    this.modeBySocket.clear()
  }

  /**
   * Everyone on the server, as every browser needs them labelled and skinned.
   * Our own bots come with the skin their visitor picked; `mode: 'player'`
   * rows are real Minecraft clients read off a bot's tab list, whose skins we
   * cannot see, so they carry none.
   */
  roster () {
    const rows = [...this.solo.values()].map(s => ({
      username: s.identity.username,
      skin: s.identity.skin,
      mode: 'solo'
    }))
    if (this.roadtrip) {
      rows.push({
        username: this.roadtrip.identity.username,
        skin: this.roadtrip.identity.skin,
        mode: 'roadtrip',
        riders: this.roadtrip.size
      })
    }
    const ours = new Set(rows.map(r => r.username))
    for (const username of this._serverPlayers()) {
      if (!ours.has(username)) rows.push({ username, mode: 'player' })
    }
    return rows
  }

  /** Usernames on the server's tab list, from any bot that is logged in. */
  _serverPlayers () {
    const sessions = [...this.solo.values()]
    if (this.roadtrip) sessions.push(this.roadtrip)
    const live = sessions.find(s => s.bot)
    if (!live) return []
    return Object.keys(live.bot.players || {}).sort((a, b) => a.localeCompare(b))
  }

  /** What the join screen needs in order to describe the choice. */
  options () {
    return {
      skins: SKINS,
      capacity: this.capacity,
      botCount: this.botCount,
      roadtripRiders: this.roadtripRiders,
      soloAvailable: this.botCount < this.capacity,
      taken: this.roster().map(r => r.username),
      // Shown on the join screen so a visitor can also connect with a real client.
      server: { host: this.config.mc.publicHost, port: this.config.mc.port },
      commit: this.config.commit
    }
  }
}

module.exports = Sessions
