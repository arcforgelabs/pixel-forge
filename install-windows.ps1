<#
.SYNOPSIS
Installs Pixel Forge on Windows from a source checkout.

.DESCRIPTION
This is the Windows installer groundwork for the public release path. It mirrors
the Linux installer boundary: keep the source checkout separate, build into a
stable per-user runtime directory, preserve user state, and create discoverable
launchers. The Windows service/tray model is intentionally not finalized here.
#>

[CmdletBinding()]
param(
    [string]$InstallRoot = $(if ($env:PIXEL_FORGE_INSTALL_DIR) { $env:PIXEL_FORGE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "PixelForge" }),
    [string]$SourceDir = $(if ($env:PIXEL_FORGE_SRC) { $env:PIXEL_FORGE_SRC } else { $PSScriptRoot }),
    [string]$RepoUrl = $(if ($env:PIXEL_FORGE_REPO_URL) { $env:PIXEL_FORGE_REPO_URL } else { "https://github.com/arcforgelabs/pixel-forge.git" }),
    [string]$Ref = $(if ($env:PIXEL_FORGE_REF) { $env:PIXEL_FORGE_REF } else { "master" }),
    [switch]$SkipBuild,
    [switch]$SkipShortcuts,
    [switch]$BootstrapOnly
)

$ErrorActionPreference = "Stop"

function Info {
    param([string]$Message)
    Write-Host "==> $Message"
}

function Warn {
    param([string]$Message)
    Write-Warning $Message
}

function Require-Command {
    param(
        [string]$Name,
        [string]$InstallHint
    )
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required. $InstallHint"
    }
}

$script:UseCorepackPnpm = $false

function Ensure-Pnpm {
    if (Get-Command "pnpm" -ErrorAction SilentlyContinue) {
        return
    }

    Require-Command "corepack" "Install Node.js 22 LTS from https://nodejs.org/."
    Warn "pnpm is not on PATH; using corepack pnpm for this install."
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
    & corepack pnpm --version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        & corepack enable pnpm
        & corepack pnpm --version | Out-Null
    }
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm is required and corepack could not prepare it. Run: corepack enable pnpm"
    }
    $script:UseCorepackPnpm = $true
}

function Run-Pnpm {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )
    if ($script:UseCorepackPnpm) {
        & corepack pnpm @Arguments
    }
    else {
        & pnpm @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

function Resolve-SourceCheckout {
    $resolvedSource = [Environment]::ExpandEnvironmentVariables($SourceDir)
    if (Test-Path (Join-Path $resolvedSource ".git")) {
        Info "Using source checkout at $resolvedSource"
        return (Resolve-Path $resolvedSource).Path
    }

    if ($resolvedSource -eq $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "package.json"))) {
        Info "Using script directory as source checkout at $PSScriptRoot"
        return (Resolve-Path $PSScriptRoot).Path
    }

    Require-Command "git" "Install Git for Windows from https://git-scm.com/download/win."
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedSource) | Out-Null
    Info "Cloning $RepoUrl into $resolvedSource"
    git clone --branch $Ref $RepoUrl $resolvedSource
    return (Resolve-Path $resolvedSource).Path
}

function Copy-DirectoryClean {
    param(
        [string]$Source,
        [string]$Destination
    )
    if (Test-Path $Destination) {
        Remove-Item -Recurse -Force $Destination
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -Recurse -Force $Source $Destination
}

function New-Launcher {
    param(
        [string]$Path,
        [string]$Content
    )
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    Set-Content -Path $Path -Value $Content -Encoding UTF8
}

function New-Shortcut {
    param(
        [string]$ShortcutPath,
        [string]$TargetPath,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [string]$Description,
        [string]$IconPath
    )
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $TargetPath
    $shortcut.Arguments = $Arguments
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.Description = $Description
    if ($IconPath -and (Test-Path $IconPath)) {
        $shortcut.IconLocation = $IconPath
    }
    $shortcut.Save()
}

if ($PSVersionTable.PSVersion.Major -lt 5) {
    throw "PowerShell 5 or newer is required."
}

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    throw "install-windows.ps1 must be run on Windows."
}

Info "Pixel Forge Windows installer groundwork"
Require-Command "node" "Install Node.js 22 LTS from https://nodejs.org/."
Ensure-Pnpm
Require-Command "python" "Install Python 3.12 from https://www.python.org/downloads/windows/."
Require-Command "git" "Install Git for Windows from https://git-scm.com/download/win."

$Source = Resolve-SourceCheckout
if ($BootstrapOnly) {
    Info "BootstrapOnly set; dependency and checkout checks passed."
    exit 0
}

$RuntimeDir = Join-Path $InstallRoot "runtime"
$BinDir = Join-Path $InstallRoot "bin"
$StateDir = if ($env:PIXEL_FORGE_SHARED_STATE_DIR) { $env:PIXEL_FORGE_SHARED_STATE_DIR } else { Join-Path $env:APPDATA "PixelForge" }
$ApiDir = Join-Path $RuntimeDir "api"
$FrontendDir = Join-Path $RuntimeDir "frontend"
$DesktopDir = Join-Path $RuntimeDir "desktop"
$VenvDir = Join-Path $RuntimeDir ".venv"
$IconSourcePng = Join-Path $Source "apps\web\public\favicon\app.png"
$IconSourceIco = Join-Path $Source "apps\web\public\favicon\app.ico"
$IconDir = Join-Path $RuntimeDir "icons"
$IconPath = Join-Path $IconDir "pixel-forge.png"
$IconIcoPath = Join-Path $IconDir "pixel-forge.ico"

New-Item -ItemType Directory -Force -Path $RuntimeDir, $BinDir, $StateDir, $IconDir | Out-Null

if (-not $SkipBuild) {
    Info "Installing workspace dependencies"
    Push-Location $Source
    try {
        $env:PUPPETEER_SKIP_DOWNLOAD = "1"
        Run-Pnpm install --frozen-lockfile --ignore-scripts
        Run-Pnpm --dir apps/web build
    }
    finally {
        Pop-Location
    }
}

Info "Copying runtime files"
Copy-DirectoryClean -Source (Join-Path $Source "apps\api") -Destination $ApiDir
Copy-DirectoryClean -Source (Join-Path $Source "apps\web\dist") -Destination $FrontendDir
Copy-DirectoryClean -Source (Join-Path $Source "apps\desktop") -Destination $DesktopDir
Copy-Item -Force (Join-Path $Source "VERSION") (Join-Path $RuntimeDir "VERSION")
if (Test-Path $IconSourcePng) {
    Copy-Item -Force $IconSourcePng $IconPath
}
if (Test-Path $IconSourceIco) {
    Copy-Item -Force $IconSourceIco $IconIcoPath
}

Info "Installing Python dependencies"
if (-not (Test-Path (Join-Path $VenvDir "Scripts\python.exe"))) {
    python -m venv $VenvDir
}
& (Join-Path $VenvDir "Scripts\python.exe") -m pip install --upgrade pip
& (Join-Path $VenvDir "Scripts\python.exe") -m pip install -r (Join-Path $Source "apps\api\requirements.txt")

Info "Installing desktop shell dependencies"
Push-Location $DesktopDir
try {
    $DesktopPackageLock = Join-Path $DesktopDir "package-lock.json"
    if (Test-Path $DesktopPackageLock) {
        Remove-Item -Force $DesktopPackageLock
    }
    $ElectronVersion = (& node -p "require('./package.json').dependencies.electron.replace(/^[^0-9]*/, '')").Trim()
    npm install --no-fund --no-audit "electron@$ElectronVersion"
}
finally {
    Pop-Location
}

$ApiPort = if ($env:PIXEL_FORGE_API_PORT) { $env:PIXEL_FORGE_API_PORT } elseif ($env:PIXEL_FORGE_PORT) { $env:PIXEL_FORGE_PORT } else { "7201" }
$UrlHost = if ($env:PIXEL_FORGE_URL_HOST) { $env:PIXEL_FORGE_URL_HOST } else { "127.0.0.1" }
$ApiLauncher = Join-Path $BinDir "pixel-forge-api.ps1"
$AppLauncher = Join-Path $BinDir "pixel-forge.ps1"
$ShellLauncher = Join-Path $BinDir "pixel-forge-shell.ps1"
$HiddenAppLauncher = Join-Path $BinDir "pixel-forge.vbs"
$WebLauncher = Join-Path $BinDir "pixel-forge-open-web.ps1"

New-Launcher -Path $ApiLauncher -Content @"
`$ErrorActionPreference = "Stop"
foreach (`$candidate in @((Join-Path `$env:APPDATA "npm"), (Join-Path `$env:LOCALAPPDATA "Microsoft\WindowsApps"))) {
    if (`$candidate -and (Test-Path `$candidate) -and (`$env:PATH -notlike "*`$candidate*")) {
        `$env:PATH = "`$candidate;`$env:PATH"
    }
}
`$env:PIXEL_FORGE_INSTALL_DIR = "$RuntimeDir"
`$env:PIXEL_FORGE_SHARED_STATE_DIR = "$StateDir"
`$env:PIXEL_FORGE_RUNTIME_DIR = "$RuntimeDir"
`$env:PIXEL_FORGE_RUNTIME_SOURCE_ROOT = "$RuntimeDir"
`$env:PIXEL_FORGE_FRONTEND_DIST = "$FrontendDir"
`$env:PIXEL_FORGE_API_PORT = "$ApiPort"
`$env:PIXEL_FORGE_PORT = "$ApiPort"
`$env:PIXEL_FORGE_URL_HOST = "$UrlHost"
`$env:PIXEL_FORGE_WITH_AGENT_DECK = "0"
`$env:PIXEL_FORGE_DEFAULT_AGENT_PROVIDER_ID = "codex-cli"
Set-Location "$ApiDir"
& "$VenvDir\Scripts\python.exe" "main.py"
"@

New-Launcher -Path $WebLauncher -Content @"
`$url = "http://${UrlHost}:${ApiPort}/"
Start-Process `$url
"@

New-Launcher -Path $ShellLauncher -Content @"
`$ErrorActionPreference = "Stop"
`$url = "http://${UrlHost}:${ApiPort}/"
`$runtimeInfoUrl = `$url + "api/runtime-info"
foreach (`$candidate in @((Join-Path `$env:APPDATA "npm"), (Join-Path `$env:LOCALAPPDATA "Microsoft\WindowsApps"))) {
    if (`$candidate -and (Test-Path `$candidate) -and (`$env:PATH -notlike "*`$candidate*")) {
        `$env:PATH = "`$candidate;`$env:PATH"
    }
}
`$env:PIXEL_FORGE_INSTALL_DIR = "$RuntimeDir"
`$env:PIXEL_FORGE_SHARED_STATE_DIR = "$StateDir"
`$env:PIXEL_FORGE_RUNTIME_DIR = "$RuntimeDir"
`$env:PIXEL_FORGE_RUNTIME_SOURCE_ROOT = "$RuntimeDir"
`$env:PIXEL_FORGE_FRONTEND_DIST = "$FrontendDir"
`$env:PIXEL_FORGE_API_PORT = "$ApiPort"
`$env:PIXEL_FORGE_PORT = "$ApiPort"
`$env:PIXEL_FORGE_URL_HOST = "$UrlHost"
`$env:PIXEL_FORGE_SHELL_URL = `$url
`$env:PIXEL_FORGE_WITH_AGENT_DECK = "0"
`$env:PIXEL_FORGE_DEFAULT_AGENT_PROVIDER_ID = "codex-cli"

function Test-PixelForgeReady {
    try {
        `$response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri `$runtimeInfoUrl
        return `$response.StatusCode -ge 200 -and `$response.StatusCode -lt 300
    }
    catch {
        return `$false
    }
}

if (-not (Test-PixelForgeReady)) {
    Start-Process powershell.exe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$ApiLauncher") -WindowStyle Hidden
    for (`$i = 0; `$i -lt 60; `$i++) {
        if (Test-PixelForgeReady) {
            break
        }
        Start-Sleep -Milliseconds 250
    }
}

if (-not (Test-PixelForgeReady)) {
    throw "Pixel Forge API did not become ready at `$runtimeInfoUrl"
}

`$electronExe = Join-Path "$DesktopDir" "node_modules\electron\dist\electron.exe"
if (-not (Test-Path `$electronExe)) {
    throw "Pixel Forge desktop shell is not installed at `$electronExe. Re-run install-windows.ps1."
}

Start-Process -FilePath `$electronExe -ArgumentList @("--no-sandbox", "$DesktopDir") -WorkingDirectory "$DesktopDir"
"@

New-Launcher -Path $AppLauncher -Content @"
`$ErrorActionPreference = "Stop"
& "$ShellLauncher"
"@

New-Launcher -Path $HiddenAppLauncher -Content @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$ShellLauncher""", 0, False
"@

if (-not $SkipShortcuts) {
    $ProgramsDir = if ($env:PIXEL_FORGE_START_MENU_DIR) { $env:PIXEL_FORGE_START_MENU_DIR } else { [Environment]::GetFolderPath("Programs") }
    $DesktopShortcutDir = if ($env:PIXEL_FORGE_DESKTOP_DIR) { $env:PIXEL_FORGE_DESKTOP_DIR } else { [Environment]::GetFolderPath("Desktop") }
    $ShortcutDir = Join-Path $ProgramsDir "Pixel Forge"
    $ShortcutIcon = if (Test-Path $IconIcoPath) { $IconIcoPath } else { $IconPath }
    New-Item -ItemType Directory -Force -Path $ShortcutDir, $DesktopShortcutDir | Out-Null
    New-Shortcut `
        -ShortcutPath (Join-Path $ShortcutDir "Pixel Forge.lnk") `
        -TargetPath "wscript.exe" `
        -Arguments "`"$HiddenAppLauncher`"" `
        -WorkingDirectory $RuntimeDir `
        -Description "Open Pixel Forge" `
        -IconPath $ShortcutIcon
    New-Shortcut `
        -ShortcutPath (Join-Path $DesktopShortcutDir "Pixel Forge.lnk") `
        -TargetPath "wscript.exe" `
        -Arguments "`"$HiddenAppLauncher`"" `
        -WorkingDirectory $RuntimeDir `
        -Description "Open Pixel Forge" `
        -IconPath $ShortcutIcon
    New-Shortcut `
        -ShortcutPath (Join-Path $ShortcutDir "Pixel Forge API.lnk") `
        -TargetPath "powershell.exe" `
        -Arguments "-NoProfile -ExecutionPolicy Bypass -File `"$ApiLauncher`"" `
        -WorkingDirectory $RuntimeDir `
        -Description "Start Pixel Forge API" `
        -IconPath $ShortcutIcon
    New-Shortcut `
        -ShortcutPath (Join-Path $ShortcutDir "Pixel Forge Web.lnk") `
        -TargetPath "powershell.exe" `
        -Arguments "-NoProfile -ExecutionPolicy Bypass -File `"$WebLauncher`"" `
        -WorkingDirectory $RuntimeDir `
        -Description "Open Pixel Forge in the browser" `
        -IconPath $ShortcutIcon
}

Info "Windows groundwork install complete"
Write-Host "Runtime: $RuntimeDir"
Write-Host "State:   $StateDir"
Write-Host "Launch:  powershell -ExecutionPolicy Bypass -File `"$AppLauncher`""
Write-Host "Start:   powershell -ExecutionPolicy Bypass -File `"$ApiLauncher`""
Write-Host "Open:    powershell -ExecutionPolicy Bypass -File `"$WebLauncher`""
