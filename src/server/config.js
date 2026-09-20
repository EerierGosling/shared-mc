'use strict'
require('dotenv').config()
const { execSync } = require('child_process')

// The join screen shows which build is serving. Docker images carry no .git,
// so the Dockerfile bakes the hash into COMMIT and that is preferred.
function commitHash () {
  if (process.env.COMMIT) return String(process.env.COMMIT).slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch (err) {
    return 'unknown'
  }
}

const int = (v, d) => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : d
}

module.exports = {
  mc: {
    // Visitors type the server they want on the join screen. MC_HOST is only
    // a default for anyone who leaves that blank, and there is none unless set.
    host: process.env.MC_HOST || null,
    port: int(process.env.MC_PORT, 25565),
    // What the join screen shows as the placeholder. Under compose MC_HOST is
    // an internal service name that means nothing outside the network.
    publicHost: process.env.MC_PUBLIC_HOST || process.env.MC_HOST || null,
    username: process.env.MC_USERNAME || 'StreamBot',
    version: process.env.MC_VERSION || '1.20.4',
    auth: process.env.MC_AUTH || 'offline'
  },
  web: {
    port: int(process.env.PORT, 3000)
  },
  commit: commitHash(),
  viewDistance: int(process.env.VIEW_DISTANCE, 6),
  // Clamped, not just defaulted. mineflayer's canDigBlock measures eye-to-block
  // *centre* against 5.1, while blockAtCursor measures eye-to-the-face-the-ray-
  // hit. Those differ by up to half a block diagonal, so a larger reach yields
  // blocks the crosshair targets and the HUD names but the bot then refuses to
  // dig, with no error anywhere. 4.5 is vanilla survival reach and stays inside
  // the limit in the worst case.
  reach: Math.min(Number(process.env.REACH) || 4.5, 4.5),
  // Every visitor gets their own bot, and every bot is a real login, so this is
  // bounded by the Minecraft server's max-players. Clamped further at startup
  // once we have pinged it; MAX_BOTS only ever lowers that.
  maxBots: int(process.env.MAX_BOTS, 8),
  // Headroom left for humans playing on the same server without our bots
  // filling every slot.
  playerSlotsReserved: int(process.env.PLAYER_SLOTS_RESERVED, 2),
  // Anti-grief budgets, per visitor. Each is "how many in the window", refused
  // once spent rather than queued, so a client cannot bank actions by idling.
  limits: {
    windowMs: int(process.env.LIMIT_WINDOW_MS, 10000),
    dig: int(process.env.LIMIT_DIG, 40),
    place: int(process.env.LIMIT_PLACE, 40),
    attack: int(process.env.LIMIT_ATTACK, 20),
    drop: int(process.env.LIMIT_DROP, 5),
    // Creative gives are free items out of nothing, so they are budgeted like
    // any other action a visitor can hold down.
    give: int(process.env.LIMIT_GIVE, 30)
  },
  // How often a member's look is applied to the bot; extra samples inside the
  // window coalesce (latest wins) rather than drop. This does not shield the
  // Minecraft server — bot.look(force) writes no packet, mineflayer sends
  // yaw/pitch once per 50ms physics tick regardless — it only bounds per-client
  // work, so it sits below the tick so every tick snapshots a fresh sample.
  lookIntervalMs: int(process.env.LOOK_INTERVAL_MS, 15),
  chatIntervalMs: int(process.env.CHAT_INTERVAL_MS, 1000)
}
