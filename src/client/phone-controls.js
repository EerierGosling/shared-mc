'use strict'
const PhoneMining = require('./phone-mining')
const { FIELDS, load, save } = require('./motion-settings')
const idle = () => ({ forward: false, jump: false, digging: false, use: false, dx: 0, dy: 0 })

module.exports = function setupPhoneControls ({ mount, apply, canPlay, onStart, onStop }) {
  const settings = load()
  const sensor = new PhoneMining()
  let enabled = false
  let manual = false
  let placing = false
  let generation = 0
  let started = 0
  const panel = document.createElement('section')
  panel.id = 'camera-controls'
  panel.hidden = true
  // Mine and Place are the two hands, big and always here. The accelerometer's
  // own controls and tuning live behind "Motion mining": it keeps running
  // underneath, but the everyday surface is just the buttons.
  panel.innerHTML = `<h2>Phone</h2>
    <div class="motion-buttons"><button class="mc-button wide" type="button" data-action="place" aria-pressed="false" style="touch-action: none; user-select: none">Place</button>
    <button class="mc-button wide" type="button" data-action="mine" aria-pressed="false" style="touch-action: none; user-select: none">Mine</button></div>
    <p data-role="mode" role="status">Hold Mine to dig, Place to build.</p>
    <details data-role="tuning"><summary class="mc-button">Motion mining</summary>
    <p>Hold the phone upright, screen facing you. Thrust forward repeatedly to mine; rest to stop.</p>
    <div class="motion-buttons"><button class="mc-button wide" data-action="motion">Start Mining</button>
    <button class="mc-button wide" data-action="stop">Stop</button></div>
    <p data-role="detected">Detected: idle</p>
    <div data-role="sliders"></div>
    <small data-role="diagnostics">Allow motion access to start. No camera is used.</small></details>`
  mount.append(panel)
  const $ = selector => panel.querySelector(selector)
  const button = $('[data-action=motion]')
  const mineButton = $('[data-action=mine]')
  const placeButton = $('[data-action=place]')
  const setMode = text => { $('[data-role=mode]').textContent = text }

  // One place, one shape for the phone's whole input: whatever is held now plus
  // the accelerometer when it is armed. Every path routes through here so digging
  // and use always leave together and never stomp one another on the wire.
  const busy = () => canPlay() && !document.hidden && document.hasFocus()
  const digging = (now = performance.now()) => busy() && (manual || (enabled && sensor.active(now)))
  const emit = () => apply({ ...idle(), digging: digging(), use: placing && busy() })
  const anyActive = () => manual || placing || enabled

  function releaseManual () {
    manual = false
    mineButton.setAttribute('aria-pressed', 'false')
  }
  function reset () {
    releaseManual()
    placing = false
    placeButton.setAttribute('aria-pressed', 'false')
    sensor.reset()
    emit()
    if (!anyActive()) onStop?.()
  }
  function pressMine () {
    if (manual || !busy()) return
    manual = true
    mineButton.setAttribute('aria-pressed', 'true')
    onStart?.()
    emit()
    // iOS only grants motion access from inside a user gesture, so there the
    // first Mine press doubles as the prompt. Elsewhere pairing already armed
    // the sensor, and re-arming here would undo an explicit Stop.
    if (!enabled && window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') start()
  }
  function pressPlace () {
    if (placing || !busy()) return
    placing = true
    placeButton.setAttribute('aria-pressed', 'true')
    onStart?.()
    // The host places one block on the rising edge of use, so a tap is a block.
    emit()
  }
  function releaseHold (release) {
    return () => { release(); emit(); if (!anyActive()) onStop?.() }
  }
  // A held control button: pointer capture so a finger sliding off still ends
  // it, and Space/Enter for the keyboard, exactly like the game's own buttons.
  function holdButton (el, press, release) {
    el.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return
      event.preventDefault()
      el.setPointerCapture(event.pointerId)
      press()
    })
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(type, release)
    el.addEventListener('keydown', event => {
      if (!['Space', 'Enter'].includes(event.code)) return
      event.preventDefault()
      if (!event.repeat) press()
    })
    el.addEventListener('keyup', event => {
      if (['Space', 'Enter'].includes(event.code)) { event.preventDefault(); release() }
    })
    el.addEventListener('blur', release)
  }
  holdButton(mineButton, pressMine, releaseHold(releaseManual))
  holdButton(placeButton, pressPlace, releaseHold(() => { placing = false; placeButton.setAttribute('aria-pressed', 'false') }))
  function stop () {
    generation++
    enabled = false
    button.disabled = false
    button.textContent = 'Start Mining'
    setMode('Motion mining off.')
    sensor.reset()
    emit()
    if (!anyActive()) onStop?.()
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
      sensor.reset()
      emit()
    })
    $('[data-role=sliders]').append(row)
  }
  // Arm the accelerometer. Idempotent, so a stray call while it is already on is
  // a no-op; iOS wants requestPermission inside a user gesture, which is why the
  // Mine button lazily calls this too.
  async function start () {
    if (enabled) return
    if (!canPlay()) { setMode('Pair with the game first.'); return }
    const token = ++generation
    button.disabled = true
    try {
      if (!window.isSecureContext || !window.DeviceMotionEvent) throw new Error('Motion access requires HTTPS and a supported phone.')
      if (typeof DeviceMotionEvent.requestPermission === 'function' && await DeviceMotionEvent.requestPermission() !== 'granted') throw new Error('Motion access denied. Tap Start Mining to retry.')
      if (token !== generation || !canPlay()) return
      sensor.reset()
      enabled = true
      started = performance.now()
      button.textContent = 'Pause Mining'
      setMode('Motion mining on — thrust forward to mine.')
      onStart?.()
    } catch (error) { if (token === generation) setMode(error.message) }
    finally { if (token === generation) button.disabled = false }
  }
  button.addEventListener('click', () => { if (enabled) stop(); else start() })
  $('[data-action=stop]').addEventListener('click', stop)
  window.addEventListener('devicemotion', event => {
    if (enabled && busy()) sensor.update(event, performance.now(), settings.phoneThreshold, settings.digHold)
  })
  const timer = setInterval(() => {
    const now = performance.now()
    emit()
    const detected = [digging(now) && 'mining', placing && busy() && 'placing'].filter(Boolean).join(', ') || 'idle'
    $('[data-role=detected]').textContent = `Detected: ${detected}`
    if (enabled) $('[data-role=diagnostics]').textContent = now - started > 3000 && now - sensor.lastSample > 1000
      ? 'No recent motion data. Check motion permissions and keep this page visible.'
      : `${sensor.status} Forward motion: ${sensor.strength.toFixed(2)} / ${settings.phoneThreshold} m/s²`
  }, 50)
  window.addEventListener('blur', reset)
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset() })
  window.addEventListener('pagehide', () => { stop(); clearInterval(timer) })
  return {
    get active () { return enabled || manual || placing },
    start,
    stop,
    show: () => { panel.hidden = false },
    hide: () => { panel.hidden = true }
  }
}
