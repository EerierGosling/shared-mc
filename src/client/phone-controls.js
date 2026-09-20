'use strict'
const PhoneMining = require('./phone-mining')
const { FIELDS, load, save } = require('./motion-settings')
const idle = () => ({ forward: false, jump: false, digging: false, use: false, dx: 0, dy: 0 })

module.exports = function setupPhoneControls ({ mount, apply, canPlay, onStart, onStop }) {
  const settings = load()
  const sensor = new PhoneMining()
  let enabled = false
  let manual = false
  let generation = 0
  let started = 0
  const panel = document.createElement('section')
  panel.id = 'camera-controls'
  panel.hidden = true
  panel.innerHTML = `<h2>Phone</h2>
    <p>Hold the phone upright, screen facing you. Thrust forward repeatedly to mine; rest to stop.</p>
    <div class="motion-buttons"><button class="mc-button wide" type="button" data-action="mine" aria-pressed="false" style="touch-action: none; user-select: none">Hold to Mine</button>
    <button class="mc-button wide" data-action="motion">Start Mining</button>
    <button class="mc-button wide" data-action="stop">Stop</button></div>
    <p data-role="mode" role="status">Mining is off.</p>
    <p data-role="detected">Detected: idle</p>
    <details data-role="tuning"><summary class="mc-button">Sensitivity</summary><div data-role="sliders"></div></details>
    <small data-role="diagnostics">Allow motion access to start. No camera is used.</small>`
  mount.append(panel)
  const $ = selector => panel.querySelector(selector)
  const button = $('[data-action=motion]')
  const mineButton = $('[data-action=mine]')
  function releaseManual () {
    manual = false
    mineButton.setAttribute('aria-pressed', 'false')
    if (!enabled) onStop?.()
  }
  function reset () { releaseManual(); sensor.reset(); apply(idle()) }
  function pressManual () {
    if (manual || !canPlay() || document.hidden) return
    manual = true
    mineButton.setAttribute('aria-pressed', 'true')
    apply({ ...idle(), digging: true })
    onStart()
  }
  function endManual () {
    releaseManual()
    apply({ ...idle(), digging: enabled && canPlay() && !document.hidden && document.hasFocus() && sensor.active(performance.now()) })
  }
  mineButton.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    mineButton.setPointerCapture(event.pointerId)
    pressManual()
  })
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) mineButton.addEventListener(event, endManual)
  mineButton.addEventListener('keydown', event => {
    if (!['Space', 'Enter'].includes(event.code)) return
    event.preventDefault()
    if (!event.repeat) pressManual()
  })
  mineButton.addEventListener('keyup', event => {
    if (['Space', 'Enter'].includes(event.code)) { event.preventDefault(); endManual() }
  })
  mineButton.addEventListener('blur', endManual)
  function stop () {
    generation++
    enabled = false
    button.disabled = false
    button.textContent = 'Start Mining'
    $('[data-role=mode]').textContent = 'Mining is off.'
    reset()
    onStop?.()
  }
  for (const key of ['phoneThreshold', 'digHold']) {
    const [label, min, max, step] = FIELDS[key]
    const row = document.createElement('label')
    row.className = 'mc-slider'
    row.innerHTML = `<input type="range" data-setting="${key}" min="${min}" max="${max}" step="${step}" value="${settings[key]}"><span>${label}: <output>${settings[key]}</output></span>`
    row.querySelector('input').addEventListener('input', event => {
      settings[key] = Number(event.target.value)
      row.querySelector('output').textContent = settings[key]
      save(settings)
      reset()
    })
    $('[data-role=sliders]').append(row)
  }
  button.addEventListener('click', async () => {
    if (enabled) { stop(); return }
    if (!canPlay()) { $('[data-role=mode]').textContent = 'Pair with the game first.'; return }
    const token = ++generation
    button.disabled = true
    try {
      if (!window.isSecureContext || !window.DeviceMotionEvent) throw new Error('Motion access requires HTTPS and a supported phone.')
      if (typeof DeviceMotionEvent.requestPermission === 'function' && await DeviceMotionEvent.requestPermission() !== 'granted') throw new Error('Motion permission was denied. Tap Start Mining to retry.')
      if (token !== generation || !canPlay()) return
      reset()
      enabled = true
      started = performance.now()
      button.textContent = 'Pause Mining'
      $('[data-role=mode]').textContent = 'Player control enabled. Forward thrusts mine.'
      onStart()
    } catch (error) { if (token === generation) $('[data-role=mode]').textContent = error.message }
    finally { if (token === generation) button.disabled = false }
  })
  $('[data-action=stop]').addEventListener('click', stop)
  window.addEventListener('devicemotion', event => {
    if (enabled && canPlay() && !document.hidden && document.hasFocus()) sensor.update(event, performance.now(), settings.phoneThreshold, settings.digHold)
  })
  const timer = setInterval(() => {
    const now = performance.now()
    const digging = canPlay() && !document.hidden && document.hasFocus() && (manual || (enabled && sensor.active(now)))
    apply({ ...idle(), digging })
    $('[data-role=detected]').textContent = digging ? 'Detected: mining' : 'Detected: idle'
    if (enabled) $('[data-role=diagnostics]').textContent = now - started > 3000 && now - sensor.lastSample > 1000
      ? 'No recent motion data. Check motion permissions and keep this page visible.'
      : `${sensor.status} Forward motion: ${sensor.strength.toFixed(2)} / ${settings.phoneThreshold} m/s²`
  }, 50)
  window.addEventListener('blur', reset)
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset() })
  window.addEventListener('pagehide', () => { stop(); clearInterval(timer) })
  return { get active () { return enabled || manual }, stop, show: () => { panel.hidden = false } }
}
