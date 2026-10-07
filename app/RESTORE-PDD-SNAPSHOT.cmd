@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restore-repository-snapshot.ps1" %*
if errorlevel 1 (
  echo.
  echo PDD repository snapshot restore failed.
  exit /b 1
)
echo.
echo PDD repository snapshot restore completed.
endlocal
