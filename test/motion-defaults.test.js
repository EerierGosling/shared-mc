'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load, save } = require('../src/client/motion-settings')
const PhoneMining = require('../src/client/phone-mining')

test('lighter repeated phone swings trigger mining, sensor noise stays idle', () => {
  const phoneMining = new PhoneMining()
  const sample = (y, now) => phoneMining.update({ acceleration: { x: 0, y, z: 0 } }, now)
  for (let now = 0; now < 500; now += 50) assert.equal(sample(0.4, now), false)
  assert.equal(sample(2.4, 500), false)
  sample(0, 750)
  assert.equal(sample(2.4, 850), true)
  assert.equal(phoneMining.active(1200), false)
})

test('saved old defaults upgrade once while custom values survive', t => {
  const original = global.localStorage
  let stored = JSON.stringify({ stepThreshold: 0.13, swingThreshold: 2.5, phoneThreshold: 3, lookSpeed: 1.7 })
  global.localStorage = { getItem: () => stored, setItem: (key, value) => { stored = value } }
  t.after(() => { if (original === undefined) delete global.localStorage; else global.localStorage = original })
  const settings = load()
  assert.equal(settings.stepThreshold, 0.08)
  assert.equal(settings.swingThreshold, 3.5)
  assert.equal(settings.phoneThreshold, 2)
  assert.equal(settings.lookSpeed, 1.7)
  save({ ...settings, stepThreshold: 0.13 })
  assert.equal(load().stepThreshold, 0.13, 'An intentional adjustment is not migrated again')
  stored = JSON.stringify({ stepThreshold: 0.2, swingThreshold: 4, phoneThreshold: 1.5 })
  const custom = load()
  assert.equal(custom.stepThreshold, 0.2)
  assert.equal(custom.swingThreshold, 4)
  assert.equal(custom.phoneThreshold, 1.5)
})
