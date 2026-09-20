'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const PhoneMining = require('../src/client/phone-mining')
const FaceGestures = require('../src/client/face-gestures')
const { normalize, DEFAULTS } = require('../src/client/motion-settings')
const { Gestures } = require('../src/client/gestures')
const accel = strength => ({ acceleration: { x: 0, y: strength, z: 0 } })

test('phone requires distinct repeated peaks and expires on missing sensor samples', () => {
  const phoneMining = new PhoneMining()
  phoneMining.update(accel(0), 0)
  assert.equal(phoneMining.update(accel(4), 50), false)
  assert.equal(phoneMining.update(accel(5), 350), false) // sustained motion is not a new swing
  phoneMining.update(accel(0), 400)
  assert.equal(phoneMining.update(accel(4), 450), true)
  assert.equal(phoneMining.active(760), false)
  phoneMining.reset()
  assert.equal(phoneMining.active(460), false)
})

test('gravity fallback ignores a stationary phone and detects dynamic acceleration', () => {
  const phoneMining = new PhoneMining()
  const gravity = y => ({ acceleration: { x: null, y: null, z: null }, accelerationIncludingGravity: { x: 0, y, z: 0 } })
  for (let time = 0; time < 1000; time += 50) assert.equal(phoneMining.update(gravity(9.8), time), false)
  phoneMining.update(gravity(15), 1000)
  phoneMining.update(gravity(9.8), 1300)
  assert.equal(phoneMining.update(gravity(15), 1350), true)
})

test('facial actions require dwell and relaxation; lost face releases actions', () => {
  const face = new FaceGestures()
  const scores = value => ['mouthSmileLeft', 'mouthSmileRight', 'jawOpen'].map(categoryName => ({ categoryName, score: value }))
  assert.equal(face.update(scores(0.9), 0, 0.65).use, false)
  assert.equal(face.update(scores(0.9), 250, 0.65).use, true)
  assert.equal(face.update(scores(0.9), 300, 0.65).jump, true)
  assert.equal(face.update(scores(0.2), 350, 0.65).use, false)
  assert.equal(face.update(scores(0.9), 400, 0.65).use, false)
  assert.equal(face.update(undefined, 700, 0.65).jump, false)
})

test('settings clamp imported values and preserve defaults for invalid data', () => {
  assert.deepEqual(normalize(null), DEFAULTS)
  const settings = normalize({ lookSpeed: 100, swingThreshold: -1, deadzone: 'fast', autojump: false, facial: 'true', arm: 'left' })
  assert.equal(settings.lookSpeed, 3)
  assert.equal(settings.swingThreshold, 0.5)
  assert.equal(settings.deadzone, DEFAULTS.deadzone)
  assert.equal(settings.autojump, false)
  assert.equal(settings.facial, false)
  assert.equal(settings.arm, 'left')
  const g = new Gestures(settings)
  g.walkUntil = 9999
  g.configure(DEFAULTS)
  assert.equal(g.walkUntil, 0)
})

test('brief expression peaks separated by subthreshold readings do not satisfy dwell', () => {
  const face = new FaceGestures()
  const scores = score => ['mouthSmileLeft', 'mouthSmileRight', 'jawOpen'].map(categoryName => ({ categoryName, score }))
  face.update(scores(0.8), 0, 0.65)
  face.update(scores(0.55), 200, 0.65)
  assert.equal(face.update(scores(0.8), 300, 0.65).use, false)
  assert.equal(face.update(scores(0.8), 550, 0.65).use, true)
})
