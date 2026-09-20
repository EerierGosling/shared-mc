'use strict'
const QRCode = require('qrcode')
const { Gestures, idle } = require('./gestures')
const posePreview = require('./pose-preview')
const FaceGestures = require('./face-gestures')
const PhoneSteps = require('./phone-steps')
const { FIELDS, DEFAULTS, load, save } = require('./motion-settings')

const RUNTIME = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304'
const MODEL_ROOT = 'https://storage.googleapis.com/mediapipe-models/'

module.exports = function setupCameraControls ({ apply, canPlay, onStart, socket, companion = false, mount = document.body }) {
  let settings = load()
  const gestures = new Gestures(settings)
  const faces = new FaceGestures()
  const steps = new PhoneSteps()
  const panel = document.createElement('section')
  panel.id = 'camera-controls'
  panel.hidden = true
  panel.setAttribute('aria-label', 'Motion controls setup')
  panel.innerHTML = `<h2>Motion controls</h2>
    <small>Start in practice mode. Calibrate, test your gestures, then enable player control.</small>
    <div class="motion-preview"><video autoplay muted playsinline aria-label="Mirrored camera preview"></video><canvas data-role="landmarks" aria-hidden="true"></canvas></div>
    <small data-role="tracking">Green landmarks show confident body tracking.</small>
    <p data-role="status" role="status">Choose a camera or phone motion input.</p>
    <div class="motion-buttons">
      <button type="button" data-action="start">Start camera</button>
      <button type="button" data-action="calibrate">Calibrate neutral pose</button>
      <button type="button" data-action="motion">Enable phone steps</button>
    </div>
    <label>Camera <select data-setting="camera"><option value="user">Front / default</option><option value="environment">Rear camera</option></select></label>
    <div class="motion-buttons motion-primary">
      <button type="button" data-action="arm">Enable player control</button>
      <button type="button" data-action="stop">Stop all inputs</button>
      <button type="button" data-action="hide">Hide panel</button>
    </div>
    <p data-role="mode">Practice mode — gestures do not affect the player.</p>
    <p data-role="detected">Detected: idle</p>
    <details data-role="tuning"><summary>Sensitivity & tuning</summary>
      <label>Preset <select data-setting="preset"><option value="normal">Balanced</option><option value="gentle">Small movements</option><option value="deliberate">Deliberate movements</option></select></label>
      <div data-role="sliders"></div>
      <label><input type="checkbox" data-setting="autojump"> Autojump while walking forward</label>
      <label><input type="checkbox" data-setting="invertX"> Invert horizontal look</label>
      <label><input type="checkbox" data-setting="invertY"> Invert vertical look</label>
      <label>Mining arm <select data-setting="arm"><option value="right">Right</option><option value="left">Left</option></select></label>
      <label><input type="checkbox" data-setting="facial"> Facial actions: smile to use/place; open mouth to jump</label>
      <small>Hold an expression for ¼ second. Relax before repeating. Face tracking downloads an additional model.</small>
      <button type="button" data-action="defaults">Reset sensitivity</button>
      <small>Settings save on this browser. Changing them returns to practice mode.</small>
    </details>
    <details><summary>Live measurements</summary><pre data-role="diagnostics">Start an input to see measurements.</pre></details>
    <details><summary>How to calibrate & practice</summary>
      <ol>
        <li>Place the camera at chest/face height with your whole body in view. Use even light and a clear background.</li>
        <li>Click Calibrate and stand still, looking straight ahead, until tracking is ready.</li>
        <li>Lean your head each way, swing your mining arm, alternate knee lifts, then try a small jump. Watch Detected.</li>
        <li>Lower a threshold if a gesture is missed. Raise it if ordinary movement triggers actions. Increase head dead zone for drift, smoothing for jitter, or reduce look speed for overshooting.</li>
        <li>Test standing still for 10 seconds and each gesture 10 times. Change one slider at a time. Enable player control when ready.</li>
      </ol>
      <p>Walking automatically jumps while moving forward. To jump from camera input, both feet and hips must rise.</p>
      <p>Use a mounted camera for body tracking. For phone steps, pair a separate phone, enable its motion sensor, and carry it with you. Keep the controller page visible and awake.</p>
      <p>Calibration and sliders personalize a pretrained detector; they do not train a new AI model. No videos or landmarks are uploaded.</p>
    </details>
    ${companion ? '' : `<details data-role="pairing"><summary>Pair a phone</summary>
      <p>Open <a href="/controller" target="_blank" rel="noopener">the phone controller</a> on your phone, then enter a code. Both devices must reach this site over HTTPS.</p>
      <label>Site address reachable from your phone <input type="text" data-role="pair-origin" aria-label="Phone-accessible HTTPS site address"></label>
      <small>Use this server’s HTTPS address. localhost on your phone points to the phone, not your computer.</small>
      <button type="button" data-action="pair">Generate pairing code</button>
      <button type="button" data-action="unpair">Disconnect phone</button>
      <canvas data-role="pair-qr" role="img" aria-label="Scan to open the phone controller with the pairing code" hidden></canvas>
      <strong data-role="pair-code"></strong><a data-role="pair-link"></a>
      <p data-role="pair-status">No phone connected. Codes expire after five minutes and work once.</p>
      <small>A phone can send camera gestures, accelerometer steps, or both. Recommended: desktop camera + phone steps. Pairing does not create another player.</small>
    </details>`}`
  if (!companion) panel.insertBefore(panel.querySelector('[data-role=pairing]'), panel.querySelector('details'))
  mount.append(panel)
  const $ = selector => panel.querySelector(selector)
  const video = $('video')
  const preview = posePreview($('[data-role=landmarks]'))
  const status = $('[data-role=status]')
  const mode = $('[data-role=mode]')
  const startButton = $('[data-action=start]')
  let menuButton
  if (!companion) {
    menuButton = document.createElement('button')
    menuButton.className = 'mc-button'
    menuButton.textContent = 'Motion controls & phone'
    document.getElementById('pause-resume').after(menuButton)
    menuButton.addEventListener('click', () => show())
  }
  let running = false
  let armed = false
  let generation = 0
  let stream = null
  let detector = null
  let faceDetector = null
  let faceLoading = false
  let timer = null
  let lastVideoTime = -1
  let lastFrame = -Infinity
  let lastControl = performance.now()
  let motionEnabled = false
  let motionSince = 0
  let candidate = idle()
  let faceState = { use: false, jump: false, score: 0 }
  let remote = idle()
  let remoteAt = -Infinity
  let paired = false
  let inferenceMs = 0
  let vision = null
  let files = null
  let faceLoadVersion = 0

  function reset () {
    gestures.resetMotion()
    faces.reset()
    steps.reset()
    candidate = idle()
    preview.clear()
    faceState = { use: false, jump: false, score: 0 }
    remote = idle()
    remoteAt = -Infinity
    apply(idle())
  }
  function practice () {
    armed = false
    reset()
    $('[data-action=arm]').textContent = 'Enable player control'
    mode.textContent = 'Practice mode — gestures do not affect the player.'
    mode.classList.remove('motion-live')
  }
  function stopCamera () {
    generation++
    running = false
    clearTimeout(timer)
    reset()
    stream?.getTracks().forEach(track => track.stop())
    stream = null
    video.srcObject = null
    detector?.close()
    detector = null
    faceLoadVersion++
    faceDetector?.close()
    faceDetector = null
    faceLoading = false
    startButton.disabled = false
  }
  function stop () {
    practice()
    stopCamera()
    motionEnabled = false
    $('[data-action=motion]').textContent = 'Enable phone steps'
    if (!companion) socket?.emit('motion:unpair')
    paired = false
    status.textContent = 'All motion inputs stopped.'
  }
  function fail (error) {
    stopCamera()
    practice()
    status.textContent = `Camera stopped: ${error.message || error}. Check permission, HTTPS and connectivity, then retry.`
  }
  function show (withPhone = false) {
    panel.hidden = false
    if (withPhone && $('[data-role=pairing]')) $('[data-role=pairing]').open = true
  }
  function renderSettings () {
    for (const [key] of Object.entries(FIELDS)) {
      $(`[data-setting=${key}]`).value = settings[key]
      $(`[data-output=${key}]`).textContent = settings[key]
    }
    for (const key of ['autojump', 'invertX', 'invertY', 'facial']) $(`[data-setting=${key}]`).checked = settings[key]
    $('[data-setting=arm]').value = settings.arm
  }
  async function syncFace () {
    if (!settings.facial || !running) {
      faceLoadVersion++
      faceDetector?.close(); faceDetector = null; faceLoading = false; faces.reset()
      faceState = { use: false, jump: false, score: 0 }
      return
    }
    if (faceDetector || faceLoading) return
    faceLoading = true
    const token = generation
    const version = ++faceLoadVersion
    try {
      const loaded = await vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: `${MODEL_ROOT}face_landmarker/face_landmarker/float16/1/face_landmarker.task` },
        runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true
      })
      if (token !== generation || version !== faceLoadVersion || !settings.facial) { loaded.close(); return }
      faceDetector = loaded
    } catch (error) {
      if (token === generation && version === faceLoadVersion) {
        settings.facial = false; save(settings); renderSettings()
        status.textContent = `Facial actions unavailable: ${error.message}. Body tracking remains available.`
      }
    } finally { if (version === faceLoadVersion) faceLoading = false }
  }
  function settingsChanged () {
    practice()
    gestures.configure(settings)
    save(settings)
    renderSettings()
    syncFace()
  }
  for (const [key, [label, min, max, step]] of Object.entries(FIELDS)) {
    const row = document.createElement('label')
    row.innerHTML = `${label} <output data-output="${key}"></output><input type="range" data-setting="${key}" min="${min}" max="${max}" step="${step}">`
    $('[data-role=sliders]').append(row)
    row.querySelector('input').addEventListener('input', event => { settings[key] = Number(event.target.value); settingsChanged() })
  }
  for (const key of ['autojump', 'invertX', 'invertY', 'facial', 'arm']) {
    $(`[data-setting=${key}]`).addEventListener('change', event => {
      settings[key] = key === 'arm' ? event.target.value : event.target.checked
      settingsChanged()
    })
  }
  $('[data-setting=preset]').addEventListener('change', event => {
    const values = {
      normal: DEFAULTS,
      gentle: { ...DEFAULTS, stepThreshold: 0.07, swingThreshold: 1.3, jumpThreshold: 0.1, phoneThreshold: 2, lookSpeed: 0.7 },
      deliberate: { ...DEFAULTS, deadzone: 0.14, stepThreshold: 0.22, swingThreshold: 3.5, jumpThreshold: 0.25, phoneThreshold: 4 }
    }
    settings = { ...values[event.target.value] }
    settingsChanged()
  })
  $('[data-action=defaults]').addEventListener('click', () => { settings = { ...DEFAULTS }; settingsChanged() })
  renderSettings()

  function tick () {
    if (!running) return
    try {
      if (!document.hidden && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        const now = performance.now()
        lastVideoTime = video.currentTime
        const result = detector.detectForVideo(video, now)
        candidate = gestures.update(result.landmarks[0], now, video.videoWidth / video.videoHeight)
        preview.draw(result.landmarks[0], video.videoWidth, video.videoHeight)
        if (faceDetector) faceState = faces.update(faceDetector.detectForVideo(video, now).faceBlendshapes[0]?.categories, now, settings.faceThreshold)
        inferenceMs = performance.now() - now
        lastFrame = performance.now()
        status.textContent = candidate.status + (faceLoading ? ' · Loading facial actions…' : '')
      }
      timer = setTimeout(tick, 65)
    } catch (error) { fail(error) }
  }

  startButton.addEventListener('click', async () => {
    if (running || startButton.disabled) return
    const token = ++generation
    practice()
    startButton.disabled = true
    status.textContent = 'Loading camera tracking…'
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Use HTTPS or localhost for camera access')
      const media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: $('[data-setting=camera]').value, width: { ideal: 640 }, height: { ideal: 480 } } })
      if (token !== generation) { media.getTracks().forEach(track => track.stop()); return }
      stream = media
      stream.getVideoTracks()[0].addEventListener('ended', () => { if (token === generation) fail(new Error('Camera disconnected')) })
      video.srcObject = stream
      await video.play()
      if (token !== generation) return
      vision = await import(/* webpackIgnore: true */ `${RUNTIME}/vision_bundle.mjs`)
      files = await vision.FilesetResolver.forVisionTasks(`${RUNTIME}/wasm`)
      if (token !== generation) return
      const loaded = await vision.PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: `${MODEL_ROOT}pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task` },
        runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.6, minTrackingConfidence: 0.6
      })
      if (token !== generation) { loaded.close(); return }
      detector = loaded
      gestures.calibrate()
      lastVideoTime = -1
      running = true
      syncFace()
      tick()
    } catch (error) { if (token === generation) fail(error) }
  })
  $('[data-setting=camera]').addEventListener('change', () => { stopCamera(); practice(); status.textContent = 'Camera changed. Click Start camera and recalibrate.' })
  $('[data-action=calibrate]').addEventListener('click', () => { practice(); gestures.calibrate() })
  $('[data-action=arm]').addEventListener('click', () => {
    if (armed) { practice(); return }
    if (!running && !motionEnabled && !paired) { status.textContent = 'Start a camera, enable phone steps, or pair a phone first.'; return }
    reset()
    armed = true
    onStart()
    $('[data-action=arm]').textContent = 'Return to practice'
    mode.textContent = 'Player control enabled. Menus and lost focus suspend input.'
    mode.classList.add('motion-live')
    // Move focus away from buttons so Space can jump after setup.
    document.activeElement?.blur()
  })
  $('[data-action=stop]').addEventListener('click', stop)
  $('[data-action=hide]').addEventListener('click', () => { panel.hidden = true })
  $('[data-action=motion]').addEventListener('click', async () => {
    if (motionEnabled) { motionEnabled = false; practice(); $('[data-action=motion]').textContent = 'Enable phone steps'; return }
    const token = generation
    try {
      if (!window.isSecureContext || !window.DeviceMotionEvent) throw new Error('Phone motion needs HTTPS and a supported browser/device')
      if (typeof DeviceMotionEvent.requestPermission === 'function' && await DeviceMotionEvent.requestPermission() !== 'granted') throw new Error('Motion permission was denied')
      if (token !== generation) return
      practice()
      motionEnabled = true
      motionSince = performance.now()
      $('[data-action=motion]').textContent = 'Disable phone steps'
      status.textContent = 'Waiting for motion sensor data. Carry this device and walk in place.'
    } catch (error) { status.textContent = error.message }
  })
  window.addEventListener('devicemotion', event => {
    if (!motionEnabled || document.hidden || !document.hasFocus()) return
    steps.update(event, performance.now(), settings.phoneThreshold, settings.walkHold)
  })

  if (!companion && socket) {
    const pairStatus = $('[data-role=pair-status]')
    $('[data-role=pair-origin]').value = window.location.origin
    $('[data-action=pair]').addEventListener('click', () => {
      if (!socket.connected) { pairStatus.textContent = 'Connect to the game first.'; return }
      let link
      try {
        link = new URL('/controller', $('[data-role=pair-origin]').value)
        if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password) throw new Error('address')
      } catch { pairStatus.textContent = 'Enter a valid HTTPS address for this game server.'; return }
      socket.timeout(5000).emit('motion:create', async (error, result) => {
        if (error || result?.error) { pairStatus.textContent = result?.error || 'Pairing request timed out. Retry.'; return }
        $('[data-role=pair-code]').textContent = result.code
        link.hash = result.code
        const anchor = $('[data-role=pair-link]')
        anchor.href = link.href; anchor.textContent = link.href
        pairStatus.textContent = 'Scan the QR code, enter the code, or open the link on your phone. Expires in five minutes.'
        if (link.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(link.hostname)) pairStatus.textContent += ' This address will not provide camera/motion access on a separate phone; use a phone-accessible HTTPS address.'
        const qr = $('[data-role=pair-qr]')
        qr.hidden = true
        try {
          await QRCode.toCanvas(qr, link.href, { width: 240, margin: 4, errorCorrectionLevel: 'M' })
          if ($('[data-role=pair-code]').textContent === result.code) { qr.hidden = false; qr.scrollIntoView({ block: 'center' }) }
        } catch { pairStatus.textContent += ' QR generation failed; enter the code manually.' }
      })
    })
    $('[data-action=unpair]').addEventListener('click', () => socket.emit('motion:unpair'))
    socket.on('motion:paired', () => {
      paired = true
      $('[data-role=pair-qr]').hidden = true
      $('[data-role=pair-code]').textContent = ''
      $('[data-role=pair-link]').removeAttribute('href'); $('[data-role=pair-link]').textContent = ''
      pairStatus.textContent = 'Phone paired. Enable player control here and on the phone when ready.'
    })
    socket.on('motion:state', state => { if (paired) { remote = state; remoteAt = performance.now() } })
    socket.on('motion:stale', () => { remote = idle(); pairStatus.textContent = 'Phone input timed out — keep its page visible and awake.' })
    socket.on('motion:ended', () => {
      paired = false; remote = idle(); remoteAt = -Infinity
      $('[data-role=pair-qr]').hidden = true
      $('[data-role=pair-code]').textContent = ''
      $('[data-role=pair-link]').removeAttribute('href'); $('[data-role=pair-link]').textContent = ''
      pairStatus.textContent = 'Phone disconnected or code expired. Generate a code to pair again.'
    })
    socket.on('disconnect', stop)
  }

  const controlTimer = setInterval(() => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - lastControl) / 1000)
    lastControl = now
    const cameraFresh = running && now - lastFrame < 250
    if (!cameraFresh) preview.clear()
    const tracking = cameraFresh ? candidate.tracking : null
    $('[data-role=tracking]').textContent = tracking
      ? `Head: ${tracking.head ? 'visible' : 'missing'} · Mining arm: ${tracking.arm ? 'visible' : 'missing'} · Legs: ${tracking.legs ? 'visible' : 'missing'}${candidate.tracked && tracking.legs && !tracking.jumpReady ? ' · Recalibrate with feet visible for jumps' : ''}`
      : 'Waiting for camera landmarks. Green points indicate confident tracking.'
    const local = cameraFresh && candidate.tracked ? candidate : idle()
    const phone = motionEnabled && steps.active(now)
    const other = paired && now - remoteAt < 350 ? remote : idle()
    const face = cameraFresh && settings.facial ? faceState : { jump: false, use: false }
    const forward = Boolean(local.forward || phone || other.forward)
    const state = {
      forward,
      jump: Boolean(local.jump || face.jump || other.jump || (forward && settings.autojump)),
      digging: Boolean(local.digging || other.digging),
      use: Boolean(face.use || other.use),
      dx: Math.max(-1, Math.min(1, local.dx + other.dx)),
      dy: Math.max(-1, Math.min(1, local.dy + other.dy))
    }
    const detected = Object.entries(state).filter(([, value]) => value).map(([key]) => key).join(', ') || 'idle'
    $('[data-role=detected]').textContent = `Detected: ${detected}`
    const m = candidate.metrics
    $('[data-role=diagnostics]').textContent = [
      m && `Head: ${m.headX.toFixed(2)}, ${m.headY.toFixed(2)} | dead zone ${settings.deadzone}`,
      m && `Knee: ${m.knee.toFixed(2)} / ${settings.stepThreshold} | arm: ${m.speed.toFixed(2)} / ${settings.swingThreshold}`,
      m && `Jump rise: ${m.rise.toFixed(2)} / ${settings.jumpThreshold}`,
      motionEnabled && `Phone: ${steps.strength.toFixed(2)} / ${settings.phoneThreshold} m/s²${now - steps.lastSample > 1000 ? ' (no recent sensor data)' : ''}`,
      settings.facial && `Expression: ${faceState.score.toFixed(2)} / ${settings.faceThreshold}`,
      running && `Tracking time: ${Math.round(inferenceMs)} ms. ${cameraFresh ? 'Camera live' : 'Waiting for fresh camera frames'}`
    ].filter(Boolean).join('\n') || 'Start an input to see measurements.'
    if (motionEnabled && !running && now - motionSince > 3000 && !Number.isFinite(steps.lastSample)) status.textContent = 'No motion data received. Check browser permissions or use camera tracking.'
    if (armed && canPlay() && !document.hidden && document.hasFocus()) {
      // Receiver owns look speed; companion packets stay normalized.
      apply(state, dt * (companion ? 1 : settings.lookSpeed))
    } else {
      apply(idle())
      if (armed) { gestures.resetMotion(); steps.reset(); faces.reset(); remote = idle(); candidate = idle(); faceState = { use: false, jump: false, score: 0 } }
    }
  }, 50)
  window.addEventListener('blur', reset)
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset() })
  window.addEventListener('pagehide', () => { stop(); clearInterval(controlTimer) })
  return { get active () { return armed }, reset, stop, show, practice }
}
