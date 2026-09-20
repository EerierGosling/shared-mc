'use strict'

/**
 * Vanilla's game menu: what Escape shows over a paused (well, dimmed) world.
 *
 * Nothing actually pauses — the bot keeps standing on a live server, and in a
 * road trip someone else may still be driving — so this is a resume button,
 * a way out, the controls, and where the bot really is. The controls used to
 * sit permanently in a corner of the HUD; here they only cost screen space
 * while you are looking for them.
 *
 * The world keeps rendering underneath, and the held keys are released by
 * whoever opens this (pointer lock going away does it on desktop), so a
 * menu on screen never means a bot walking into lava.
 *
 * Like vanilla's Options, the motion controls are a page of this menu, not
 * a window over it: "Motion Controls..." swaps the main page out for the
 * setup panel (mounted in here by camera-controls.js) and Done or Escape
 * brings the main page back. onPage tells the owner which one is showing.
 */
class PauseMenu {
  constructor ({ onResume, onQuit, onPage, onAdvancements }) {
    this.root = document.getElementById('pause')
    this.main = document.getElementById('pause-main')
    this.serverLine = document.getElementById('pause-server')
    this.addressLine = document.getElementById('pause-address')
    this.server = null
    this.openedAt = 0
    this.page = 'main'
    this.onPage = onPage

    document.getElementById('pause-resume').addEventListener('click', () => onResume())
    document.getElementById('pause-quit').addEventListener('click', () => onQuit())
    document.getElementById('pause-motion').addEventListener('click', () => { this.open(); this.showPage('motion') })
    // Aim and per-action tuning; a page of this menu like the motion controls.
    document.getElementById('pause-settings').addEventListener('click', () => { this.open(); this.showPage('settings') })
    // The advancements screen is its own overlay, not a page of this menu:
    // it also opens from the L key with no menu involved.
    document.getElementById('pause-advancements').addEventListener('click', () => { this.close(); onAdvancements() })
  }

  get isOpen () {
    return this.root.classList.contains('open')
  }

  showPage (page) {
    if (page === this.page) return
    this.page = page
    this.main.hidden = page !== 'main'
    this.root.scrollTop = 0
    this.onPage(page)
  }

  // True for a moment after opening: long enough to swallow the keydown of
  // the Escape that released pointer lock in browsers that deliver it.
  get justOpened () {
    return Date.now() - this.openedAt < 250
  }

  open () {
    if (this.isOpen) return
    this.root.classList.add('open')
    document.body.classList.add('paused')
    this.openedAt = Date.now()
    this.render()
  }

  // Closes on the main page, so the next Escape lands there.
  close () {
    this.showPage('main')
    this.root.classList.remove('open')
    document.body.classList.remove('paused')
  }

  /**
   * { host, port, address } — host and port are what the visitor typed (or
   * the default), address is the IP the bot's socket connected to, or null
   * until a bot is up. Arrives with join:accepted and every bot:status.
   */
  setServer (server) {
    if (!server) return
    this.server = { ...this.server, ...server }
    if (this.isOpen) this.render()
  }

  render () {
    const s = this.server
    if (!s) {
      this.serverLine.textContent = 'not connected'
      this.addressLine.textContent = ''
      return
    }
    const port = s.port ? `:${s.port}` : ''
    this.serverLine.textContent = `${s.host}${port}`
    // The IP is only worth a line when it says something the host does not.
    if (!s.address) this.addressLine.textContent = 'resolving…'
    else if (s.address === s.host) this.addressLine.textContent = ''
    else this.addressLine.textContent = `${s.address}${port}`
  }
}

module.exports = PauseMenu
