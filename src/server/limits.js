'use strict'

/**
 * Per-visitor action budgets.
 *
 * Everyone shares one world, so one person holding left click must not be able
 * to strip-mine it. Each action kind gets a fixed allowance per rolling window;
 * spending it refuses further attempts until the window rolls, rather than
 * queueing them, so nobody can bank actions by idling and then dump them.
 *
 * The refusal is reported back to the browser instead of being swallowed. A
 * silent throttle is indistinguishable from lag and gets read as a bug.
 */
class Budget {
  constructor (limits) {
    this.limits = limits
    this.spent = Object.create(null)
    this.windowStart = Date.now()
  }

  _roll () {
    const now = Date.now()
    if (now - this.windowStart < this.limits.windowMs) return
    this.windowStart = now
    this.spent = Object.create(null)
  }

  /** True if the action is allowed, and counts it. False means refused. */
  take (kind) {
    const allowance = this.limits[kind]
    if (typeof allowance !== 'number') return true
    this._roll()
    const used = this.spent[kind] || 0
    if (used >= allowance) return false
    this.spent[kind] = used + 1
    return true
  }

  /** Seconds until `kind` is spendable again, for the message to the browser. */
  retryInSeconds () {
    const remaining = this.limits.windowMs - (Date.now() - this.windowStart)
    return Math.max(1, Math.ceil(remaining / 1000))
  }
}

module.exports = { Budget }
