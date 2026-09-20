'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const Vec3 = require('vec3')
const Controller = require('../src/server/control')

const LEAVES = 276

// A bot whose server answers the dig with `answer` (a block state id), the
// way mineflayer sees it: the raw packet lands, then dig() resolves on its
// own timer regardless.
function stubBot (answer) {
  const position = new Vec3(0, 64, 0)
  const block = { name: 'spruce_leaves', displayName: 'Spruce Leaves', position, face: 1, diggable: true }
  const bot = {
    _client: new EventEmitter(),
    registry: { blocksByStateId: { 0: { name: 'air' }, [LEAVES]: { name: 'spruce_leaves' } } },
    entity: { position: new Vec3(0.5, 65, 0.5) },
    restored: [],
    blockAtCursor: () => block,
    canDigBlock: () => true,
    digTime: () => 300,
    stopDigging: () => {},
    _updateBlockState: (pos, stateId) => bot.restored.push({ pos, stateId }),
    dig: async () => {
      bot._client.emit('block_change', { location: { x: 0, y: 64, z: 0 }, type: answer })
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  return bot
}

function run (bot) {
  const events = []
  const emitter = { emit: (event, payload) => events.push({ event, payload }) }
  const budget = { take: () => true, retryInSeconds: () => 0 }
  const control = new Controller(emitter, { reach: 4.5, lookIntervalMs: 50 }, null, budget, null, null)
  control.bot = bot
  return new Promise(resolve => {
    const original = emitter.emit
    emitter.emit = (event, payload) => {
      original(event, payload)
      if (event === 'dig:stop') {
        control.setDig('s1', false)
        setImmediate(() => resolve(events))
      }
    }
    control.setDig('s1', true)
  })
}

test('a dig the server refuses puts the block back and is not reported as broken', async () => {
  const bot = stubBot(LEAVES)
  const events = await run(bot)
  assert.deepEqual(bot.restored, [{ pos: new Vec3(0, 64, 0), stateId: LEAVES }])
  const stop = events.find(e => e.event === 'dig:stop')
  assert.equal(stop.payload.broken, false)
  assert.ok(events.some(e => e.event === 'chat' && /does not allow mining/.test(e.payload.text)))
})

test('a dig the server confirms with air is broken and left alone', async () => {
  const bot = stubBot(0)
  const events = await run(bot)
  assert.deepEqual(bot.restored, [])
  assert.equal(events.find(e => e.event === 'dig:stop').payload.broken, true)
  assert.ok(!events.some(e => e.event === 'chat'))
})
