'use strict'
const { normalize } = require('./motion-settings')
const idle = () => ({ forward: false, jump: false, digging: false, use: false, dx: 0, dy: 0 })
// Milliseconds the off-hand must stay raised before a place fires — long enough
// that a hand passing overhead on its way somewhere does not drop a block.
const PLACE_HOLD = 200
const visible = (p, ids) => ids.every(i => p?.[i] && Number.isFinite(p[i].x) && Number.isFinite(p[i].y) && p[i].x >= 0 && p[i].x <= 1 && p[i].y >= 0 && p[i].y <= 1 && (p[i].visibility ?? 1) > 0.6)
const deadzone = (value, threshold) => Math.sign(value) * Math.min(1, Math.max(0, Math.abs(value) - threshold) * 3)
const average = (samples, key) => {
  const values = samples.map(s => s[key]).filter(Number.isFinite)
  return values.length >= 24 ? values.reduce((sum, v) => sum + v, 0) / values.length : null
}

class Gestures {
  constructor (settings) { this.settings = normalize(settings); this.calibrate() }
  configure (settings) { this.settings = normalize(settings); this.resetMotion() }
  calibrate () {
    this.neutral = null
    this.samples = []
    this.lastSampleTime = null
    this.resetMotion()
  }
  resetMotion () {
    this.smoothedX = this.smoothedY = 0
    this.previous = null
    this.swingStart = null
    this.lastLeg = 0
    this.lastStep = -Infinity
    this.walkUntil = this.digUntil = this.jumpUntil = 0
    this.lastSwing = this.lastJump = -Infinity
    this.raiseStart = null
    // Latched true so a hand already raised (e.g. mid arm-to-play gesture) must
    // come back down before the first place; ordinary resting re-arms at once.
    this.placeLatched = true
  }

  // X and Z are normalized by image width; Y by image height. Convert them to
  // the same units before measuring direction, distances, and velocity.
  update (p, now, aspect = 1) {
    aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
    const settings = this.settings
    const shoulders = visible(p, [11, 12])
    const head = shoulders && visible(p, [0])
    const hips = shoulders && visible(p, [23, 24])
    const legs = hips && visible(p, [25, 26, 27, 28])
    const [shoulder, elbow, hand] = settings.arm === 'left' ? [11, 13, 15] : [12, 14, 16]
    const arm = shoulders && visible(p, [elbow, hand])
    // The hand not set for mining signals placing, so a place and a mine can
    // never come from one motion. Only its wrist against its shoulder matters.
    const [offShoulder, offHand] = settings.arm === 'left' ? [12, 16] : [11, 15]
    const offArm = shoulders && visible(p, [offHand])
    const tracking = { head, arm, legs, jumpReady: false }
    const gap = this.lastSampleTime !== null && (now - this.lastSampleTime > 300 || now <= this.lastSampleTime)
    this.lastSampleTime = now
    if (gap) { this.resetMotion(); if (!this.neutral) this.samples = [] }
    if (!shoulders || (!this.neutral && !head)) {
      this.resetMotion()
      if (!this.neutral) this.samples = []
      return { ...idle(), tracking, status: 'Show your face and both shoulders to the camera' }
    }
    const shoulderX = (p[11].x + p[12].x) / 2
    const shoulderY = (p[11].y + p[12].y) / 2
    // Head/arm control must not depend on hips being inside a desktop webcam.
    const upperScale = Math.max(0.05, Math.hypot((p[11].x - p[12].x) * aspect, p[11].y - p[12].y))
    const hipY = hips ? (p[23].y + p[24].y) / 2 : null
    const scale = hips ? Math.max(0.08, Math.abs(hipY - shoulderY)) : upperScale
    const pose = {
      x: head ? (p[0].x - shoulderX) * aspect / upperScale : null,
      y: head ? (p[0].y - shoulderY) / upperScale : null,
      hipY, scale, upperScale, shoulderX, shoulderY,
      leftFoot: legs ? p[27].y : null,
      rightFoot: legs ? p[28].y : null,
      kneeOffset: legs ? (p[25].y - p[26].y) / scale : null,
      footOffset: legs ? (p[27].y - p[28].y) / scale : null
    }
    if (!this.neutral) {
      // Compare with the beginning of the window, not only the previous frame:
      // a slow continuous lean otherwise passes a per-frame stability check.
      const anchor = this.samples[0]
      if (anchor && (Math.abs(pose.x - anchor.x) > 0.12 || Math.abs(pose.y - anchor.y) > 0.12 ||
        Math.hypot((shoulderX - anchor.shoulderX) * aspect, shoulderY - anchor.shoulderY) / upperScale > 0.12 ||
        Math.abs(upperScale / anchor.upperScale - 1) > 0.12)) this.samples = []
      this.samples.push(pose)
      if (this.samples.length >= 30) this.neutral = Object.fromEntries(Object.keys(pose).map(key => [key, average(this.samples, key)]))
      return { ...idle(), tracking, status: `Calibrating ${this.samples.length}/30 — hold a comfortable neutral pose` }
    }
    tracking.jumpReady = this.neutral.hipY !== null && this.neutral.leftFoot !== null && this.neutral.rightFoot !== null
    let lift = 0; let speed = 0; let rise = 0
    if (legs) {
      // A step is one leg riding higher than the other. Read that from both
      // the knees and the ankles and take whichever swings further: a gentle
      // walk in place lifts the thigh only a little, so the knees barely
      // separate, but the raised leg carries its ankle up with it and the foot
      // clears the threshold the knee alone missed. Knee-only detection is why
      // it took a full stomp before — the feet are the more sensitive signal.
      const kneeDiff = (p[25].y - p[26].y) / scale - (this.neutral.kneeOffset || 0)
      const footDiff = (p[27].y - p[28].y) / scale - (this.neutral.footOffset || 0)
      const difference = Math.abs(footDiff) > Math.abs(kneeDiff) ? footDiff : kneeDiff
      lift = Math.abs(difference)
      const leg = lift > settings.stepThreshold ? Math.sign(difference) : 0
      if (leg && leg !== this.lastLeg && now - this.lastStep > 180) {
        if (this.lastLeg && now - this.lastStep < 1200) this.walkUntil = now + settings.walkHold
        this.lastLeg = leg
        this.lastStep = now
      }
      if (tracking.jumpReady) {
        rise = (this.neutral.hipY - hipY) / this.neutral.scale
        const feetRise = Math.min(this.neutral.leftFoot - p[27].y, this.neutral.rightFoot - p[28].y) / this.neutral.scale
        if (feetRise > settings.jumpThreshold * 0.55 && rise > settings.jumpThreshold && Number.isFinite(this.previous?.hipY) && hipY < this.previous.hipY - 0.005 && now - this.lastJump > 900) {
          this.jumpUntil = now + 200
          this.lastJump = now
        }
      }
    } else {
      this.walkUntil = this.jumpUntil = 0
      this.lastLeg = 0
      this.lastStep = -Infinity
    }
    const wrist = arm ? {
      x: (p[hand].x - p[shoulder].x) * aspect / upperScale,
      y: (p[hand].y - p[shoulder].y) / upperScale,
      z: Number.isFinite(p[hand].z) && Number.isFinite(p[shoulder].z) ? (p[hand].z - p[shoulder].z) * aspect / upperScale : null
    } : null
    const dt = this.previous ? (now - this.previous.time) / 1000 : 0
    if (wrist && this.previous?.wrist && dt > 0 && dt <= 0.3) {
      const old = this.previous.wrist
      const depth = wrist.z !== null && old.z !== null ? wrist.z - old.z : 0
      speed = Math.hypot(wrist.x - old.x, wrist.y - old.y, depth) / dt
      if (speed > settings.swingThreshold) {
        if (!this.swingStart) this.swingStart = { ...old, time: this.previous.time, frames: 0 }
        const start = this.swingStart
        start.frames++
        const displacement = Math.hypot(wrist.x - start.x, wrist.y - start.y, wrist.z !== null && start.z !== null ? wrist.z - start.z : 0)
        // Confirm a sustained movement instead of mining from a single noisy
        // frame. Net displacement rejects a spike that immediately snaps back.
        if (start.frames >= 2 && now - start.time >= 75 && displacement > 0.18 && now - this.lastSwing > 250) {
          this.digUntil = now + settings.digHold
          this.lastSwing = now
          this.swingStart = null
        }
      } else this.swingStart = null
    } else this.swingStart = null
    if (!wrist) this.digUntil = 0
    // Placing: raise the off-hand above the shoulder and hold it a moment. A
    // still, high pose on the arm that never mines, so it cannot be confused
    // for a thrust. One block per raise — it latches when it fires and re-arms
    // only once the hand drops well back down, so a hover cannot repeat-place.
    const offWristY = offArm ? (p[offHand].y - p[offShoulder].y) / upperScale : null
    let placing = false
    if (offWristY !== null && offWristY < -settings.placeThreshold) {
      if (this.raiseStart === null) this.raiseStart = now
      else if (!this.placeLatched && now - this.raiseStart >= PLACE_HOLD) { placing = true; this.placeLatched = true }
    } else {
      this.raiseStart = null
      if (offWristY === null || offWristY > -settings.placeThreshold * 0.6) this.placeLatched = false
    }
    this.previous = { hipY, wrist, time: now }
    const forward = legs && now < this.walkUntil
    const headX = head ? pose.x - this.neutral.x : 0
    const headY = head ? pose.y - this.neutral.y : 0
    const x = -deadzone(headX, settings.deadzone) * (settings.invertX ? -1 : 1)
    const y = deadzone(headY, settings.deadzone) * (settings.invertY ? -1 : 1)
    // Keep the response consistent when inference frame rate changes.
    const smoothing = settings.smoothing ** (Math.max(0.02, dt || 0.065) / 0.065)
    this.smoothedX = x === 0 ? 0 : this.smoothedX * smoothing + x * (1 - smoothing)
    this.smoothedY = y === 0 ? 0 : this.smoothedY * smoothing + y * (1 - smoothing)
    return {
      metrics: { headX, headY, lift, speed, rise, place: offWristY !== null ? -offWristY : 0 }, tracking,
      tracked: true, forward,
      jump: (forward && settings.autojump) || now < this.jumpUntil,
      digging: now < this.digUntil,
      use: placing,
      dx: this.smoothedX || 0, dy: this.smoothedY || 0,
      status: !legs ? 'Upper-body tracking — show legs for walking/jumping' : !tracking.jumpReady ? 'Tracking — recalibrate with feet visible for physical jumps' : 'Tracking — walk in place to move'
    }
  }
}
module.exports = { Gestures, idle, visible }
