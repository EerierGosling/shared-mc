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

// prismarine-windows names the crafting table window differently depending on
// protocol era - handle both rather than betting on one.
const WORKBENCH_TYPES = new Set(['minecraft:crafting', 'minecraft:crafting_table'])
const WORKBENCH_OUTPUT = 0
const WORKBENCH_GRID = [1, 2, 3, 4, 5, 6, 7, 8, 9]

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
    this.cursorItemEl = document.getElementById('cursor-item')
    this.payload = null
    this.containerOpen = false
    // A held-mouse-button path across slots. Released over one slot it's an
    // ordinary click; released over several it's a stack split (see _endDrag).
    this.drag = null

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
    this.root.addEventListener('mousemove', event => {
      this.cursorItemEl.style.left = `${event.clientX}px`
      this.cursorItemEl.style.top = `${event.clientY}px`
    })
    document.addEventListener('mouseup', event => this._endDrag(event))
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

  /** Repaint slots drawn before the icon data had loaded (see icons.js). */
  refresh () {
    if (this.isOpen) this.render()
  }

  render () {
    const payload = this.payload
    this.body.innerHTML = ''
    renderSlot(this.cursorItemEl, payload && payload.cursorItem)
    this.cursorItemEl.classList.toggle('visible', Boolean(payload && payload.cursorItem))
    if (!payload || !payload.window) {
      this.body.textContent = 'waiting for the bot…'
      return
    }

    const { window: win, isContainer } = payload
    this.title.textContent = isContainer ? (win.title || 'Container') : 'Inventory'

    if (isContainer) {
      const end = win.inventoryStart !== null ? win.inventoryStart : win.slotCount
      if (WORKBENCH_TYPES.has(win.type)) {
        this.workbenchRow(win.slots)
      } else {
        this.section('container', range(0, end), win.slots)
      }
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

  /** Recipe-book icon, 3x3 crafting grid and output slot for a crafting table. */
  workbenchRow (slots) {
    const heading = document.createElement('p')
    heading.className = 'section-label'
    heading.textContent = 'Crafting'
    this.body.appendChild(heading)

    const main = document.createElement('div')
    main.className = 'crafting-main'

    const icon = document.createElement('div')
    icon.className = 'workbench-icon'
    main.appendChild(icon)

    const grid = document.createElement('div')
    grid.className = 'grid grid-3'
    for (const slotNumber of WORKBENCH_GRID) grid.appendChild(this.slotCell(slotNumber, slots))
    main.appendChild(grid)

    const arrow = document.createElement('span')
    arrow.className = 'crafting-arrow'
    arrow.textContent = '→'
    main.appendChild(arrow)

    const outputWrap = document.createElement('div')
    outputWrap.className = 'grid grid-1'
    outputWrap.appendChild(this.slotCell(WORKBENCH_OUTPUT, slots))
    main.appendChild(outputWrap)

    this.body.appendChild(main)
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

    // Left/right button down starts a drag path; released over just the one
    // slot it's replayed as a normal click, released over several it's a
    // stack split (see _endDrag). Shift-click (quick move) fires immediately
    // instead, same as vanilla - it was never a drag gesture.
    cell.addEventListener('mousedown', event => {
      if (event.button !== 0 && event.button !== 2) return
      event.preventDefault()
      if (event.shiftKey) {
        this.socket.emit('window:click', { slot: slotNumber, mouseButton: 0, mode: 1 })
        return
      }
      this.drag = { mouseButton: event.button === 2 ? 1 : 0, path: [slotNumber] }
      cell.classList.add('drag-target')
    })
    cell.addEventListener('mouseenter', () => {
      if (!this.drag || this.drag.path.includes(slotNumber)) return
      this.drag.path.push(slotNumber)
      cell.classList.add('drag-target')
    })
    // The actual click/drag is sent from mousedown/mouseenter above; this
    // only stops the browser's own right-click menu from popping up and
    // swallowing the mouseup _endDrag needs to finish the drag.
    cell.addEventListener('contextmenu', event => event.preventDefault())
    return cell
  }

  _endDrag (event) {
    const drag = this.drag
    this.drag = null
    if (!drag) return
    for (const cell of this.body.querySelectorAll('.slot.drag-target')) cell.classList.remove('drag-target')
    // Vanilla's creative bin: let go of a stack over the item list and it is
    // gone. The server ignores this unless it is really in creative, so there
    // is nothing to check here.
    if (event && event.target && event.target.closest && event.target.closest('#creative')) {
      this.socket.emit('creative:destroy', { slot: drag.path[0] })
      return
    }
    if (drag.path.length === 1) {
      this.socket.emit('window:click', { slot: drag.path[0], mouseButton: drag.mouseButton, mode: 0 })
    } else {
      this.socket.emit('window:drag', { slots: drag.path, mouseButton: drag.mouseButton })
    }
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
