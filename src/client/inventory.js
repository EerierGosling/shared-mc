'use strict'
const { renderSlot } = require('./hud')

// Slot layout of the player window, as mineflayer numbers it.
const CRAFT_OUTPUT = 0
const CRAFT_GRID = [1, 2, 3, 4]
const ARMOR = [5, 6, 7, 8]
const MAIN_START = 9
const MAIN_END = 36
const HOTBAR_START = 36
const HOTBAR_END = 45
const OFFHAND = 45

// Vanilla draws a faint placeholder icon in these slots when they're empty.
const EMPTY_ICON = {
  5: 'empty_armor_slot_helmet',
  6: 'empty_armor_slot_chestplate',
  7: 'empty_armor_slot_leggings',
  8: 'empty_armor_slot_boots',
  45: 'empty_armor_slot_shield'
}

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

    this.craftingRow(win.slots)
    this.section('inventory', range(MAIN_START, MAIN_END), win.slots)
    this.section('hotbar', range(HOTBAR_START, HOTBAR_END), win.slots)
  }

  /** Armor column, a player bust with the offhand slot, and the 2x2 crafting grid. */
  craftingRow (slots) {
    const row = document.createElement('div')
    row.className = 'crafting-row'

    const armorCol = document.createElement('div')
    armorCol.className = 'grid grid-1'
    for (const slotNumber of ARMOR) armorCol.appendChild(this.slotCell(slotNumber, slots))
    row.appendChild(armorCol)

    const frame = document.createElement('div')
    frame.className = 'player-frame'
    frame.appendChild(playerFigure())
    const offhandWrap = document.createElement('div')
    offhandWrap.className = 'grid grid-1 offhand-wrap'
    offhandWrap.appendChild(this.slotCell(OFFHAND, slots))
    frame.appendChild(offhandWrap)
    row.appendChild(frame)

    const craftingCol = document.createElement('div')
    craftingCol.className = 'crafting-col'

    const heading = document.createElement('p')
    heading.className = 'section-label'
    heading.textContent = 'Crafting'
    craftingCol.appendChild(heading)

    const main = document.createElement('div')
    main.className = 'crafting-main'

    const grid = document.createElement('div')
    grid.className = 'grid grid-2'
    for (const slotNumber of CRAFT_GRID) grid.appendChild(this.slotCell(slotNumber, slots))
    main.appendChild(grid)

    const arrow = document.createElement('span')
    arrow.className = 'crafting-arrow'
    arrow.textContent = '→'
    main.appendChild(arrow)

    const outputWrap = document.createElement('div')
    outputWrap.className = 'grid grid-1'
    outputWrap.appendChild(this.slotCell(CRAFT_OUTPUT, slots))
    main.appendChild(outputWrap)

    craftingCol.appendChild(main)
    row.appendChild(craftingCol)

    this.body.appendChild(row)
  }

  section (label, slotNumbers, slots) {
    const heading = document.createElement('p')
    heading.className = 'section-label'
    heading.textContent = label
    this.body.appendChild(heading)

    const grid = document.createElement('div')
    grid.className = 'grid'
    for (const slotNumber of slotNumbers) grid.appendChild(this.slotCell(slotNumber, slots))
    this.body.appendChild(grid)
  }

  slotCell (slotNumber, slots) {
    const cell = document.createElement('div')
    cell.className = 'slot'
    const item = slots[slotNumber] || null
    renderSlot(cell, item)

    const emptyIcon = EMPTY_ICON[slotNumber]
    if (emptyIcon) cell.style.backgroundImage = item ? '' : `url(/assets/items/${emptyIcon}.png)`

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
    return cell
  }
}

/** A flat CSS stand-in for the vanilla 3D player preview. */
function playerFigure () {
  const figure = document.createElement('div')
  figure.className = 'player-figure'
  for (const part of ['p-hair', 'p-head', 'p-body', 'p-arm p-arm-l', 'p-arm p-arm-r', 'p-leg p-leg-l', 'p-leg p-leg-r']) {
    const i = document.createElement('i')
    i.className = part
    figure.appendChild(i)
  }
  return figure
}

function range (start, end) {
  const out = []
  for (let i = start; i < end; i++) out.push(i)
  return out
}

module.exports = InventoryUI
