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
  ['packages/sdk-node/package.json', path.join(repoRoot, 'packages', 'sdk-node', 'package.json')],
]

// CalVer per SPECS.md REQ-S-014:
//   stable date tag:          YYYY.M.D
//   same-day release ordinal: YYYY.M.D-N       (N >= 1)
//   prerelease:               YYYY.M.D-beta.N  (N >= 1)
const STABLE_REGEX = /^(\d{4})\.([1-9]\d?)\.([1-9]\d?)$/
const RELEASE_ORDINAL_REGEX = /^(\d{4})\.([1-9]\d?)\.([1-9]\d?)-([1-9]\d*)$/
const BETA_REGEX = /^(\d{4})\.([1-9]\d?)\.([1-9]\d?)-beta\.([1-9]\d*)$/

function isValidCalver(value) {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (!STABLE_REGEX.test(v) && !RELEASE_ORDINAL_REGEX.test(v) && !BETA_REGEX.test(v)) return false
  const match = STABLE_REGEX.exec(v) ?? RELEASE_ORDINAL_REGEX.exec(v) ?? BETA_REGEX.exec(v)
  const [, y, m, d] = match
  const year = Number(y), month = Number(m), day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  // calendar-validate the date
  const candidate = new Date(Date.UTC(year, month - 1, day))
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day
}

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
const formatErrors = versions.filter((entry) => !isValidCalver(entry.value))

if (formatErrors.length > 0) {
  console.error('[check:version] Version format error — expected YYYY.M.D, YYYY.M.D-N, or YYYY.M.D-beta.N:')
  for (const entry of formatErrors) {
    console.error(`- ${entry.label}: ${entry.value}`)
  }
  process.exit(1)
}

if (mismatches.length > 0) {
  console.error('[check:version] Version drift detected:')
  for (const entry of versions) {
    console.error(`- ${entry.label}: ${entry.value}`)
  }
  process.exit(1)
}

console.log(`[check:version] All version surfaces match: ${expected}`)
