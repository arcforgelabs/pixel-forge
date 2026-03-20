import path from 'node:path'

import {
  assert,
  cleanupSmokeContext,
  createSmokeContext,
  fetchJson,
  installPixelForge,
  pathExists,
  readJsonFile,
  repoRoot,
  reportSmokeFailure,
  runPixelForge,
  waitForHttpOk,
} from './lib/smoke-helpers.mjs'

const context = await createSmokeContext('install')
const expectedVersion = (await readJsonFile(path.join(repoRoot, 'package.json'))).version

try {
  await installPixelForge(repoRoot, context)

  for (const requiredPath of [
    path.join(context.paths.installDir, 'VERSION'),
    path.join(context.paths.installDir, 'frontend', 'index.html'),
    path.join(context.paths.installDir, '.venv', 'bin', 'uvicorn'),
    path.join(context.paths.binDir, 'pixel-forge'),
    path.join(context.paths.binDir, 'pixel-forge-shell'),
  ]) {
    assert(await pathExists(requiredPath), `Missing install artifact: ${requiredPath}`)
  }

  await runPixelForge(context, ['start'])
  await waitForHttpOk(`${context.baseUrl}/api/runtime-info`, {
    description: 'installed Pixel Forge runtime',
  })

  const runtimeInfo = await fetchJson(`${context.baseUrl}/api/runtime-info`)
  assert(
    runtimeInfo.controllerVersion === expectedVersion,
    `Expected controller version ${expectedVersion}, got ${runtimeInfo.controllerVersion}`,
  )
  assert(
    typeof runtimeInfo.installedAt === 'string' && runtimeInfo.installedAt.trim(),
    `Expected runtime-info to include installedAt, got ${JSON.stringify(runtimeInfo)}`,
  )

  console.log(`[smoke:install] installed runtime responded with ${runtimeInfo.controllerVersion}`)
} catch (error) {
  await reportSmokeFailure('install', error, context)
  process.exitCode = 1
} finally {
  await cleanupSmokeContext(context)
}
