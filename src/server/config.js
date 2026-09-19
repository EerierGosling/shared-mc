'use strict'
require('dotenv').config()

const int = (v, d) => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : d
}

module.exports = {
  mc: {
    host: process.env.MC_HOST || 'localhost',
    port: int(process.env.MC_PORT, 25565),
    username: process.env.MC_USERNAME || 'StreamBot',
    version: process.env.MC_VERSION || '1.20.4',
    auth: process.env.MC_AUTH || 'offline'
  },
  web: {
    port: int(process.env.PORT, 3000)
  },
  viewDistance: int(process.env.VIEW_DISTANCE, 6),
  // Clamped, not just defaulted. mineflayer's canDigBlock measures eye-to-block
  // *centre* against 5.1, while blockAtCursor measures eye-to-the-face-the-ray-
  // hit. Those differ by up to half a block diagonal, so a larger reach yields
  // blocks the crosshair targets and the HUD names but the bot then refuses to
  // dig, with no error anywhere. 4.5 is vanilla survival reach and stays inside
  // the limit in the worst case.
  reach: Math.min(Number(process.env.REACH) || 4.5, 4.5),
  // Look packets are rate limited per client so a fast mouse can't spam the
  // Minecraft server hard enough to look like a cheat client.
  lookIntervalMs: int(process.env.LOOK_INTERVAL_MS, 50),
  chatIntervalMs: int(process.env.CHAT_INTERVAL_MS, 1000)
}
