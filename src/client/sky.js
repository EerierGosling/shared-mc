'use strict'

const THREE = global.THREE || require('three')

// prismarine-viewer hardcodes scene.background to 'lightblue' and never touches
// it again (viewer.js). bot.time.timeOfDay runs 0-24000 per Minecraft day
// (0 = sunrise, 6000 = noon, 12000 = sunset, 18000 = midnight), so we drive the
// sky/lighting off that ourselves. Keyframes below get lerped between.
//
// Each keyframe carries two sky colors, not one: `horizon` is what vanilla
// paints near the horizon (the warm sunset/sunrise band lives here) and
// `zenith` is straight up. skyDome blends between them per-pixel — a flat
// scene.background color is what a *box* looks like, not a sky.
const DAY_LENGTH = 24000
const CELESTIAL_RADIUS = 400
const DOME_RADIUS = CELESTIAL_RADIUS * 1.2
const STAR_COUNT = 1500

const KEYFRAMES = [
  { t: 0, horizon: 0xfcb46b, zenith: 0x6a89c9, ambient: 0.41, sun: 0.41, sunColor: 0xffd9a0 },
  { t: 2000, horizon: 0xbfe3f5, zenith: 0x4a90d9, ambient: 0.64, sun: 0.64, sunColor: 0xffffff },
  { t: 6000, horizon: 0x9fd8f0, zenith: 0x2f6fb0, ambient: 0.68, sun: 0.68, sunColor: 0xffffff },
  { t: 10000, horizon: 0xbfe3f5, zenith: 0x4a90d9, ambient: 0.64, sun: 0.64, sunColor: 0xffffff },
  { t: 12000, horizon: 0xfb8b5b, zenith: 0x4a3f6b, ambient: 0.38, sun: 0.38, sunColor: 0xffab66 },
  { t: 13000, horizon: 0x2b2f5b, zenith: 0x05060f, ambient: 0.15, sun: 0.06, sunColor: 0x4a5a8a },
  { t: 18000, horizon: 0x0a0e1c, zenith: 0x000000, ambient: 0.09, sun: 0.015, sunColor: 0x223355 },
  { t: 22000, horizon: 0x2b2f5b, zenith: 0x05060f, ambient: 0.15, sun: 0.06, sunColor: 0x4a5a8a },
  { t: DAY_LENGTH, horizon: 0xfcb46b, zenith: 0x6a89c9, ambient: 0.41, sun: 0.41, sunColor: 0xffd9a0 }
]

function findSegment (t) {
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    if (t >= KEYFRAMES[i].t && t <= KEYFRAMES[i + 1].t) return [KEYFRAMES[i], KEYFRAMES[i + 1]]
  }
  return [KEYFRAMES[0], KEYFRAMES[1]]
}

// Sun and moon ride opposite ends of one fixed circle around the player; the
// small z nudge keeps the arc off the exact X axis so it doesn't ever look
// like it's moving edge-on.
function celestialDirection (fraction) {
  const theta = fraction * Math.PI * 2
  return new THREE.Vector3(-Math.cos(theta), Math.sin(theta), 0.2).normalize()
}

// A big sphere around the camera, shaded top-to-bottom between two flat
// colors in the fragment shader. Object-space position is used (not world
// position) so the gradient stays correct no matter how far the dome has
// been translated to follow the player through the world.
function buildSkyDome () {
  const geometry = new THREE.SphereGeometry(DOME_RADIUS, 24, 16)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x6a89c9) },
      bottomColor: { value: new THREE.Color(0xfcb46b) },
      exponent: { value: 0.6 }
    },
    vertexShader: `
      varying vec3 vPosition;
      void main() {
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float exponent;
      varying vec3 vPosition;
      void main() {
        float h = normalize(vPosition).y;
        gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false
  })
  const dome = new THREE.Mesh(geometry, material)
  dome.renderOrder = -3
  return dome
}

// Picking (theta, phi) directly and looping phi over [0, PI/2] bunches points
// at the pole (straight up) — the area a band of phi covers shrinks to zero
// there (it scales with sin(phi)), so a uniform phi wildly overcounts it.
// Vanilla's LevelRenderer.renderStars sidesteps this with rejection sampling
// inside a cube and only keeping points that land inside the unit sphere,
// which is uniform over the whole sphere by construction; we do the same and
// throw away the lower hemisphere instead of ever generating it.
function buildStars () {
  const positions = new Float32Array(STAR_COUNT * 3)
  const brightness = new Float32Array(STAR_COUNT * 3)
  let i = 0
  while (i < STAR_COUNT) {
    const x = Math.random() * 2 - 1
    const y = Math.random() * 2 - 1
    const z = Math.random() * 2 - 1
    const lengthSq = x * x + y * y + z * z
    if (lengthSq > 1 || lengthSq < 0.01 || y < 0) continue

    const scale = CELESTIAL_RADIUS / Math.sqrt(lengthSq)
    positions[i * 3] = x * scale
    positions[i * 3 + 1] = y * scale
    positions[i * 3 + 2] = z * scale

    // Vanilla varies each star's quad size (~0.15-0.25); we're stuck with a
    // uniform point size, so vary brightness instead to fake the twinkle.
    const b = 0.25 + Math.random() * 0.4
    brightness[i * 3] = brightness[i * 3 + 1] = brightness[i * 3 + 2] = b
    i++
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(brightness, 3))
  const material = new THREE.PointsMaterial({
    vertexColors: true,
    size: 1.5,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false
  })
  const points = new THREE.Points(geometry, material)
  points.renderOrder = -1
  return points
}

// Real vanilla sprites (served out of minecraft-assets, same as the HUD).
// They ship with no alpha channel at all (sips -g hasAlpha says no) — vanilla
// draws them with additive blending so the black background contributes
// nothing and only the bright disc shows. Alpha-blending them instead is what
// painted a solid black square over the sky.
//
// moon_phases.png is a 4x2 sheet; we don't track the Minecraft day count
// anywhere in this project, so the moon is just pinned to one phase (full).
function loadCelestialTexture (path, uv) {
  const texture = new THREE.TextureLoader().load(path)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  if (uv) {
    texture.offset.set(uv.x, uv.y)
    texture.repeat.set(uv.w, uv.h)
  }
  return texture
}

function buildBillboard (size, texture) {
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(size, size, 1)
  sprite.renderOrder = -1
  return sprite
}

/** Builds the dome/stars/sun/moon and adds them to the scene. Call once per viewer. */
function createSky (viewer) {
  const dome = buildSkyDome()
  const stars = buildStars()
  const sun = buildBillboard(120, loadCelestialTexture('/assets/environment/sun.png'))
  const moon = buildBillboard(90, loadCelestialTexture('/assets/environment/moon_phases.png', { x: 0, y: 0.5, w: 0.25, h: 0.5 }))
  viewer.scene.add(dome, stars, sun, moon)
  return { dome, stars, sun, moon }
}

function applySkyForTime (viewer, timeOfDay, sky) {
  const t = ((timeOfDay % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH
  const fraction = t / DAY_LENGTH
  const [from, to] = findSegment(t)
  const span = to.t - from.t
  const frac = span === 0 ? 0 : (t - from.t) / span

  const sunColor = new THREE.Color(from.sunColor).lerp(new THREE.Color(to.sunColor), frac)
  const ambient = from.ambient + (to.ambient - from.ambient) * frac

  viewer.ambientLight.intensity = ambient
  viewer.directionalLight.intensity = from.sun + (to.sun - from.sun) * frac
  viewer.directionalLight.color = sunColor

  if (!sky) return

  const horizon = new THREE.Color(from.horizon).lerp(new THREE.Color(to.horizon), frac)
  const zenith = new THREE.Color(from.zenith).lerp(new THREE.Color(to.zenith), frac)
  sky.dome.material.uniforms.bottomColor.value.copy(horizon)
  sky.dome.material.uniforms.topColor.value.copy(zenith)

  // Reuses the ambient keyframe curve so stars/moon fade in exactly as the
  // sky darkens, instead of keying off timeOfDay again with new thresholds.
  const nightFactor = THREE.MathUtils.clamp((0.5 - ambient) / (0.5 - 0.2), 0, 1)
  const direction = celestialDirection(fraction)
  const center = viewer.camera.position

  sky.dome.position.copy(center)

  sky.stars.position.copy(center)
  sky.stars.material.opacity = nightFactor

  sky.sun.position.copy(center).addScaledVector(direction, CELESTIAL_RADIUS)
  sky.sun.material.opacity = 1 - nightFactor

  sky.moon.position.copy(center).addScaledVector(direction, -CELESTIAL_RADIUS)
  sky.moon.material.opacity = nightFactor
}

module.exports = { createSky, applySkyForTime }
