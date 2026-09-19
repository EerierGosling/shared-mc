'use strict'

const THREE = global.THREE || require('three')

// prismarine-viewer hardcodes scene.background to 'lightblue' and never touches
// it again (viewer.js). bot.time.timeOfDay runs 0-24000 per Minecraft day
// (0 = sunrise, 6000 = noon, 12000 = sunset, 18000 = midnight), so we drive the
// sky/lighting off that ourselves. Keyframes below get lerped between.
const DAY_LENGTH = 24000

const KEYFRAMES = [
  { t: 0, sky: 0xfcb46b, ambient: 0.55, sun: 0.55, sunColor: 0xffd9a0 },
  { t: 2000, sky: 0x8ecae6, ambient: 0.85, sun: 0.85, sunColor: 0xffffff },
  { t: 6000, sky: 0x87ceeb, ambient: 0.9, sun: 0.9, sunColor: 0xffffff },
  { t: 10000, sky: 0x8ecae6, ambient: 0.85, sun: 0.85, sunColor: 0xffffff },
  { t: 12000, sky: 0xfb8b5b, ambient: 0.5, sun: 0.5, sunColor: 0xffab66 },
  { t: 13000, sky: 0x1b1f3b, ambient: 0.2, sun: 0.08, sunColor: 0x4a5a8a },
  { t: 18000, sky: 0x05060f, ambient: 0.12, sun: 0.02, sunColor: 0x223355 },
  { t: 22000, sky: 0x1b1f3b, ambient: 0.2, sun: 0.08, sunColor: 0x4a5a8a },
  { t: DAY_LENGTH, sky: 0xfcb46b, ambient: 0.55, sun: 0.55, sunColor: 0xffd9a0 }
]

function findSegment (t) {
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    if (t >= KEYFRAMES[i].t && t <= KEYFRAMES[i + 1].t) return [KEYFRAMES[i], KEYFRAMES[i + 1]]
  }
  return [KEYFRAMES[0], KEYFRAMES[1]]
}

function applySkyForTime (viewer, timeOfDay) {
  const t = ((timeOfDay % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH
  const [from, to] = findSegment(t)
  const span = to.t - from.t
  const frac = span === 0 ? 0 : (t - from.t) / span

  const sky = new THREE.Color(from.sky).lerp(new THREE.Color(to.sky), frac)
  const sun = new THREE.Color(from.sunColor).lerp(new THREE.Color(to.sunColor), frac)

  viewer.scene.background = sky
  viewer.ambientLight.intensity = from.ambient + (to.ambient - from.ambient) * frac
  viewer.directionalLight.intensity = from.sun + (to.sun - from.sun) * frac
  viewer.directionalLight.color = sun
}

module.exports = { applySkyForTime }
