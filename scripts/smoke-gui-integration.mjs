import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  assert,
  cleanupSmokeContext,
  createSmokeContext,
  installPixelForge,
  pathExists,
  repoRoot,
  reportSmokeFailure,
  runProcess,
} from './lib/smoke-helpers.mjs'

function isTruthy(value) {
  return typeof value === 'string'
    && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
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

const context = await createSmokeContext('gui')
const homeDir = path.join(context.root, 'home')
const installName = context.env.PIXEL_FORGE_INSTALL_NAME
const shellName = context.env.PIXEL_FORGE_SHELL_NAME
const desktopFileName = `${installName}.desktop`
const wmClass = `${installName}-desktop`
const env = {
  ...context.env,
  HOME: homeDir,
  XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
  XDG_CONFIG_HOME: path.join(homeDir, '.config'),
  XDG_CACHE_HOME: path.join(homeDir, '.cache'),
  CI: 'true',
  PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION: '0',
  PIXEL_FORGE_INSTALL_SKIP_SYSTEMD: '1',
  PIXEL_FORGE_INSTALL_CLAUDE_CHANNEL_SPIKE: '0',
  PIXEL_FORGE_INSTALL_CODEX_CHANNEL: '0',
  PIXEL_FORGE_INSTALL_CACHE_DIR: path.join(
    os.homedir(),
    '.cache',
    'pixel-forge',
    'install-cache',
    installName,
  ),
  PIXEL_FORGE_WITH_AGENT_DECK: '0',
}
context.env = env

try {
  await fs.mkdir(homeDir, { recursive: true })
  await installPixelForge(repoRoot, context)

  const desktopFilePath = path.join(
    homeDir,
    '.local',
    'share',
    'applications',
    desktopFileName,
  )
  const iconPath = path.join(
    homeDir,
    '.local',
    'share',
    'icons',
    'hicolor',
    '256x256',
    'apps',
    `${installName}.png`,
  )
  const installedPackagePath = path.join(context.paths.installDir, 'desktop', 'package.json')
  const shellLauncherPath = path.join(context.paths.binDir, shellName)

  for (const requiredPath of [
    desktopFilePath,
    iconPath,
    installedPackagePath,
    shellLauncherPath,
    path.join(context.paths.installDir, 'frontend', 'favicon', 'app.png'),
  ]) {
    assert(await pathExists(requiredPath), `Missing GUI integration artifact: ${requiredPath}`)
  }

  const desktopFile = await fs.readFile(desktopFilePath, 'utf-8')
  assert(desktopFile.includes('Name=Pixel Forge'), `Desktop file missing app name:\n${desktopFile}`)
  assert(
    desktopFile.includes(`Exec=bash -lc "exec ${shellName}"`),
    `Desktop file does not launch ${shellName}:\n${desktopFile}`,
  )
  assert(desktopFile.includes(`Icon=${installName}`), `Desktop file missing icon name:\n${desktopFile}`)
  assert(
    desktopFile.includes(`StartupWMClass=${wmClass}`),
    `Desktop file missing StartupWMClass ${wmClass}:\n${desktopFile}`,
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

  let launchProof = 'desktop artifacts verified'
  const canAttemptLaunch = isTruthy(process.env.PIXEL_FORGE_SMOKE_GUI_LAUNCH)
    && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
    && await commandExists('gtk-launch', env)
  if (canAttemptLaunch) {
    await runProcess('timeout', ['20', 'gtk-launch', installName], {
      env,
      label: `gtk-launch ${installName}`,
    })
    launchProof = 'desktop artifacts verified and gtk-launch exited successfully'
  }

  console.log(`[smoke:gui] ${launchProof} for ${desktopFileName}`)
} catch (error) {
  await reportSmokeFailure('gui', error, context)
  process.exitCode = 1
} finally {
  await cleanupSmokeContext(context)
}
