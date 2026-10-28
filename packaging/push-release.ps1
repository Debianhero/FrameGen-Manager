# Push source + tag from the LOCAL repo (T9).
#
# Replaces the old "clone into %TEMP%, robocopy, commit, push" dance: the local
# checkout is now the source of truth, so history and diffs actually exist.
#
#   powershell -ExecutionPolicy Bypass -File packaging\push-release.ps1 -Tag v1.5.1
#
# Token comes from the same git credential helper the rest of the flow uses.
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$Branch = 'main',
  [string]$Remote = 'origin'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Get-Token {
  $q = Join-Path $env:TEMP 'fgm-cred-in.txt'
  $o = Join-Path $env:TEMP 'fgm-cred-out.txt'
  $e = Join-Path $env:TEMP 'fgm-cred-err.txt'
  [System.IO.File]::WriteAllText($q, "protocol=https`r`nhost=github.com`r`n`r`n")
  Start-Process -FilePath 'git' -ArgumentList 'credential', 'fill' `
    -RedirectStandardInput $q -RedirectStandardOutput $o -RedirectStandardError $e `
    -NoNewWindow -Wait | Out-Null
  $raw = Get-Content $o -Encoding UTF8 -ErrorAction SilentlyContinue
  $m = [regex]::Match(($raw -join "`n"), 'password=(\S+)')
  if (-not $m.Success) { throw 'no GitHub token in credential helper' }
  return $m.Groups[1].Value
}

Write-Output '== 1. worktree =='
$dirty = (git status --porcelain | Measure-Object -Line).Lines
if ($dirty -ne 0) {
  Write-Output "  ! $dirty uncommitted file(s); commit or stash before releasing"
  exit 2
}
Write-Output '  clean'

Write-Output '== 2. tag =='
$head = (git rev-parse HEAD).Trim()
$existing = (git tag --points-at HEAD) -split "`n" | Where-Object { $_ -eq $Tag }
if (-not $existing) {
  git tag -f $Tag | Out-Null
  Write-Output "  created $Tag at $head"
} else {
  Write-Output "  $Tag already at $head"
}

Write-Output '== 3. push =='
$token = Get-Token
$url = 'https://github.com/XiaoQAQ10086/FrameGen-Manager.git'
$ok = $false
for ($i = 1; $i -le 5; $i++) {
  if ($i % 2 -eq 1) {
    git push $Remote "$Branch" 2>&1 | Out-Null
  } else {
    git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $( [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$token")) )" push $Remote "$Branch" 2>&1 | Out-Null
  }
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  Start-Sleep 5
}
if (-not $ok) { throw 'push branch failed' }
Write-Output "  $Branch pushed"

$ok = $false
for ($i = 1; $i -le 5; $i++) {
  git push -f $Remote $Tag 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  Start-Sleep 5
}
if (-not $ok) { throw 'push tag failed' }
Write-Output "  $Tag pushed"

Write-Output '== 4. verify =='
$h = @{ Authorization = "Bearer $token"; 'User-Agent' = 'fgm-push' }
$repo = Invoke-RestMethod -Uri 'https://api.github.com/repos/XiaoQAQ10086/FrameGen-Manager' -Headers $h
$remoteHead = $repo.default_branch
$ref = Invoke-RestMethod -Uri "https://api.github.com/repos/XiaoQAQ10086/FrameGen-Manager/git/ref/heads/$remoteHead" -Headers $h
if ($ref.object.sha -ne $head) {
  Write-Output "  ! remote head $($ref.object.sha) != local $head"
  exit 3
}
Write-Output "  remote $remoteHead = $head"

Pop-Location
Write-Output ''
Write-Output 'done'
