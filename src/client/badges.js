'use strict'

// The three ways a name gets onto the server, as one glyph each. Used by the
// join screen's mode rows and by the player list's badges, so the vocabulary
// is the same from the first screen to the last.
//
// The two web modes are pixel art drawn here rather than sprites: vanilla has
// no "several people" or "one person" icon, and a borrowed heart or drumstick
// said nothing about who was behind the name. Real players get the dirt block
// out of minecraft-assets, the one thing on the list that is unmistakably
// Minecraft itself. Everything is 10 texels square and sized in --u by CSS.

const FRONT = '#ffffff'
const BACK = '#9aa5b1'

// Several people, the front one whole and two behind: collaborative mode.
const GROUP = [
  '.BB....BB.',
  '.BB.FF.BB.',
  '....FF....',
  'BBBB..BBBB',
  'BBBFFFFBBB',
  'BBFFFFFFBB',
  'BBFFFFFFBB',
  '..FFFFFF..',
  '..FFFFFF..',
  '..........'
]

// One person: solo mode.
const PERSON = [
  '..........',
  '....FF....',
  '...FFFF...',
  '...FFFF...',
  '....FF....',
  '..FFFFFF..',
  '.FFFFFFFF.',
  '.FFFFFFFF.',
  '.FFFFFFFF.',
  '..........'
]

const TITLES = {
  roadtrip: 'collaborative: everyone driving the shared character',
  solo: 'solo: their own character, from this page',
  player: 'a Minecraft player'
}

function pixelSvg (rows, label) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 10 10')
  svg.setAttribute('shape-rendering', 'crispEdges')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]
      if (ch === '.') continue
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', x)
      rect.setAttribute('y', y)
      rect.setAttribute('width', 1)
      rect.setAttribute('height', 1)
      rect.setAttribute('fill', ch === 'F' ? FRONT : BACK)
      svg.appendChild(rect)
    }
  })
  return svg
}

/** An element for `mode`: 'roadtrip' | 'solo' | 'player'. */
function modeBadge (mode) {
  const wrap = document.createElement('i')
  wrap.className = 'badge'
  wrap.dataset.mode = mode
  wrap.title = TITLES[mode] || ''
  if (mode === 'player') {
    const img = document.createElement('img')
    img.src = '/assets/blocks/dirt.png'
    img.alt = TITLES.player
    img.draggable = false
    wrap.appendChild(img)
  } else {
    wrap.appendChild(pixelSvg(mode === 'roadtrip' ? GROUP : PERSON, TITLES[mode] || mode))
  }
  return wrap
}

module.exports = { modeBadge }
