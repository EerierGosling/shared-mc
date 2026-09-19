'use strict'

/**
 * The player skins a visitor can pick from.
 *
 * These are Mojang's own default skins, which minecraft-assets already ships
 * and index.js already serves under /assets — so the picker needs no uploads,
 * no external fetches and no moderation of what people supply.
 *
 * The Minecraft server itself is in offline mode and will not show any of
 * this: skins here are applied by our own renderer to the player entity, so
 * they are what other *visitors* see, not what a vanilla client sees.
 */
const SKINS = [
  'steve', 'alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'sunny', 'zuri'
]

// 'wide' is the classic Steve proportion, 'slim' the Alex one. Mojang ships
// every skin in both; we only offer wide so the entity model always matches.
const SKIN_VARIANT = 'wide'

function skinUrl (skin) {
  const safe = SKINS.includes(skin) ? skin : SKINS[0]
  return `/assets/entity/player/${SKIN_VARIANT}/${safe}.png`
}

module.exports = { SKINS, SKIN_VARIANT, skinUrl }
