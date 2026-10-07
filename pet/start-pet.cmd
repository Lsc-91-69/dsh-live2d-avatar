@echo off
REM 桌宠启动器：双击即可。只在 DSH 开着的时候才会真正显示。
setlocal
set URL=http://127.0.0.1:3080
if not "%~1"=="" set URL=%~1
where pwsh >nul 2>nul
if errorlevel 1 (
  echo 需要 PowerShell 7 ^(pwsh^)。请先安装： winget install Microsoft.PowerShell
  pause
  exit /b 1
)
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-pet.ps1" -Url "%URL%"
if errorlevel 1 pause
endlocal
