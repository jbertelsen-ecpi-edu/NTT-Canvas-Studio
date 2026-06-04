# package-extension.ps1
# ---------------------------------------------------------------------------
# Builds a clean, versioned zip of the browser extension for "Load unpacked"
# distribution to the team. Includes ONLY the files the extension needs at
# runtime — not the Theme base CSS, build scripts, dist, docs, or git data.
#
# Usage:  pwsh ./package-extension.ps1
# Output: dist/NTT-Canvas-Editor-v<version>.zip
#         (unzips to a NTT-Canvas-Editor/ folder with manifest.json at its root)
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$root    = $PSScriptRoot
$distDir = Join-Path $root 'dist'

# Files/folders that make up the shippable extension.
$include = @(
    'manifest.json',
    'runtime.js',
    'runtime.css',
    'authoring.js',
    'authoring.css',
    'background.js',
    'popup.html',
    'popup.css',
    'popup.js',
    'icons'
)

# Read version from the manifest so the zip name tracks it.
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$version  = $manifest.version
if (-not $version) { throw "Could not read version from manifest.json" }

# Verify every expected item exists before packaging.
foreach ($item in $include) {
    $p = Join-Path $root $item
    if (-not (Test-Path $p)) { throw "Missing extension file/folder: $item" }
}

if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }

# Stage into a named folder so the zip extracts to NTT-Canvas-Editor/.
$stageRoot = Join-Path $distDir 'pkg'
$stageDir  = Join-Path $stageRoot 'NTT-Canvas-Editor'
if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir | Out-Null

foreach ($item in $include) {
    Copy-Item (Join-Path $root $item) -Destination $stageDir -Recurse
}

$zipPath = Join-Path $distDir "NTT-Canvas-Editor-v$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $stageDir -DestinationPath $zipPath

Remove-Item $stageRoot -Recurse -Force

$size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "OK  wrote $zipPath ($size KB)"
Write-Host ""
Write-Host "Share this zip with the team. They extract it to a PERMANENT folder"
Write-Host "and Load unpacked the NTT-Canvas-Editor folder (see INSTALL.md)."
