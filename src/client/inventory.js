'use strict'
const { renderSlot } = require('./hud')

// Slot layout of the player window, as mineflayer numbers it.
const ARMOR = [5, 6, 7, 8]
const MAIN_START = 9
const MAIN_END = 36
const HOTBAR_START = 36
const HOTBAR_END = 45

/**
 * Inventory / container overlay. Clicks are sent straight through as window
 * clicks so mineflayer performs a real vanilla click against the server.
 */
class InventoryUI {
  constructor (socket) {
    this.socket = socket
    this.root = document.getElementById('inventory')
    this.body = document.getElementById('inventory-body')
    this.title = document.getElementById('inventory-title')
    this.payload = null
    this.containerOpen = false

    socket.on('inventory', payload => {
      this.payload = payload
      if (this.isOpen) this.render()
    })
    socket.on('window:open', () => {
      this.containerOpen = true
      this.socket.emit('inventory:get')
      this.open()
    })
    socket.on('window:close', () => {
      this.containerOpen = false
      this.close()
    })

    this.root.addEventListener('click', event => {
      if (event.target === this.root) this.close()
    })
  }

  get isOpen () {
    return this.root.classList.contains('open')
  }

  open () {
    this.socket.emit('inventory:get')
    this.root.classList.add('open')
    this.render()
  }

  close () {
    this.root.classList.remove('open')
    if (this.containerOpen) {
      this.containerOpen = false
      this.socket.emit('window:close')
    }
  }

  toggle () {
    if (this.isOpen) this.close()
    else this.open()
  }

  render () {
    const payload = this.payload
    this.body.innerHTML = ''
    if (!payload || !payload.window) {
      this.body.textContent = 'waiting for the bot…'
      return
    }

    const { window: win, isContainer } = payload
    this.title.textContent = isContainer ? (win.title || 'Container') : 'Inventory'

    if (isContainer) {
      const end = win.inventoryStart !== null ? win.inventoryStart : win.slotCount
      this.section('container', range(0, end), win.slots)
      this.section('inventory', range(end, win.slotCount), win.slots)
      return
    }

    this.section('armor', ARMOR, win.slots)
    this.section('inventory', range(MAIN_START, MAIN_END), win.slots)
    this.section('hotbar', range(HOTBAR_START, HOTBAR_END), win.slots)
  }

  section (label, slotNumbers, slots) {
    const heading = document.createElement('p')
    heading.className = 'section-label'
    heading.textContent = label
    this.body.appendChild(heading)

    const grid = document.createElement('div')
    grid.className = 'grid'
    for (const slotNumber of slotNumbers) {
      const cell = document.createElement('div')
      cell.className = 'slot'
      renderSlot(cell, slots[slotNumber] || null)
      cell.addEventListener('click', event => {
        event.preventDefault()
        this.socket.emit('window:click', {
          slot: slotNumber,
          mouseButton: 0,
          mode: event.shiftKey ? 1 : 0 // shift-click = quick move
        })
      })
      cell.addEventListener('contextmenu', event => {
        event.preventDefault()
        this.socket.emit('window:click', { slot: slotNumber, mouseButton: 1, mode: 0 })
      })
      grid.appendChild(cell)
    }
    this.body.appendChild(grid)
  }
}

function range (start, end) {
  const out = []
  for (let i = start; i < end; i++) out.push(i)
  return out
}

module.exports = InventoryUI
