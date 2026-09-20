'use strict'

// Per-browser input tuning: aim sensitivity and the timing of the actions that
// used to be hardcoded constants in input.js. Saved in localStorage so a
// visitor's feel follows them across joins, the way motion-settings.js does for
// the camera controls.

// Radians turned per pixel at 100%: exactly the values input.js shipped with
// before any of this was adjustable, so a fresh profile aims as it always did.
const BASE_MOUSE = 0.004
const BASE_TOUCH = 0.006
// The input speed (pixels moved in one pointer event) at which acceleration
// reaches its full multiplier. Past it the curve is flat, so a hard flick
// amplifies by (1 + acceleration) and no further — it cannot run away.
const ACCEL_REF = 40

// [label, min, max, step, default, unit]. Order is the order they render.
const FIELDS = {
  mouseSensitivity: ['Mouse sensitivity', 10, 300, 5, 100, '%'],
  touchSensitivity: ['Touch sensitivity', 10, 300, 5, 100, '%'],
  acceleration: ['Mouse acceleration', 0, 3, 0.05, 0],
  curve: ['Acceleration curve', 0.5, 4, 0.1, 1.6],
  placeRepeat: ['Place repeat (ms)', 60, 500, 10, 200],
  doubleTap: ['Double-tap window (ms)', 150, 500, 10, 300]
}
const DEFAULTS = Object.fromEntries(Object.entries(FIELDS).map(([key, field]) => [key, field[4]]))
Object.assign(DEFAULTS, { invertX: false, invertY: false, invertScroll: false })

function normalize (data = {}) {
  const result = { ...DEFAULTS }
  for (const [key, [, min, max]] of Object.entries(FIELDS)) {
    if (Number.isFinite(data?.[key])) result[key] = Math.min(max, Math.max(min, data[key]))
  }
  for (const key of ['invertX', 'invertY', 'invertScroll']) {
    if (typeof data?.[key] === 'boolean') result[key] = data[key]
  }
  return result
}

/**
 * The one place the aim response curve is defined, shared by the live look in
 * input.js and the graph that previews it, so what you drag is exactly what
 * you get. `speed` is the magnitude of a pointer event in pixels; `base` is the
 * radians-per-pixel the caller wants at rest (mouse or touch, already scaled by
 * its sensitivity percentage). Returns the radians-per-pixel to apply now.
 *
 * With acceleration at 0 this is a flat `base`, i.e. the linear feel this
 * project always had. Above 0 the multiplier ramps from 1 to (1 + acceleration)
 * as the flick speed climbs to ACCEL_REF, shaped by the curve exponent.
 */
function lookScale (speed, { acceleration, curve }, base) {
  if (!acceleration) return base
  const t = Math.min(1, speed / ACCEL_REF)
  return base * (1 + acceleration * Math.pow(t, curve))
}

function load () {
  try {
    const settings = normalize(JSON.parse(localStorage.getItem('control-settings-v1') || '{}'))
    save(settings)
    return settings
  } catch { return { ...DEFAULTS } }
}
function save (settings) {
  try { localStorage.setItem('control-settings-v1', JSON.stringify(normalize(settings))) } catch {}
}

module.exports = { FIELDS, DEFAULTS, BASE_MOUSE, BASE_TOUCH, ACCEL_REF, normalize, lookScale, load, save }
