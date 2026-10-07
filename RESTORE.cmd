@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restore-Pdd.ps1" %*
exit /b %errorlevel%
