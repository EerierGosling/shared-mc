'use strict'
// webpack loader applied to prismarine-viewer/viewer/lib/models.js only.
//
// Upstream skips model lookup with `block.name.includes('air')`, meant for
// air / cave_air / void_air. 'stairs' contains 'air', so all 56 stairs blocks
// mesh as nothing: a staircase the bot climbs, and collides with, is invisible.
// One token in a 500-line file is not worth a full copy, so the line is
// rewritten at build time. If the bump ever changes that line this throws and
// the build fails, rather than silently reverting to invisible stairs.
const FROM = "if (block.name.includes('air')) return []"
const TO = "if (block.name === 'air' || block.name.endsWith('_air')) return []"

module.exports = function (source) {
  if (!source.includes(FROM)) {
    throw new Error(`models-loader: upstream air check not found in ${this.resourcePath}; re-check the patch against this prismarine-viewer version`)
  }
  return source.replace(FROM, TO)
}
