'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Gestures } = require('../src/client/gestures')

function pose () {
  const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }))
  p[0] = { x: 0.5, y: 0.2, visibility: 1 }
  p[11].x = 0.6; p[12].x = 0.4
  p[11].y = p[12].y = 0.4
  p[23].y = p[24].y = 0.65
  p[25].y = p[26].y = 0.8
  p[27].y = p[28].y = 0.95
  return p
}
function calibrated () {
  const g = new Gestures()
  for (let i = 0; i < 30; i++) assert.equal(g.update(pose(), i * 50).forward, false)
  return g
}

test('neutral pose stays idle and head directions match mirrored preview', () => {
  const g = calibrated()
  let p = pose()
  assert.equal(g.update(p, 1500).dx, 0)
  p[0].x += 0.1 // user's left in the unmirrored camera image
  assert.ok(g.update(p, 1550).dx < 0)
  p = pose(); p[0].x -= 0.1
  assert.ok(g.update(p, 1600).dx > 0)
  p = pose(); p[0].y -= 0.1
  assert.ok(g.update(p, 1650).dy < 0)
  p = pose(); p[0].y += 0.1
  assert.ok(g.update(p, 1700).dy > 0)
})

test('walking requires alternating steps, autojumps, and expires', () => {
  const g = calibrated()
  let p = pose(); p[25].y -= 0.08
  assert.equal(g.update(p, 1500).forward, false)
  g.update(p, 1700)
  p = pose(); p[26].y -= 0.08
  const moving = g.update(p, 1850)
  assert.equal(moving.forward, true)
  assert.equal(moving.jump, true)
  assert.equal(g.update(p, 2600).forward, false)
})

test('lost landmarks release mining and movement immediately', () => {
  const g = calibrated()
  g.update(pose(), 1500)
  const p = pose(); p[16].y += 0.1
  assert.equal(g.update(p, 1550).digging, false)
  p[16].y += 0.1
  assert.equal(g.update(p, 1600).digging, true)
  assert.equal(g.update([], 1650).digging, false)
  assert.equal(g.update(pose(), 1700).digging, false)
})

test('jumps require feet and hips to rise together', () => {
  const g = calibrated()
  g.update(pose(), 1500)
  const p = pose(); p[23].y -= 0.07; p[24].y -= 0.07
  assert.equal(g.update(p, 1550).jump, false)
  p[23].y -= 0.01; p[24].y -= 0.01
  p[27].y -= 0.07; p[28].y -= 0.07
  assert.equal(g.update(p, 1600).jump, true)
  assert.equal(g.update(pose(), 1900).jump, false)
})

test('missing legs cannot walk and recalibration clears actions', () => {
  const g = calibrated()
  let p = pose(); p[25].y -= 0.08; g.update(p, 1500)
  g.update(p, 1700)
  p = pose(); p[26].y -= 0.08; assert.equal(g.update(p, 1850).forward, true)
  p[27].visibility = 0
  assert.equal(g.update(p, 1900).forward, false)
  g.calibrate()
  assert.equal(g.update(pose(), 1950).jump, false)
  assert.equal(g.neutral, null)
})

test('upper-body calibration and steering do not require visible hips', () => {
  const g = new Gestures()
  const p = pose()
  for (let i = 23; i < 33; i++) p[i].visibility = 0
  for (let i = 0; i < 30; i++) g.update(p, i * 50)
  assert.ok(g.neutral)
  p[0].x += 0.05
  const state = g.update(p, 1500)
  assert.ok(state.dx < 0)
  assert.equal(state.tracking.legs, false)
  assert.equal(state.forward, false)
  p[16].y += 0.1; g.update(p, 1550)
  p[16].y += 0.1
  assert.equal(g.update(p, 1600).digging, true)
})

test('slow calibration drift cannot masquerade as a neutral pose', () => {
  const g = new Gestures()
  for (let i = 0; i < 60; i++) {
    const p = pose(); p[0].x += i * 0.003
    g.update(p, i * 50)
  }
  assert.equal(g.neutral, null)
})

test('single-frame wrist outliers and snap-back do not mine', () => {
  const g = calibrated()
  g.update(pose(), 1500)
  const p = pose(); p[16].y += 0.1
  assert.equal(g.update(p, 1600).digging, false)
  assert.equal(g.update(pose(), 1700).digging, false)
})

test('forward punches use depth and require consecutive movement samples', () => {
  const g = calibrated()
  const p = pose(); p[12].z = 0; p[16].z = 0
  g.update(p, 1500)
  p[16].z = -0.06
  assert.equal(g.update(p, 1550).digging, false)
  p[16].z = -0.12
  assert.equal(g.update(p, 1600).digging, true)
})

test('tracking gaps discard partial swings and pending walking', () => {
  const g = calibrated()
  g.update(pose(), 1500)
  const p = pose(); p[16].y += 0.1
  g.update(p, 1550)
  p[16].y += 0.1
  const state = g.update(p, 2000)
  assert.equal(state.digging, false)
  assert.equal(state.forward, false)
})

test('losing hips does not change normalized head steering', () => {
  const g = calibrated()
  g.configure({ smoothing: 0 })
  const p = pose(); p[0].x += 0.04
  const before = g.update(p, 1500)
  p[23].visibility = p[24].visibility = 0
  const after = g.update(p, 1550)
  assert.equal(after.dx, before.dx)
  assert.equal(after.dy, before.dy)
})

test('physical jump needs a new full-body calibration after seated setup', () => {
  const g = new Gestures()
  const p = pose(); p[27].visibility = p[28].visibility = 0
  for (let i = 0; i < 30; i++) g.update(p, i * 50)
  const state = g.update(pose(), 1500)
  assert.equal(state.tracking.jumpReady, false)
  assert.match(state.status, /recalibrate/)
})

test('small alternating knee lifts walk while tiny shifts stay idle', () => {
  const g = calibrated()
  for (let i = 0; i < 4; i++) {
    const p = pose(); p[i % 2 ? 26 : 25].y -= 0.01
    assert.equal(g.update(p, 1500 + i * 200).forward, false)
  }
  let p = pose(); p[25].y -= 0.025
  assert.equal(g.update(p, 2300).forward, false)
  p = pose(); p[26].y -= 0.025
  assert.equal(g.update(p, 2500).forward, true)
})

test('moderate arm movement does not mine; deliberate swings still do', () => {
  const g = calibrated()
  const p = pose()
  g.update(p, 1500)
  p[16].y += 0.03
  assert.equal(g.update(p, 1550).digging, false)
  p[16].y += 0.03
  assert.equal(g.update(p, 1600).digging, false)
  p[16].y += 0.05
  assert.equal(g.update(p, 1650).digging, false)
  p[16].y += 0.05
  assert.equal(g.update(p, 1700).digging, true)
})
