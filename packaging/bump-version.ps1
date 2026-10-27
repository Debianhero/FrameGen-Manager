param([Parameter(Mandatory=$true)][string]$Version)
# 一键改版本号（P1-6）：四处必须一致，改完顺带跑一致性校验。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$files = @(
  (Join-Path $root 'Cargo.toml'),
  (Join-Path $root 'crates/core/Cargo.toml'),
  (Join-Path $root 'apps/sidecar/Cargo.toml'),
  (Join-Path $root 'apps/electron/package.json')
)
$pattern = '"\d+\.\d+\.\d+"'
foreach ($f in $files) {
  $text = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
  $new = [regex]::Replace($text, '(?m)^(\s*version\s*=\s*)"\d+\.\d+\.\d+"', ('$1"' + $Version + '"'), 1)
  $new = [regex]::Replace($new, '(?m)^(\s*"version"\s*:\s*)"\d+\.\d+\.\d+"', ('$1"' + $Version + '"'), 1)
  if ($new -ne $text) {
    [System.IO.File]::WriteAllText($f, $new, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output ("  updated " + (Split-Path $f -Leaf))
  }
}
$bad = @()
foreach ($f in $files) {
  $text = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
  if ($text -notmatch [regex]::Escape('"' + $Version + '"')) { $bad += (Split-Path $f -Leaf) }
}
if ($bad.Count -gt 0) { throw ("版本号不一致: " + ($bad -join ', ')) }
Write-Output ("OK  version = " + $Version)
