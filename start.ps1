$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendRoot = Join-Path $projectRoot "backend"

Write-Host "Starting Sunshine Community Express API..." -ForegroundColor Green
Write-Host "Preview: http://localhost:3000/preview/"
Write-Host "Admin:   http://localhost:3000/admin/"

Set-Location $backendRoot
node --no-warnings src/server.js
