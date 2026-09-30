@echo off
chcp 65001 >nul
title 阳光社区邻里快办 - 后端服务
cd /d "%~dp0backend"

echo ============================================
echo    阳光社区邻里快办 - 后端服务
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node 22 或更高版本。
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %errorlevel% equ 0 (
  echo 后端已在运行，正在为你打开浏览器...
  start "" "http://localhost:3000/preview/"
  %SystemRoot%\System32\ping.exe -n 3 127.0.0.1 >nul 2>&1
  exit /b 0
)

echo 正在启动后端服务，约 3 秒后自动打开浏览器...
echo.
echo    移动端预览 : http://localhost:3000/preview/
echo    管理后台   : http://localhost:3000/admin/    账号 admin / admin123
echo.
echo    关闭本窗口即可停止后端服务。
echo.
echo --------------------------------------------

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:3000/preview/'"

node --no-warnings src/server.js

echo.
echo --------------------------------------------
echo 后端已停止运行。
pause
