@echo off
chcp 65001 >nul
title Composition Coach Launcher
cd /d "%~dp0"

echo.
echo   构图教练 · 一键启动
echo   ==================
echo.

echo [1/2] 启动本地服务 (localhost:5177) ...
start "CC-本地服务" cmd /k node server.js

timeout /t 2 >nul

echo [2/2] 启动 serveo 公网隧道（SSH，保持窗口开着别关）...
start "CC-隧道" cmd /k ssh -i "%USERPROFILE%\.ssh\serveo_key" -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R coach48663:80:localhost:5177 serveo.net

echo.
echo   完成。隧道窗口里 "Forwarding HTTP traffic from" 后面就是手机访问地址。
echo   电脑访问:  http://localhost:5177
echo   说明: 已注册 serveo 密钥后，地址固定为 https://coach48663.serveo.net；
echo         未注册时每次启动地址会变，以隧道窗口显示为准。
echo.
pause
