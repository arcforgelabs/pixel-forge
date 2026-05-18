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
  assert(
    typeof initialRuntimeInfo.installedAt === 'string' && initialRuntimeInfo.installedAt.trim(),
    `Expected initial runtime-info installedAt, got ${JSON.stringify(initialRuntimeInfo)}`,
  )

  await copyRepoForSmoke(updateSourceRoot)
  await writeVersionSet(updateSourceRoot, stagedVersion)

  const stageResult = await runPixelForge(context, [
    'controller-update',
    'stage',
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

  await runPixelForge(context, [
    'controller-update',
    'apply',
    '--project',
    updateSourceRoot,
    '--mode',
    'live-editor',
    '--no-shell-relaunch',
  ])

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
  assert(
    typeof updatedRuntimeInfo.installedAt === 'string' && updatedRuntimeInfo.installedAt.trim(),
    `Expected updated runtime-info installedAt, got ${JSON.stringify(updatedRuntimeInfo)}`,
  )
  assert(
    await pathExists(path.join(context.paths.installDir, 'frontend', 'index.html')),
    'Updated install is missing frontend/index.html.',
  )
  assert(
    await pathExists(path.join(context.paths.installDir, 'desktop', 'package.json')),
    'Updated install is missing desktop/package.json.',
  )
  const updatedRootResponse = await fetch(`${context.baseUrl}/`, { cache: 'no-store' })
  assert(
    updatedRootResponse.ok,
    `Updated runtime root returned HTTP ${updatedRootResponse.status}.`,
  )
  const updatedRootHtml = await updatedRootResponse.text()
  assert(
    typeof updatedRootHtml === 'string'
      && updatedRootHtml.toLowerCase().includes('<!doctype html'),
    'Updated runtime root did not return HTML.',
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
    typeof rolledBackRuntimeInfo.installedAt === 'string' && rolledBackRuntimeInfo.installedAt.trim(),
    `Expected rolled back runtime-info installedAt, got ${JSON.stringify(rolledBackRuntimeInfo)}`,
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
