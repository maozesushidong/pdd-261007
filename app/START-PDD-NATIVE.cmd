@echo off
setlocal
chcp 65001 >nul
title PDD Automation - Start
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-native-windows.ps1" -StartWorker -NoBrowser
if errorlevel 1 (
  echo.
  echo PDD automation failed to start. Review the error above.
  pause
  exit /b 1
)
echo.
echo PDD automation started successfully.
echo Dashboard: http://127.0.0.1:4173/
timeout /t 5 /nobreak >nul
endlocal
