<#
.SYNOPSIS
  Bumps the app version in every place it is stored.
.DESCRIPTION
  Updates package.json, package-lock.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml and
  src-tauri/Cargo.lock so they never drift apart (the installer takes its version from tauri.conf.json).
.PARAMETER Part
  patch (default), minor or major.
.PARAMETER Version
  Set an explicit version instead, e.g. 1.2.0 or 1.2.0-beta.1
.PARAMETER DryRun
  Show what would change without writing anything.
.EXAMPLE
  .\bump-version.ps1            # 0.1.0 -> 0.1.1
  .\bump-version.ps1 minor      # 0.1.1 -> 0.2.0
  .\bump-version.ps1 -Version 1.0.0
#>
[CmdletBinding()]
param(
    [ValidateSet('major', 'minor', 'patch')][string]$Part = 'patch',
    [string]$Version,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$semver = '^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-Text($path) { [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot $path)) }
function Write-Text($path, $text) {
    if (-not $DryRun) { [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot $path), $text, $utf8) }
}

# current version = the one in tauri.conf.json (source of truth for the installer)
$conf = Read-Text 'src-tauri/tauri.conf.json'
if ($conf -notmatch '"version":\s*"([^"]+)"') { throw 'version not found in tauri.conf.json' }
$current = $Matches[1]

if ($Version) {
    if ($Version -notmatch $semver) { throw "'$Version' is not a valid semver (x.y.z[-pre])" }
    $new = $Version
} else {
    if ($current -notmatch $semver) { throw "Current version '$current' is not plain semver" }
    $maj = [int]$Matches[1]; $min = [int]$Matches[2]; $pat = [int]$Matches[3]
    switch ($Part) {
        'major' { $maj++; $min = 0; $pat = 0 }
        'minor' { $min++; $pat = 0 }
        'patch' { $pat++ }
    }
    $new = "$maj.$min.$pat"
}
if ($new -eq $current) { Write-Host "Already at $current - nothing to do."; return }

Write-Host "Version: $current -> $new$(if ($DryRun) { '  (dry run)' })" -ForegroundColor Cyan

# replace only the FIRST match so dependency versions are never touched
function Set-First([string]$path, [string]$pattern, [string]$replacement) {
    $text = Read-Text $path
    $rx = [regex]::new($pattern, 'Multiline')
    if (-not $rx.IsMatch($text)) { throw "Pattern not found in $path" }
    Write-Text $path ($rx.Replace($text, $replacement, 1))
    Write-Host "  $(if ($DryRun) { 'would update' } else { 'updated' }) $path"
}

Set-First 'package.json' '("version":\s*")[^"]+(")' "`${1}$new`${2}"
Set-First 'src-tauri/tauri.conf.json' '("version":\s*")[^"]+(")' "`${1}$new`${2}"
Set-First 'src-tauri/Cargo.toml' '^(version\s*=\s*")[^"]+(")' "`${1}$new`${2}"

# package-lock.json: root entry appears twice (top level and packages[""])
if (Test-Path 'package-lock.json') {
    $lock = Read-Text 'package-lock.json'
    $rx = [regex]::new('("name":\s*"pdfio",\s*"version":\s*")[^"]+(")')
    Write-Text 'package-lock.json' ($rx.Replace($lock, "`${1}$new`${2}"))
    Write-Host '  updated package-lock.json'
}

# Cargo.lock: only the pdfio package entry
if (Test-Path 'src-tauri/Cargo.lock') {
    $cl = Read-Text 'src-tauri/Cargo.lock'
    $rx = [regex]::new('(name = "pdfio"\r?\nversion = ")[^"]+(")')
    if ($rx.IsMatch($cl)) {
        Write-Text 'src-tauri/Cargo.lock' ($rx.Replace($cl, "`${1}$new`${2}", 1))
        Write-Host '  updated src-tauri/Cargo.lock'
    }
}

Write-Host "Done. Next: .\package.ps1" -ForegroundColor Green
