'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const StartGesture = require('../src/client/start-gesture')
const pose = () => {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }))
  points[0].y = 0.3
  points[15].y = points[16].y = 0.1
  return points
}
test('start requires calibration and both hands held for a full second', () => {
  const gesture = new StartGesture()
  const points = pose()
  for (let now = 0; now <= 1500; now += 100) assert.equal(gesture.update(points, now, false), false)
  for (let now = 1600; now < 2600; now += 100) assert.equal(gesture.update(points, now, true), false)
  assert.equal(gesture.update(points, 2600, true), true)
  gesture.reset()
  points[16].y = 0.5
  for (let now = 3000; now <= 4500; now += 100) assert.equal(gesture.update(points, now, true), false)
})
test('missing tracking, lowered hands, and frame gaps cancel the hold', () => {
  for (const interruption of ['missing', 'lowered', 'gap']) {
    const gesture = new StartGesture()
    const points = pose()
    for (let now = 0; now <= 800; now += 100) gesture.update(points, now, true)
    if (interruption === 'missing') gesture.update(null, 900, true)
    if (interruption === 'lowered') {
      points[15].y = 0.5
      gesture.update(points, 900, true)
      points[15].y = 0.1
    }
    const resume = interruption === 'gap' ? 1200 : 1000
    assert.equal(gesture.update(points, resume, true), false)
    assert.equal(gesture.progress, 0)
  }
})
