import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const versionFiles = [
  ['VERSION', path.join(repoRoot, 'VERSION')],
  ['package.json', path.join(repoRoot, 'package.json')],
  ['apps/web/package.json', path.join(repoRoot, 'apps', 'web', 'package.json')],
  ['apps/desktop/package.json', path.join(repoRoot, 'apps', 'desktop', 'package.json')],
]

async function readVersion([label, filePath]) {
  if (label === 'VERSION') {
    const value = (await fs.readFile(filePath, 'utf-8')).trim()
    return { label, value }
  }

  const payload = JSON.parse(await fs.readFile(filePath, 'utf-8'))
  if (typeof payload.version !== 'string' || !payload.version.trim()) {
    throw new Error(`Missing version in ${label}`)
  }
  return { label, value: payload.version.trim() }
}

const versions = await Promise.all(versionFiles.map(readVersion))
const expected = versions[0]?.value
const mismatches = versions.filter((entry) => entry.value !== expected)

if (mismatches.length > 0) {
  console.error('[check:version] Version drift detected:')
  for (const entry of versions) {
    console.error(`- ${entry.label}: ${entry.value}`)
  }
  process.exit(1)
}

console.log(`[check:version] All version surfaces match: ${expected}`)
