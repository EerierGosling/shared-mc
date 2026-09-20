'use strict'
const Vec3 = require('vec3')

// FACE_VECTORS and INTERACTABLE mirror control.js — the prediction is only
// right while it gates the same way use() does, so a change there must land
// here too.
//
// prismarine's raycast reports the hit face as an index; placing a block needs
// the matching normal vector.
const FACE_VECTORS = [
  new Vec3(0, -1, 0),
  new Vec3(0, 1, 0),
  new Vec3(0, 0, -1),
  new Vec3(0, 0, 1),
  new Vec3(-1, 0, 0),
  new Vec3(1, 0, 0)
]

const INTERACTABLE = /chest|furnace|crafting_table|barrel|shulker_box|hopper|dispenser|dropper|anvil|enchanting_table|brewing_stand|beacon|lectern|loom|smoker|blast_furnace|cartography|grindstone|stonecutter|door|trapdoor|fence_gate|button|lever|bed$|note_block|jukebox|comparator|repeater|sign$/

function isPlaceable (bot, item) {
  const registry = bot.registry || bot.mcData
  if (!registry || !registry.blocksByName) return false
  return Boolean(registry.blocksByName[item.name])
}

// Vanilla rejects a placement whose collision box would overlap the player;
// predicting one anyway would flash a ghost block into the camera on every
// click at your own feet.
function intersectsBot (bot, pos) {
  const p = bot.entity.position
  return pos.x + 1 > p.x - 0.3 && pos.x < p.x + 0.3 &&
    pos.z + 1 > p.z - 0.3 && pos.z < p.z + 0.3 &&
    pos.y + 1 > p.y && pos.y < p.y + 1.8
}

/**
 * What a right-click on `block` would place, computed ahead of the click so
 * the browser can draw the result immediately instead of waiting for the
 * round trip through the Minecraft server (see client/place.js).
 *
 * Conservative on purpose: any case where the outcome is uncertain —
 * interactables open instead of accepting a block, the destination is
 * occupied, the block would clip the bot — predicts nothing, and the click
 * just waits for the authoritative update like before. A wrong guess costs a
 * visible flicker; a missing one only costs the old latency.
 */
function predictPlacement (bot, block) {
  const held = bot.heldItem
  if (!held || !isPlaceable(bot, held)) return null
  // use() opens these rather than placing (except while sneaking, which this
  // deliberately ignores — no prediction beats a wrong one).
  if (INTERACTABLE.test(block.name)) return null
  const face = FACE_VECTORS[block.face]
  if (!face) return null
  const pos = block.position.plus(face)
  const dest = bot.blockAt(pos)
  if (!dest || dest.boundingBox !== 'empty') return null
  if (intersectsBot(bot, pos)) return null
  const placed = (bot.registry || bot.mcData).blocksByName[held.name]
  // defaultState knows nothing about placement context, so stairs and logs
  // appear in their default orientation until the real update lands.
  const stateId = placed.defaultState != null ? placed.defaultState : placed.minStateId
  if (!Number.isInteger(stateId)) return null
  return {
    position: { x: pos.x, y: pos.y, z: pos.z },
    stateId,
    // what the client puts back if the server never answers
    revertStateId: Number.isInteger(dest.stateId) ? dest.stateId : 0
  }
}

module.exports = { FACE_VECTORS, INTERACTABLE, isPlaceable, predictPlacement }
