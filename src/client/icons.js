'use strict'
// Item icons for the hotbar and inventory slots.
//
// Flat items — swords, seeds, doors, anything vanilla draws from an item
// texture — come straight from /icons/item/<name>.png. Block items are drawn
// here the way vanilla draws them: the block model under the GUI transform,
// rotated (30°, 225°), orthographic. Under that one fixed view every face of
// an axis-aligned box projects to a parallelogram, and a parallelogram is
// exactly one affine canvas transform — so a block icon is a handful of
// drawImage calls against the same texture atlas the world renderer uses,
// not a third 3D scene.

const { modelForIcon } = require('../shared/blockIcon')

// 16 texture px at GUI scale 3 on a 2x display; slots downscale cleanly.
const SIZE = 96

const COS30 = Math.sqrt(3) / 2
const SIN30 = 0.5
const R = Math.SQRT1_2
// A full cube projects 32R wide and 16·cos30 + 32R·sin30 tall; scale so it
// fills the icon the way vanilla's does.
const SCALE = SIZE / (16 * COS30 + 32 * R * SIN30 + 0.8)
const HALF = SIZE / 2

// Faces the fixed view can see, with vanilla's directional face light. Each
// corner list is [p00, p10, p01]: where the face texture's (0,0), (1,0) and
// (0,1) corners land, matching the mesher's uv convention in
// prismarine-viewer's models.js — the atlas rects in blocksStates already
// have the model's uv window (and any mirroring, as negative su/sv) baked in.
const FACES = {
  up: { shade: 1.0, corners: (f, t) => [[f[0], t[1], f[2]], [t[0], t[1], f[2]], [f[0], t[1], t[2]]] },
  north: { shade: 0.8, corners: (f, t) => [[t[0], t[1], f[2]], [f[0], t[1], f[2]], [t[0], f[1], f[2]]] },
  east: { shade: 0.6, corners: (f, t) => [[t[0], t[1], t[2]], [t[0], t[1], f[2]], [t[0], f[1], t[2]]] }
}

// Faces with a tintindex take a biome colour in-game; icons get the plains
// palette, matching vanilla's fixed GUI tint.
const GRASS_TINT = [145, 189, 89]
const FOLIAGE_TINT = [119, 171, 47]

let kinds = null // item name -> 'flat' | 'block', from the server's index
let states = null // resolved block models, shared with the world renderer
let atlas = null // the world texture atlas
const rendered = new Map() // item name -> data URL
const tiles = new Map() // atlas rect + shade + tint -> shaded scratch canvas

/**
 * `onLoaded` fires as each piece of icon data lands (index, models, atlas).
 * Callers use it to repaint slots that were drawn as text before the data
 * arrived — the hotbar only repaints when its contents change, so it would
 * otherwise show labels until the next pickup.
 */
function init (version, onLoaded) {
  if (kinds || states || atlas) return
  const loaded = () => { if (onLoaded) onLoaded() }
  window.fetch('/icons/index.json')
    .then(res => (res.ok ? res.json() : null))
    .then(json => { kinds = json; loaded() })
    .catch(() => {})
  window.fetch(`/blocksStates/${version}.json`)
    .then(res => (res.ok ? res.json() : null))
    .then(json => { states = json; loaded() })
    .catch(() => {})
  const img = new window.Image()
  img.onload = () => { atlas = img; loaded() }
  img.src = `/textures/${version}.png`
}

/**
 * URL for an item's icon, or null while the icon data is still loading (the
 * hotbar re-renders every state tick, so it heals itself) or for the odd
 * item with no texture anywhere — callers show the item name as text.
 */
function iconFor (name) {
  if (kinds && kinds[name] === 'flat') return `/icons/item/${name}.png`
  const cached = rendered.get(name)
  if (cached) return cached
  if (!states || !atlas) return null
  const model = modelForIcon(states[name])
  if (!model) return null
  const url = render(name, model)
  rendered.set(name, url)
  return url
}

// Rotate 225° about Y, then 30° about X, project orthographically. Depth
// grows toward the camera and only orders faces for the painter loop.
function project (p) {
  const qx = p[0] - 8
  const qy = p[1] - 8
  const qz = p[2] - 8
  const px = -R * (qx + qz)
  const pz = R * (qx - qz)
  return {
    x: HALF + SCALE * px,
    y: HALF - SCALE * (qy * COS30 - pz * SIN30),
    depth: qy * SIN30 + pz * COS30
  }
}

function render (name, model) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false

  const faces = []
  model.elements.forEach((element, order) => {
    for (const dir of Object.keys(FACES)) {
      const face = element.faces && element.faces[dir]
      if (!face || !face.texture) continue
      const quad = FACES[dir].corners(element.from, element.to).map(project)
      faces.push({
        order,
        // Depth of the face centre; for a parallelogram that is the mean of
        // the two corners across the diagonal from each other.
        depth: (quad[1].depth + quad[2].depth) / 2,
        quad,
        texture: face.texture,
        rotation: face.rotation || 0,
        shade: FACES[dir].shade,
        tint: face.tintindex !== undefined
          ? (name.includes('leaves') ? FOLIAGE_TINT : GRASS_TINT)
          : null
      })
    }
  })

  // Painter's algorithm, back to front. The order tiebreak keeps coplanar
  // overlays (grass block sides) above their base face.
  faces.sort((a, b) => (a.depth - b.depth) || (a.order - b.order))
  for (const face of faces) drawFace(ctx, face)
  return canvas.toDataURL()
}

function drawFace (ctx, face) {
  const t = face.texture
  const sw = Math.max(1, Math.round(Math.abs(t.su) * atlas.width))
  const sh = Math.max(1, Math.round(Math.abs(t.sv) * atlas.height))
  const tile = shadedTile(t, sw, sh, face.shade, face.tint)

  let [p00, p10, p01] = face.quad
  // p11 completes the parallelogram; a uv rotation walks the corner cycle.
  let p11 = { x: p10.x + p01.x - p00.x, y: p10.y + p01.y - p00.y }
  let cycle = [p00, p10, p11, p01]
  for (let turns = face.rotation / 90; turns > 0; turns--) {
    cycle = [cycle[1], cycle[2], cycle[3], cycle[0]]
  }
  ;[p00, p10, p11, p01] = cycle

  ctx.setTransform(
    (p10.x - p00.x) / sw, (p10.y - p00.y) / sw,
    (p01.x - p00.x) / sh, (p01.y - p00.y) / sh,
    p00.x, p00.y
  )
  ctx.drawImage(tile, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

/**
 * The face's atlas rect as its own little canvas, unmirrored, darkened by
 * the face light and tinted where the model asks. Doing this on a scratch
 * canvas (multiply, then destination-in to restore alpha) keeps transparent
 * texels transparent and never bleeds shading onto already-drawn faces.
 */
function shadedTile (t, sw, sh, shade, tint) {
  const key = `${t.u},${t.v},${t.su},${t.sv},${shade},${tint || ''}`
  const cached = tiles.get(key)
  if (cached) return cached

  const sx = Math.round((t.su < 0 ? t.u + t.su : t.u) * atlas.width)
  const sy = Math.round((t.sv < 0 ? t.v + t.sv : t.v) * atlas.height)
  const tile = document.createElement('canvas')
  tile.width = sw
  tile.height = sh
  const g = tile.getContext('2d')
  g.imageSmoothingEnabled = false
  const blit = () => {
    g.save()
    g.translate(t.su < 0 ? sw : 0, t.sv < 0 ? sh : 0)
    g.scale(t.su < 0 ? -1 : 1, t.sv < 0 ? -1 : 1)
    g.drawImage(atlas, sx, sy, sw, sh, 0, 0, sw, sh)
    g.restore()
  }
  blit()

  const [r, gr, b] = tint || [255, 255, 255]
  if (shade < 1 || tint) {
    g.globalCompositeOperation = 'multiply'
    g.fillStyle = `rgb(${Math.round(r * shade)}, ${Math.round(gr * shade)}, ${Math.round(b * shade)})`
    g.fillRect(0, 0, sw, sh)
    g.globalCompositeOperation = 'destination-in'
    blit()
    g.globalCompositeOperation = 'source-over'
  }

  tiles.set(key, tile)
  return tile
}

/**
 * A block's resolved blocksStates entry, or null until the models load. The
 * particle system reads each block's `particle` texture rect from here rather
 * than fetching the 10 MB models file a second time.
 */
function blockState (name) {
  return (states && states[name]) || null
}

module.exports = { init, iconFor, blockState, itemAssets: () => ({ kinds, atlas }) }
