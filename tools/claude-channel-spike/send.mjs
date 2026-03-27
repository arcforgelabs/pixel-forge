#!/usr/bin/env node

const host = process.env.PIXEL_FORGE_CLAUDE_CHANNEL_HOST || '127.0.0.1'
const port = Number(process.env.PIXEL_FORGE_CLAUDE_CHANNEL_PORT || '8788')

const args = process.argv.slice(2)
let content = ''
const meta = {}

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--content') {
    content = args[i + 1] || ''
    i += 1
    continue
  }
  if (arg === '--meta') {
    const pair = args[i + 1] || ''
    const eq = pair.indexOf('=')
    if (eq > 0) {
      meta[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    i += 1
    continue
  }
  if (!content) {
    content = arg
  }
}

if (!content) {
  console.error('usage: node tools/claude-channel-spike/send.mjs --content "message" [--meta key=value]')
  process.exit(1)
}

const response = await fetch(`http://${host}:${port}/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content, meta }),
})

const body = await response.text()
if (!response.ok) {
  console.error(body)
  process.exit(1)
}

console.log(body)
