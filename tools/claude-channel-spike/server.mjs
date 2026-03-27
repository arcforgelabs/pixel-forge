#!/usr/bin/env node

import http from 'node:http'
import { writeFileSync } from 'node:fs'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const host = process.env.PIXEL_FORGE_CLAUDE_CHANNEL_HOST || '127.0.0.1'
const port = Number(process.env.PIXEL_FORGE_CLAUDE_CHANNEL_PORT || '8788')
const readyFile = process.env.PIXEL_FORGE_CLAUDE_CHANNEL_READY_FILE || '/tmp/pixel-forge-claude-channel-ready.json'

const mcp = new Server(
  { name: 'pixel-forge-channel', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions:
      'Messages from the Pixel Forge channel arrive as <channel source="pixel-forge-channel" ...>. Treat them as external operator context arriving while the terminal session is already open. This is a one-way channel spike: respond in-session normally and do not attempt to reply through the channel.',
  },
)

await mcp.connect(new StdioServerTransport())

const sanitizeMeta = (meta) => {
  if (!meta || typeof meta !== 'object') {
    return undefined
  }
  const cleaned = {}
  for (const [key, value] of Object.entries(meta)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      continue
    }
    cleaned[key] = String(value)
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const body = JSON.stringify({ ok: true, host, port })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end('method not allowed')
    return
  }

  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const rawBody = Buffer.concat(chunks).toString('utf8')

  let content = rawBody.trim()
  let meta

  const contentType = req.headers['content-type'] || ''
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(rawBody)
      content = String(parsed.content || '').trim()
      meta = sanitizeMeta(parsed.meta)
    } catch (error) {
      res.writeHead(400)
      res.end(`invalid json: ${error.message}`)
      return
    }
  }

  if (!content) {
    res.writeHead(400)
    res.end('missing content')
    return
  }

  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta,
      },
    })
    res.writeHead(202)
    res.end('accepted')
  } catch (error) {
    console.error('[pixel-forge-channel] failed to publish event', error)
    res.writeHead(500)
    res.end('publish failed')
  }
})

server.listen(port, host, () => {
  const body = JSON.stringify({ ok: true, host, port }) + '\n'
  writeFileSync(readyFile, body)
  console.error(`[pixel-forge-channel] listening on http://${host}:${port}`)
})

const shutdown = () => {
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
