'use strict'
class FaceGestures {
  constructor () { this.reset() }
  reset () { this.smile = false; this.mouth = false; this.smileSince = null; this.mouthSince = null }
  update (categories, now, threshold) {
    if (!categories?.length) { this.reset(); return { use: false, jump: false, score: 0 } }
    const scores = Object.fromEntries(categories.map(c => [c.categoryName, c.score]))
    const smile = Math.min(scores.mouthSmileLeft || 0, scores.mouthSmileRight || 0)
    const mouth = scores.jawOpen || 0
    // Hysteresis plus dwell avoids brief expression noise. Release before the
    // next activation; the input layer emits use only on the rising edge.
    for (const [key, value] of [['smile', smile], ['mouth', mouth]]) {
      if (value < threshold * 0.7) { this[key] = false; this[`${key}Since`] = null }
      else if (value >= threshold) {
        if (this[`${key}Since`] === null) this[`${key}Since`] = now
        if (now - this[`${key}Since`] >= 250) this[key] = true
      } else if (!this[key]) this[`${key}Since`] = null
    }
    return { use: this.smile, jump: this.mouth, score: Math.max(smile, mouth) }
  }
}
module.exports = FaceGestures
