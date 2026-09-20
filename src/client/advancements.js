'use strict'
const icons = require('./icons')

// Vanilla keeps an advancement toast up this long.
const TOAST_MS = 5000

const HEADLINES = {
  task: 'Advancement Made!',
  goal: 'Goal Reached!',
  challenge: 'Challenge Complete!'
}

/**
 * The advancement toast and the advancements screen.
 *
 * The server relays the bot's tree as `advancements` deltas — `reset` wipes
 * the local copy, `entries` upsert, `removed` delete — and fires
 * `advancement:earned` for each one newly completed. Entries arrive in the
 * server's own order, which is parent before child, so grouping by root as
 * they come gives vanilla's tabs without a tree walk.
 *
 * The toast is vanilla's 160x32 sprite with the icon at (8,8) and two lines
 * of text from x=30, measured in --u like the rest of the HUD. Toasts queue
 * and show one at a time, as vanilla's do.
 */
class AdvancementsUI {
  constructor () {
    this.root = document.getElementById('advancements')
    this.list = document.getElementById('advancements-list')
    this.summary = document.getElementById('advancements-summary')
    this.toast = document.getElementById('toast')
    this.entries = new Map() // id -> entry, in arrival order
    this.queue = []
    this.toastTimer = null
    document.getElementById('advancements-close').addEventListener('click', () => this.close())
  }

  get isOpen () {
    return this.root.classList.contains('open')
  }

  open () {
    this.root.classList.add('open')
    this.render()
  }

  close () {
    this.root.classList.remove('open')
  }

  toggle () {
    if (this.isOpen) this.close()
    else this.open()
  }

  /** { reset, entries, removed } from the server. */
  update ({ reset, entries, removed }) {
    if (reset) this.entries.clear()
    for (const id of removed || []) this.entries.delete(id)
    for (const entry of entries || []) this.entries.set(entry.id, entry)
    if (this.isOpen) this.render()
  }

  earned (entry) {
    this.queue.push(entry)
    if (!this.toastTimer) this._nextToast()
  }

  _nextToast () {
    const entry = this.queue.shift()
    if (!entry) {
      this.toast.classList.remove('show')
      this.toastTimer = null
      return
    }
    this.toast.innerHTML = ''
    this.toast.dataset.frame = entry.frame
    this.toast.appendChild(iconFor(entry))
    const headline = document.createElement('div')
    headline.className = 'toast-headline'
    headline.textContent = HEADLINES[entry.frame] || HEADLINES.task
    const title = document.createElement('div')
    title.className = 'toast-title'
    title.textContent = entry.title
    this.toast.append(headline, title)
    this.toast.classList.add('show')
    this.toastTimer = setTimeout(() => this._nextToast(), TOAST_MS)
  }

  render () {
    const tabs = new Map() // root id -> { root, entries }
    for (const entry of this.entries.values()) {
      const rootId = this._rootOf(entry)
      if (!tabs.has(rootId)) tabs.set(rootId, { root: this.entries.get(rootId), entries: [] })
      tabs.get(rootId).entries.push(entry)
    }
    let done = 0
    for (const entry of this.entries.values()) if (entry.done) done++
    this.summary.textContent = this.entries.size
      ? `${done} of ${this.entries.size} completed`
      : 'nothing yet: the server has not sent any advancements'

    this.list.innerHTML = ''
    for (const { root, entries } of tabs.values()) {
      const tab = document.createElement('section')
      tab.className = 'adv-tab'
      const head = document.createElement('h2')
      const tabDone = entries.filter(e => e.done).length
      head.textContent = `${root ? root.title : 'Other'} (${tabDone}/${entries.length})`
      tab.appendChild(head)
      for (const entry of entries) tab.appendChild(this._row(entry))
      this.list.appendChild(tab)
    }
  }

  _rootOf (entry) {
    let current = entry
    // Parents can be missing (a hidden root, or a parent this server has
    // not sent); stop at the last one we know.
    while (current.parent && this.entries.has(current.parent)) current = this.entries.get(current.parent)
    return current.id
  }

  _row (entry) {
    const row = document.createElement('div')
    row.className = 'adv-row'
    row.dataset.frame = entry.frame
    row.dataset.done = entry.done ? 'yes' : 'no'
    row.appendChild(iconFor(entry))
    const text = document.createElement('div')
    text.className = 'adv-text'
    const title = document.createElement('b')
    title.textContent = entry.title
    const description = document.createElement('span')
    description.textContent = entry.description
    text.append(title, description)
    if (entry.done && entry.doneAt) {
      const when = document.createElement('small')
      when.textContent = new Date(entry.doneAt).toLocaleDateString()
      text.appendChild(when)
    }
    row.appendChild(text)
    return row
  }
}

// The item icon inside its frame sprite; a missing texture leaves the frame
// empty rather than showing a broken image.
function iconFor (entry) {
  const frame = document.createElement('i')
  frame.className = 'adv-icon'
  const url = entry.icon ? icons.iconFor(entry.icon) : null
  if (url) {
    const img = document.createElement('img')
    img.alt = ''
    img.draggable = false
    img.src = url
    img.onerror = () => img.remove()
    frame.appendChild(img)
  }
  return frame
}

module.exports = AdvancementsUI
