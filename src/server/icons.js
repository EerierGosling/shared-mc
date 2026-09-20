'use strict'
const fs = require('fs')
const path = require('path')
const { modelForIcon } = require('../shared/blockIcon')

// Item icons for the hotbar and inventory overlay. minecraft-assets' texture
// folders are incomplete (1.20.2 ships no stone.png), which is why guessing
// /assets/<items|blocks>/<name>.png used to leave half the slots as text.
// The viewer's asset set — the same one the atlas is served from — carries
// items_textures.json (is this item drawn from an item texture or a block
// model?) and texture_content.json (a 16x16 PNG for every item name), which
// together cover everything.
//
// Each item is classified once at boot:
//   'flat'  — served from /icons/item/<name>.png, decoded out of
//             texture_content.json
//   'block' — the browser draws the block model itself from blocksStates and
//             the atlas (src/client/icons.js)

// Vanilla draws these flat even though their textures live under block/ —
// the choice is made by item model JSONs that no dependency of ours ships,
// so it has to be a list. Cross models (flowers, saplings) are caught by
// shape in modelForIcon instead.
const FLAT_BLOCK_ITEMS = /(^|_)(torch|rail)$|_pane$|_coral_fan$|^(ladder|iron_bars|vine|glow_lichen|sculk_vein|lily_pad|frogspawn)$/

function build (viewerPublic, assetVersion) {
  const assetDir = path.join(viewerPublic, 'textures', assetVersion)
  const itemsTextures = JSON.parse(fs.readFileSync(path.join(assetDir, 'items_textures.json'), 'utf8'))
  const textureContent = JSON.parse(fs.readFileSync(path.join(assetDir, 'texture_content.json'), 'utf8'))
  const blocksStates = JSON.parse(fs.readFileSync(path.join(viewerPublic, 'blocksStates', `${assetVersion}.json`), 'utf8'))

  const pngs = new Map()
  for (const { name, texture } of textureContent) {
    if (!texture) continue
    const comma = texture.indexOf(',')
    if (comma !== -1) pngs.set(name, Buffer.from(texture.slice(comma + 1), 'base64'))
  }

  const index = {}
  for (const { name, texture } of itemsTextures) {
    if (!texture) continue
    const hasModel = !!modelForIcon(blocksStates[name])
    const wantsFlat = /^(minecraft:)?items?\//.test(texture) || FLAT_BLOCK_ITEMS.test(name) || !hasModel
    if (wantsFlat && pngs.has(name)) index[name] = 'flat'
    else if (hasModel) index[name] = 'block'
  }
  return { index, pngs }
}

module.exports = function serveIcons (app, viewerPublic, assetVersion) {
  let data
  try {
    data = build(viewerPublic, assetVersion)
  } catch (err) {
    console.warn(`item icons unavailable (${err.message}); slots fall back to text labels`)
    return
  }

  const indexJson = JSON.stringify(data.index)
  app.get('/icons/index.json', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('json').send(indexJson)
  })
  app.get('/icons/item/:file', (req, res) => {
    const png = data.pngs.get(req.params.file.replace(/\.png$/, ''))
    if (!png) return res.status(404).end()
    res.set('Cache-Control', 'public, max-age=86400').type('png').send(png)
  })
}
