'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load, save } = require('../src/client/motion-settings')
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
