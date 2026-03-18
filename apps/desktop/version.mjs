import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONTROLLER_VERSION = '0.0.0-dev'

async function readVersionFile(filePath) {
  try {
    const value = (await fs.readFile(filePath, 'utf-8')).trim()
    return value || null
  } catch {
    return null
  }
}

async function readPackageVersion(filePath) {
  try {
    const payload = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    return typeof payload?.version === 'string' && payload.version.trim()
      ? payload.version.trim()
      : null
  } catch {
    return null
  }
}

async function readVersionInRoot(rootPath) {
  const version = await readVersionFile(path.join(rootPath, 'VERSION'))
  if (version) {
    return version
  }
  return readPackageVersion(path.join(rootPath, 'package.json'))
}

async function findNearestVersion(startPath) {
  let currentPath = path.resolve(startPath)
  let previousPath = null

  while (currentPath !== previousPath) {
    const version = await readVersionInRoot(currentPath)
    if (version) {
      return version
    }
    previousPath = currentPath
    currentPath = path.dirname(currentPath)
  }

  return null
}

let controllerVersionPromise = null

export async function readControllerVersion() {
  if (!controllerVersionPromise) {
    controllerVersionPromise = findNearestVersion(__dirname).then(
      (version) => version || DEFAULT_CONTROLLER_VERSION,
    )
  }
  return controllerVersionPromise
}

export async function readProjectVersion(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return null
  }
  return readVersionInRoot(path.resolve(projectPath))
}
