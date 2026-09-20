'use strict'
const { randomBytes } = require('crypto')

const EMPTY = { forward: false, jump: false, digging: false, use: false, dx: 0, dy: 0 }
function sanitize (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = { ...EMPTY }
  for (const key of ['forward', 'jump', 'digging', 'use']) state[key] = value[key] === true
  for (const key of ['dx', 'dy']) {
    if (!Number.isFinite(value[key])) return null
    state[key] = Math.max(-1, Math.min(1, value[key]))
  }
  return state
}

// A phone sends only derived controls to its owning browser. It never joins a
// Minecraft session or gains the ability to address another player's bot.
class MotionPairing {
  constructor (isPlayer, now = Date.now) {
    this.isPlayer = isPlayer
    this.now = now
    this.hosts = new Map()
    this.phones = new Map()
    this.codes = new Map()
    this.timer = setInterval(() => this.expire(), 100)
    this.timer.unref?.()
  }

  register (socket) {
    let lastRequest = -Infinity
    const allowed = () => {
      const now = this.now()
      if (now - lastRequest < 1000) return false
      lastRequest = now
      return true
    }
    socket.on('motion:create', reply => {
      if (typeof reply !== 'function') return
      if (!allowed() || !this.isPlayer(socket.id)) return reply({ error: 'Join the game first, or wait a second and retry.' })
      this.remove(socket)
      // Six readable characters; omit ambiguous I, O, 0 and 1.
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      let code
      do {
        code = Array.from(randomBytes(6), byte => alphabet[byte % alphabet.length]).join('')
      } while (this.codes.has(code))
      const entry = { host: socket, code, expires: this.now() + 300000, phone: null, last: 0, released: true, lastPacket: -Infinity }
      this.hosts.set(socket.id, entry)
      this.codes.set(code, entry)
      reply({ code, expires: entry.expires })
    })
    socket.on('motion:pair', (value, reply) => {
      if (typeof reply !== 'function') return
      if (!allowed()) return reply({ error: 'Wait a second before trying again.' })
      const code = typeof value?.code === 'string' ? value.code.replace(/[\s-]/g, '').toUpperCase() : ''
      const entry = this.codes.get(code)
      if (!entry || entry.expires <= this.now() || entry.host.id === socket.id || !entry.host.connected || !this.isPlayer(entry.host.id) || this.isPlayer(socket.id)) {
        return reply({ error: 'Code is invalid or expired. Generate a new code on the game screen.' })
      }
      this.remove(socket)
      this.codes.delete(code) // single use
      entry.code = null
      entry.phone = socket
      entry.last = this.now()
      this.phones.set(socket.id, entry)
      entry.host.emit('motion:paired')
      reply({ ok: true })
    })
    socket.on('motion:state', value => {
      const entry = this.phones.get(socket.id)
      if (!entry || !this.isPlayer(entry.host.id)) return
      const now = this.now()
      if (now - entry.lastPacket < 35) return
      const state = sanitize(value)
      if (!state) return
      entry.lastPacket = now
      entry.last = now
      entry.released = false
      entry.host.emit('motion:state', state)
    })
    socket.on('motion:unpair', () => this.remove(socket))
    socket.on('disconnect', () => this.remove(socket))
  }

  remove (socket) {
    const entry = this.hosts.get(socket.id) || this.phones.get(socket.id)
    if (!entry) return
    if (entry.code) this.codes.delete(entry.code)
    this.hosts.delete(entry.host.id)
    if (entry.phone) this.phones.delete(entry.phone.id)
    entry.host.emit('motion:state', { ...EMPTY })
    entry.host.emit('motion:ended')
    entry.phone?.emit('motion:ended')
  }

  expire () {
    const now = this.now()
    for (const entry of this.hosts.values()) {
      if (entry.code && now >= entry.expires) { this.remove(entry.host); continue }
      if (entry.phone && !entry.released && now - entry.last > 500) {
        entry.released = true
        entry.host.emit('motion:state', { ...EMPTY })
        entry.host.emit('motion:stale')
      }
    }
  }

  destroy () {
    clearInterval(this.timer)
    for (const entry of this.hosts.values()) this.remove(entry.host)
  }
}
module.exports = { MotionPairing, sanitize }
