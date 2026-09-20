'use strict'
const { Vec3 } = require('vec3')

// How long a predicted block survives with no word from the server at that
// position. Long enough for click → bot → Minecraft tick → block_change on a
// bad day; short enough that a rejected placement doesn't leave a ghost block
// standing around.
const REVERT_MS = 1500

/**
 * Optimistic block placement. The state snapshot tells us ahead of time what a
 * right-click would place and where (placeTarget, computed server-side by
 * placement.js); on click that block is written into the local world
 * immediately instead of waiting for the round trip through the Minecraft
 * server. The authoritative blockUpdate that follows either matches the guess
 * (re-mesh, no visible change) or corrects it — and if nothing comes back at
 * all, the guess is reverted.
 */
class PlacePrediction {
  constructor (viewer, socket) {
    this.viewer = viewer
    this.target = null
    this.pending = new Map() // "x,y,z" -> { revertStateId, timer }
    // Any authoritative update at a predicted position supersedes the guess.
    // The viewer applies it through its own listener; this one only has to
    // stop the revert timer.
    socket.on('blockUpdate', ({ pos }) => this._settle(pos))
    // A refused budget means the server never attempted the placement, so no
    // blockUpdate is coming — take the ghost down now, not at the timeout.
    socket.on('action:refused', ({ kind }) => {
      if (kind === 'place') this.revertAll()
    })
    // A reconnecting bot replays the whole world; stale reverts fired into the
    // fresh copy would punch holes in it.
    socket.on('version', () => this.revertAll(false))
  }

  setTarget (target) {
    this.target = target || null
  }

  place () {
    const target = this.target
    if (!target) return
    const { x, y, z } = target.position
    const key = `${x},${y},${z}`
    // Click spam on one spot: the first guess is already drawn and pending.
    if (this.pending.has(key)) return
    this.viewer.setBlockStateId(new Vec3(x, y, z), target.stateId)
    const entry = {
      revertStateId: target.revertStateId,
      timer: setTimeout(() => this._revert(key), REVERT_MS)
    }
    this.pending.set(key, entry)
  }

  _settle (pos) {
    const entry = this.pending.get(`${pos.x},${pos.y},${pos.z}`)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(`${pos.x},${pos.y},${pos.z}`)
  }

  _revert (key) {
    const entry = this.pending.get(key)
    if (!entry) return
    this.pending.delete(key)
    const [x, y, z] = key.split(',').map(Number)
    this.viewer.setBlockStateId(new Vec3(x, y, z), entry.revertStateId)
  }

  revertAll (draw = true) {
    for (const key of [...this.pending.keys()]) {
      if (draw) this._revert(key)
      else {
        clearTimeout(this.pending.get(key).timer)
        this.pending.delete(key)
      }
    }
  }
}

module.exports = PlacePrediction
