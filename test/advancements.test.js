'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const Advancements = require('../src/server/advancements')

const registry = require('minecraft-data')('1.20.4')

// A display block the way the 1.20.4 packet carries it: NBT chat components,
// a slot for the icon, vanilla's frame id and the flag bits.
function display (title, { frame = 0, hidden = false, toast = true, item = 'crafting_table' } = {}) {
  return {
    title: { type: 'string', value: title },
    description: { type: 'string', value: `about ${title}` },
    icon: { present: true, itemId: registry.itemsByName[item].id, itemCount: 1 },
    frameType: frame,
    flags: { hidden: hidden ? 1 : 0, show_toast: toast ? 1 : 0, has_background_texture: 0 },
    xCord: 0,
    yCord: 0
  }
}

function entry (key, parentId, displayData, requirements) {
  return { key, value: { parentId, displayData, requirements, sendsTelemtryData: false } }
}

function progress (key, done) {
  return { key, value: done.map(([criterionIdentifier, at]) => ({ criterionIdentifier, criterionProgress: at })) }
}

function setup () {
  const events = []
  const emitter = { emit: (event, payload) => events.push({ event, payload }) }
  const adv = new Advancements(emitter)
  const bot = { _client: new EventEmitter(), registry }
  adv.setBot(bot)
  return { adv, bot, events }
}

const LOGIN = {
  reset: true,
  advancementMapping: [
    entry('minecraft:story/root', null, display('Minecraft'), [['crafting_table']]),
    entry('minecraft:story/mine_stone', 'minecraft:story/root', display('Stone Age', { item: 'wooden_pickaxe' }), [['get_stone']]),
    entry('minecraft:nether/uneasy_alliance', 'minecraft:nether/root', display('Uneasy Alliance', { frame: 1, hidden: true }), [['killed_ghast']]),
    entry('minecraft:recipes/misc/stick', 'minecraft:recipes/root', null, [['has_planks']])
  ],
  identifiers: [],
  progressMapping: [
    progress('minecraft:story/root', [['crafting_table', 1700000000000]]),
    progress('minecraft:story/mine_stone', [['get_stone', null]]),
    progress('minecraft:recipes/misc/stick', [['has_planks', 1700000000000]])
  ]
}

test('the login dump is relayed without toasts, hidden and recipe entries left out', () => {
  const { bot, events } = setup()
  bot._client.emit('advancements', LOGIN)
  assert.equal(events.length, 1)
  const { event, payload } = events[0]
  assert.equal(event, 'advancements')
  assert.equal(payload.reset, true)
  assert.deepEqual(payload.entries.map(e => e.id), ['minecraft:story/root', 'minecraft:story/mine_stone'])
  const root = payload.entries[0]
  assert.equal(root.title, 'Minecraft')
  assert.equal(root.description, 'about Minecraft')
  assert.equal(root.icon, 'crafting_table')
  assert.equal(root.done, true)
  assert.equal(root.doneAt, 1700000000000)
  assert.equal(payload.entries[1].done, false)
})

test('a criterion arriving later completes the advancement and fires one toast', () => {
  const { adv, bot, events } = setup()
  bot._client.emit('advancements', LOGIN)
  events.length = 0
  bot._client.emit('advancements', {
    reset: false,
    advancementMapping: [],
    identifiers: [],
    progressMapping: [progress('minecraft:story/mine_stone', [['get_stone', 1700000001000]])]
  })
  assert.deepEqual(events.map(e => e.event), ['advancements', 'advancement:earned'])
  assert.equal(events[0].payload.reset, false)
  assert.equal(events[0].payload.entries[0].done, true)
  assert.equal(events[1].payload.title, 'Stone Age')
  assert.equal(events[1].payload.frame, 'task')
  // Progress restated for an advancement already done must not toast again.
  events.length = 0
  bot._client.emit('advancements', {
    reset: false,
    advancementMapping: [],
    identifiers: [],
    progressMapping: [progress('minecraft:story/mine_stone', [['get_stone', 1700000001000]])]
  })
  assert.deepEqual(events.map(e => e.event), ['advancements'])
  assert.equal(adv._isDone('minecraft:story/mine_stone'), true)
})

test('a hidden challenge appears only once earned, with its own frame', () => {
  const { bot, events } = setup()
  bot._client.emit('advancements', LOGIN)
  events.length = 0
  bot._client.emit('advancements', {
    reset: false,
    advancementMapping: [],
    identifiers: [],
    progressMapping: [progress('minecraft:nether/uneasy_alliance', [['killed_ghast', 1700000002000]])]
  })
  const toast = events.find(e => e.event === 'advancement:earned').payload
  assert.equal(toast.id, 'minecraft:nether/uneasy_alliance')
  assert.equal(toast.frame, 'challenge')
  assert.equal(events[0].payload.entries[0].id, 'minecraft:nether/uneasy_alliance')
})

test('requirement groups are OR within and AND across', () => {
  const { adv, bot } = setup()
  bot._client.emit('advancements', {
    reset: true,
    advancementMapping: [entry('x:two', null, display('Two'), [['a', 'b'], ['c']])],
    identifiers: [],
    progressMapping: [progress('x:two', [['a', 1], ['b', null], ['c', null]])]
  })
  assert.equal(adv._isDone('x:two'), false)
  bot._client.emit('advancements', {
    reset: false,
    advancementMapping: [],
    identifiers: [],
    progressMapping: [progress('x:two', [['a', 1], ['b', null], ['c', 2]])]
  })
  assert.equal(adv._isDone('x:two'), true)
})

test('removed ids are relayed and a late socket gets the current set', () => {
  const { adv, bot, events } = setup()
  bot._client.emit('advancements', LOGIN)
  events.length = 0
  bot._client.emit('advancements', { reset: false, advancementMapping: [], identifiers: ['minecraft:story/mine_stone'], progressMapping: [] })
  assert.deepEqual(events[0].payload.removed, ['minecraft:story/mine_stone'])
  const late = []
  adv.register({ emit: (event, payload) => late.push({ event, payload }) })
  assert.equal(late[0].event, 'advancements')
  assert.equal(late[0].payload.reset, true)
  assert.deepEqual(late[0].payload.entries.map(e => e.id), ['minecraft:story/root'])
})

test('clearBot drops everything so the next bot starts from its own dump', () => {
  const { adv, bot, events } = setup()
  bot._client.emit('advancements', LOGIN)
  adv.clearBot()
  assert.equal(adv.entries.size, 0)
  assert.equal(bot._client.listenerCount('advancements'), 0)
  const late = []
  adv.register({ emit: (event, payload) => late.push({ event, payload }) })
  assert.deepEqual(late[0].payload.entries, [])
  assert.equal(events.length, 1)
})
