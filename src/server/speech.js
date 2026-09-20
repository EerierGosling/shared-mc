'use strict'

// A held button on a touch device records the microphone, the browser streams
// the encoded audio here, and Deepgram turns it into one line of chat. The
// API key never leaves this process; the browser only ever sees text.
//
// Deepgram detects the container itself (WebM/Opus from Chrome and Firefox,
// MP4/AAC from Safari), so no encoding is declared. The transcript is handed
// to `onTranscript`, which queues it on the speaker's session (one queue per
// bot: a solo player's own, or the road trip's shared one), and echoed to
// the speaker as `speech:result` so the page can show what was heard.
//
// The speaker is not always the player: a paired phone (motion-pairing.js)
// can hold its own mic, and its words go to the host browser's bot. The
// host is then told the phone's progress as `speech:phone` so its HUD can
// show listening/sending the way it does for its own key.

const MAX_CHUNK_BYTES = 64 * 1024
// A held button must not stream for ever if the release is lost.
const MAX_HOLD_MS = 30000
// After CloseStream, Deepgram flushes its last results and closes. If that
// never comes, what has been heard so far is delivered anyway.
const FLUSH_TIMEOUT_MS = 5000
const NOT_CONFIGURED = 'speech to text is not set up on this server'

class Speech {
  /**
   * `playerFor` maps a socket to the player socket it speaks for: itself
   * while it is playing, its host while it is a paired phone, else null.
   * `connect` opens a Deepgram live socket; the default builds one from the
   * SDK, and tests hand in a fake.
   */
  constructor ({ apiKey, playerFor, onTranscript, connect }) {
    this.playerFor = playerFor
    this.onTranscript = onTranscript
    this.connect = connect || (apiKey ? deepgramConnect(apiKey) : null)
    this.live = new Map() // socket.id -> { socket, player, dg, parts, queue, timer, closing }
  }

  get enabled () {
    return Boolean(this.connect)
  }

  register (socket) {
    socket.on('speech:start', () => this.start(socket))
    socket.on('speech:audio', chunk => this.audio(socket.id, chunk))
    socket.on('speech:stop', () => this.stop(socket.id))
    socket.on('disconnect', () => this.abort(socket.id))
  }

  async start (socket) {
    if (!this.enabled) return socket.emit('speech:error', { reason: NOT_CONFIGURED })
    const player = this.playerFor(socket)
    if (!player) return
    this.abort(socket.id)
    const entry = { socket, player, dg: null, parts: [], queue: [], timer: null, closing: false, done: false }
    this.live.set(socket.id, entry)
    this._progress(entry, 'listening')
    entry.timer = setTimeout(() => this.stop(socket.id), MAX_HOLD_MS)
    let dg
    try {
      dg = await this.connect()
    } catch (err) {
      return this._fail(entry, err)
    }
    // The button may have been released, or the tab closed, while connecting.
    if (this.live.get(socket.id) !== entry) return dg.close()
    entry.dg = dg
    dg.on('message', message => {
      if (message.type !== 'Results' || !message.is_final) return
      const text = message.channel?.alternatives?.[0]?.transcript
      if (text) entry.parts.push(text)
    })
    dg.on('error', err => this._fail(entry, err))
    dg.on('close', () => this._deliver(entry))
    try {
      dg.connect()
      await dg.waitForOpen()
    } catch (err) {
      return this._fail(entry, err)
    }
    if (entry.done) return
    for (const chunk of entry.queue) dg.sendMedia(chunk)
    entry.queue = []
    if (entry.closing) dg.sendCloseStream({ type: 'CloseStream' })
  }

  audio (socketId, chunk) {
    const entry = this.live.get(socketId)
    if (!entry || entry.closing || !isBinary(chunk) || chunk.byteLength > MAX_CHUNK_BYTES) return
    if (entry.dg && entry.dg.readyState === 1) entry.dg.sendMedia(chunk)
    else entry.queue.push(chunk)
  }

  stop (socketId) {
    const entry = this.live.get(socketId)
    if (!entry || entry.closing) return
    entry.closing = true
    this._progress(entry, 'sending')
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this._deliver(entry), FLUSH_TIMEOUT_MS)
    // Not open yet: start() sends the close once it is.
    if (entry.dg && entry.dg.readyState === 1) entry.dg.sendCloseStream({ type: 'CloseStream' })
  }

  /** The visitor is gone; nothing to deliver to. */
  abort (socketId) {
    const entry = this.live.get(socketId)
    if (!entry) return
    this._finish(entry)
  }

  _deliver (entry) {
    if (entry.done) return
    const text = entry.parts.join(' ').replace(/\s+/g, ' ').trim()
    entry.socket.emit('speech:result', { text })
    // A phone unpaired mid-hold no longer speaks for anyone.
    if (text && this.playerFor(entry.socket) === entry.player) this.onTranscript(entry.player, text)
    this._finish(entry)
  }

  _fail (entry, err) {
    if (entry.done) return
    console.warn('speech: ' + (err && err.message ? err.message : err))
    entry.socket.emit('speech:error', { reason: 'speech to text failed, try again' })
    this._finish(entry)
  }

  _finish (entry) {
    entry.done = true
    this._progress(entry, 'idle')
    clearTimeout(entry.timer)
    if (this.live.get(entry.socket.id) === entry) this.live.delete(entry.socket.id)
    if (entry.dg) {
      try { entry.dg.close() } catch (err) { /* already closed */ }
    }
  }

  _progress (entry, state) {
    if (entry.player !== entry.socket) entry.player.emit('speech:phone', { state })
  }
}

function deepgramConnect (apiKey) {
  const { DeepgramClient } = require('@deepgram/sdk')
  const client = new DeepgramClient({ apiKey })
  return () => client.listen.v1.createConnection({
    model: 'nova-3',
    language: 'en',
    smart_format: true,
    // A refused key or a dead network must fail the one press, not retry in
    // the background for the SDK's default thirty attempts.
    reconnectAttempts: 0
  })
}

const isBinary = chunk => Buffer.isBuffer(chunk) || chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)

module.exports = { Speech, NOT_CONFIGURED }
