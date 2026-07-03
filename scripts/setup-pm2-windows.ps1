# TaskGraph OS — pm2 boot persistence (Windows, run as Administrator)
# Usage: powershell -ExecutionPolicy Bypass -File scripts/setup-pm2-windows.ps1

$ErrorActionPreference = "Stop"

Write-Host "Installing pm2 + pm2-windows-startup globally..."
npm install -g pm2 pm2-windows-startup

Write-Host "Installing pm2-logrotate..."
pm2 install pm2-logrotate

Write-Host "Saving current pm2 process list..."
pm2 save

Write-Host "Installing Windows startup hook..."
pm2-startup install

Write-Host ""
Write-Host "Done. Reboot once and verify: pm2 status"
Write-Host "Also disable sleep/hibernate in Windows power settings for 24/7 operation."
