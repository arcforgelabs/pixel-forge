import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  assert,
  cleanupSmokeContext,
  createSmokeContext,
  fetchJson,
  pathExists,
  readJsonFile,
  repoRoot,
  reportSmokeFailure,
  runPixelForge,
  runProcess,
  waitForHttpOk,
} from './lib/smoke-helpers.mjs'

const installerPackage = await readJsonFile(
  path.join(repoRoot, 'packages', 'npm-installer', 'package.json'),
)
const packageName = installerPackage.name
const expectedVersion = installerPackage.version
const expectedTag = `v${expectedVersion}`

const context = await createSmokeContext('npm-install')
const paths = {
  ...context.paths,
  homeDir: path.join(context.root, 'home'),
  sourceDir: path.join(context.root, 'src', 'pixel-forge'),
  npmCacheDir: path.join(context.root, 'npm-cache'),
  installCacheDir: path.join(context.root, 'install-cache'),
}
const smokeContext = { ...context, paths, env: npmInstallEnv() }

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
    PIXEL_FORGE_INSTALL_CLAUDE_CHANNEL_SPIKE: '0',
    PIXEL_FORGE_INSTALL_CODEX_CHANNEL: '0',
  }

  delete env.PIXEL_FORGE_REF
  delete env.PIXEL_FORGE_REPO_URL

  return env
}

async function gitOutput(args) {
  const result = await runProcess('git', ['-C', paths.sourceDir, ...args], {
    cwd: paths.sourceDir,
    env: npmInstallEnv(),
    label: `git ${args.join(' ')}`,
  })
  return result.stdout.trim()
}

try {
  await fs.mkdir(paths.homeDir, { recursive: true })
  await installProviderCliStubs()
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
  for (const requiredPath of [
    path.join(paths.installDir, 'VERSION'),
    path.join(paths.installDir, 'runtime-install-metadata.json'),
    path.join(paths.installDir, 'frontend', 'index.html'),
    path.join(paths.installDir, '.venv', 'bin', 'uvicorn'),
    path.join(paths.binDir, cliName),
    path.join(paths.binDir, shellName),
  ]) {
    assert(await pathExists(requiredPath), `Missing install artifact: ${requiredPath}`)
  }

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

  console.log(
    `[smoke:npm-install] ${packageName}@${expectedVersion} installed ${runtimeInfo.runtimeLayout} runtime from ${runtimeInfo.gitDescribe}`,
  )
} catch (error) {
  await reportSmokeFailure('npm-install', error, smokeContext)
  process.exitCode = 1
} finally {
  await cleanupSmokeContext(smokeContext)
}
