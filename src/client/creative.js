'use strict'
const { renderSlot } = require('./hud')

// Vanilla's creative screen shows five rows of nine and pages the rest. There
// is no paging here, so this is the cap on how many matches get built into DOM
// at once — every cell is an image request, and the full list is 1300 items.
const MAX_RESULTS = 90

/**
 * The creative item list, and what the browser knows about creative mode.
 *
 * Nothing here turns on by itself: the server sends a `creative` state saying
 * what the Minecraft server has actually granted, and this hides completely
 * until that says creative. The catalogue arrives once, separately, because it
 * is ~77 KB.
 *
 * Clicking an item asks for a full stack, right-clicking for one, matching
 * what dragging out of vanilla's list with either button does. Slot
 * destruction lives in inventory.js, since it starts as an ordinary slot drag.
 */
class CreativeUI {
  constructor (socket) {
    this.socket = socket
    this.root = document.getElementById('creative')
    this.list = document.getElementById('creative-list')
    this.search = document.getElementById('creative-search')
    this.note = document.getElementById('creative-note')
    this.catalog = []
    this.state = { available: false, mayFly: false, flying: false, gameMode: null }
    this.onState = () => {}

    socket.on('creative', state => this._setState(state))
    socket.on('creative:catalog', catalog => {
      this.catalog = Array.isArray(catalog) ? catalog : []
      this.render()
    })

    this.search.addEventListener('input', () => this.render())
    // The inventory overlay is the only thing listening for these, and a
    // keystroke meant for the search box must not also move the bot.
    this.search.addEventListener('keydown', event => {
      event.stopPropagation()
      if (event.key === 'Escape') this.search.blur()
    })
  }

  get available () {
    return Boolean(this.state.available)
  }

  get flying () {
    return Boolean(this.state.flying)
  }

  get canFly () {
    return Boolean(this.state.mayFly)
  }

  _setState (state) {
    this.state = state || { available: false }
    this.root.classList.toggle('open', this.available)
    if (this.available) this.render()
    else this.list.innerHTML = ''
    this.onState(this.state)
  }

  /** Called when the inventory overlay opens, so the box is ready to type in. */
  focusSearch () {
    if (this.available) this.search.focus()
  }

  render () {
    if (!this.available) return
    const query = this.search.value.trim().toLowerCase()
    const matches = query
      ? this.catalog.filter(item =>
        item.name.includes(query) || item.displayName.toLowerCase().includes(query))
      : this.catalog

    this.list.innerHTML = ''
    for (const item of matches.slice(0, MAX_RESULTS)) this.list.appendChild(this.cell(item))

    const hidden = matches.length - Math.min(matches.length, MAX_RESULTS)
    this.note.textContent = matches.length === 0
      ? 'nothing matches'
      : hidden > 0
        ? `${hidden} more — narrow the search`
        : `${matches.length} item${matches.length === 1 ? '' : 's'}`
  }

  cell (item) {
    const cell = document.createElement('div')
    cell.className = 'slot'
    renderSlot(cell, { name: item.name, displayName: item.displayName, count: 1 })
    cell.title = item.displayName

    cell.addEventListener('mousedown', event => {
      if (event.button !== 0 && event.button !== 2) return
      event.preventDefault()
      this.socket.emit('creative:give', {
        name: item.name,
        count: event.button === 2 ? 1 : (item.stackSize || 64)
      })
    })
    cell.addEventListener('contextmenu', event => event.preventDefault())
    return cell
  }
}

module.exports = CreativeUI
