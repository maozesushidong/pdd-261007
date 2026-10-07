@echo off
setlocal
chcp 65001 >nul
title PDD Automation - Stop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-native-windows.ps1"
if errorlevel 1 pause
endlocal
