'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const PhoneMining = require('../src/client/phone-mining')
function harness (fallback = false, flat = false) {
  const sensor = new PhoneMining()
  let now = 0
  const sample = (z = 0, x = 0, y = 0, rotationRate) => {
    now += 20
    return sensor.update({
      acceleration: fallback ? null : { x, y, z },
      accelerationIncludingGravity: { x, y: y + (flat ? 0 : 9.8), z: z + (flat ? 9.8 : 0) },
      rotationRate
    }, now)
  }
  const repeat = (n, z = 0, x = 0, y = 0) => Array.from({ length: n }, () => sample(z, x, y))
  repeat(40)
  return { sensor, sample, repeat, time: () => now }
}
test('forward thrust then braking mines and rest promptly releases it', () => {
  for (const fallback of [false, true]) {
    const h = harness(fallback)
    assert.ok(h.repeat(6, -4).every(active => !active))
    assert.ok(h.repeat(4, 4).some(Boolean))
    assert.equal(h.sensor.active(h.time()), true)
    h.repeat(25)
    assert.equal(h.sensor.active(h.time()), false)
    h.repeat(6, -4)
    assert.ok(h.repeat(4, 4).some(Boolean))
    assert.equal(h.sensor.active(h.time() + 251), false)
  }
})
test('stationary noise, sideways shakes, vertical placement and isolated impacts never mine', () => {
  for (const fallback of [false, true]) {
    const h = harness(fallback)
    for (let i = 0; i < 100; i++) assert.equal(h.sample(i % 2 ? 0.3 : -0.3), false)
    for (const axis of ['x', 'y']) {
      assert.ok(h.repeat(6, 0, axis === 'x' ? 5 : 0, axis === 'y' ? 5 : 0).every(v => !v))
      assert.ok(h.repeat(6, 0, axis === 'x' ? -5 : 0, axis === 'y' ? -5 : 0).every(v => !v))
      h.repeat(12)
    }
    assert.equal(h.sample(-15), false)
    assert.ok(h.repeat(4, 15).every(v => !v))
    assert.ok(h.repeat(30).every(v => !v))
    const flat = harness(fallback, true)
    assert.ok(flat.repeat(6, -4).every(v => !v))
    assert.ok(flat.repeat(4, 4).every(v => !v))
  }
})
test('rotation, tracking gaps and invalid sensor data cancel a pending stroke', () => {
  for (const kind of ['rotation', 'gap', 'invalid']) {
    const h = harness()
    h.repeat(6, -4)
    if (kind === 'rotation') h.sample(0, 0, 0, { alpha: 180, beta: 0, gamma: 0 })
    if (kind === 'gap') h.sensor.update({ acceleration: { x: 0, y: 0, z: 4 } }, h.time() + 500)
    if (kind === 'invalid') h.sensor.update({}, h.time() + 1)
    assert.ok(h.repeat(4, 4).every(v => !v))
  }
})

test('repeated forward strokes keep mining continuously through brief pauses', () => {
  for (const fallback of [false, true]) {
    for (const pause of [0, 10]) {
      const h = harness(fallback)
      h.repeat(6, -4)
      h.repeat(4, 4)
      assert.equal(h.sensor.active(h.time()), true)
      for (let stroke = 0; stroke < 8; stroke++) {
        assert.ok(h.repeat(pause).every(Boolean), 'Brief turnaround must not release mining')
        assert.ok(h.repeat(6, -4).every(Boolean), 'Next forward thrust must keep mining held')
        assert.ok(h.repeat(4, 4).every(Boolean), 'Completed stroke must renew the hold')
      }
      h.repeat(30)
      assert.equal(h.sensor.active(h.time()), false, 'Rest must still stop mining')
    }
  }
})

test('gentle forward thrusts mine at the lower default threshold', () => {
  for (const fallback of [false, true]) {
    const h = harness(fallback)
    h.repeat(6, -0.15)
    assert.ok(h.repeat(4, 0.15).some(Boolean))
    h.repeat(30)
    assert.equal(h.sensor.active(h.time()), false)
  }
})

test('small sensor bias does not prevent arming or recognizing a short forward stroke', () => {
  const sensor = new PhoneMining()
  let now = 0
  const sample = z => {
    now += 20
    return sensor.update({ acceleration: { x: 0.05, y: 0.04, z } }, now)
  }
  for (let i = 0; i < 30; i++) assert.equal(sample(0.06), false)
  assert.equal(sensor.ready, true, 'A stationary hand need not be perfectly noise-free')
  for (let i = 0; i < 4; i++) sample(-0.2)
  const braking = [sample(0.2), sample(0.2), sample(0.2)]
  assert.ok(braking.some(Boolean), 'A short forward stroke should register')
  for (let i = 0; i < 25; i++) sample(0.06)
  assert.equal(sensor.active(now), false)
})
