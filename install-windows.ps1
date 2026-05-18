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
Require-Command "pnpm" "Install pnpm with: corepack enable pnpm"
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
$IconSource = Join-Path $Source "apps\web\public\favicon\app.png"
$IconDir = Join-Path $RuntimeDir "icons"
$IconPath = Join-Path $IconDir "pixel-forge.png"

New-Item -ItemType Directory -Force -Path $RuntimeDir, $BinDir, $StateDir, $IconDir | Out-Null

if (-not $SkipBuild) {
    Info "Installing workspace dependencies"
    Push-Location $Source
    try {
        pnpm install --frozen-lockfile
        pnpm --dir apps/web build
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
if (Test-Path $IconSource) {
    Copy-Item -Force $IconSource $IconPath
}

Info "Installing Python dependencies"
if (-not (Test-Path (Join-Path $VenvDir "Scripts\python.exe"))) {
    python -m venv $VenvDir
}
& (Join-Path $VenvDir "Scripts\python.exe") -m pip install --upgrade pip
& (Join-Path $VenvDir "Scripts\python.exe") -m pip install -r (Join-Path $Source "apps\api\requirements.txt")

$ApiPort = if ($env:PIXEL_FORGE_API_PORT) { $env:PIXEL_FORGE_API_PORT } elseif ($env:PIXEL_FORGE_PORT) { $env:PIXEL_FORGE_PORT } else { "7201" }
$UrlHost = if ($env:PIXEL_FORGE_URL_HOST) { $env:PIXEL_FORGE_URL_HOST } else { "127.0.0.1" }
$ApiLauncher = Join-Path $BinDir "pixel-forge-api.ps1"
$WebLauncher = Join-Path $BinDir "pixel-forge-open-web.ps1"

New-Launcher -Path $ApiLauncher -Content @"
`$ErrorActionPreference = "Stop"
`$env:PIXEL_FORGE_INSTALL_DIR = "$RuntimeDir"
`$env:PIXEL_FORGE_SHARED_STATE_DIR = "$StateDir"
`$env:PIXEL_FORGE_RUNTIME_DIR = "$RuntimeDir"
`$env:PIXEL_FORGE_API_PORT = "$ApiPort"
`$env:PIXEL_FORGE_PORT = "$ApiPort"
`$env:PIXEL_FORGE_URL_HOST = "$UrlHost"
Set-Location "$ApiDir"
& "$VenvDir\Scripts\python.exe" "main.py"
"@

New-Launcher -Path $WebLauncher -Content @"
`$url = "http://${UrlHost}:${ApiPort}/"
Start-Process `$url
"@

if (-not $SkipShortcuts) {
    $ProgramsDir = [Environment]::GetFolderPath("Programs")
    $ShortcutDir = Join-Path $ProgramsDir "Pixel Forge"
    New-Item -ItemType Directory -Force -Path $ShortcutDir | Out-Null
    New-Shortcut `
        -ShortcutPath (Join-Path $ShortcutDir "Pixel Forge API.lnk") `
        -TargetPath "powershell.exe" `
        -Arguments "-NoProfile -ExecutionPolicy Bypass -File `"$ApiLauncher`"" `
        -WorkingDirectory $RuntimeDir `
        -Description "Start Pixel Forge API" `
        -IconPath $IconPath
    New-Shortcut `
        -ShortcutPath (Join-Path $ShortcutDir "Pixel Forge Web.lnk") `
        -TargetPath "powershell.exe" `
        -Arguments "-NoProfile -ExecutionPolicy Bypass -File `"$WebLauncher`"" `
        -WorkingDirectory $RuntimeDir `
        -Description "Open Pixel Forge in the browser" `
        -IconPath $IconPath
}

Info "Windows groundwork install complete"
Write-Host "Runtime: $RuntimeDir"
Write-Host "State:   $StateDir"
Write-Host "Start:   powershell -ExecutionPolicy Bypass -File `"$ApiLauncher`""
Write-Host "Open:    powershell -ExecutionPolicy Bypass -File `"$WebLauncher`""
