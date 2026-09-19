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
  reach: Number(process.env.REACH) || 5,
  // Look packets are rate limited per client so a fast mouse can't spam the
  // Minecraft server hard enough to look like a cheat client.
  lookIntervalMs: int(process.env.LOOK_INTERVAL_MS, 50),
  chatIntervalMs: int(process.env.CHAT_INTERVAL_MS, 1000)
}
