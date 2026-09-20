'use strict'
const Session = require('./session')
const { SKINS } = require('./skins')

const MAX_NAME = 16
// Minecraft usernames: letters, digits and underscore only. Anything else and
// the login is rejected by the Minecraft server rather than by us, which reads
// as the site being broken.
const LEGAL_NAME = /^[A-Za-z0-9_]{3,16}$/

// Everyone in roadtrip mode on the same server shares one bot, so they all
// sit in one room and a single login covers the lot of them.
const roadtripRoom = key => `roadtrip:${key}`
const MODES = ['roadtrip', 'solo']

// Hostnames and IPv4 literals; anything else is refused before it becomes a
// bot that retries a nonsense address forever.
const LEGAL_HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$/
const serverKey = ({ host, port }) => `${host}:${port}`

/**
 * Every session, and the rules about who may have one.
 *
 * Each visitor names the server they want, so sessions are grouped by
 * `host:port`: one road trip bot per server, and rosters that only show a
 * browser the server it is on.
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
    this.roadtrips = new Map() // serverKey -> Session, built on demand
    this.modeBySocket = new Map() // socket.id -> 'solo' | 'roadtrip'
    this.serverBySocket = new Map() // socket.id -> serverKey
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

  /** Logins in use: every solo visitor, plus one per server with a road trip. */
  get botCount () {
    return this.solo.size + this.roadtrips.size
  }

  get roadtripRiders () {
    let riders = 0
    for (const session of this.roadtrips.values()) riders += session.size
    return riders
  }

  /** All sessions on one server, or everywhere when no key is given. */
  _sessions (key) {
    const all = [...this.solo.values(), ...this.roadtrips.values()]
    return key ? all.filter(s => s.serverKey === key) : all
  }

  // Includes real players: on an offline-mode server a second login under an
  // online name kicks the first, so a visitor could knock a real player off.
  nameTaken (username, key) {
    const wanted = username.toLowerCase()
    return this.roster(key).some(r => r.username.toLowerCase() === wanted)
  }

  /**
   * The server a join asks for. A blank field means the configured default,
   * and "host:port" typed into the host field is taken apart, since that is
   * how Minecraft's own server list writes an address.
   */
  _vetServer (payload) {
    let host = String((payload && payload.host) || '').trim().toLowerCase()
    let port = String((payload && payload.port) || '').trim()
    if (host.includes(':') && !port) [host, port] = host.split(':', 2)
    if (!host) host = this.config.mc.host
    if (!host) return { ok: false, reason: 'Enter a server address.' }
    if (!LEGAL_HOST.test(host)) return { ok: false, reason: 'That server address does not look right.' }
    const portNumber = port ? Number(port) : this.config.mc.port
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      return { ok: false, reason: 'Ports are a number from 1 to 65535.' }
    }
    return { ok: true, server: { host, port: portNumber } }
  }

  /**
   * Validates a join. Returns { ok: true, mode, identity, server } or
   * { ok: false, reason } — the reason is shown to the visitor, so it reads as
   * a sentence rather than a code.
   */
  vet (payload) {
    const mode = MODES.includes(payload && payload.mode) ? payload.mode : null
    if (!mode) return { ok: false, reason: 'Pick a mode first.' }

    const target = this._vetServer(payload)
    if (!target.ok) return target
    const { server } = target
    const key = serverKey(server)

    // Riding along costs no extra login and uses the shared character, so
    // there is nothing to name or dress.
    if (mode === 'roadtrip') {
      if (!this.roadtrips.has(key) && this.botCount >= this.capacity) {
        return { ok: false, reason: 'All the bots are in use right now. Try again shortly.' }
      }
      return { ok: true, mode, server, identity: { username: this.config.mc.username, skin: SKINS[0] } }
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
    if (this.nameTaken(username, key)) {
      return { ok: false, reason: `Someone is already playing as ${username}.` }
    }
    if (this.botCount >= this.capacity) {
      return { ok: false, reason: `All ${this.capacity} bots are in use. Join the road trip instead.` }
    }
    return { ok: true, mode, server, identity: { username, skin } }
  }

  join (socket, mode, identity, server) {
    const key = serverKey(server)
    this.modeBySocket.set(socket.id, mode)
    this.serverBySocket.set(socket.id, key)

    if (mode === 'roadtrip') {
      const room = roadtripRoom(key)
      socket.join(room)
      let trip = this.roadtrips.get(key)
      if (!trip) {
        trip = new Session({
          mode,
          identity,
          server,
          config: this.config,
          emitter: this.io.to(room),
          io: this.io,
          onPlayers: () => this._playersChanged()
        })
        this.roadtrips.set(key, trip)
        trip.start()
      }
      trip.addMember(socket)
      return trip
    }

    const session = new Session({
      mode,
      identity,
      server,
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
    const key = this.serverBySocket.get(socket.id)
    if (!mode) return null
    this.modeBySocket.delete(socket.id)
    this.serverBySocket.delete(socket.id)

    if (mode === 'roadtrip') {
      const trip = this.roadtrips.get(key)
      if (!trip) return null
      trip.removeMember(socket)
      // The shared bot stays logged in only while somebody is watching it.
      if (trip.size === 0) {
        trip.destroy()
        this.roadtrips.delete(key)
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
    for (const session of this._sessions()) session.destroy()
    this.solo.clear()
    this.roadtrips.clear()
    this.modeBySocket.clear()
    this.serverBySocket.clear()
  }

  /**
   * Everyone on one server (or, with no key, every server), as a browser
   * needs them labelled and skinned. Our own bots come with the skin their
   * visitor picked; `mode: 'player'` rows are real Minecraft clients read off
   * a bot's tab list, whose skins we cannot see, so they carry none.
   */
  roster (key) {
    const rows = []
    for (const s of this._sessions(key)) {
      rows.push({
        username: s.identity.username,
        skin: s.identity.skin,
        mode: s.mode,
        riders: s.mode === 'roadtrip' ? s.size : undefined
      })
    }
    const ours = new Set(rows.map(r => r.username))
    for (const username of this._serverPlayers(key)) {
      if (!ours.has(username)) rows.push({ username, mode: 'player' })
    }
    return rows
  }

  /** The roster for the server this socket is playing on; nothing before it joins. */
  rosterFor (socket) {
    const key = this.serverBySocket.get(socket.id)
    return key ? this.roster(key) : []
  }

  /** Usernames on the tab list, from one logged-in bot per server. */
  _serverPlayers (key) {
    const names = new Set()
    const seen = new Set()
    for (const s of this._sessions(key)) {
      if (!s.bot || seen.has(s.serverKey)) continue
      seen.add(s.serverKey)
      for (const name of Object.keys(s.bot.players || {})) names.add(name)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
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
      // Placeholder text for the address fields, and what a blank one means.
      defaultServer: { host: this.config.mc.publicHost, port: this.config.mc.port },
      commit: this.config.commit
    }
  }
}

module.exports = Sessions
