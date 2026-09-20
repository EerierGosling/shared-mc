'use strict'
const FIELDS = {
  lookSpeed: ['Look speed', 0.2, 3, 0.1, 1],
  deadzone: ['Head dead zone', 0.02, 0.3, 0.01, 0.08],
  smoothing: ['Head smoothing', 0, 0.9, 0.05, 0.45],
  stepThreshold: ['Knee lift threshold', 0.04, 0.4, 0.01, 0.13],
  swingThreshold: ['Arm speed threshold', 0.5, 6, 0.1, 2.5],
  jumpThreshold: ['Jump height threshold', 0.08, 0.4, 0.01, 0.18],
  walkHold: ['Walking stop delay (ms)', 250, 1000, 50, 650],
  digHold: ['Mining hold (ms)', 250, 1500, 50, 800],
  phoneThreshold: ['Phone step threshold (m/s²)', 1, 8, 0.1, 3],
  faceThreshold: ['Smile / mouth threshold', 0.3, 0.95, 0.05, 0.65]
}
const DEFAULTS = Object.fromEntries(Object.entries(FIELDS).map(([key, field]) => [key, field[4]]))
Object.assign(DEFAULTS, { autojump: true, invertX: false, invertY: false, facial: false, arm: 'right' })
function normalize (data = {}) {
  const result = { ...DEFAULTS }
  for (const [key, [, min, max]] of Object.entries(FIELDS)) {
    if (Number.isFinite(data?.[key])) result[key] = Math.min(max, Math.max(min, data[key]))
  }
  for (const key of ['autojump', 'invertX', 'invertY', 'facial']) if (typeof data?.[key] === 'boolean') result[key] = data[key]
  if (data?.arm === 'left') result.arm = 'left'
  return result
}
function load () {
  try { return normalize(JSON.parse(localStorage.getItem('motion-settings-v1') || '{}')) } catch { return { ...DEFAULTS } }
}
function save (settings) { try { localStorage.setItem('motion-settings-v1', JSON.stringify(normalize(settings))) } catch {} }
module.exports = { FIELDS, DEFAULTS, normalize, load, save }
