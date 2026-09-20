'use strict'
const { visible } = require('./gestures')

// A deliberate two-hand pose works with the existing body tracker.
class StartGesture {
  constructor () { this.reset() }
  reset () { this.since = null; this.last = null; this.progress = 0 }
  update (points, now, ready) {
    const gap = this.last !== null && (now <= this.last || now - this.last > 300)
    const raised = ready && visible(points, [0, 11, 12, 15, 16]) &&
      points[15].y < points[0].y - 0.05 && points[16].y < points[0].y - 0.05
    if (!raised || gap) this.reset()
    this.last = now
    if (!raised) return false
    if (this.since === null) this.since = now
    this.progress = Math.min(1, (now - this.since) / 1000)
    return this.progress === 1
  }
}
module.exports = StartGesture
