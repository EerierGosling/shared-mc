// prismarine-viewer's entities.js requires node-canvas to draw nametag
// sprites. In the browser a real <canvas> does the same job.
module.exports.createCanvas = (width, height) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}
