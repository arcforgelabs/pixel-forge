#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

if (process.platform !== 'win32') {
  console.error('pixel-forge-windows must be run on Windows.')
  process.exit(2)
}

const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('./pixel-forge-install.mjs', import.meta.url)),
], {
  stdio: 'inherit',
  env: process.env,
})

if (result.error) {
  console.error(`pixel-forge-windows failed: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
