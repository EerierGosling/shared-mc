'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const express = require('express')

// Compressing at request time put megabytes of zlib per visitor on the same
// thread that runs every bot's physics. These files are compressed once, to
// .br and .gz siblings, and a request just picks the best one it accepts.

const TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8'
}
const COMPRESSIBLE = new Set(Object.keys(TYPES))

/**
 * Writes file.br and file.gz next to file unless they are already newer.
 * Async: zlib runs on the threadpool, so a server compressing at boot keeps
 * serving meanwhile and requests simply fall back until the siblings exist.
 */
async function precompress (file, { quality = 9 } = {}) {
  const stat = await fs.promises.stat(file)
  const stale = async out => {
    try { return (await fs.promises.stat(out)).mtimeMs < stat.mtimeMs } catch (err) { return true }
  }
  const source = await fs.promises.readFile(file)
  if (await stale(file + '.gz')) {
    const gz = await new Promise((resolve, reject) =>
      zlib.gzip(source, { level: 9 }, (err, out) => err ? reject(err) : resolve(out)))
    await fs.promises.writeFile(file + '.gz', gz)
  }
  if (await stale(file + '.br')) {
    const br = await new Promise((resolve, reject) =>
      zlib.brotliCompress(source, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length
        }
      }, (err, out) => err ? reject(err) : resolve(out)))
    await fs.promises.writeFile(file + '.br', br)
  }
}

/**
 * Serves `dir` like express.static, but a request for `x.js` that accepts
 * brotli or gzip gets `x.js.br` / `x.js.gz` when one exists. Falls through
 * to express.static for everything else (PNGs, ranges, directories).
 */
function precompressed (dir, options = {}) {
  const fallback = express.static(dir, options)
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fallback(req, res, next)
    // Malformed %-encoding must not throw inside middleware.
    let rel
    try {
      rel = decodeURIComponent(req.path)
    } catch (err) {
      return fallback(req, res, next)
    }
    const ext = path.extname(rel)
    if (!COMPRESSIBLE.has(ext)) return fallback(req, res, next)
    const file = path.join(dir, rel)
    if (!file.startsWith(dir)) return fallback(req, res, next)
    const accepts = String(req.headers['accept-encoding'] || '')
    const candidates = []
    if (/\bbr\b/.test(accepts)) candidates.push(['br', file + '.br'])
    if (/\bgzip\b/.test(accepts)) candidates.push(['gzip', file + '.gz'])
    // sendFile stats the file anyway, so probe by sending rather than with a
    // separate existsSync per candidate per request; a miss just moves to the
    // next encoding or to the plain file.
    const attempt = i => {
      if (i >= candidates.length) {
        res.removeHeader('Content-Encoding')
        return fallback(req, res, next)
      }
      const [encoding, candidate] = candidates[i]
      res.set('Content-Type', TYPES[ext])
      res.set('Content-Encoding', encoding)
      res.set('Vary', 'Accept-Encoding')
      res.sendFile(candidate, { maxAge: options.maxAge, immutable: options.immutable }, err => {
        if (!err) return
        if (res.headersSent) return next(err)
        attempt(i + 1)
      })
    }
    attempt(0)
  }
}

module.exports = { precompress, precompressed }
