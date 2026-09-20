'use strict'
const { FIELDS, DEFAULTS, ACCEL_REF, normalize, lookScale, load, save } = require('./control-settings')

// Palette (canvas cannot read the CSS custom properties directly).
const INK = { grid: 'rgba(255,255,255,0.10)', axis: '#aaaaaa', linear: '#777777', curve: '#55ff55', handle: '#ffff55', label: '#aaaaaa' }
const decimals = step => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2)

/**
 * The Controls page of the game menu: the same idea as camera-controls.js one
 * page over. Sliders and toggles for aim and per-action timing, plus a live
 * graph of the mouse response curve you can drag to shape — up for more
 * acceleration, right to sharpen where it ramps. Returns { get, show, hide };
 * get() hands input.js the live settings object so a slider takes effect on the
 * very next mouse move, no round trip and nothing to re-read.
 */
module.exports = function setupSettings ({ mount = document.body, onDone } = {}) {
  const isTouch = window.matchMedia('(pointer: coarse)').matches || /[?&]touch\b/.test(window.location.search)
  let settings = load()

  const panel = document.createElement('section')
  panel.id = 'control-settings'
  panel.hidden = true
  panel.setAttribute('aria-label', 'Control settings')
  panel.innerHTML = `<h2>Controls</h2>
    <small>Fine-tune aim and per-action timing. Saved on this browser.</small>
    <figure class="aim-graph">
      <canvas data-role="graph" aria-label="Mouse aim response curve"></canvas>
      <figcaption>Aim response — drag up for acceleration, right to sharpen the ramp.</figcaption>
    </figure>
    <div data-role="sliders"></div>
    <div class="cs-toggles">
      <label class="mc-button mc-toggle"><input type="checkbox" data-setting="invertX"><span>Invert X</span></label>
      <label class="mc-button mc-toggle"><input type="checkbox" data-setting="invertY"><span>Invert Y</span></label>
      <label class="mc-button mc-toggle"><input type="checkbox" data-setting="invertScroll"><span>Invert scroll</span></label>
    </div>
    <div class="cs-buttons">
      <button type="button" class="mc-button" data-action="defaults">Reset to Defaults</button>
      <button type="button" class="mc-button" data-action="done">Done</button>
    </div>`
  mount.append(panel)
  const $ = selector => panel.querySelector(selector)
  const canvas = $('[data-role=graph]')
  const ctx = canvas.getContext('2d')

  for (const [key, [label, min, max, step]] of Object.entries(FIELDS)) {
    // The touch row is noise on a mouse and the mouse aim rows are noise on a
    // phone, so each side sees only the sensitivity it can actually feel.
    if (key === 'touchSensitivity' && !isTouch) continue
    if ((key === 'mouseSensitivity' || key === 'acceleration' || key === 'curve') && isTouch) continue
    const row = document.createElement('label')
    row.className = 'mc-slider'
    row.innerHTML = `<input type="range" data-setting="${key}" min="${min}" max="${max}" step="${step}"><span>${label}: <output data-output="${key}"></output></span>`
    $('[data-role=sliders]').append(row)
  }
  // The graph only means anything for a mouse; a touch profile keeps the sliders.
  if (isTouch) $('.aim-graph').hidden = true

  const format = key => {
    const [, , , step, , unit] = FIELDS[key]
    return settings[key].toFixed(decimals(step)) + (unit || '')
  }

  // Push readouts and the graph without touching the slider handles, so a live
  // drag is not fought by a value write-back on the same frame.
  const refresh = () => {
    for (const output of panel.querySelectorAll('[data-output]')) output.textContent = format(output.dataset.output)
    draw()
  }
  // Full sync: handle positions, checkbox states, readouts. Used on show, reset
  // and graph-drag, where the inputs really do need to move to match.
  const sync = () => {
    for (const input of panel.querySelectorAll('input[data-setting]')) {
      if (input.type === 'checkbox') input.checked = Boolean(settings[input.dataset.setting])
      else input.value = settings[input.dataset.setting]
    }
    refresh()
  }

  const commit = () => { settings = normalize(settings); save(settings) }

  panel.addEventListener('input', event => {
    const key = event.target.dataset.setting
    if (!key) return
    settings[key] = event.target.type === 'checkbox' ? event.target.checked : Number(event.target.value)
    commit()
    refresh()
  })
  $('[data-action=defaults]').addEventListener('click', () => { settings = { ...DEFAULTS }; commit(); sync() })
  $('[data-action=done]').addEventListener('click', () => onDone?.())

  // --- the graph ------------------------------------------------------------
  // Plots output turn against input speed: a straight diagonal is linear aim,
  // a curve bowing above it is acceleration. The y-axis rescales to the current
  // curve's peak so the shape always fills the box.
  function draw () {
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (!cssW || !cssH) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const pad = 6
    const px = pad
    const py = pad
    const pw = cssW - pad * 2
    const ph = cssH - pad * 2
    const xMax = ACCEL_REF
    const yMax = xMax * (1 + settings.acceleration)
    const sx = v => px + (v / xMax) * pw
    const sy = v => py + ph - (v / yMax) * ph

    ctx.lineWidth = 1
    ctx.strokeStyle = INK.grid
    for (let i = 1; i < 4; i++) {
      const gx = px + (pw * i) / 4
      const gy = py + (ph * i) / 4
      ctx.beginPath(); ctx.moveTo(gx, py); ctx.lineTo(gx, py + ph); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(px, gy); ctx.lineTo(px + pw, gy); ctx.stroke()
    }

    // Linear reference: what aim would do with acceleration off.
    ctx.strokeStyle = INK.linear
    ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(sx(0), sy(0)); ctx.lineTo(sx(xMax), sy(xMax)); ctx.stroke()
    ctx.setLineDash([])

    // The actual response curve. base = 1 so y reads as raw output speed.
    ctx.strokeStyle = INK.curve
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i <= 64; i++) {
      const speed = (xMax * i) / 64
      const out = speed * lookScale(speed, settings, 1)
      const x = sx(speed)
      const y = sy(out)
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
    }
    ctx.stroke()

    // Handle at the fast end, where the multiplier is fully in.
    ctx.fillStyle = INK.handle
    ctx.beginPath()
    ctx.arc(sx(xMax), sy(xMax * (1 + settings.acceleration)), 3, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = INK.label
    ctx.font = '10px monospace'
    ctx.textBaseline = 'bottom'
    ctx.fillText('fast flick →', px + 2, py + ph - 2)
    ctx.textBaseline = 'top'
    ctx.fillText(settings.acceleration ? `×${(1 + settings.acceleration).toFixed(2)}` : 'linear', px + 2, py + 2)
  }

  // Drag to shape the curve: vertical sets acceleration (top = strongest),
  // horizontal sets the curve exponent (right = sharper, later ramp). Both snap
  // to their slider steps so the sliders and the graph never disagree.
  const [, , accelMax, accelStep] = FIELDS.acceleration
  const [, curveMin, curveMax, curveStep] = FIELDS.curve
  const snap = (v, step) => Math.round(v / step) * step
  let dragging = false
  const shape = event => {
    const rect = canvas.getBoundingClientRect()
    const fx = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    const fy = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    settings.acceleration = snap(accelMax * (1 - fy), accelStep)
    settings.curve = snap(curveMin + fx * (curveMax - curveMin), curveStep)
    commit()
    sync()
  }
  canvas.addEventListener('pointerdown', event => {
    if (isTouch) return
    dragging = true
    canvas.setPointerCapture(event.pointerId)
    shape(event)
  })
  canvas.addEventListener('pointermove', event => { if (dragging) shape(event) })
  const endDrag = () => { dragging = false }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)

  window.addEventListener('resize', () => { if (!panel.hidden) draw() })

  return {
    get: () => settings,
    show () {
      panel.hidden = false
      // The canvas has no measurable size until it is laid out; sync once now
      // (in case it was) and again next frame to be sure it renders.
      sync()
      window.requestAnimationFrame(draw)
    },
    hide () { panel.hidden = true }
  }
}
