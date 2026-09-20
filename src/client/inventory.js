'use strict'
const { renderSlot } = require('./hud')
const { skinUrl } = require('./join')

// Slot layout of the player window, as mineflayer numbers it.
const CRAFT_OUTPUT = 0
const CRAFT_GRID = [1, 2, 3, 4]
const ARMOR = [5, 6, 7, 8]
const MAIN_START = 9
const OFFHAND = 45

// prismarine-windows names the crafting table window differently depending on
// protocol era - handle both rather than betting on one.
const WORKBENCH_TYPES = new Set(['minecraft:crafting', 'minecraft:crafting_table'])
const WORKBENCH_OUTPUT = 0
const WORKBENCH_GRID = [1, 2, 3, 4, 5, 6, 7, 8, 9]

// Vanilla draws a faint placeholder icon in these player-window slots when
// they're empty. Keyed by slot number, so only playerWindow may consult it:
// slot 5 of a chest is just a chest slot.
const EMPTY_ICON = {
  5: 'empty_armor_slot_helmet',
  6: 'empty_armor_slot_chestplate',
  7: 'empty_armor_slot_leggings',
  8: 'empty_armor_slot_boots',
  45: 'empty_armor_slot_shield'
}

// Every window is the vanilla container sheet drawn at GUI scale with slots
// laid over it at the texture's own coordinates (top-left of each 18x18
// cell, in texture pixels), so nothing here is a lookalike: the frame, the
// slot bevels and the arrows are the real `gui/container/*.png`. The
// player's rows sit at the same place in every 166-tall window.
const SHEET = '/assets/gui/container'
const PLAYER_ROWS_Y = 83
const HOTBAR_Y = 141
const SLOT_X = 7

/**
 * Inventory / container overlay. Clicks are sent straight through as window
 * clicks so mineflayer performs a real vanilla click against the server.
 */
class InventoryUI {
  constructor (socket) {
    this.socket = socket
    this.root = document.getElementById('inventory')
    this.body = document.getElementById('inventory-body')
    this.cursorItemEl = document.getElementById('cursor-item')
    this.payload = null
    this.containerOpen = false
    this.skin = 'steve'
    // A held-mouse-button path across slots while the cursor carries a stack,
    // vanilla's drag split. Released over one slot it's an ordinary click;
    // released over several it's a stack split (see _endDrag).
    this.drag = null
    this.cells = new Map() // slot number -> its element, for the drag preview

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

  /** The player figure in the inventory window wears the visitor's skin. */
  setSkin (skin) {
    if (skin) this.skin = skin
    if (this.isOpen) this.render()
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
    this.cells.clear()
    renderSlot(this.cursorItemEl, payload && payload.cursorItem)
    this.cursorItemEl.classList.toggle('visible', Boolean(payload && payload.cursorItem))
    if (!payload || !payload.window) {
      this.body.textContent = 'waiting for the bot…'
      return
    }

    const { window: win, isContainer } = payload
    if (!isContainer) {
      this.body.appendChild(this.playerWindow(win.slots))
      return
    }
    if (WORKBENCH_TYPES.has(win.type)) {
      this.body.appendChild(this.workbenchWindow(win.slots))
      return
    }
    // Chests, barrels and shulkers are drawn as vanilla draws them. Anything
    // else (furnace, hopper, ...) has no layout of its own here and borrows
    // the chest sheet, so its slots at least land on real slot art.
    const end = win.inventoryStart !== null ? win.inventoryStart : win.slotCount
    this.body.appendChild(this.chestWindow(win, Math.ceil(end / 9), end))
  }

  /** Armor column, player figure with the offhand slot, 2x2 crafting, recipe book. */
  playerWindow (slots) {
    const win = this.window('inventory', 166)
    ARMOR.forEach((slotNumber, i) => {
      win.appendChild(this.slotCell(slotNumber, slots, SLOT_X, 7 + 18 * i, EMPTY_ICON[slotNumber]))
    })
    win.appendChild(this.slotCell(OFFHAND, slots, 76, 61, EMPTY_ICON[OFFHAND]))
    win.appendChild(label('Crafting', 97, 8))
    CRAFT_GRID.forEach((slotNumber, i) => {
      win.appendChild(this.slotCell(slotNumber, slots, 97 + 18 * (i % 2), 17 + 18 * Math.floor(i / 2)))
    })
    win.appendChild(this.slotCell(CRAFT_OUTPUT, slots, 153, 27))
    win.appendChild(recipeBook(104, 61))
    win.appendChild(this.doll())
    this.playerRows(win, slots, MAIN_START, PLAYER_ROWS_Y, HOTBAR_Y)
    return win
  }

  /** Recipe book, 3x3 crafting grid and the big output slot of a crafting table. */
  workbenchWindow (slots) {
    const win = this.window('crafting_table', 166)
    win.appendChild(label('Crafting', 29, 6))
    win.appendChild(recipeBook(5, 34))
    WORKBENCH_GRID.forEach((slotNumber, i) => {
      win.appendChild(this.slotCell(slotNumber, slots, 29 + 18 * (i % 3), 16 + 18 * Math.floor(i / 3)))
    })
    // The output sits in a 26x26 frame; the item is drawn centred in it.
    const output = this.slotCell(WORKBENCH_OUTPUT, slots, 123, 30)
    output.classList.add('slot-large')
    win.appendChild(output)
    this.playerRows(win, slots, 10, PLAYER_ROWS_Y, HOTBAR_Y)
    return win
  }

  /**
   * generic_54.png holds a six-row chest; vanilla draws its top `rows` rows
   * then the player half from further down the sheet, so the window grows
   * with the container. Same two pieces here.
   */
  chestWindow (win, rows, end) {
    const split = rows * 18 + 17
    const el = this.window('generic_54', split + 96)
    const bottom = document.createElement('div')
    bottom.className = 'window-lower'
    bottom.style.top = `calc(${split} * var(--u))`
    el.appendChild(bottom)

    el.appendChild(label(win.title || 'Chest', 8, 6))
    for (let i = 0; i < end; i++) {
      el.appendChild(this.slotCell(i, win.slots, SLOT_X + 18 * (i % 9), 17 + 18 * Math.floor(i / 9)))
    }
    el.appendChild(label('Inventory', 8, split + 3))
    this.playerRows(el, win.slots, end, split + 13, split + 71)
    return el
  }

  /** Three rows of main inventory then the hotbar, both starting at `first`. */
  playerRows (win, slots, first, rowsY, hotbarY) {
    for (let i = 0; i < 27; i++) {
      win.appendChild(this.slotCell(first + i, slots, SLOT_X + 18 * (i % 9), rowsY + 18 * Math.floor(i / 9)))
    }
    for (let i = 0; i < 9; i++) {
      win.appendChild(this.slotCell(first + 27 + i, slots, SLOT_X + 18 * i, hotbarY))
    }
  }

  window (sheet, height) {
    const el = document.createElement('div')
    el.className = 'window'
    el.style.height = `calc(${height} * var(--u))`
    el.style.backgroundImage = `url(${SHEET}/${sheet}.png)`
    return el
  }

  /** The same front-view skin cutout the join screen shows, in the black frame. */
  doll () {
    const doll = document.createElement('div')
    doll.className = 'doll window-doll'
    doll.style.setProperty('--skin', `url(${skinUrl(this.skin)})`)
    for (const part of ['arm-r', 'sleeve-r', 'arm-l', 'sleeve-l', 'leg-r', 'pants-r', 'leg-l', 'pants-l', 'body', 'jacket', 'head', 'hat']) {
      const i = document.createElement('i')
      i.className = `d-${part}`
      doll.appendChild(i)
    }
    return doll
  }

  slotCell (slotNumber, slots, x, y, emptyIcon) {
    const cell = document.createElement('div')
    cell.className = 'slot'
    cell.style.left = `calc(${x} * var(--u))`
    cell.style.top = `calc(${y} * var(--u))`
    const item = slots[slotNumber] || null
    renderSlot(cell, item)
    if (emptyIcon && !item) cell.style.backgroundImage = `url(/assets/items/${emptyIcon}.png)`
    this.cells.set(slotNumber, cell)

    // A press starts a gesture that ends on release (see _endDrag): over one
    // slot it is a click on the slot pressed, over several with a stack on
    // the cursor it is vanilla's drag split. With an empty cursor no path is
    // collected at all, so a hand that slips onto the next slot on the way up
    // cannot scatter the stack it is picking up. Shift-click (quick move)
    // fires at once, same as vanilla - it was never a drag gesture.
    cell.addEventListener('mousedown', event => {
      if (event.button !== 0 && event.button !== 2) return
      event.preventDefault()
      if (event.shiftKey) {
        this.socket.emit('window:click', { slot: slotNumber, mouseButton: 0, mode: 1 })
        return
      }
      this.drag = { mouseButton: event.button === 2 ? 1 : 0, origin: slotNumber, path: [] }
      this._dragOver(slotNumber)
    })
    cell.addEventListener('mouseenter', () => this._dragOver(slotNumber))
    // The actual click/drag is sent from mousedown/mouseenter above; this
    // only stops the browser's own right-click menu from popping up and
    // swallowing the mouseup _endDrag needs to finish the drag.
    cell.addEventListener('contextmenu', event => event.preventDefault())
    return cell
  }

  get cursorItem () {
    return (this.payload && this.payload.cursorItem) || null
  }

  /** The crafting result slot of the open window, if it has one. */
  get outputSlot () {
    const win = this.payload && this.payload.window
    if (!win) return null
    if (!this.payload.isContainer) return CRAFT_OUTPUT
    return WORKBENCH_TYPES.has(win.type) ? WORKBENCH_OUTPUT : null
  }

  /**
   * Vanilla adds a slot to the drag only if the held stack can go there: not
   * the crafting output, and empty or the same item with room. A left drag
   * gives every slot at least one, so it takes no more slots than items.
   */
  _dragOver (slotNumber) {
    const drag = this.drag
    const held = this.cursorItem
    if (!drag || !held || drag.path.includes(slotNumber)) return
    if (slotNumber === this.outputSlot) return
    const existing = this.payload.window.slots[slotNumber]
    if (existing && (existing.name !== held.name || existing.count >= held.stackSize)) return
    if (drag.mouseButton === 0 && drag.path.length >= held.count) return
    drag.path.push(slotNumber)
    this._previewDrag()
  }

  /**
   * What the split will leave in each slot and on the cursor, drawn before
   * the server has been asked, the way vanilla previews it: the held item
   * ghosted into each slot at its projected count, and the cursor stack
   * counting down to what stays behind.
   */
  _previewDrag () {
    const { path, mouseButton } = this.drag
    const held = this.cursorItem
    const share = mouseButton === 0 ? Math.floor(held.count / path.length) : 1
    let dealt = 0
    for (const slot of path) {
      const existing = this.payload.window.slots[slot]
      const before = existing ? existing.count : 0
      const after = Math.min(held.stackSize, before + share)
      dealt += after - before
      const cell = this.cells.get(slot)
      if (!cell) continue
      renderSlot(cell, { ...held, count: after })
      cell.classList.add('drag-target')
    }
    const left = held.count - dealt
    renderSlot(this.cursorItemEl, left > 0 ? { ...held, count: left } : null)
    this.cursorItemEl.classList.toggle('visible', left > 0)
  }

  _endDrag (event) {
    const drag = this.drag
    this.drag = null
    if (!drag) return
    // Put the preview back the way the server last said; its answer to the
    // click follows on the next inventory push.
    this.render()
    // Vanilla's creative bin: let go of a stack over the item list and it is
    // gone. The server ignores this unless it is really in creative, so there
    // is nothing to check here.
    if (event && event.target && event.target.closest && event.target.closest('#creative')) {
      this.socket.emit('creative:destroy', { slot: drag.origin })
      return
    }
    if (drag.path.length < 2) {
      this.socket.emit('window:click', { slot: drag.origin, mouseButton: drag.mouseButton, mode: 0 })
    } else {
      this.socket.emit('window:drag', { slots: drag.path, mouseButton: drag.mouseButton })
    }
  }
}

function label (text, x, y) {
  const el = document.createElement('span')
  el.className = 'window-label'
  el.textContent = text
  el.style.left = `calc(${x} * var(--u))`
  el.style.top = `calc(${y} * var(--u))`
  return el
}

/** Vanilla's recipe book toggle. Drawn for fidelity; there is no book behind it. */
function recipeBook (x, y) {
  const el = document.createElement('div')
  el.className = 'recipe-book'
  el.style.left = `calc(${x} * var(--u))`
  el.style.top = `calc(${y} * var(--u))`
  return el
}

module.exports = InventoryUI
