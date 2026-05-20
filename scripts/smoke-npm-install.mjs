import { promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import {
  assert,
  cleanupSmokeContext,
  copyRepoForSmoke,
  createSmokeContext,
  fetchJson,
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

const installerPackage = await readJsonFile(
  path.join(repoRoot, 'packages', 'npm-installer', 'package.json'),
)
const packageName = installerPackage.name
const expectedVersion = installerPackage.version
const expectedTag = `v${expectedVersion}`
const stagedVersion = nextReleaseVersion(expectedVersion)
const stagedTag = `v${stagedVersion}`
const applyReleaseUpdate = isTruthy(process.env.PIXEL_FORGE_SMOKE_NPM_APPLY_RELEASE_UPDATE)

const context = await createSmokeContext('npm-install')
const paths = {
  ...context.paths,
  homeDir: path.join(context.root, 'home'),
  sourceDir: path.join(context.root, 'src', 'pixel-forge'),
  npmCacheDir: path.join(context.root, 'npm-cache'),
  installCacheDir: path.join(context.root, 'install-cache'),
  updateSourceDir: path.join(context.root, 'github-release-source'),
  releaseArchivePath: path.join(context.root, 'github-release.tar.gz'),
}
const smokeContext = { ...context, paths, env: npmInstallEnv() }
let releaseServer = null

function isTruthy(value) {
  return typeof value === 'string'
    && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function nextReleaseVersion(version) {
  const match = /^(\d{4}\.[1-9]\d?\.[1-9]\d?)-([1-9]\d*)$/.exec(version)
  if (!match) {
    throw new Error(`Cannot derive smoke update version from ${version}`)
  }
  return `${match[1]}-${Number(match[2]) + 1}`
}

async function startReleaseServer() {
  const latestPayload = {
    id: 1,
    tag_name: stagedTag,
    name: `Pixel Forge ${stagedVersion}`,
    html_url: `https://example.test/arcforgelabs/pixel-forge/releases/tag/${stagedTag}`,
    tarball_url: null,
    zipball_url: null,
    published_at: '2026-05-20T00:00:00Z',
    prerelease: false,
    draft: false,
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/latest') {
        const origin = `http://${request.headers.host}`
        const payload = {
          ...latestPayload,
          tarball_url: `${origin}/archive.tar.gz`,
          zipball_url: `${origin}/archive.zip`,
        }
        response.writeHead(200, {
          'content-type': 'application/json',
          etag: '"pixel-forge-smoke-release"',
        })
        response.end(JSON.stringify(payload))
        return
      }

      if (request.url === '/archive.tar.gz') {
        response.writeHead(200, { 'content-type': 'application/gzip' })
        response.end(await fs.readFile(paths.releaseArchivePath))
        return
      }

      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  assert(address && typeof address !== 'string', 'Failed to start smoke release server')
  return {
    server,
    latestUrl: `http://127.0.0.1:${address.port}/latest`,
  }
}

async function writeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, 'utf-8')
  await fs.chmod(filePath, 0o755)
}

async function installProviderCliStubs() {
  await fs.mkdir(paths.binDir, { recursive: true })
  for (const commandName of ['claude', 'codex']) {
    await writeExecutable(
      path.join(paths.binDir, commandName),
      `#!/usr/bin/env bash
case "\${1:-}" in
  --version|-v|version)
    echo "${commandName} smoke stub 0.0.0"
    ;;
  *)
    echo "${commandName} smoke stub: provider CLI execution is outside smoke:npm-install scope" >&2
    ;;
esac
exit 0
`,
    )
  }
}

function npmInstallEnv() {
  const env = {
    ...context.env,
    HOME: paths.homeDir,
    XDG_CONFIG_HOME: path.join(paths.homeDir, '.config'),
    XDG_CACHE_HOME: path.join(paths.homeDir, '.cache'),
    XDG_DATA_HOME: path.join(paths.homeDir, '.local', 'share'),
    NPM_CONFIG_CACHE: paths.npmCacheDir,
    npm_config_cache: paths.npmCacheDir,
    PUPPETEER_SKIP_DOWNLOAD: 'true',
    PUPPETEER_SKIP_CHROME_DOWNLOAD: 'true',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    PIXEL_FORGE_SRC: paths.sourceDir,
    PIXEL_FORGE_UNATTENDED: '1',
    PIXEL_FORGE_INSTALL_CACHE_DIR: paths.installCacheDir,
    PIXEL_FORGE_WITH_AGENT_DECK: '0',
    PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION: '0',
    PIXEL_FORGE_INSTALL_CLAUDE_CHANNEL_SPIKE: '0',
    PIXEL_FORGE_INSTALL_CODEX_CHANNEL: '0',
    PIXEL_FORGE_RELEASE_CHECK_INTERVAL_SECONDS: '300',
  }

  delete env.PIXEL_FORGE_REF
  delete env.PIXEL_FORGE_REPO_URL

  return env
}

async function prepareReleaseArchive() {
  await copyRepoForSmoke(paths.updateSourceDir)
  await writeVersionSet(paths.updateSourceDir, stagedVersion)
  await runProcess('tar', [
    '--dereference',
    '-czf',
    paths.releaseArchivePath,
    '-C',
    path.dirname(paths.updateSourceDir),
    path.basename(paths.updateSourceDir),
  ], {
    cwd: paths.updateSourceDir,
    env: smokeContext.env,
    label: `tar release archive ${stagedVersion}`,
  })
}

async function commandExists(command, env) {
  try {
    await runProcess('bash', ['-lc', `command -v ${command}`], {
      env,
      label: `command -v ${command}`,
    })
    return true
  } catch {
    return false
  }
}

async function launchDesktopEntryIfRequested({
  cliName,
  desktopFilePath,
  env,
}) {
  if (
    !isTruthy(process.env.PIXEL_FORGE_SMOKE_GUI_LAUNCH)
    || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
  ) {
    return 'desktop artifacts verified'
  }

  if (await commandExists('gtk-launch', env)) {
    await runProcess('timeout', [
      '20',
      'bash',
      '-lc',
      `gtk-launch ${JSON.stringify(cliName)} >/dev/null 2>&1`,
    ], {
      env,
      label: `gtk-launch ${cliName}`,
    })
    return 'desktop artifacts verified and gtk-launch exited successfully'
  }

  if (await commandExists('gio', env)) {
    await runProcess('timeout', [
      '20',
      'bash',
      '-lc',
      `gio launch ${JSON.stringify(desktopFilePath)} >/dev/null 2>&1`,
    ], {
      env,
      label: `gio launch ${desktopFilePath}`,
    })
    return 'desktop artifacts verified and gio launch exited successfully'
  }

  return 'desktop artifacts verified; no gtk-launch or gio command available'
}

async function gitOutput(args) {
  const result = await runProcess('git', ['-C', paths.sourceDir, ...args], {
    cwd: paths.sourceDir,
    env: npmInstallEnv(),
    label: `git ${args.join(' ')}`,
  })
  return result.stdout.trim()
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let parsed = null
  if (text.trim()) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text}`)
  }
  return parsed
}

async function waitForControllerVersion(version, description) {
  return await waitForCondition(async () => {
    const runtimeInfo = await fetchJson(`${context.baseUrl}/api/runtime-info`)
    return runtimeInfo.controllerVersion === version ? runtimeInfo : null
  }, {
    timeoutMs: 45000,
    intervalMs: 1000,
    description,
  })
}

try {
  await fs.mkdir(paths.homeDir, { recursive: true })
  await installProviderCliStubs()
  await prepareReleaseArchive()
  const release = await startReleaseServer()
  releaseServer = release.server
  smokeContext.env.PIXEL_FORGE_RELEASE_API_URL = release.latestUrl
  const env = smokeContext.env

  await runProcess('npx', ['--yes', `${packageName}@${expectedVersion}`], {
    cwd: context.root,
    env,
    label: `npx --yes ${packageName}@${expectedVersion}`,
  })

  const sourcePackage = await readJsonFile(path.join(paths.sourceDir, 'package.json'))
  assert(
    sourcePackage.version === expectedVersion,
    `Expected cloned source package version ${expectedVersion}, got ${sourcePackage.version}`,
  )

  const exactTag = await gitOutput(['describe', '--tags', '--exact-match'])
  assert(
    exactTag === expectedTag,
    `Expected npm installer to clone ${expectedTag}, got ${exactTag}`,
  )

  const gitStatus = await gitOutput(['status', '--porcelain'])
  assert(!gitStatus, `Expected cloned source to stay clean, got:\n${gitStatus}`)

  const cliName = env.PIXEL_FORGE_CLI_NAME || env.PIXEL_FORGE_INSTALL_NAME || 'pixel-forge'
  const shellName = env.PIXEL_FORGE_SHELL_NAME || `${cliName}-shell`
  const desktopFileName = `${cliName}.desktop`
  const desktopFilePath = path.join(
    paths.homeDir,
    '.local',
    'share',
    'applications',
    desktopFileName,
  )
  const iconPath = path.join(
    paths.homeDir,
    '.local',
    'share',
    'icons',
    'hicolor',
    '256x256',
    'apps',
    `${cliName}.png`,
  )
  const installedPackagePath = path.join(paths.installDir, 'desktop', 'package.json')
  const shellLauncherPath = path.join(paths.binDir, shellName)
  for (const requiredPath of [
    path.join(paths.installDir, 'VERSION'),
    path.join(paths.installDir, 'runtime-install-metadata.json'),
    path.join(paths.installDir, 'frontend', 'index.html'),
    path.join(paths.installDir, '.venv', 'bin', 'uvicorn'),
    desktopFilePath,
    iconPath,
    installedPackagePath,
    path.join(paths.binDir, cliName),
    shellLauncherPath,
  ]) {
    assert(await pathExists(requiredPath), `Missing install artifact: ${requiredPath}`)
  }

  const desktopFile = await fs.readFile(desktopFilePath, 'utf-8')
  assert(desktopFile.includes('Name=Pixel Forge'), `Desktop file missing app name:\n${desktopFile}`)
  assert(
    desktopFile.includes(`Exec=bash -lc "exec ${shellName}"`),
    `Desktop file does not launch ${shellName}:\n${desktopFile}`,
  )
  assert(desktopFile.includes(`Icon=${cliName}`), `Desktop file missing icon name:\n${desktopFile}`)
  assert(
    desktopFile.includes(`StartupWMClass=${cliName}-desktop`),
    `Desktop file missing StartupWMClass ${cliName}-desktop:\n${desktopFile}`,
  )

  const packageJson = JSON.parse(await fs.readFile(installedPackagePath, 'utf-8'))
  assert(
    packageJson.productName === 'Pixel Forge',
    `Installed desktop package has wrong productName: ${packageJson.productName}`,
  )
  assert(
    packageJson.desktopName === desktopFileName,
    `Installed desktop package has wrong desktopName: ${packageJson.desktopName}`,
  )

  const shellLauncher = await fs.readFile(shellLauncherPath, 'utf-8')
  assert(
    shellLauncher.includes('PIXEL_FORGE_DESKTOP_ICON_PATH'),
    'Shell launcher does not export PIXEL_FORGE_DESKTOP_ICON_PATH.',
  )
  assert(
    shellLauncher.includes('"--class=$PIXEL_FORGE_DESKTOP_WM_CLASS"'),
    'Shell launcher does not pass the desktop WM class to Electron.',
  )

  await runPixelForge(smokeContext, ['start'], { cwd: paths.sourceDir })
  await waitForHttpOk(`${context.baseUrl}/api/runtime-info`, {
    description: 'public npm installed Pixel Forge runtime',
  })

  const runtimeInfo = await fetchJson(`${context.baseUrl}/api/runtime-info`)
  assert(
    runtimeInfo.controllerVersion === expectedVersion,
    `Expected controller version ${expectedVersion}, got ${runtimeInfo.controllerVersion}`,
  )
  assert(
    runtimeInfo.runtimeKind === 'controller',
    `Expected runtimeKind controller, got ${runtimeInfo.runtimeKind}`,
  )
  assert(
    runtimeInfo.runtimeLayout === 'installed',
    `Expected runtimeLayout installed, got ${runtimeInfo.runtimeLayout}`,
  )
  assert(
    runtimeInfo.runtimeRoot === path.resolve(paths.installDir),
    `Expected runtimeRoot ${path.resolve(paths.installDir)}, got ${runtimeInfo.runtimeRoot}`,
  )
  assert(
    runtimeInfo.sourcePath === path.resolve(paths.sourceDir),
    `Expected sourcePath ${path.resolve(paths.sourceDir)}, got ${runtimeInfo.sourcePath}`,
  )
  assert(
    typeof runtimeInfo.installedAt === 'string' && runtimeInfo.installedAt.trim(),
    `Expected runtime-info to include installedAt, got ${JSON.stringify(runtimeInfo)}`,
  )
  assert(
    typeof runtimeInfo.gitCommit === 'string' && runtimeInfo.gitCommit.trim(),
    `Expected runtime-info to include gitCommit, got ${JSON.stringify(runtimeInfo)}`,
  )
  assert(
    runtimeInfo.gitDescribe === expectedTag,
    `Expected runtime-info gitDescribe ${expectedTag}, got ${runtimeInfo.gitDescribe}`,
  )
  assert(
    runtimeInfo.gitDirty === false,
    `Expected runtime-info gitDirty false, got ${runtimeInfo.gitDirty}`,
  )

  const desktopLaunchProof = await launchDesktopEntryIfRequested({
    cliName,
    desktopFilePath,
    env,
  })

  const checkedRelease = await postJson(
    `${context.baseUrl}/api/controller-release-update/check`,
    { force: true },
  )
  assert(
    checkedRelease.state?.currentVersion === expectedVersion,
    `Expected release state currentVersion ${expectedVersion}, got ${JSON.stringify(checkedRelease)}`,
  )
  assert(
    checkedRelease.state?.updateAvailable === true,
    `Expected release state to show an available update, got ${JSON.stringify(checkedRelease)}`,
  )
  assert(
    checkedRelease.state?.latest?.version === stagedVersion,
    `Expected latest release ${stagedVersion}, got ${JSON.stringify(checkedRelease)}`,
  )

  const stagedRelease = await postJson(
    `${context.baseUrl}/api/controller-release-update/stage`,
    { force: false },
  )
  assert(
    stagedRelease.staged === true,
    `Expected release update to stage, got ${JSON.stringify(stagedRelease)}`,
  )
  assert(
    stagedRelease.update?.source === 'github-release',
    `Expected staged update source github-release, got ${JSON.stringify(stagedRelease.update)}`,
  )
  assert(
    stagedRelease.update?.version === stagedVersion,
    `Expected staged update version ${stagedVersion}, got ${JSON.stringify(stagedRelease.update)}`,
  )
  assert(
    await pathExists(stagedRelease.update?.snapshotPath),
    `Expected staged snapshot to exist at ${stagedRelease.update?.snapshotPath}`,
  )

  if (applyReleaseUpdate) {
    await runPixelForge(smokeContext, [
      'controller-update',
      'apply',
      '--project',
      paths.sourceDir,
      '--mode',
      'live-editor',
      '--no-shell-relaunch',
    ], { cwd: paths.sourceDir })

    await waitForHttpOk(`${context.baseUrl}/api/runtime-info`, {
      description: 'public npm installed Pixel Forge runtime after release update',
    })
    const updatedRuntimeInfo = await waitForControllerVersion(
      stagedVersion,
      `release-updated controller version ${stagedVersion}`,
    )
    assert(
      updatedRuntimeInfo.runtimeLayout === 'installed',
      `Expected updated runtimeLayout installed, got ${updatedRuntimeInfo.runtimeLayout}`,
    )
    assert(
      updatedRuntimeInfo.runtimeRoot === path.resolve(paths.installDir),
      `Expected updated runtimeRoot ${path.resolve(paths.installDir)}, got ${updatedRuntimeInfo.runtimeRoot}`,
    )
    assert(
      updatedRuntimeInfo.gitDirty === false,
      `Expected updated runtime-info gitDirty false, got ${updatedRuntimeInfo.gitDirty}`,
    )
    await waitForCondition(
      async () => !(await pathExists(paths.pendingUpdatePath)),
      {
        timeoutMs: 15000,
        intervalMs: 500,
        description: 'pending release controller update cleanup',
      },
    )
  }

  console.log(
    applyReleaseUpdate
      ? `[smoke:npm-install] ${packageName}@${expectedVersion} installed ${runtimeInfo.runtimeLayout} runtime from ${runtimeInfo.gitDescribe}, ${desktopLaunchProof}, then applied ${stagedTag} through release update`
      : `[smoke:npm-install] ${packageName}@${expectedVersion} installed ${runtimeInfo.runtimeLayout} runtime from ${runtimeInfo.gitDescribe}, ${desktopLaunchProof}, then staged ${stagedTag} through release update`,
  )
} catch (error) {
  await reportSmokeFailure('npm-install', error, smokeContext)
  process.exitCode = 1
} finally {
  if (releaseServer) {
    await new Promise((resolve) => releaseServer.close(resolve))
  }
  await cleanupSmokeContext(smokeContext)
}
