// prismarine-viewer requires node-canvas in two places. entities.js really does
// run in the browser — it draws username nametags into a texture — so
// createCanvas has to work rather than be stubbed out. atlas.js only ever runs
// server-side (it reads PNGs off disk with fs) and the browser gets the prebuilt
// atlas instead, so its exports only need to resolve.
// The DOM canvas is API-compatible with everything either file actually touches.

function createCanvas (width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

class Canvas {
  constructor (width, height) {
    return createCanvas(width, height)
  }
}

module.exports = { createCanvas, Canvas, Image: globalThis.Image }
