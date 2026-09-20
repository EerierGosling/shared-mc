'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Speech, NOT_CONFIGURED } = require('../src/server/speech')
const Controller = require('../src/server/control')

class Socket {
  constructor (id) { this.id = id; this.handlers = {}; this.sent = [] }
  on (event, handler) { this.handlers[event] = handler }
  emit (event, payload) { this.sent.push({ event, payload }) }
  receive (event, ...args) { return this.handlers[event](...args) }
}

// Stands in for the SDK's live socket: records what was sent and lets the
// test play Deepgram's side.
class FakeDeepgram {
  constructor () { this.handlers = {}; this.media = []; this.closed = false; this.readyState = 0; this.closeStreams = 0 }
  on (event, fn) { this.handlers[event] = fn }
  connect () { this.readyState = 1; this.handlers.open?.() }
  async waitForOpen () {}
  sendMedia (chunk) { this.media.push(chunk) }
  sendCloseStream () { this.closeStreams += 1 }
  close () { this.closed = true; this.readyState = 3 }
  results (transcript, isFinal = true) {
    this.handlers.message({ type: 'Results', is_final: isFinal, channel: { alternatives: [{ transcript }] } })
  }
  end () { this.handlers.close?.({}) }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

function setup ({ configured = true } = {}) {
  const connections = []
  const transcripts = []
  const sockets = Object.fromEntries(['a', 'b', 'lobby', 'phone'].map(id => [id, new Socket(id)]))
  // 'phone' is paired to 'a' until the test unpairs it.
  const pairing = { phone: sockets.a }
  const speech = new Speech({
    playerFor: socket => ['a', 'b'].includes(socket.id) ? socket : pairing[socket.id] || null,
    onTranscript: (socket, text) => transcripts.push([socket.id, text]),
    connect: configured ? async () => { const dg = new FakeDeepgram(); connections.push(dg); return dg } : null
  })
  for (const s of Object.values(sockets)) speech.register(s)
  return { speech, connections, transcripts, pairing, ...sockets }
}

test('each socket gets its own transcription, delivered to its own session', async () => {
  const { a, b, connections, transcripts } = setup()
  a.receive('speech:start')
  b.receive('speech:start')
  await tick()
  assert.equal(connections.length, 2)
  const [dgA, dgB] = connections
  a.receive('speech:audio', Buffer.from('aaa'))
  b.receive('speech:audio', Buffer.from('bbb'))
  assert.deepEqual(dgA.media.map(String), ['aaa'])
  assert.deepEqual(dgB.media.map(String), ['bbb'])
  dgA.results('hello', false)
  dgA.results('hello there')
  dgB.results('goodbye')
  a.receive('speech:stop')
  assert.equal(dgA.closeStreams, 1)
  dgA.end()
  assert.deepEqual(transcripts, [['a', 'hello there']])
  assert.deepEqual(a.sent.at(-1), { event: 'speech:result', payload: { text: 'hello there' } })
  assert.ok(dgA.closed)
  assert.ok(!dgB.closed, 'stopping one speaker leaves the other recording')
  b.receive('speech:stop')
  dgB.end()
  assert.deepEqual(transcripts, [['a', 'hello there'], ['b', 'goodbye']])
})

test('audio and a release that arrive before Deepgram is open are replayed in order', async () => {
  const { a, connections } = setup()
  a.receive('speech:start')
  a.receive('speech:audio', Buffer.from('1'))
  a.receive('speech:audio', Buffer.from('2'))
  a.receive('speech:stop')
  await tick()
  const [dg] = connections
  assert.deepEqual(dg.media.map(String), ['1', '2'])
  assert.equal(dg.closeStreams, 1)
})

test('nothing heard, disconnects and an unconfigured server are reported without a transcript', async () => {
  const { a, connections, transcripts } = setup()
  a.receive('speech:start')
  await tick()
  a.receive('speech:stop')
  connections[0].end()
  assert.deepEqual(a.sent.at(-1), { event: 'speech:result', payload: { text: '' } })
  a.receive('speech:start')
  await tick()
  a.receive('disconnect')
  assert.ok(connections[1].closed)
  connections[1].results('too late')
  connections[1].end()
  assert.deepEqual(transcripts, [])

  const { lobby, a: unconfigured, connections: none } = setup({ configured: false })
  unconfigured.receive('speech:start')
  assert.deepEqual(unconfigured.sent, [{ event: 'speech:error', payload: { reason: NOT_CONFIGURED } }])
  assert.equal(none.length, 0)
  lobby.receive('speech:start')
  assert.deepEqual(lobby.sent, [{ event: 'speech:error', payload: { reason: NOT_CONFIGURED } }])
})

test('a paired phone speaks for its host, who sees the progress', async () => {
  const { a, phone, connections, transcripts, pairing } = setup()
  phone.receive('speech:start')
  await tick()
  assert.deepEqual(a.sent, [{ event: 'speech:phone', payload: { state: 'listening' } }])
  connections[0].results('dig here')
  phone.receive('speech:stop')
  assert.deepEqual(a.sent.at(-1), { event: 'speech:phone', payload: { state: 'sending' } })
  connections[0].end()
  assert.deepEqual(transcripts, [['a', 'dig here']])
  assert.deepEqual(phone.sent.at(-1), { event: 'speech:result', payload: { text: 'dig here' } })
  assert.deepEqual(a.sent.at(-1), { event: 'speech:phone', payload: { state: 'idle' } })
  // Unpaired mid-hold: the phone gets its result but nobody says the words.
  phone.receive('speech:start')
  await tick()
  connections[1].results('not mine')
  delete pairing.phone
  phone.receive('speech:stop')
  connections[1].end()
  assert.deepEqual(transcripts, [['a', 'dig here']])
  assert.deepEqual(phone.sent.at(-1), { event: 'speech:result', payload: { text: 'not mine' } })
  // Never paired: nothing starts.
  phone.receive('speech:start')
  await tick()
  assert.equal(connections.length, 2)
})

test('spoken lines queue one per chat interval instead of being refused', async () => {
  const said = []
  const notices = []
  const controller = new Controller({ emit () {} }, { chatIntervalMs: 30, limits: {} }, null, null, { notice: (id, text) => notices.push(text), said: (id, text) => said.push([id, text]) }, null)
  controller.bot = { chat: text => said.push(['bot', text]) }
  controller.say('a', 'one')
  controller.say('b', 'two')
  controller.say('a', 'three')
  controller.chat('a', 'typed')
  assert.deepEqual(said, [['bot', 'one'], ['a', 'one']])
  assert.deepEqual(notices, ['* not sent: one message per second'])
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(said.filter(([who]) => who === 'bot').map(([, text]) => text), ['one', 'two', 'three'])
  controller.say('a', 'four')
  controller.say('b', 'five')
  controller.clearBot()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(said.filter(([who]) => who === 'bot').length, 4, 'queued speech dies with the bot')
})
