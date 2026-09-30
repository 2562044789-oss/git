@echo off
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
 echo 请右键本文件，选择“以管理员身份运行”。
 pause
 exit /b 1
)
netsh advfirewall firewall delete rule name="Sunshine Community Backend 3000" >nul 2>&1
netsh advfirewall firewall add rule name="Sunshine Community Backend 3000" dir=in action=allow protocol=TCP localport=3000
echo 已允许手机访问电脑的 3000 端口。
pause
