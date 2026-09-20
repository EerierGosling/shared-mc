'use strict'
const { PhoneLink, buildPairingUI } = require('./phone-pairing')
const { Gestures, idle } = require('./gestures')
const posePreview = require('./pose-preview')
const FaceGestures = require('./face-gestures')
const StartGesture = require('./start-gesture')
const { FIELDS, DEFAULTS, load, save } = require('./motion-settings')

const RUNTIME = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304'
const MODEL_ROOT = 'https://storage.googleapis.com/mediapipe-models/'

// The panel is a page of the game menu. Camera configures local tracking;
// Phone pairs the dedicated accelerometer controller. Done returns to the menu.
module.exports = function setupCameraControls ({ apply, canPlay, onStart, onDone, socket, phoneLink, mount = document.body }) {
  let settings = load()
  const gestures = new Gestures(settings)
  const faces = new FaceGestures()
  const startGesture = new StartGesture()
  // The join screen can have minted this pairing already; both blocks render
  // the one PhoneLink, and the phone's input merges in once armed.
  const link = phoneLink || (socket ? new PhoneLink(socket) : null)
  const panel = document.createElement('section')
  panel.id = 'camera-controls'
  panel.hidden = true
  panel.setAttribute('aria-label', 'Motion controls setup')
  panel.innerHTML = `<h2>Motion Controls</h2>
    <small>Start in practice mode. Calibrate, test your gestures, then enable player control.</small>
    <div class="motion-preview"><video autoplay muted playsinline aria-label="Mirrored camera preview"></video><canvas data-role="landmarks" aria-hidden="true"></canvas></div>
    <small data-role="tracking">Green landmarks show confident body tracking.</small>
    <p data-role="status" role="status">Choose a camera or phone motion input.</p>
    <div class="motion-buttons">
      <button type="button" class="mc-button" data-action="start">Start Camera</button>
      <button type="button" class="mc-button" data-action="calibrate">Calibrate</button>
      <label class="mc-button mc-cycle">Camera:&nbsp;<select data-setting="camera" aria-label="Camera to track from"><option value="user">Front</option><option value="environment">Rear</option></select></label>
    </div>
    <div class="motion-buttons">
      <button type="button" class="mc-button wide" data-action="arm">Enable Player Control</button>
      <button type="button" class="mc-button wide" data-action="stop">Stop All Inputs</button>
    </div>
    <p data-role="mode">Practice mode: gestures do not affect the player.</p>
    <small data-role="start-hint">After camera calibration, raise both hands above your head and hold for one second to enable player control.</small>
    <p data-role="detected">Detected: idle</p>
    <details data-role="tuning"><summary class="mc-button">Sensitivity &amp; Tuning...</summary>
      <div class="motion-buttons">
        <label class="mc-button mc-cycle wide">Preset:&nbsp;<select data-setting="preset"><option value="normal">Balanced</option><option value="gentle">Small movements</option><option value="deliberate">Deliberate movements</option></select></label>
      </div>
      <div data-role="sliders"></div>
      <div class="motion-buttons">
        <label class="mc-button mc-toggle"><input type="checkbox" data-setting="autojump"><span>Autojump</span></label>
        <label class="mc-button mc-toggle"><input type="checkbox" data-setting="invertX"><span>Invert X</span></label>
        <label class="mc-button mc-toggle"><input type="checkbox" data-setting="invertY"><span>Invert Y</span></label>
        <label class="mc-button mc-cycle">Mining arm:&nbsp;<select data-setting="arm"><option value="right">Right</option><option value="left">Left</option></select></label>
        <label class="mc-button mc-toggle wide"><input type="checkbox" data-setting="facial"><span>Facial Actions</span></label>
      </div>
      <small>Smile to use or place, open your mouth to jump. Hold an expression for a quarter second and relax before repeating. Face tracking downloads an additional model.</small>
      <div class="motion-buttons"><button type="button" class="mc-button wide" data-action="defaults">Reset Sensitivity</button></div>
      <small>Settings save on this browser. Changing them returns to practice mode.</small>
    </details>
    <details><summary class="mc-button">Live Measurements...</summary><pre data-role="diagnostics">Start an input to see measurements.</pre></details>
    <details class="motion-help"><summary class="mc-button">How to Calibrate...</summary>
      <ol>
        <li>Place the camera at chest or face height with your whole body in view. Use even light and a clear background.</li>
        <li>Click Calibrate and stand still, looking straight ahead, until tracking is ready.</li>
        <li>Lean your head each way, thrust your mining arm forward, alternate knee lifts, then try a small jump. Watch Detected.</li>
        <li>Lower a threshold if a gesture is missed. Raise it if ordinary movement triggers actions. Increase head dead zone for drift, smoothing for jitter, or reduce look speed for overshooting.</li>
        <li>Test standing still for 10 seconds and each gesture 10 times. Change one slider at a time. Enable player control when ready.</li>
      </ol>
      <p>Walking automatically jumps while moving forward. To jump from camera input, both feet and hips must rise.</p>
      <p>Thrust your mining arm forward to mine. To place a block, raise your other hand above your shoulder and hold it there a moment; lower and raise it again for the next block.</p>
      <p>Use a mounted camera for body tracking. For phone mining, pair a separate phone, enable its motion sensor, hold it upright with the screen facing you, then thrust it forward to mine. Keep the controller page visible and awake.</p>
      <p>Calibration and sliders personalize a pretrained detector; they do not train a new AI model. No videos or landmarks are uploaded.</p>
    </details>
    <div class="motion-buttons"><button type="button" class="mc-button wide" data-action="hide">Done</button></div>`
  mount.append(panel)
  const $ = selector => panel.querySelector(selector)
  const cameraOptions = document.createElement('details')
  cameraOptions.dataset.role = 'camera'
  cameraOptions.innerHTML = '<summary class="mc-button">Camera</summary>'
  panel.querySelector('h2').after(cameraOptions)
  const cameraButtons = $('[data-action=start]').parentElement
  for (const element of [$('.motion-preview'), $('[data-role=tracking]'), $('[data-role=status]'), cameraButtons,
    $('[data-role=start-hint]'), $('[data-role=tuning]'), $('[data-role=diagnostics]').parentElement, $('.motion-help')]) cameraOptions.append(element)
  if (link) cameraOptions.after(buildPairingUI(link))
  const video = $('video')
  const preview = posePreview($('[data-role=landmarks]'))
  const status = $('[data-role=status]')
  const mode = $('[data-role=mode]')
  const startButton = $('[data-action=start]')
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
  let candidate = idle()
  let faceState = { use: false, jump: false, score: 0 }
  let inferenceMs = 0
  let vision = null
  let files = null
  let faceLoadVersion = 0

  function reset () {
    gestures.resetMotion()
    startGesture.reset()
    faces.reset()
    candidate = idle()
    preview.clear()
    faceState = { use: false, jump: false, score: 0 }
    apply(idle())
  }
  function practice () {
    armed = false
    reset()
    $('[data-action=arm]').textContent = 'Enable Player Control'
    mode.textContent = 'Practice mode: gestures do not affect the player.'
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
    syncFeed()
  }
  function stop () {
    practice()
    stopCamera()
    link?.unpair()
    status.textContent = 'All motion inputs stopped.'
  }
  function fail (error) {
    stopCamera()
    practice()
    status.textContent = `Camera stopped: ${error.message || error}. Check permission, HTTPS and connectivity, then retry.`
  }
  // With the panel closed the same video (and its landmarks) sits in a HUD
  // box by the minimap while the camera runs; one element, so the detector
  // keeps reading the frames it was reading.
  const feed = document.getElementById('motion-feed')
  const previewBox = $('.motion-preview')
  function syncFeed () {
    if (!feed) return
    const live = running && panel.hidden
    feed.classList.toggle('live', live)
    const home = live ? feed : cameraOptions
    if (previewBox.parentNode === home) return
    if (live) home.append(previewBox)
    else $('[data-role=tracking]').before(previewBox)
    video.play().catch(() => {})
  }
  function show () { panel.hidden = false; syncFeed() }
  function hide () { panel.hidden = true; syncFeed() }
  function renderSettings () {
    for (const [key] of Object.entries(FIELDS)) {
      if (key === 'phoneThreshold') continue
      $(`[data-setting=${key}]`).value = settings[key]
      $(`[data-output=${key}]`).textContent = settings[key]
    }
    for (const key of ['autojump', 'invertX', 'invertY', 'facial']) $(`[data-setting=${key}]`).checked = settings[key]
    $('[data-setting=arm]').value = settings.arm
    renderCameras()
  }
  // Front/Rear stay as facingMode requests; every video input the browser
  // reports is listed under them by deviceId so an external webcam can be
  // picked over the built-in one. Labels are blank until a camera permission
  // has been granted once, so the list is refilled after each successful
  // start and whenever a device is plugged in or removed.
  const cameraSelect = $('[data-setting=camera]')
  let cameras = []
  function renderCameras () {
    for (const option of [...cameraSelect.options].filter(option => option.dataset.device)) option.remove()
    cameras.forEach((device, index) => {
      const option = document.createElement('option')
      option.value = device.deviceId
      option.dataset.device = 'true'
      option.textContent = device.label || `Camera ${index + 1}`
      cameraSelect.append(option)
    })
    cameraSelect.value = settings.camera
    // A saved deviceId whose camera is gone (unplugged, other machine) falls
    // back to the front camera rather than leaving the select blank.
    if (cameraSelect.selectedIndex === -1) cameraSelect.value = 'user'
  }
  async function listCameras () {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      cameras = devices.filter(device => device.kind === 'videoinput' && device.deviceId)
    } catch { cameras = [] }
    renderCameras()
  }
  function cameraConstraints () {
    const choice = cameraSelect.value
    const facing = choice === 'user' || choice === 'environment'
    return { audio: false, video: { ...(facing ? { facingMode: choice } : { deviceId: { exact: choice } }), width: { ideal: 640 }, height: { ideal: 480 } } }
  }
  if (navigator.mediaDevices?.enumerateDevices) {
    listCameras()
    navigator.mediaDevices.addEventListener?.('devicechange', listCameras)
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
  // Sliders grouped by the body action they tune, so head / leg / arm
  // adjustments read as a set instead of one flat list. phoneThreshold has no
  // group here — it lives on the phone controller page (phone-controls.js).
  const SLIDER_GROUPS = [
    ['Head — looking', ['lookSpeed', 'deadzone', 'smoothing']],
    ['Legs — walking', ['stepThreshold', 'walkHold', 'jumpThreshold']],
    ['Arm — mining', ['swingThreshold', 'digHold']],
    ['Arm — placing', ['placeThreshold']],
    ['Face', ['faceThreshold']]
  ]
  for (const [title, keys] of SLIDER_GROUPS) {
    const heading = document.createElement('h3')
    heading.className = 'cs-group'
    heading.textContent = title
    $('[data-role=sliders]').append(heading)
    for (const key of keys) {
      const [label, min, max, step] = FIELDS[key]
      const row = document.createElement('label')
      row.className = 'mc-slider'
      row.innerHTML = `<input type="range" data-setting="${key}" min="${min}" max="${max}" step="${step}"><span>${label}: <output data-output="${key}"></output></span>`
      $('[data-role=sliders]').append(row)
      row.querySelector('input').addEventListener('input', event => { settings[key] = Number(event.target.value); settingsChanged() })
    }
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
      gentle: { ...DEFAULTS, stepThreshold: 0.04, swingThreshold: 1.3, jumpThreshold: 0.1, phoneThreshold: 2, lookSpeed: 0.7, placeThreshold: 0.6 },
      deliberate: { ...DEFAULTS, deadzone: 0.14, stepThreshold: 0.22, swingThreshold: 3.5, jumpThreshold: 0.25, phoneThreshold: 4, placeThreshold: 1 }
    }
    settings = { ...values[event.target.value], camera: settings.camera }
    settingsChanged()
  })
  $('[data-action=defaults]').addEventListener('click', () => { settings = { ...DEFAULTS, camera: settings.camera }; settingsChanged() })
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
        const start = startGesture.update(result.landmarks[0], now, !armed && candidate.tracked && document.hasFocus())
        $('[data-role=start-hint]').textContent = armed
          ? 'Player control is on. Use Return to Practice or Stop All Inputs to pause.'
          : startGesture.progress > 0
            ? `Keep both hands raised… ${Math.round(startGesture.progress * 100)}%`
            : 'After camera calibration, raise both hands above your head and hold for one second to enable player control.'
        if (start) $('[data-action=arm]').click()
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
      const media = await navigator.mediaDevices.getUserMedia(cameraConstraints()).catch(error => {
        // A chosen webcam that is no longer attached fails with an exact
        // deviceId constraint; drop back to the front camera instead of dying.
        if (error.name !== 'OverconstrainedError' && error.name !== 'NotFoundError') throw error
        if (cameraSelect.value === 'user') throw error
        settings.camera = 'user'; save(settings); renderCameras()
        mode.textContent = 'Chosen camera not found; tracking from the front camera.'
        return navigator.mediaDevices.getUserMedia(cameraConstraints())
      })
      if (token !== generation) { media.getTracks().forEach(track => track.stop()); return }
      stream = media
      listCameras()
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
      syncFeed()
      syncFace()
      tick()
    } catch (error) { if (token === generation) fail(error) }
  })
  cameraSelect.addEventListener('change', () => {
    settings.camera = cameraSelect.value
    save(settings)
    stopCamera()
    practice()
    status.textContent = 'Camera changed. Click Start Camera and recalibrate.'
  })
  $('[data-action=calibrate]').addEventListener('click', () => { practice(); gestures.calibrate() })
  $('[data-action=arm]').addEventListener('click', () => {
    if (armed) { practice(); return }
    if (!running && !link?.paired) { status.textContent = 'Start Camera or pair a Phone first.'; return }
    reset()
    armed = true
    onStart()
    $('[data-action=arm]').textContent = 'Return to Practice'
    mode.textContent = 'Player control enabled. Menus and lost focus suspend input.'
    mode.classList.add('motion-live')
    // Move focus away from buttons so Space can jump after setup.
    document.activeElement?.blur()
  })
  $('[data-action=stop]').addEventListener('click', stop)
  $('[data-action=hide]').addEventListener('click', onDone || hide)
  socket?.on('disconnect', stop)

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
    const other = link ? link.fresh(now) : idle()
    const face = cameraFresh && settings.facial ? faceState : { jump: false, use: false }
    const forward = Boolean(local.forward || other.forward)
    const state = {
      forward,
      jump: Boolean(local.jump || face.jump || other.jump || (forward && settings.autojump)),
      digging: Boolean(local.digging || other.digging),
      use: Boolean(local.use || face.use || other.use),
      dx: Math.max(-1, Math.min(1, local.dx + other.dx)),
      dy: Math.max(-1, Math.min(1, local.dy + other.dy))
    }
    const detected = Object.entries(state).filter(([, value]) => value).map(([key]) => key).join(', ') || 'idle'
    $('[data-role=detected]').textContent = `Detected: ${detected}`
    const m = candidate.metrics
    $('[data-role=diagnostics]').textContent = [
      m && `Head: ${m.headX.toFixed(2)}, ${m.headY.toFixed(2)} | dead zone ${settings.deadzone}`,
      m && `Step lift: ${m.lift.toFixed(2)} / ${settings.stepThreshold} | thrust: ${m.speed.toFixed(2)} / ${settings.swingThreshold}`,
      m && `Jump rise: ${m.rise.toFixed(2)} / ${settings.jumpThreshold} | raise: ${(m.place ?? 0).toFixed(2)} / ${settings.placeThreshold}`,
      settings.facial && `Expression: ${faceState.score.toFixed(2)} / ${settings.faceThreshold}`,
      running && `Tracking time: ${Math.round(inferenceMs)} ms. ${cameraFresh ? 'Camera live' : 'Waiting for fresh camera frames'}`
    ].filter(Boolean).join('\n') || 'Start an input to see measurements.'
    if (armed && canPlay() && !document.hidden && document.hasFocus()) {
      // Receiver owns look speed; phone packets stay normalized.
      apply(state, dt * settings.lookSpeed)
    } else {
      apply(idle())
      if (armed) { gestures.resetMotion(); faces.reset(); candidate = idle(); faceState = { use: false, jump: false, score: 0 } }
    }
  }, 50)
  window.addEventListener('blur', reset)
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset() })
  window.addEventListener('pagehide', () => { stop(); clearInterval(controlTimer) })
  return { get active () { return armed }, reset, stop, show, hide, practice }
}
