'use strict'
// Run after webpack: writes .br and .gz siblings for the bundles in dist/, so
// the server never gzips 24 MB of mesher worker per visitor at request time.
const fs = require('fs')
const path = require('path')
const { precompress } = require('../src/server/static')

const dist = path.join(__dirname, '..', 'dist')

async function main () {
  const files = fs.readdirSync(dist).filter(f => f.endsWith('.js'))
  for (const f of files) {
    const file = path.join(dist, f)
    const before = fs.statSync(file).size
    await precompress(file)
    const br = fs.statSync(file + '.br').size
    console.log(`${f}: ${mb(before)} MB -> ${mb(br)} MB brotli`)
  }
}

const mb = n => (n / 1048576).toFixed(1)

main().catch(err => {
  console.error(err)
  process.exit(1)
})
