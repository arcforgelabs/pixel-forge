#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const repoUrl = process.env.PIXEL_FORGE_REPO_URL || 'https://github.com/arcforgelabs/pixel-forge.git'
const ref = process.env.PIXEL_FORGE_REF || 'master'

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      PIXEL_FORGE_REPO_URL: repoUrl,
      PIXEL_FORGE_REF: ref,
    },
  })
  if (result.error) {
    console.error(`pixel-forge installer failed to start ${command}: ${result.error.message}`)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}

if (process.platform === 'win32') {
  const sourceDir = process.env.PIXEL_FORGE_SRC || '%LOCALAPPDATA%\\PixelForge\\src'
  const command = [
    '$ErrorActionPreference = "Stop"',
    `$repo = ${JSON.stringify(repoUrl)}`,
    `$ref = ${JSON.stringify(ref)}`,
    `$src = [Environment]::ExpandEnvironmentVariables(${JSON.stringify(sourceDir)})`,
    'if (!(Get-Command git -ErrorAction SilentlyContinue)) { throw "git is required before Pixel Forge can be installed from npm." }',
    'if (Test-Path (Join-Path $src ".git")) { git -C $src fetch origin; git -C $src checkout $ref; git -C $src pull --ff-only origin $ref }',
    'else { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $src) | Out-Null; git clone --branch $ref $repo $src }',
    '& (Join-Path $src "install-windows.ps1")',
  ].join('; ')
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command])
}

const sourceDir = process.env.PIXEL_FORGE_SRC || '$HOME/.local/src/pixel-forge'
const script = [
  'set -euo pipefail',
  `REPO_URL=${JSON.stringify(repoUrl)}`,
  `REF=${JSON.stringify(ref)}`,
  `SRC_DIR="${sourceDir}"`,
  'SRC_DIR="${SRC_DIR/#\\$HOME/$HOME}"',
  'if ! command -v git >/dev/null 2>&1; then echo "git is required before Pixel Forge can be installed from npm." >&2; exit 1; fi',
  'if [ -d "$SRC_DIR/.git" ]; then git -C "$SRC_DIR" fetch origin && git -C "$SRC_DIR" checkout "$REF" && git -C "$SRC_DIR" pull --ff-only origin "$REF";',
  'else mkdir -p "$(dirname "$SRC_DIR")" && git clone --branch "$REF" "$REPO_URL" "$SRC_DIR"; fi',
  'cd "$SRC_DIR"',
  'exec ./scripts/quick-install.sh',
].join('\n')

run('bash', ['-lc', script])
