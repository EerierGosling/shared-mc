'use strict'
const { DEFAULTS } = require('./motion-settings')
const valid = a => a && [a.x, a.y, a.z].every(Number.isFinite)
class PhoneMining {
  constructor () { this.reset() }
  reset () {
    this.digUntil = 0
    this.lastSample = -Infinity
    this.gravity = null
    this.gravitySince = null
    this.strength = 0
    this.quietSince = null
    this.ready = false
    this.stroke = null
  }
  update (event, now, threshold = DEFAULTS.phoneThreshold, hold = DEFAULTS.digHold) {
    const gap = now - this.lastSample
    if (gap > 250 || gap <= 0) this.reset()
    const dt = Math.min(100, Math.max(0, gap))
    let a = event.acceleration
    const raw = event.accelerationIncludingGravity
    const fallback = !valid(a)
    if (valid(raw)) {
      const values = [raw.x, raw.y, raw.z]
      if (!this.gravity) { this.gravity = values.slice(); this.gravitySince = now }
      const blend = 1 - Math.exp(-dt / 500)
      this.gravity = this.gravity.map((g, i) => g + blend * (values[i] - g))
      if (fallback) a = { x: raw.x - this.gravity[0], y: raw.y - this.gravity[1], z: raw.z - this.gravity[2] }
    }
    if (!valid(a)) { this.reset(); return false }
    this.lastSample = now
    this.strength = Math.max(0, -a.z)
    const flat = this.gravity && Math.abs(this.gravity[2]) > Math.hypot(...this.gravity) * 0.8
    const turning = event.rotationRate && Object.values(event.rotationRate).some(value => Number.isFinite(value) && Math.abs(value) > 120)
    if (flat || turning || (fallback && now - this.gravitySince < 500)) {
      this.digUntil = 0; this.stroke = null; this.ready = false; this.quietSince = null
      return false
    }
    const magnitude = Math.hypot(a.x, a.y, a.z)
    if (magnitude < threshold * 0.45) {
      if (this.quietSince === null) this.quietSince = now
      if (now - this.quietSince >= 150) {
        this.stroke = null
        this.ready = true
      }
      // Bridge the brief pause between strokes instead of releasing mining
      // at every turnaround. A sustained rest still ends the action.
      if (now - this.quietSince >= 350) this.digUntil = 0
    } else this.quietSince = null

    // Hold the screen facing you. A forward thrust is negative screen-normal
    // acceleration, followed by a positive braking pulse. Sideways movement,
    // isolated impacts and merely turning the phone are not mining strokes.
    const axial = Math.abs(a.z) > Math.hypot(a.x, a.y) * 1.5
    if (this.stroke && now - this.stroke.started > 600) this.stroke = null
    if (this.ready && axial && a.z < -threshold) {
      this.stroke = { started: now, forward: 0, brakeSince: null }
      this.ready = false
    }
    if (this.stroke) {
      if (axial && a.z < -threshold) this.stroke.forward = now - this.stroke.started
      else if (axial && a.z > threshold * 0.6 && this.stroke.forward >= 70) {
        if (this.stroke.brakeSince === null) this.stroke.brakeSince = now
        if (now - this.stroke.brakeSince >= 40) {
          this.digUntil = now + hold
          this.stroke = null
          // A completed stroke arms the next one without requiring a rest.
          this.ready = true
        }
      } else if (magnitude >= threshold) this.stroke = null
    }
    return this.active(now)
  }
  active (now) { return now < this.digUntil && now - this.lastSample < 250 }
}
module.exports = PhoneMining
