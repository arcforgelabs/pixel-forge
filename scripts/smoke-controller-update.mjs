import path from 'node:path'
import { promises as fs } from 'node:fs'

import {
  assert,
  cleanupSmokeContext,
  copyRepoForSmoke,
  createSmokeContext,
  fetchJson,
  installPixelForge,
  pathExists,
  readJsonFile,
  repoRoot,
  reportSmokeFailure,
  runPixelForge,
  runProcess,
  waitForCondition,
  waitForHttpOk,
  writeVersionSet,
} from './lib/smoke-helpers.mjs'

const context = await createSmokeContext('update')
const baseVersion = (await readJsonFile(path.join(repoRoot, 'package.json'))).version
const stagedVersion = `${baseVersion}-smoke.1`
const poisonVersion = `${baseVersion}-smoke.2`
const updateSourceRoot = path.join(context.root, 'update-source')

async function waitForControllerVersion(expectedVersion, description) {
  return await waitForCondition(async () => {
    const runtimeInfo = await fetchJson(`${context.baseUrl}/api/runtime-info`)
    return runtimeInfo.controllerVersion === expectedVersion ? runtimeInfo : null
  }, {
    timeoutMs: 30000,
    intervalMs: 1000,
    description,
  })
}

try {
  await installPixelForge(repoRoot, context)
  await runPixelForge(context, ['start'])
  await waitForHttpOk(`${context.baseUrl}/api/runtime-info`, {
    description: 'base Pixel Forge runtime',
  })

  const initialRuntimeInfo = await waitForControllerVersion(
    baseVersion,
    `base controller version ${baseVersion}`,
  )
  assert(
    initialRuntimeInfo.controllerVersion === baseVersion,
    `Expected initial controller version ${baseVersion}, got ${initialRuntimeInfo.controllerVersion}`,
  )

  await copyRepoForSmoke(updateSourceRoot)
  await writeVersionSet(updateSourceRoot, stagedVersion)

  const stageResult = await runPixelForge(context, [
    'stage-update',
    '--project',
    updateSourceRoot,
    '--summary',
    'Smoke update ready to load.',
  ])
  const stagedPayload = JSON.parse(stageResult.stdout)
  assert(
    stagedPayload.version === stagedVersion,
    `Expected staged version ${stagedVersion}, got ${stagedPayload.version}`,
  )
  assert(
    await pathExists(stagedPayload.snapshotPath),
    `Missing staged snapshot: ${stagedPayload.snapshotPath}`,
  )

  await writeVersionSet(updateSourceRoot, poisonVersion)

  await runProcess(process.execPath, [
    path.join(repoRoot, 'apps', 'desktop', 'controller-update-runner.mjs'),
    '--state-dir',
    context.paths.stateDir,
    '--install-root',
    stagedPayload.snapshotPath,
    '--update-id',
    stagedPayload.id,
    '--shell-url',
    context.baseUrl,
  ], {
    env: {
      ...context.env,
      PIXEL_FORGE_SKIP_SHELL_RELAUNCH: '1',
    },
    label: 'controller-update-runner',
  })

  await waitForHttpOk(`${context.baseUrl}/api/runtime-info`, {
    description: 'updated Pixel Forge runtime',
  })

  const updatedRuntimeInfo = await waitForControllerVersion(
    stagedVersion,
    `updated controller version ${stagedVersion}`,
  )
  assert(
    updatedRuntimeInfo.controllerVersion === stagedVersion,
    `Expected updated controller version ${stagedVersion}, got ${updatedRuntimeInfo.controllerVersion}`,
  )

  await waitForCondition(
    async () => !(await pathExists(context.paths.pendingUpdatePath)),
    {
      timeoutMs: 15000,
      intervalMs: 500,
      description: 'pending controller update cleanup',
    },
  )

  await waitForCondition(
    async () => !(await pathExists(stagedPayload.snapshotPath)),
    {
      timeoutMs: 25000,
      intervalMs: 1000,
      description: 'controller update snapshot cleanup',
    },
  )

  await waitForCondition(
    async () => !(await pathExists(context.paths.applyStatePath)),
    {
      timeoutMs: 15000,
      intervalMs: 500,
      description: 'controller update apply-state cleanup',
    },
  )

  await runPixelForge(context, ['rollback'])
  await waitForHttpOk(`${context.baseUrl}/api/runtime-info`, {
    description: 'rolled back Pixel Forge runtime',
  })

  const rolledBackRuntimeInfo = await waitForControllerVersion(
    baseVersion,
    `rolled back controller version ${baseVersion}`,
  )
  assert(
    rolledBackRuntimeInfo.controllerVersion === baseVersion,
    `Expected rolled back controller version ${baseVersion}, got ${rolledBackRuntimeInfo.controllerVersion}`,
  )
  assert(
    (await fs.readFile(path.join(context.paths.installDir, 'VERSION'), 'utf-8')).trim() === baseVersion,
    'Rollback did not restore the installed VERSION file.',
  )

  console.log(
    `[smoke:update] updated ${baseVersion} -> ${stagedVersion} from a frozen snapshot, then rolled back successfully`,
  )
} catch (error) {
  await reportSmokeFailure('update', error, context)
  process.exitCode = 1
} finally {
  await cleanupSmokeContext(context)
}
