'use strict'

// Push-to-talk. While the talk key or button is held the microphone is
// recorded and each quarter second of encoded audio goes to the server, which
// has Deepgram transcribe it and sends the words as this player's chat line.
// The mic is opened on press and released on let go, so the browser's
// recording indicator is only on while the key is.
//
// Progress is published as classes on <body>: `talking` while the mic is
// open, `talk-busy` while the last recording is being transcribed. The touch
// button and the desktop HUD indicator both style off those.
//
// The same module runs on the phone controller page, where the server
// routes the words to the paired game (`speech:phone` carries the phone's
// progress back to the host page, which shows it as if it were its own).
// `notify` is where a one-line notice goes: chat in game, the status line on
// the phone.

const SLICE_MS = 250
// Chrome and Firefox record WebM/Opus; Safari only MP4. Deepgram sniffs both.
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

function setupSpeech ({ socket, notify }) {
  let recorder = null
  let stream = null
  // Set on press and cleared on release, so a release that arrives while
  // getUserMedia is still asking for permission is not lost.
  let wanted = false
  let sending = Promise.resolve()
  // The server says at join whether it holds a transcription key. Checked
  // before the mic opens so a key press on a server without one does not
  // light the browser's recording indicator for nothing.
  let enabled = false
  socket.on('join:options', options => {
    enabled = Boolean(options.speech)
    document.body.classList.toggle('speech', enabled)
  })

  const supported = () => Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)
  const mimeType = () => MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type))
  const setTalking = on => document.body.classList.toggle('talking', on)

  const releaseMic = () => {
    if (stream) for (const track of stream.getTracks()) track.stop()
    stream = null
    recorder = null
  }

  const start = async () => {
    if (wanted) return
    if (!enabled) {
      notify('* speech to text is not set up on this server')
      return
    }
    if (!supported()) {
      notify('* this browser cannot record audio')
      return
    }
    wanted = true
    setTalking(true)
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      notify('* microphone access was refused')
      wanted = false
      setTalking(false)
      return
    }
    if (!wanted) return releaseMic()
    recorder = new MediaRecorder(stream, { mimeType: mimeType() })
    // Chunks are sent in order: arrayBuffer() is asynchronous and two of them
    // could otherwise overtake each other.
    recorder.addEventListener('dataavailable', event => {
      if (!event.data.size) return
      sending = sending.then(() => event.data.arrayBuffer()).then(buffer => socket.emit('speech:audio', buffer))
    })
    recorder.addEventListener('stop', () => {
      sending = sending.then(() => socket.emit('speech:stop'))
      releaseMic()
    })
    socket.emit('speech:start')
    recorder.start(SLICE_MS)
  }

  // Only a recording that was actually started has a result to wait for; a
  // press cancelled while the permission prompt was up (which blurs the
  // window, which releases everything) just goes back to idle.
  const stop = () => {
    if (!wanted) return
    wanted = false
    setTalking(false)
    if (recorder && recorder.state !== 'inactive') {
      document.body.classList.add('talk-busy')
      recorder.stop()
    } else releaseMic()
  }

  const settle = () => document.body.classList.remove('talk-busy')
  socket.on('speech:result', ({ text }) => {
    settle()
    if (!text) notify('* nothing heard')
  })
  socket.on('speech:error', ({ reason }) => {
    settle()
    notify(`* ${reason}`)
  })
  // A paired phone holding its mic lights the same indicator here; its own
  // page reports outcomes, so nothing is added to chat for it.
  socket.on('speech:phone', ({ state }) => {
    document.body.classList.toggle('talking', state === 'listening')
    document.body.classList.toggle('talk-busy', state === 'sending')
  })

  return { start, stop }
}

module.exports = setupSpeech
