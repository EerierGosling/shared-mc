'use strict'

/**
 * Counters the rest of the server bumps, and the two routes that read them.
 *
 * Module-level on purpose: worldStream.js and sessions.js increment these
 * from deep inside a session and threading a metrics object through every
 * constructor buys nothing. Everything here is a plain number a reader can
 * difference between two scrapes.
 */
const counters = {
  startedAt: Date.now(),
  columnsSerialized: 0, // column.toJson() calls: the expensive half of a chunk
  columnsSent: 0, // loadChunk messages, cached or not
  chunkBytes: 0, // uncompressed JSON bytes handed to socket.io
  joins: 0,
  joinsRefused: Object.create(null), // reason -> count
  pings: 0, // real pings sent, as opposed to cache hits
  expired: 0, // solo sessions reclaimed for idleness
  gone: 0 // sessions torn down because the bot could not stay on its server
}

function refused (reason) {
  counters.joinsRefused[reason] = (counters.joinsRefused[reason] || 0) + 1
}

function snapshot (sessions, io, load) {
  const perServer = {}
  for (const [key, set] of sessions.byServer) {
    let solo = 0
    let riders = 0
    for (const s of set) {
      if (s.mode === 'solo') solo += 1
      else riders += s.size
    }
    perServer[key] = { bots: set.size, solo, riders }
  }
  return {
    uptimeSeconds: Math.round((Date.now() - counters.startedAt) / 1000),
    sockets: io.sockets.sockets.size,
    bots: sessions.botCount,
    capacity: sessions.capacity,
    riders: sessions.roadtripRiders,
    servers: perServer,
    load: load.snapshot(),
    counters: {
      columnsSerialized: counters.columnsSerialized,
      columnsSent: counters.columnsSent,
      chunkMB: Math.round(counters.chunkBytes / 1048576),
      joins: counters.joins,
      joinsRefused: counters.joinsRefused,
      pings: counters.pings,
      expired: counters.expired,
      gone: counters.gone
    }
  }
}

/**
 * /healthz answers a load balancer: 503 while shedding, so traffic goes
 * elsewhere before visitors see the busy message. /metrics is for a human
 * or a scraper deciding what MAX_BOTS should be on this box.
 */
function install (app, sessions, io, load) {
  app.get('/healthz', (req, res) => {
    const ok = !load.shedding
    res.status(ok ? 200 : 503).json({ ok, bots: sessions.botCount, sockets: io.sockets.sockets.size, uptime: Math.round(process.uptime()) })
  })
  app.get('/metrics', (req, res) => res.json(snapshot(sessions, io, load)))

  // One line a minute so a log tail shows the shape of the load over time
  // without anyone having to be scraping.
  const timer = setInterval(() => {
    const s = snapshot(sessions, io, load)
    console.log(`load: ${s.bots} bots ${s.riders} riders ${s.sockets} sockets ` +
      `lag p99 ${s.load.eventLoopMs.p99}ms heap ${s.load.heapMB.used}/${s.load.heapMB.limit}MB` +
      (s.load.shedding ? ' SHEDDING' : ''))
  }, 60000)
  timer.unref()
}

module.exports = { counters, refused, snapshot, install }
