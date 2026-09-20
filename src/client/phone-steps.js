'use strict'
const { DEFAULTS } = require('./motion-settings')
class PhoneSteps {
  constructor () { this.reset() }
  reset () {
    this.lastLow = -Infinity
    this.lastPeak = -Infinity
    this.walkUntil = 0
    this.lastSample = -Infinity
    this.gravity = null
    this.strength = 0
  }
  update (event, now, threshold = DEFAULTS.phoneThreshold, hold = DEFAULTS.walkHold) {
    let a = event.acceleration
    if (!a || ![a.x, a.y, a.z].every(Number.isFinite)) {
      a = event.accelerationIncludingGravity
      if (!a || ![a.x, a.y, a.z].every(Number.isFinite)) return false
      const values = [a.x, a.y, a.z]
      if (!this.gravity) this.gravity = values.slice()
      const linear = values.map((value, i) => {
        this.gravity[i] = this.gravity[i] * 0.9 + value * 0.1
        return value - this.gravity[i]
      })
      a = { x: linear[0], y: linear[1], z: linear[2] }
    }
    this.lastSample = now
    this.strength = Math.hypot(a.x, a.y, a.z)
    if (this.strength < threshold * 0.5) this.lastLow = now
    if (this.strength > threshold && now - this.lastLow < 250 && now - this.lastPeak > 250) {
      if (now - this.lastPeak < 1200) this.walkUntil = now + hold
      this.lastPeak = now
      this.lastLow = -Infinity
    }
    return this.active(now)
  }
  active (now) { return now < this.walkUntil && now - this.lastSample < 300 }
}
module.exports = PhoneSteps
