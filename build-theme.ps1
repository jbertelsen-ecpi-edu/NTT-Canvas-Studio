# build-theme.ps1
# ---------------------------------------------------------------------------
# Produces the combined Canvas Theme CSS for upload WITHOUT ever modifying the
# pristine institutional base file (NTTcanvasUI.20190225.css).
#
# The base is copied BYTE-FOR-BYTE, then the NTT component styles (runtime.css)
# are appended inside a clearly delimited, commented block matching the file's
# existing style. A self-check then verifies the base bytes are preserved
# exactly; if even one byte differs, the build aborts and writes nothing usable.
#
# Usage:  pwsh ./build-theme.ps1   (or right-click > Run with PowerShell)
# Output: dist/NTTcanvasUI.<yyyyMMdd>.css   <- upload this to Canvas Theme CSS
#         dist/runtime.<yyyyMMdd>.js        <- upload this to Canvas Theme JS
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$root     = $PSScriptRoot
$basePath = Join-Path $root 'NTTcanvasUI.20190225.css'
$cssPath  = Join-Path $root 'runtime.css'
$jsPath   = Join-Path $root 'runtime.js'
$distDir  = Join-Path $root 'dist'
$stamp    = Get-Date -Format 'yyyyMMdd'
$today    = Get-Date -Format 'MM/dd/yyyy'
$outCss   = Join-Path $distDir "NTTcanvasUI.$stamp.css"
$outJs    = Join-Path $distDir "runtime.$stamp.js"

if (-not (Test-Path $basePath)) { throw "Base CSS not found: $basePath" }
if (-not (Test-Path $cssPath))  { throw "runtime.css not found: $cssPath" }
if (-not (Test-Path $distDir))  { New-Item -ItemType Directory -Path $distDir | Out-Null }

function ToCrlf([string]$text) {
    # Normalize any LF / CRLF / CR mix to CRLF, matching the base file.
    return ($text -replace "`r`n", "`n" -replace "`r", "`n" -replace "`n", "`r`n")
}

# 1. Read the pristine base as raw bytes. This array is never altered.
$baseBytes = [System.IO.File]::ReadAllBytes($basePath)

# 2. Build the appended NTT block. CRLF, tab style, no BOM. The banner mirrors
#    the existing header/change-log comment style and makes clear that
#    everything above is the untouched original.
$banner = @"


/********************************************************************************
*********************************************************************************
*** NTT Canvas Interactive Components (Tabs / Accordion / File Download Rows) ***
*********************************************************************************
********************************************************************************/

/**
 *   NTT Canvas Interactive Components
 *
 *   Added: $today
 *
 *   Source of truth: runtime.css in the NTT Canvas Editor project.
 *   AUTO-APPENDED by build-theme.ps1 -- do NOT hand-edit below this banner.
 *   To change these styles, edit runtime.css in the project and rebuild.
 *
 *   Everything ABOVE this banner is the original NTTcanvasUI.20190225.css,
 *   preserved byte-for-byte.
 *
 *   All selectors below are namespaced to .ntt-* and have no effect on pages
 *   that do not contain NTT components.
 *
 *   Change Log
 *   ----------
		$today
			Initial integration of NTT Tabs / Accordion / File Row styles.
 */


"@

$appendText  = (ToCrlf $banner) + (ToCrlf ([System.IO.File]::ReadAllText($cssPath)))
$appendBytes = [System.Text.Encoding]::UTF8.GetBytes($appendText)   # UTF8.GetBytes adds no BOM

# 3. Concatenate base (verbatim) + appended block and write. No BOM.
$all = New-Object byte[] ($baseBytes.Length + $appendBytes.Length)
[System.Array]::Copy($baseBytes, 0, $all, 0, $baseBytes.Length)
[System.Array]::Copy($appendBytes, 0, $all, $baseBytes.Length, $appendBytes.Length)
[System.IO.File]::WriteAllBytes($outCss, $all)

# 4. SELF-CHECK: the first N bytes of the output MUST equal the base exactly.
$outBytes = [System.IO.File]::ReadAllBytes($outCss)
if ($outBytes.Length -lt $baseBytes.Length) {
    Remove-Item $outCss -Force
    throw "Output shorter than base -- aborted, no file kept."
}
for ($i = 0; $i -lt $baseBytes.Length; $i++) {
    if ($outBytes[$i] -ne $baseBytes[$i]) {
        Remove-Item $outCss -Force
        throw "Byte mismatch at offset $i -- base NOT preserved. Output deleted."
    }
}

# 5. Stage the runtime JS for the (currently empty) Theme JS slot. No base to
#    preserve here, so a plain dated copy is sufficient.
Copy-Item $jsPath $outJs -Force

Write-Host "OK  base preserved byte-for-byte ($($baseBytes.Length) bytes verified)."
Write-Host "OK  wrote $outCss ($($outBytes.Length) bytes; +$($appendBytes.Length) appended)."
Write-Host "OK  wrote $outJs."
Write-Host ""
Write-Host "Upload to Canvas Theme Editor:"
Write-Host "  CSS file        -> dist/NTTcanvasUI.$stamp.css"
Write-Host "  JavaScript file -> dist/runtime.$stamp.js"
Write-Host "Rollback if needed: re-upload the original NTTcanvasUI.20190225.css."
