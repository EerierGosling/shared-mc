'use strict'
const mc = require('minecraft-protocol')
const Session = require('./session')
const { SKINS } = require('./skins')
const { counters, refused } = require('./metrics')

const MAX_NAME = 16
// Minecraft usernames: letters, digits and underscore only. Anything else and
// the login is rejected by the Minecraft server rather than by us, which reads
// as the site being broken.
const LEGAL_NAME = /^[A-Za-z0-9_]{3,16}$/

// Everyone in roadtrip mode on the same server shares one bot, so they all
// sit in one room and a single login covers the lot of them.
const roadtripRoom = key => `roadtrip:${key}`
// Everyone playing on one server, whatever their mode: rosters go here.
const serverRoom = key => `server:${key}`
// Browsers that have not joined yet: the join screen's live occupancy.
const LOBBY = 'lobby'
const MODES = ['roadtrip', 'solo']

// Hostnames and IPv4 literals; anything else is refused before it becomes a
// bot that retries a nonsense address forever.
const LEGAL_HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$/
const serverKey = ({ host, port }) => `${host}:${port}`

// A server's player count is asked for once per join burst, not once per
// join: some servers rate-limit pings, and fifty visitors arriving from one
// link is one question, not fifty.
const PING_TTL_MS = 10000
const PING_TIMEOUT_MS = 5000
// How often idle solo bots are looked for.
const IDLE_SWEEP_MS = 30000

/**
 * Every session, and the rules about who may have one.
 *
 * Each visitor names the server they want, so sessions are grouped by
 * `host:port`: one road trip bot per server, and rosters that only show a
 * browser the server it is on.
 *
 * Two ceilings. The Minecraft server's: a solo visitor is a real login, so a
 * server is asked for its player count before one is spent on it. Ours: the
 * process runs at most `maxBots` bots, and fewer while `load` says the event
 * loop is already late. Roadtrip visitors cost nothing after the first —
 * they share one bot — so riders are not capped at all.
 */
class Sessions {
  constructor (config, io, load) {
    this.config = config
    this.io = io
    this.load = load || null
    this.solo = new Map() // socket.id -> Session
    this.roadtrips = new Map() // serverKey -> Session, built on demand
    this.byServer = new Map() // serverKey -> Set<Session>
    this.modeBySocket = new Map() // socket.id -> 'solo' | 'roadtrip'
    this.serverBySocket = new Map() // socket.id -> serverKey
    this.pings = new Map() // serverKey -> { at, promise, joinedSince }
    this.capacity = config.maxBots
    // Called with a server key whenever who-is-online there changes; the
    // roster for that server and the join screen's counts follow.
    this.onChange = null
    this.changeTimers = new Map() // serverKey -> debounce timer
    this.sweepTimer = setInterval(() => this._sweepIdle(), IDLE_SWEEP_MS)
    this.sweepTimer.unref()
  }

  /**
   * Every bot on a server hears the same tab-list update, and a fresh login
   * hears one per player already there, so bursts fold into one broadcast.
   */
  _playersChanged (key) {
    if (!this.onChange || this.changeTimers.has(key)) return
    this.changeTimers.set(key, setTimeout(() => {
      this.changeTimers.delete(key)
      this.onChange(key)
    }, 100))
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
    if (key) return [...(this.byServer.get(key) || [])]
    return [...this.solo.values(), ...this.roadtrips.values()]
  }

  _index (session) {
    let set = this.byServer.get(session.serverKey)
    if (!set) {
      set = new Set()
      this.byServer.set(session.serverKey, set)
    }
    set.add(session)
  }

  _unindex (session) {
    const set = this.byServer.get(session.serverKey)
    if (!set) return
    set.delete(session)
    if (set.size === 0) this.byServer.delete(session.serverKey)
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

  /** Whether this process can take one more bot right now, as a refusal or null. */
  _roomHere () {
    if (this.load && this.load.shedding) return 'The site is busy right now. Try again in a minute.'
    if (this.botCount >= this.capacity) return `All ${this.capacity} bots are in use. Try again shortly.`
    return null
  }

  /**
   * Validates a join. Returns { ok: true, mode, identity, server, needsLogin }
   * or { ok: false, reason } — the reason is shown to the visitor, so it
   * reads as a sentence rather than a code. `needsLogin` says whether this
   * join would spend a login on the Minecraft server (a rider joining a road
   * trip that is already running does not).
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
      const needsLogin = !this.roadtrips.has(key)
      const full = needsLogin && this._roomHere()
      if (full) return { ok: false, reason: full }
      return { ok: true, mode, server, needsLogin, identity: { username: this.config.mc.username, skin: SKINS[0] } }
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
    const full = this._roomHere()
    if (full) return { ok: false, reason: full.replace('Try again shortly.', 'Join the road trip instead.') }
    return { ok: true, mode, server, needsLogin: true, identity: { username, skin } }
  }

  /**
   * Whether the Minecraft server has a slot for one more bot, from a ping
   * cached for PING_TTL_MS. Logins handed out since the ping are counted on
   * top of what it reported, so a burst cannot all pass on one stale number.
   */
  async checkRoom (server) {
    const key = serverKey(server)
    let entry = this.pings.get(key)
    if (!entry || Date.now() - entry.at > PING_TTL_MS) {
      counters.pings += 1
      entry = { at: Date.now(), joinedSince: 0, promise: ping(server) }
      this.pings.set(key, entry)
    }
    const result = await entry.promise
    if (result.err) {
      // A failed ping is not cached: the next visitor deserves a fresh look.
      if (this.pings.get(key) === entry) this.pings.delete(key)
      return { ok: false, reason: `Could not reach ${server.host}:${server.port}.` }
    }
    const players = result.players
    if (!players || !Number.isFinite(players.max)) return { ok: true }
    const online = (players.online || 0) + entry.joinedSince
    const allowed = Math.max(1, players.max - this.config.playerSlotsReserved)
    if (online >= allowed) {
      return { ok: false, reason: `${server.host} is full (${players.online}/${players.max}).`, online, max: players.max }
    }
    return { ok: true, online, max: players.max }
  }

  /**
   * The whole join, start to finish: vet, ask the server for room if a login
   * would be spent, vet again (someone may have taken the last bot or the
   * name meanwhile), then join. Resolves to { ok, reason } or
   * { ok: true, mode, identity, server }.
   */
  async tryJoin (socket, payload) {
    const vetted = this.vet(payload)
    if (!vetted.ok) return this._refuse(vetted.reason)
    if (vetted.needsLogin) {
      const room = await this.checkRoom(vetted.server)
      if (!room.ok) return this._refuse(room.reason)
    }
    if (!socket.connected || this.modeBySocket.has(socket.id)) return { ok: false, reason: 'already joined' }
    const again = this.vet(payload)
    if (!again.ok) return this._refuse(again.reason)
    this.join(socket, again.mode, again.identity, again.server)
    counters.joins += 1
    return { ok: true, mode: again.mode, identity: again.identity, server: again.server }
  }

  // Counted with the numbers and addresses blanked, so the metrics see one
  // "server is full" reason rather than one per server and count.
  _refuse (reason) {
    refused(reason.replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?\b|\d+/gi, '#'))
    return { ok: false, reason }
  }

  join (socket, mode, identity, server) {
    const key = serverKey(server)
    this.modeBySocket.set(socket.id, mode)
    this.serverBySocket.set(socket.id, key)
    socket.leave(LOBBY)
    socket.join(serverRoom(key))

    if (mode === 'roadtrip') {
      const room = roadtripRoom(key)
      socket.join(room)
      let trip = this.roadtrips.get(key)
      if (!trip) {
        trip = this._create({ mode, identity, server, emitter: this.io.to(room) })
        this.roadtrips.set(key, trip)
        trip.start()
      }
      trip.addMember(socket)
      return trip
    }

    const session = this._create({ mode, identity, server, emitter: socket })
    this.solo.set(socket.id, session)
    session.start()
    session.addMember(socket)
    return session
  }

  _create ({ mode, identity, server, emitter }) {
    const key = serverKey(server)
    const session = new Session({
      mode,
      identity,
      server,
      config: this.config,
      emitter,
      io: this.io,
      onPlayers: () => this._playersChanged(key),
      onGone: reason => this._gone(session, reason)
    })
    this._index(session)
    const entry = this.pings.get(key)
    if (entry) entry.joinedSince += 1
    return session
  }

  leave (socket) {
    const mode = this.modeBySocket.get(socket.id)
    const key = this.serverBySocket.get(socket.id)
    if (!mode) return null
    this.modeBySocket.delete(socket.id)
    this.serverBySocket.delete(socket.id)
    if (socket.connected) {
      socket.leave(serverRoom(key))
      socket.join(LOBBY)
    }

    if (mode === 'roadtrip') {
      const trip = this.roadtrips.get(key)
      if (!trip) return null
      socket.leave(roadtripRoom(key))
      trip.removeMember(socket)
      // The shared bot stays logged in only while somebody is watching it.
      if (trip.size === 0) {
        trip.destroy()
        this._unindex(trip)
        this.roadtrips.delete(key)
      }
      return { mode, identity: null }
    }

    const session = this.solo.get(socket.id)
    if (!session) return null
    this.solo.delete(socket.id)
    session.removeMember(socket)
    session.destroy()
    this._unindex(session)
    return { mode, identity: session.identity }
  }

  /**
   * Ends a session from our side: every member is told why and returned to
   * the join screen, and the bot is logged out through the same path a
   * closed tab takes.
   */
  expire (session, reason) {
    session.emitter.emit('session:expired', { reason })
    for (const socket of [...session.socketsById.values()]) this.leave(socket)
    if (this.onChange) this.onChange(session.serverKey)
  }

  _sweepIdle () {
    const limit = this.config.idleTimeoutMs
    if (!limit) return
    const now = Date.now()
    for (const session of [...this.solo.values()]) {
      if (now - session.lastInputAt < limit) continue
      counters.expired += 1
      console.log(`[${session.identity.username}@${session.serverKey}] idle for ${duration(limit)}; logging out`)
      this.expire(session, `You were idle for ${duration(limit)}, so your bot logged out.`)
    }
  }

  _gone (session, reason) {
    counters.gone += 1
    console.log(`[${session.identity.username}@${session.serverKey}] gone: ${reason}`)
    this.expire(session, `Lost the connection to ${session.server.host}.`)
  }

  destroyAll () {
    clearInterval(this.sweepTimer)
    for (const timer of this.changeTimers.values()) clearTimeout(timer)
    this.changeTimers.clear()
    for (const session of this._sessions()) session.destroy()
    this.solo.clear()
    this.roadtrips.clear()
    this.byServer.clear()
    this.modeBySocket.clear()
    this.serverBySocket.clear()
  }

  /**
   * Everyone on one server, as a browser needs them labelled and skinned.
   * Our own bots come with the skin their visitor picked; `mode: 'player'`
   * rows are real Minecraft clients read off a bot's tab list, whose skins
   * we cannot see, so they carry none.
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

  /** Usernames on the tab list, from one logged-in bot on the server. */
  _serverPlayers (key) {
    for (const s of this._sessions(key)) {
      if (!s.bot) continue
      return Object.keys(s.bot.players || {}).sort((a, b) => a.localeCompare(b))
    }
    return []
  }

  /** What the join screen needs in order to describe the choice. */
  options () {
    return {
      skins: SKINS,
      capacity: this.capacity,
      botCount: this.botCount,
      roadtripRiders: this.roadtripRiders,
      soloAvailable: !this._roomHere(),
      // Placeholder text for the address fields, and what a blank one means.
      defaultServer: { host: this.config.mc.publicHost, port: this.config.mc.port },
      commit: this.config.commit
    }
  }
}

const duration = ms => ms >= 60000 ? `${Math.round(ms / 60000)} minutes` : `${Math.round(ms / 1000)} seconds`

/** mc.ping as a promise that never rejects: { err } or the status. */
function ping ({ host, port }) {
  return new Promise(resolve => {
    mc.ping({ host, port, closeTimeout: PING_TIMEOUT_MS }, (err, result) => {
      resolve(err ? { err } : (result || { err: new Error('no response') }))
    })
  })
}

Sessions.LOBBY = LOBBY
Sessions.serverRoom = serverRoom

module.exports = Sessions
