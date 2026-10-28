# Deploy/scan baseline (T10). ASCII only (PowerShell 5.1 reads ANSI).
#
#   powershell -ExecutionPolicy Bypass -File packaging\bench.ps1 [-Runs 5]
#
# What it measures (all against a throw-away data dir, nothing touches real installs):
#   1) sidecar startup (ping)
#   2) library listing (list_games)
#   3) deploy of the bundled frame-gen assets into a sandbox dir
#
# Keep the printed numbers; they are the baseline any "speed up deploy" change must beat.
param([int]$Runs = 3)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sidecar = Join-Path $root 'apps\sidecar\target\release\framegen-sidecar.exe'
if (-not (Test-Path $sidecar)) { throw "sidecar not built: $sidecar" }

$sandbox = Join-Path $env:TEMP 'fgm-bench'
$data = Join-Path $sandbox 'data'
$game = Join-Path $sandbox 'game'
if (Test-Path $sandbox) { Remove-Item $sandbox -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $data 'assets') | Out-Null
New-Item -ItemType Directory -Force $game | Out-Null

# assets needed by deploy
$src = Join-Path $root 'apps\electron\bundled-assets'
if (-not (Test-Path $src)) { throw "bundled-assets missing: $src" }
Copy-Item (Join-Path $src '*') (Join-Path $data 'assets') -Recurse -Force
Copy-Item (Join-Path $env:SystemRoot 'System32\notepad.exe') (Join-Path $game 'Game.exe')

$env:FGM_DATA_DIR = $data
$gameArg = $game -replace '\\', '\\\\'

function Invoke-Cmd([string]$json) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $null = $json | & $sidecar 2>$null
  $sw.Stop()
  return $sw.ElapsedMilliseconds
}

Write-Output ("runs = $Runs")
$ping = @()
$list = @()
for ($i = 1; $i -le $Runs; $i++) {
  $ping += Invoke-Cmd '{"id":1,"cmd":"ping"}'
  $list += Invoke-Cmd '{"id":2,"cmd":"list_games"}'
}
$deploy = @()
for ($i = 1; $i -le $Runs; $i++) {
  $json = '{"id":3,"cmd":"deploy_game","args":{"dir":"' + $gameArg + '","proxy":"version.dll","optimized":1,"frames":3,"preset":"A","sr":false,"srMode":"Off","engine":"DLSS","flow":"Middle","hudless":"Auto"}}'
  $deploy += Invoke-Cmd $json
}

function Stat([string]$name, $arr) {
  $sorted = $arr | Sort-Object
  $avg = [math]::Round((($arr | Measure-Object -Average).Average), 1)
  $min = $sorted[0]
  $max = $sorted[$sorted.Count - 1]
  Write-Output ("  {0,-14} avg {1,7} ms   min {2,6}   max {3,6}" -f $name, $avg, $min, $max)
}

Write-Output '== results =='
Stat 'startup(ping)' $ping
Stat 'list_games' $list
Stat 'deploy' $deploy

Remove-Item Env:FGM_DATA_DIR -ErrorAction SilentlyContinue
Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
Write-Output 'done'
