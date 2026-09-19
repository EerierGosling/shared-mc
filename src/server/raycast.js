'use strict'

/**
 * Cursor raycasts, guarded against a non-finite bot position.
 *
 * prismarine-world's RaycastIterator only stops once
 * `Math.min(tMaxX, tMaxY, tMaxZ) > maxDistance`. Comparisons against NaN are
 * always false, so the moment the bot's position goes NaN that test stops
 * firing and `world.raycast` spins forever — one tick wedges the entire server
 * at 100% CPU and it never serves another request. mineflayer's own guard just
 * checks that `entity.position` exists, not that its components are numbers,
 * so it does not catch this.
 */
function hasFinitePosition (bot) {
  const p = bot && bot.entity && bot.entity.position
  return Boolean(p) && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

function blockAtCursor (bot, reach) {
  if (!hasFinitePosition(bot)) return null
  try {
    return bot.blockAtCursor(reach)
  } catch (err) {
    return null
  }
}

function entityAtCursor (bot, reach) {
  if (!hasFinitePosition(bot)) return null
  if (typeof bot.entityAtCursor !== 'function') return null
  try {
    return bot.entityAtCursor(reach)
  } catch (err) {
    return null
  }
}

module.exports = { hasFinitePosition, blockAtCursor, entityAtCursor }
