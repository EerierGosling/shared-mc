'use strict'
const FIELDS = {
  lookSpeed: ['Look speed', 0.2, 3, 0.1, 1],
  deadzone: ['Head dead zone', 0.02, 0.3, 0.01, 0.08],
  smoothing: ['Head smoothing', 0, 0.9, 0.05, 0.45],
  stepThreshold: ['Knee lift threshold', 0.04, 0.4, 0.01, 0.08],
  swingThreshold: ['Arm speed threshold', 0.5, 6, 0.1, 3.5],
  jumpThreshold: ['Jump height threshold', 0.08, 0.4, 0.01, 0.18],
  walkHold: ['Walking stop delay (ms)', 250, 1000, 50, 650],
  digHold: ['Mining hold (ms)', 250, 1500, 50, 800],
  phoneThreshold: ['Phone mining threshold (m/s²)', 0.1, 2, 0.05, 0.1],
  faceThreshold: ['Smile / mouth threshold', 0.3, 0.95, 0.05, 0.65]
}
const DEFAULTS = Object.fromEntries(Object.entries(FIELDS).map(([key, field]) => [key, field[4]]))
// camera is a facingMode ('user' / 'environment') or a deviceId from
// enumerateDevices(); the latter is only meaningful on the browser that saved it.
Object.assign(DEFAULTS, { autojump: true, invertX: false, invertY: false, facial: false, arm: 'right', camera: 'user' })
function normalize (data = {}) {
  const result = { ...DEFAULTS }
  for (const [key, [, min, max]] of Object.entries(FIELDS)) {
    if (Number.isFinite(data?.[key])) result[key] = Math.min(max, Math.max(min, data[key]))
  }
  for (const key of ['autojump', 'invertX', 'invertY', 'facial']) if (typeof data?.[key] === 'boolean') result[key] = data[key]
  if (data?.arm === 'left') result.arm = 'left'
  if (typeof data?.camera === 'string' && data.camera && data.camera.length <= 128) result.camera = data.camera
  return result
}
function load () {
  try {
    const data = JSON.parse(localStorage.getItem('motion-settings-v1') || '{}')
    // Upgrade unchanged defaults once; preserve individually tuned thresholds.
    if (data && (data.defaultsVersion || 0) < 2) {
      for (const [key, previous] of Object.entries({ stepThreshold: 0.13, swingThreshold: 2.5, phoneThreshold: 3 })) {
        if (data[key] === previous) data[key] = DEFAULTS[key]
      }
    }
    if (data && (data.defaultsVersion || 0) < 3 && data.phoneThreshold === 2) data.phoneThreshold = DEFAULTS.phoneThreshold
    if (data && (data.defaultsVersion || 0) < 4 && data.phoneThreshold === 1.2) data.phoneThreshold = DEFAULTS.phoneThreshold
    const settings = normalize(data)
    save(settings)
    return settings
  } catch { return { ...DEFAULTS } }
}
function save (settings) { try { localStorage.setItem('motion-settings-v1', JSON.stringify({ ...normalize(settings), defaultsVersion: 4 })) } catch {} }
module.exports = { FIELDS, DEFAULTS, normalize, load, save }
