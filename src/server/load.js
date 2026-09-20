'use strict'
const { monitorEventLoopDelay } = require('perf_hooks')
const v8 = require('v8')

// How often the event-loop histogram is read and reset, so "lag" always
// means the last few seconds rather than since boot.
const SAMPLE_MS = 5000

/**
 * Whether this process has room for another bot.
 *
 * Every bot's physics, packet decoding and chunk serialisation share one
 * thread, so the honest capacity signal is not a bot count but how late the
 * event loop is running. Past the lag threshold every visitor already here
 * gets a worse stream, so a new one is refused instead. Heap is the other
 * ceiling: a bot's world copy is not reclaimed until it leaves.
 */
class Load {
  constructor ({ maxLagMs, maxHeapFraction }) {
    this.maxLagMs = maxLagMs
    this.maxHeapFraction = maxHeapFraction
    this.histogram = monitorEventLoopDelay({ resolution: 20 })
    this.histogram.enable()
    this.lag = { p50: 0, p99: 0, max: 0 }
    this.heap = { used: 0, limit: v8.getHeapStatistics().heap_size_limit, rss: 0 }
    this.timer = setInterval(() => this.sample(), SAMPLE_MS)
    this.timer.unref()
    this.sample()
  }

  sample () {
    const h = this.histogram
    // nanoseconds; the histogram reports the timer's own period as baseline
    // lag, so subtract the resolution rather than counting it as delay.
    const ms = n => Math.max(0, n / 1e6 - 20)
    this.lag = { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) }
    h.reset()
    const mem = process.memoryUsage()
    this.heap = { used: mem.heapUsed, limit: this.heap.limit, rss: mem.rss }
  }

  get heapFraction () {
    return this.heap.used / this.heap.limit
  }

  /** True while a new bot would make things worse for everyone already here. */
  get shedding () {
    return this.lag.p99 > this.maxLagMs || this.heapFraction > this.maxHeapFraction
  }

  snapshot () {
    return {
      shedding: this.shedding,
      eventLoopMs: { p50: round(this.lag.p50), p99: round(this.lag.p99), max: round(this.lag.max) },
      heapMB: { used: mb(this.heap.used), limit: mb(this.heap.limit), rss: mb(this.heap.rss) }
    }
  }

  stop () {
    clearInterval(this.timer)
    this.histogram.disable()
  }
}

const round = n => Math.round(n * 10) / 10
const mb = n => Math.round(n / 1048576)

module.exports = Load
