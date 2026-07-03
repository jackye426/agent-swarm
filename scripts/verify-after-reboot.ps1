# Run after host reboot to verify pm2 boot persistence.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/verify-after-reboot.ps1

$RepoRoot = Split-Path $PSScriptRoot -Parent
$LogFile = Join-Path $RepoRoot "logs\reboot-verify.log"
New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
Start-Transcript -Path $LogFile -Append | Out-Null

Write-Host "=== TaskGraph post-reboot verification ===" -ForegroundColor Cyan
Write-Host "Time: $(Get-Date -Format o)"
Write-Host ""

Write-Host "--- pm2 status ---" -ForegroundColor Yellow
pm2 list

$apps = @("taskgraph-scheduler", "taskgraph-intake", "taskgraph-watchdog")
$failed = @()

foreach ($app in $apps) {
  $line = pm2 jlist 2>$null | ConvertFrom-Json | Where-Object { $_.name -eq $app }
  if (-not $line -or $line.pm2_env.status -ne "online") {
    $failed += $app
  }
}

Write-Host ""
if ($failed.Count -eq 0) {
  Write-Host "PASS: all three TaskGraph apps online" -ForegroundColor Green
} else {
  Write-Host "FAIL: not online: $($failed -join ', ')" -ForegroundColor Red
  Write-Host "Try: cd to repo && pm2 resurrect"
  exit 1
}

Write-Host ""
Write-Host "--- healthcheck ---" -ForegroundColor Yellow
Set-Location $PSScriptRoot\..
npm run healthcheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Reboot test PASS" -ForegroundColor Green
Stop-Transcript | Out-Null
exit 0
