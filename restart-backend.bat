@echo off
chcp 65001 >nul
echo 正在停止旧后端...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Start-Sleep -Milliseconds 800 }"
echo 正在启动新后端...
cd /d "%~dp0backend"
node --no-warnings src/server.js
pause
