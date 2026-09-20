'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { MotionPairing, sanitize } = require('../src/server/motion-pairing')

class Socket {
  constructor (id) { this.id = id; this.connected = true; this.handlers = {}; this.sent = [] }
  on (event, handler) { this.handlers[event] = handler }
  emit (event, payload) { this.sent.push({ event, payload }) }
  receive (event, ...args) { this.handlers[event](...args) }
  request (event, value) {
    let response
    const reply = result => { response = result }
    if (value === undefined) this.receive(event, reply)
    else this.receive(event, value, reply)
    return response
  }
}
function setup (t) {
  let now = 10000
  const manager = new MotionPairing(id => ['host', 'other'].includes(id), () => now)
  const host = new Socket('host'); const phone = new Socket('phone'); const other = new Socket('other')
  for (const s of [host, phone, other]) manager.register(s)
  t.after(() => manager.destroy())
  return { manager, host, phone, other, advance: ms => { now += ms } }
}
const packet = { forward: false, jump: false, digging: true, use: false, dx: 0, dy: 0 }

test('pairing sends controls only to the owning player, and consumes code', t => {
  const { manager, host, phone, other } = setup(t)
  const { code } = host.request('motion:create')
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/)
  assert.deepEqual(phone.request('motion:pair', { code: `${code.slice(0, 3)}-${code.slice(3)}`.toLowerCase() }), { ok: true })
  phone.receive('motion:state', packet)
  assert.deepEqual(host.sent.at(-1), { event: 'motion:state', payload: packet })
  assert.equal(other.sent.length, 0)
  assert.equal(manager.codes.size, 0)
  const intruder = new Socket('intruder'); manager.register(intruder)
  assert.ok(intruder.request('motion:pair', { code }).error)
  intruder.receive('motion:state', packet)
  assert.equal(manager.phones.size, 1)
})

test('expired and replaced codes are rejected', t => {
  const { host, phone, advance, manager } = setup(t)
  const old = host.request('motion:create').code
  advance(1001)
  const next = host.request('motion:create').code
  assert.notEqual(old, next)
  assert.ok(phone.request('motion:pair', { code: old }).error)
  advance(300001); manager.expire()
  assert.ok(phone.request('motion:pair', { code: next }).error)
  assert.equal(manager.hosts.size, 0)
})

test('stale frames release controls; disconnect removes the pair', t => {
  const { host, phone, advance, manager } = setup(t)
  phone.request('motion:pair', { code: host.request('motion:create').code })
  phone.receive('motion:state', packet)
  advance(501); manager.expire()
  assert.equal(host.sent.at(-2).payload.digging, false)
  assert.equal(host.sent.at(-1).event, 'motion:stale')
  phone.receive('motion:state', packet)
  assert.equal(host.sent.at(-1).payload.digging, true)
  phone.receive('disconnect')
  assert.equal(host.sent.at(-2).payload.digging, false)
  assert.equal(manager.phones.size, 0)
  assert.equal(manager.hosts.size, 0)
})

test('packets are bounded, malformed packets rejected, requests throttled', t => {
  assert.equal(sanitize({ dx: NaN, dy: 0 }), null)
  assert.equal(sanitize({ dx: '1', dy: 0 }), null)
  assert.equal(sanitize(null), null)
  assert.deepEqual(sanitize({ ...packet, forward: true, jump: true, use: true, dx: 99, dy: -8, socketId: 'other' }), packet)
  const { host, phone } = setup(t)
  const { code } = host.request('motion:create')
  assert.equal(host.request('motion:create').code, code)
  phone.request('motion:pair', { code })
  phone.receive('motion:state', packet)
  const count = host.sent.length
  phone.receive('motion:state', packet)
  assert.equal(host.sent.length, count)
})

test('host disconnect and explicit unpair revoke phone authorization', t => {
  const { host, phone, manager } = setup(t)
  phone.request('motion:pair', { code: host.request('motion:create').code })
  host.receive('motion:unpair')
  const count = host.sent.length
  phone.receive('motion:state', packet)
  assert.equal(host.sent.length, count)
  assert.equal(phone.sent.at(-1).event, 'motion:ended')
  assert.equal(manager.hosts.size, 0)
})

test('pair before joining; only mining is relayed once the host joins', t => {
  const joined = new Set()
  const manager = new MotionPairing(id => joined.has(id))
  t.after(() => manager.destroy())
  const host = new Socket('lobby-host')
  const phone = new Socket('phone')
  manager.register(host)
  manager.register(phone)
  const created = host.request('motion:create')
  assert.match(created.code, /^[A-HJ-NP-Z2-9]{6}$/)
  assert.deepEqual(host.request('motion:create'), created, 'Immediate retries reuse the valid code')
  assert.deepEqual(phone.request('motion:pair', { code: created.code }), { ok: true })
  const count = host.sent.length
  const gestures = { digging: true, forward: true, jump: true, use: true, dx: 1, dy: -1 }
  phone.receive('motion:state', gestures)
  assert.equal(host.sent.length, count, 'No game input before joining')
  joined.add(host.id)
  phone.receive('motion:state', gestures)
  assert.deepEqual(host.sent.at(-1), { event: 'motion:state', payload: packet })
  assert.deepEqual(sanitize({ digging: false }), { ...packet, digging: false })
})
