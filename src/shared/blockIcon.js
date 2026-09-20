'use strict'

// Both ends of the item-icon pipeline need to agree on which blocks can be
// drawn as a little 3D model: the server classifies every item once at boot
// (src/server/icons.js), the browser renders the survivors (src/client/icons.js).
// This is the shared judgement call, fed a block's entry from the viewer's
// resolved blocksStates JSON.

// The icon renderer draws the model exactly as stored, without applying
// variant x/y rotations, so prefer the state a player would call "the normal
// one": bottom straight stairs, an upright log, an unpowered lever.
const PREFERRED = {
  'shape=straight': 4,
  'axis=y': 3,
  'half=bottom': 2,
  'type=bottom': 2,
  'snowy=false': 1,
  'open=false': 1,
  'powered=false': 1,
  'lit=false': 1,
  'extended=false': 1
}

function pickVariant (variants) {
  let best = null
  let bestScore = -1
  for (const key of Object.keys(variants)) {
    let entry = variants[key]
    if (Array.isArray(entry)) entry = entry[0]
    let score = 0
    for (const pair of key.split(',')) score += PREFERRED[pair] || 0
    // An entry without x/y rotation is the model's canonical pose.
    if (entry && !entry.x && !entry.y) score += 2
    if (score > bestScore) {
      bestScore = score
      best = entry
    }
  }
  return best
}

/**
 * The model to draw for a block's inventory icon, or null when the item
 * should fall back to a flat texture: no geometry (chests and other
 * entity-rendered blocks) or a cross model (flowers, saplings — vanilla
 * draws those flat too).
 */
function modelForIcon (state) {
  if (!state) return null
  let entry = null
  if (state.variants) {
    entry = pickVariant(state.variants)
  } else if (state.multipart) {
    // The parts that always apply are the block's core — a fence's post; the
    // conditional ones grow toward neighbours and make no sense in an icon.
    const always = state.multipart.filter(part => !part.when)
    const part = always[0] || state.multipart[0]
    entry = part && part.apply
  }
  if (Array.isArray(entry)) entry = entry[0]
  const model = entry && entry.model
  if (!model || !model.elements || !model.elements.length) return null
  // A 45° element rotation marks a cross model. The renderer ignores element
  // rotation, which is harmless everywhere else but would squash these.
  if (model.elements.some(e => e.rotation && Math.abs(e.rotation.angle) === 45)) return null
  return model
}

module.exports = { modelForIcon }
