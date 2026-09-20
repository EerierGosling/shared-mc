'use strict'
// Optional browser integration check. Install playwright-core separately and set
// PLAYWRIGHT_MODULE to its module path (or install it in your dev environment).
// Uses a local fake game session and synthetic camera/sensor data, never Minecraft.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const express = require('express')
const { Server } = require('socket.io')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const { MotionPairing } = require('../src/server/motion-pairing')

async function main () {
  const app = express()
  const server = http.createServer(app)
  const io = new Server(server)
  const joined = new Set()
  const packets = []
  const pairing = new MotionPairing(id => joined.has(id))
  const root = path.resolve(__dirname, '..')
  const bundle = prefix => fs.readdirSync(path.join(root, 'dist')).find(name => new RegExp(`^${prefix}\\.[a-f0-9]+\\.js$`).test(name)) || `${prefix}.js`
  app.get('/', (req, res) => res.type('html').send(fs.readFileSync(path.join(root, 'src/client/index.html'), 'utf8')
    .replace('/dist/bundle.js', `/dist/${bundle('bundle')}`)))
  app.get(['/controller', '/p'], (req, res) => res.type('html').send(fs.readFileSync(path.join(root, 'src/client/controller.html'), 'utf8')
    .replace('/dist/controller.js', `/dist/${bundle('controller')}`)))
  for (const sheet of ['ui.css', 'motion.css']) app.get(`/${sheet}`, (req, res) => res.sendFile(path.join(root, 'src/client', sheet)))
  app.use('/dist', express.static(path.join(root, 'dist')))
  app.use('/fonts', express.static(path.join(root, 'src/client/fonts')))
  app.use('/assets', express.static(require('minecraft-assets')('1.20.4').directory))
  io.on('connection', socket => {
    pairing.register(socket)
    socket.emit('join:options', { skins: ['steve'], roadtripRiders: 0, botCount: 0, capacity: 10, soloAvailable: true, defaultServer: { host: 'test.invalid', port: 25565 } })
    socket.on('join', () => {
      joined.add(socket.id)
      socket.emit('join:accepted', { username: 'Test', skin: 'steve', mode: 'roadtrip', server: { host: 'test.invalid', port: 25565 } })
    })
    socket.on('input:state', state => packets.push(state))
    socket.on('action:dig', state => packets.push({ digging: state.active }))
    socket.on('action:use', () => packets.push({ use: true }))
    socket.on('disconnect', () => joined.delete(socket.id))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({
      channel: 'chrome', headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
    })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const errors = []
    const host = await context.newPage()
    host.on('pageerror', error => errors.push(error.message))
    const base = `http://127.0.0.1:${server.address().port}`
    await host.goto(base)
    await host.getByRole('link', { name: 'Use this device as a controller', exact: true }).click()
    await host.locator('#pair-code').waitFor({ state: 'visible' })
    assert.equal(new URL(host.url()).pathname, '/controller')
    assert.equal(joined.size, 0, 'Opening the controller does not join a player')
    await host.getByRole('link', { name: 'Back to game' }).click()
    // The phone can be paired on the join screen, before any mode is picked:
    // the code is minted on the same socket that goes on to join.
    await host.locator('#join-controls [data-role=pairing] > summary').click()
    await host.locator('#join-controls [data-role=pair-qr]').waitFor({ state: 'visible' })
    // Explicit generation must also reveal and focus the QR, even if the
    // section is collapsed while the request is pending.
    await host.locator('#join-controls [data-role=pairing]').evaluate(section => {
      section.querySelector('[data-action=pair]').click()
      section.open = false
    })
    await host.waitForFunction(() => {
      const section = document.querySelector('#join-controls [data-role=pairing]')
      const qr = section.querySelector('[data-role=pair-qr]')
      return section.open && !qr.hidden && document.activeElement === qr && !section.querySelector('[data-action=pair]').disabled
    })
    const code = await host.locator('#join-controls [data-role=pair-code]').textContent()
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/)
    const link = await host.locator('#join-controls [data-role=pair-link]').getAttribute('href')
    assert.equal(new URL(link).hash, `#${code}`)
    assert.equal(new URL(link).pathname, '/p')
    assert.ok(await host.locator('#join-controls [data-role=pair-qr]').evaluate(canvas => canvas.width >= 240 && canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 !== 3 && value === 0)))
    await host.screenshot({ path: '/private/tmp/shared-mc-pairing.png' })

    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const phone = await phoneContext.newPage()
    phone.on('pageerror', error => errors.push(error.message))
    await phone.goto(link)
    assert.equal(new URL(phone.url()).hash, '')
    await phone.locator('#camera-controls').waitFor({ state: 'visible' })
    assert.equal(await phone.locator('video, [data-action=start], [data-action=calibrate], [data-setting=facial]').count(), 0, 'Phone offers only accelerometer controls')
    assert.equal(await phone.locator('[data-setting]').count(), 2, 'Phone exposes only mining sensitivity and hold')
    await host.locator('#join-controls [data-role=pair-qr]').waitFor({ state: 'hidden' })
    assert.match(await host.locator('#join-controls [data-role=pair-status]').textContent(), /Phone paired/)
    await host.getByRole('button', { name: /Collaborative/ }).click()
    await host.locator('#join-button').click()
    await host.waitForFunction(() => document.getElementById('join').classList.contains('open') === false)
    assert.equal(await host.locator('#camera-controls').isVisible(), false, 'Joining does not open motion controls')
    // The game menu is the only way in; Escape needs pointer lock, so press its button directly.
    await host.evaluate(() => document.getElementById('pause-motion').click())
    await host.locator('#camera-controls').waitFor({ state: 'visible' })
    assert.match(await host.locator('[data-role=mode]').textContent(), /Practice mode/)
    // The pairing made on the join screen is the same one shown in game.
    await host.locator('#camera-controls [data-role=pairing]').evaluate(section => { section.open = true })
    assert.match(await host.locator('#camera-controls [data-role=pair-status]').textContent(), /Phone paired/)
    await host.locator('[data-action=arm]').click()
    await phone.bringToFront()
    // Pairing arms thrust-mining on its own where no permission prompt stands in
    // the way (Chromium has none), so no Start Mining tap is needed. Open the
    // tuning disclosure to reach the accelerometer's own Start/Stop and sliders.
    assert.match(await phone.locator('[data-role=mode]').textContent(), /Motion mining on/)
    await phone.locator('[data-role=tuning]').evaluate(section => { section.open = true })
    const sendMotion = (z, count, y = 0.04) => phone.evaluate(async ({ z, count, y }) => {
      for (let i = 0; i < count; i++) {
        window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
          acceleration: { x: 0.05, y, z },
          accelerationIncludingGravity: { x: 0.05, y: y + 9.8, z }
        }))
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }, { z, count, y })
    await sendMotion(0.06, 15)
    await sendMotion(0, 6, 5)
    await sendMotion(0, 6, -5)
    await sendMotion(0.06, 15)
    assert.ok(!packets.some(state => state.digging), 'Stationary and vertical handling do not mine')
    await sendMotion(-0.2, 4)
    await sendMotion(0.2, 3)
    await phone.waitForTimeout(80)
    assert.ok(packets.some(state => state.digging), 'Phone swings start mining')
    assert.ok(!packets.some(state => state.forward || state.jump), 'Phone acceleration never walks or autojumps')
    const miningStart = packets.length
    for (let stroke = 0; stroke < 5; stroke++) {
      await sendMotion(0, 8)
      await sendMotion(-0.2, 4)
      await sendMotion(0.2, 3)
    }
    assert.ok(!packets.slice(miningStart).some(p => p.digging === false), 'Repeated thrusts hold mining continuously')
    await sendMotion(0.06, 30)
    await phone.waitForTimeout(100)
    assert.equal(packets.filter(p => 'digging' in p).at(-1).digging, false, 'Resting releases mining')
    await phone.locator('[data-action=stop]').click()
    await phone.waitForTimeout(200)
    assert.equal(packets.filter(p => 'digging' in p).at(-1).digging, false)
    // Manual mining works with the accelerometer stopped and releases on up.
    const mineButton = phone.locator('[data-action=mine]')
    await mineButton.scrollIntoViewIfNeeded()
    const mineBox = await mineButton.boundingBox()
    await phone.mouse.move(mineBox.x + mineBox.width / 2, mineBox.y + mineBox.height / 2)
    await phone.mouse.down()
    await phone.waitForTimeout(150)
    assert.equal(packets.filter(p => 'digging' in p).at(-1).digging, true)
    await phone.mouse.up()
    await phone.waitForTimeout(150)
    assert.equal(packets.filter(p => 'digging' in p).at(-1).digging, false)
    // Place: a press sends use, and the host turns its rising edge into one action:use.
    const placesBefore = packets.filter(p => p.use).length
    const placeButton = phone.locator('[data-action=place]')
    const placeBox = await placeButton.boundingBox()
    await phone.mouse.move(placeBox.x + placeBox.width / 2, placeBox.y + placeBox.height / 2)
    await phone.mouse.down()
    await phone.waitForTimeout(150)
    await phone.mouse.up()
    await phone.waitForTimeout(150)
    assert.ok(packets.filter(p => p.use).length > placesBefore, 'Phone Place button places a block')
    await phone.locator('[data-setting=phoneThreshold]').fill('1.2')
    assert.match(await phone.locator('[data-role=mode]').textContent(), /Motion mining off/)
    assert.equal(await phone.evaluate(() => JSON.parse(localStorage.getItem('motion-settings-v1')).phoneThreshold), 1.2)
    await phone.screenshot({ path: '/private/tmp/shared-mc-phone.png', fullPage: true })
    await phone.locator('#pair-disconnect').click()
    await host.waitForFunction(() => document.querySelector('#camera-controls [data-role=pair-status]').textContent.includes('disconnected'))

    // Exercise the camera pipeline using deterministic landmark output. This
    // validates calibration and cleanup; hardware/model accuracy is separate.
    await host.route('https://cdn.jsdelivr.net/**/vision_bundle.mjs', route => route.fulfill({
      contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' },
      body: `export const FilesetResolver = { forVisionTasks: async () => ({}) };
        export const PoseLandmarker = { createFromOptions: async () => ({ close() {}, detectForVideo() {
          const p = Array.from({length:33}, () => ({x:.5,y:.5,visibility:1}));
          p[0].y=.2; p[11].x=.6;p[12].x=.4;p[11].y=p[12].y=.4;
          p[23].y=p[24].y=.65;p[25].y=p[26].y=.8;p[27].y=p[28].y=.95;
          if (window.testStartGesture) p[15].y=p[16].y=.05;
          return {landmarks: [p]};
        } }) };
        export const FaceLandmarker = { createFromOptions: async () => ({close(){},detectForVideo(){return {faceBlendshapes:[]}}}) };`
    }))
    await host.evaluate(() => document.getElementById('pause-motion').click())
    await host.locator('[data-role=camera]').evaluate(section => { section.open = true })
    await host.locator('[data-action=start]').click()
    await host.waitForFunction(() => document.querySelector('[data-role=status]').textContent.startsWith('Tracking'), { timeout: 10000 })
    await host.evaluate(() => { window.testStartGesture = true })
    await host.waitForFunction(() => document.querySelector('[data-role=mode]').textContent.includes('Player control enabled'))
    await host.evaluate(() => { window.testStartGesture = false })
    assert.match(await host.locator('[data-role=mode]').textContent(), /Player control enabled/)
    // Enabling control closes the menu; reopen the page to keep driving it.
    await host.evaluate(() => document.getElementById('pause-motion').click())
    await host.locator('[data-action=calibrate]').click()
    assert.match(await host.locator('[data-role=mode]').textContent(), /Practice mode/)
    await host.locator('[data-action=stop]').click()
    assert.equal(await host.locator('video').evaluate(video => video.srcObject), null)
    if (process.env.LIVE_MEDIAPIPE === '1') {
      await host.unroute('https://cdn.jsdelivr.net/**/vision_bundle.mjs')
      // Reload to clear the ESM cache containing our synthetic detector.
      await host.reload()
      await host.getByRole('button', { name: /Collaborative/ }).click()
      await host.locator('#join-button').click()
      await host.evaluate(() => document.getElementById('pause-motion').click())
      await host.locator('[data-role=camera]').evaluate(section => { section.open = true })
    await host.locator('[data-action=start]').click()
      await host.waitForFunction(() => {
        const text = document.querySelector('[data-role=status]').textContent
        return text.startsWith('Tracking') || text.startsWith('Calibrating') || text.startsWith('Camera stopped')
      }, null, { timeout: 45000 })
      const liveStatus = await host.locator('[data-role=status]').textContent()
      assert.ok(!liveStatus.startsWith('Camera stopped'), liveStatus)
      await host.locator('[data-role=tuning] > summary').click()
      await host.locator('[data-setting=facial]').check()
      await host.waitForTimeout(8000)
      assert.equal(await host.locator('[data-setting=facial]').isChecked(), true)
      assert.ok(!(await host.locator('[data-role=status]').textContent()).includes('Loading facial'))
      await host.locator('[data-action=stop]').click()
      console.log('Live MediaPipe pose and face models initialized successfully with a synthetic camera.')
    }
    assert.deepEqual(errors, [])
    console.log('Browser checks passed: menu-only panel, QR generation, pairing, phone mining without walking, stop/unpair, saved settings, start gesture, calibration and camera cleanup.')
  } finally {
    await browser?.close()
    pairing.destroy()
    await new Promise(resolve => io.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
