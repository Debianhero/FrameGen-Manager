# Pre-commit preflight (T6). ASCII only on purpose: Windows PowerShell 5.1
# reads scripts as ANSI, so non-ASCII text breaks parsing without a BOM.
#
#   powershell -ExecutionPolicy Bypass -File packaging\preflight.ps1 [-SkipTests]
#
# Checks:
#   1) no "\r\r" in sources (scripted writes with newline translation doubled the CR)
#   2) JS syntax (node --check)
#   3) i18n coverage (dev-only/i18n-coverage.py)
#   4) Rust tests (cargo test) unless -SkipTests
param([switch]$SkipTests)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fail = @()

Write-Output '== 1. CRLF sanity =='
$latin1 = [System.Text.Encoding]::GetEncoding(28591)
$bad = @()
$files = Get-ChildItem -Path $root -Recurse -File | Where-Object {
  $_.FullName -notmatch '\\(target|node_modules|\.git)\\' -and
  @('.js', '.html', '.json', '.nsh', '.css', '.rs', '.ps1', '.md') -contains $_.Extension
}
foreach ($f in $files) {
  $text = [System.IO.File]::ReadAllText($f.FullName, $latin1)
  if ($text.Contains("`r`r")) { $bad += $f.FullName.Substring($root.Length + 1) }
}
if ($bad.Count -gt 0) {
  $fail += 'double-CR'
  $bad | ForEach-Object { Write-Output ('  [BAD] ' + $_) }
} else {
  Write-Output '  OK'
}

Write-Output '== 2. JS syntax =='
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Output '  skipped (node not found)'
} else {
  # ui/ 下的脚本全查（P1-12 拆成多个文件后，漏查一个就等于没有语法门禁）
  $jsList = @()
  $uiDir = Join-Path $root 'apps\electron\ui'
  if (Test-Path $uiDir) {
    $jsList += (Get-ChildItem $uiDir -Filter *.js -File | Sort-Object Name | ForEach-Object { 'apps/electron/ui/' + $_.Name })
  }
  $jsList += @('apps/electron/main.js', 'apps/electron/preload.js')
  foreach ($f in $jsList) {
    $p = Join-Path $root $f
    if (-not (Test-Path $p)) { continue }
    & node --check $p 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $fail += ('syntax: ' + $f); Write-Output ('  [BAD] ' + $f) }
  }
  Write-Output '  OK'
}

Write-Output '== 3. i18n coverage =='
$cov = Join-Path (Split-Path -Parent $root) 'dev-only\i18n-coverage.py'
if (-not (Test-Path $cov)) {
  Write-Output '  skipped (dev-only not found)'
} else {
  $py = Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) {
    Write-Output '  skipped (python not found)'
  } else {
    $env:PYTHONIOENCODING = 'utf-8'
    $out = & python $cov 2>&1
    $code = $LASTEXITCODE
    $out | ForEach-Object { if ($_ -match 'app\.js|index\.html') { Write-Output ('  ' + $_.Trim()) } }
    if ($code -ne 0) { $fail += 'i18n coverage'; Write-Output '  [BAD] coverage check failed' }
  }
}

if (-not $SkipTests) {
  Write-Output '== 4. cargo test =='
  Push-Location $root
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = & cargo test --quiet --manifest-path crates/core/Cargo.toml 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  $out | Select-String -Pattern 'test result|FAILED' | ForEach-Object { Write-Output ('  core   ' + $_.Line.Trim()) }
  if ($code -ne 0) { $fail += 'cargo test (core)' }

  $out2 = & cargo test --quiet --manifest-path apps/sidecar/Cargo.toml 2>&1
  $code2 = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  $out2 | Select-String -Pattern 'test result|FAILED' | ForEach-Object { Write-Output ('  sidecar ' + $_.Line.Trim()) }
  if ($code2 -ne 0) { $fail += 'cargo test (sidecar)' }
  Pop-Location
}

Write-Output ''
if ($fail.Count -gt 0) {
  Write-Output ('FAILED: ' + ($fail -join ', '))
  exit 1
}
Write-Output 'all checks passed'
