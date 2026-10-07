@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-native-windows-shop-browsers.ps1"
if errorlevel 1 pause
endlocal
