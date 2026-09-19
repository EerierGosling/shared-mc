'use strict'

/** Minimal, JSON-safe description of an inventory item. */
function describeItem (item) {
  if (!item) return null
  return {
    name: item.name,
    displayName: item.displayName,
    count: item.count,
    slot: item.slot,
    durabilityUsed: item.durabilityUsed || 0,
    maxDurability: item.maxDurability || 0
  }
}

module.exports = { describeItem }
