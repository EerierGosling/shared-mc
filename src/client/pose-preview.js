'use strict'
const { visible } = require('./gestures')
const CONNECTIONS = [[0, 2], [0, 5], [2, 7], [5, 8], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]]
module.exports = function posePreview (canvas) {
  const ctx = canvas.getContext('2d')
  const clear = () => ctx.clearRect(0, 0, canvas.width, canvas.height)
  return {
    clear,
    draw (points, width, height) {
      canvas.width = width || 640
      canvas.height = height || 480
      clear()
      if (!points) return
      ctx.lineWidth = Math.max(2, canvas.width / 250)
      ctx.strokeStyle = '#85ff83'
      for (const [a, b] of CONNECTIONS) {
        if (!visible(points, [a, b])) continue
        ctx.beginPath()
        ctx.moveTo(points[a].x * canvas.width, points[a].y * canvas.height)
        ctx.lineTo(points[b].x * canvas.width, points[b].y * canvas.height)
        ctx.stroke()
      }
      for (let i = 0; i < points.length; i++) {
        if (!visible(points, [i])) continue
        ctx.fillStyle = i === 16 ? '#ffd75e' : '#85ff83'
        ctx.beginPath()
        ctx.arc(points[i].x * canvas.width, points[i].y * canvas.height, canvas.width / 125, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}
