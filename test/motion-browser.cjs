'use strict'
// Optional browser integration check. Install playwright-core separately and set
// PLAYWRIGHT_MODULE to its module path (or install it in your dev environment).
// Uses a local fake game session and synthetic camera/sensor data, never Minecraft.
const assert = require('node:assert/strict')
const path = require('node:path')
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
  app.get('/', (req, res) => res.sendFile(path.join(root, 'src/client/index.html')))
  app.get('/controller', (req, res) => res.sendFile(path.join(root, 'src/client/controller.html')))
  app.get('/motion.css', (req, res) => res.sendFile(path.join(root, 'src/client/motion.css')))
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
    await host.locator('#join-control-mode').selectOption('hybrid')
    await host.getByRole('button', { name: /Collaborative/ }).click()
    await host.locator('#join-button').click()
    await host.locator('#camera-controls').waitFor({ state: 'visible' })
    assert.match(await host.locator('[data-role=mode]').textContent(), /Practice mode/)
    await host.locator('[data-action=pair]').click()
    await host.locator('[data-role=pair-qr]').waitFor({ state: 'visible' })
    const code = await host.locator('[data-role=pair-code]').textContent()
    assert.match(code, /^[A-F0-9]{12}$/)
    const link = await host.locator('[data-role=pair-link]').getAttribute('href')
    assert.equal(new URL(link).hash, `#${code}`)
    assert.ok(await host.locator('[data-role=pair-qr]').evaluate(canvas => canvas.width >= 240 && canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 !== 3 && value === 0)))
    await host.screenshot({ path: '/private/tmp/shared-mc-pairing.png' })

    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const phone = await phoneContext.newPage()
    phone.on('pageerror', error => errors.push(error.message))
    await phone.goto(link)
    assert.equal(await phone.locator('#pair-code').inputValue(), code)
    assert.equal(new URL(phone.url()).hash, '')
    await phone.locator('#pair-connect').click()
    await phone.locator('#camera-controls').waitFor({ state: 'visible' })
    await host.locator('[data-role=pair-qr]').waitFor({ state: 'hidden' })
    assert.match(await host.locator('[data-role=pair-status]').textContent(), /Phone paired/)
    await host.locator('[data-action=arm]').click()
    await phone.locator('[data-action=motion]').click()
    await phone.locator('[data-action=arm]').click()
    const sendAcceleration = y => phone.evaluate(value => {
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 0, y: value, z: 0 } }))
    }, y)
    await sendAcceleration(0)
    await phone.waitForTimeout(80)
    await sendAcceleration(4)
    await phone.waitForTimeout(350)
    await sendAcceleration(0)
    await phone.waitForTimeout(80)
    await sendAcceleration(4)
    await phone.waitForTimeout(200)
    assert.ok(packets.some(state => state.forward && state.jump), 'Phone steps move the player with autojump')
    await phone.locator('[data-action=stop]').click()
    await phone.waitForTimeout(200)
    assert.equal(packets.filter(p => 'forward' in p).at(-1).forward, false)
    await phone.locator('[data-role=tuning] > summary').click()
    await phone.locator('[data-setting=stepThreshold]').fill('0.22')
    assert.match(await phone.locator('[data-role=mode]').textContent(), /Practice/)
    assert.equal(await phone.evaluate(() => JSON.parse(localStorage.getItem('motion-settings-v1')).stepThreshold), 0.22)
    await phone.screenshot({ path: '/private/tmp/shared-mc-phone.png', fullPage: true })
    await phone.locator('#pair-disconnect').click()
    await host.waitForFunction(() => document.querySelector('[data-role=pair-status]').textContent.includes('disconnected'))

    // Exercise the camera pipeline using deterministic landmark output. This
    // validates calibration and cleanup; hardware/model accuracy is separate.
    await host.route('https://cdn.jsdelivr.net/**/vision_bundle.mjs', route => route.fulfill({
      contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' },
      body: `export const FilesetResolver = { forVisionTasks: async () => ({}) };
        export const PoseLandmarker = { createFromOptions: async () => ({ close() {}, detectForVideo() {
          const p = Array.from({length:33}, () => ({x:.5,y:.5,visibility:1}));
          p[0].y=.2; p[11].x=.6;p[12].x=.4;p[11].y=p[12].y=.4;
          p[23].y=p[24].y=.65;p[25].y=p[26].y=.8;p[27].y=p[28].y=.95;
          return {landmarks: [p]};
        } }) };
        export const FaceLandmarker = { createFromOptions: async () => ({close(){},detectForVideo(){return {faceBlendshapes:[]}}}) };`
    }))
    await host.locator('[data-action=start]').click()
    await host.waitForFunction(() => document.querySelector('[data-role=status]').textContent.startsWith('Tracking'), { timeout: 10000 })
    await host.locator('[data-action=arm]').click()
    assert.match(await host.locator('[data-role=mode]').textContent(), /Player control enabled/)
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
    await host.reload()
    assert.equal(await host.locator('#join-control-mode').inputValue(), 'hybrid')
    assert.deepEqual(errors, [])
    console.log('Browser checks passed: opening selection, QR generation, pairing, phone steps/autojump, stop/unpair, saved settings, calibration and camera cleanup.')
  } finally {
    await browser?.close()
    pairing.destroy()
    await new Promise(resolve => io.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
