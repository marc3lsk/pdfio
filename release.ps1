<#
.SYNOPSIS
  Builds the release installers (NSIS .exe and/or MSI) and collects them in .\release\.
.PARAMETER Bundle
  nsis, msi or all (default).
.PARAMETER SkipInstall
  Do not run npm install even if node_modules is missing.
.PARAMETER SkipChecks
  Skip the TypeScript check before building.
.EXAMPLE
  .\package.ps1
  .\package.ps1 -Bundle nsis
#>
[CmdletBinding()]
param(
    [ValidateSet('all', 'nsis', 'msi')][string]$Bundle = 'all',
    [switch]$SkipInstall,
    [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ((Test-Path $cargoBin) -and ($env:Path -notlike "*$cargoBin*")) { $env:Path += ";$cargoBin" }

foreach ($t in @(@('node', 'Install Node.js 20+'), @('cargo', 'Install Rust from https://rustup.rs'))) {
    if (-not (Get-Command $t[0] -ErrorAction SilentlyContinue)) { throw "'$($t[0])' not found. $($t[1])" }
}

function Invoke-Step([string]$title, [scriptblock]$block) {
    Write-Host "> $title" -ForegroundColor Cyan
    & $block
    if ($LASTEXITCODE -ne 0) { throw "Step failed: $title (exit code $LASTEXITCODE)" }
}

# --- versions must agree, otherwise the installer and the app disagree
$pkgVer = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tauriVer = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
$cargoVer = if ((Get-Content src-tauri/Cargo.toml -Raw) -match '(?m)^version\s*=\s*"([^"]+)"') { $Matches[1] } else { '?' }
if ($pkgVer -ne $tauriVer -or $tauriVer -ne $cargoVer) {
    throw "Version mismatch: package.json=$pkgVer, tauri.conf.json=$tauriVer, Cargo.toml=$cargoVer. Run .\bump-version.ps1 -Version $tauriVer"
}
Write-Host "Packaging PDFio $tauriVer" -ForegroundColor Green

if (-not (Test-Path node_modules) -and -not $SkipInstall) { Invoke-Step 'npm install' { npm install } }
if (-not $SkipChecks) { Invoke-Step 'typecheck' { npm run typecheck } }

$started = Get-Date
$buildArgs = @()
if ($Bundle -ne 'all') { $buildArgs += @('--bundles', $Bundle) }
Invoke-Step "tauri build ($Bundle)" { npm run app:build -- @buildArgs }

# --- collect artifacts
$bundleDir = 'src-tauri\target\release\bundle'
$out = Join-Path $PSScriptRoot 'release'
New-Item -ItemType Directory -Force $out | Out-Null

$files = Get-ChildItem $bundleDir -Recurse -Include *.exe, *.msi -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $started -and $_.Name -like "*$tauriVer*" }
if (-not $files) { throw "No installers found in $bundleDir" }

Write-Host "`nInstallers:" -ForegroundColor Green
foreach ($f in $files) {
    $dest = Copy-Item $f.FullName $out -Force -PassThru
    $hash = (Get-FileHash $dest.FullName -Algorithm SHA256).Hash
    '{0,-34} {1,7:N1} MB  sha256 {2}' -f $dest.Name, ($dest.Length / 1MB), $hash.Substring(0, 16)
}
Write-Host "`nCopied to $out" -ForegroundColor Green
