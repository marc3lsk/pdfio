<#
.SYNOPSIS
  Starts PDFio in development mode.
.DESCRIPTION
  Default: full desktop app (Tauri + Vite, hot reload).
  -Web   : frontend only in the browser (http://127.0.0.1:1420) - fastest UI iteration, no Rust needed.
.EXAMPLE
  .\dev.ps1
  .\dev.ps1 -Web
#>
[CmdletBinding()]
param(
    [switch]$Web
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# rustup installs to %USERPROFILE%\.cargo\bin, which a fresh shell may not have on PATH yet
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ((Test-Path $cargoBin) -and ($env:Path -notlike "*$cargoBin*")) { $env:Path += ";$cargoBin" }

function Assert-Tool([string]$name, [string]$hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "'$name' not found. $hint" }
}

Assert-Tool node 'Install Node.js 20+ from https://nodejs.org'
if (-not $Web) { Assert-Tool cargo 'Install Rust from https://rustup.rs (plus VS Build Tools, "Desktop development with C++").' }

if (-not (Test-Path node_modules)) {
    Write-Host '> npm install' -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}

# Vite uses a fixed port (strictPort) - free it if a previous run left something behind
$busy = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    foreach ($c in $busy) {
        $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        Write-Warning "Port 1420 is in use by '$($p.ProcessName)' (PID $($c.OwningProcess)) - stopping it."
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

if ($Web) {
    Write-Host '> vite (browser mode) -> http://127.0.0.1:1420' -ForegroundColor Cyan
    npm run dev
} else {
    Write-Host '> tauri dev (first build compiles Rust dependencies, takes a few minutes)' -ForegroundColor Cyan
    npm run app:dev
}
exit $LASTEXITCODE
