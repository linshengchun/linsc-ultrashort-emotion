@echo off
chcp 65001 >nul
cd /d "%~dp0"
where pwsh.exe >nul 2>nul
if not errorlevel 1 (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-evening-data-collection.ps1"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-evening-data-collection.ps1"
)
if errorlevel 1 (
  echo.
  echo 启动失败，请保留本窗口并查看上方错误信息。
  pause
)
