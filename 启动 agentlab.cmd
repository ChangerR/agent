@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "AGENTLAB_DESKTOP=%~dp0desktop\release\agentlab-win32-x64\agentlab.exe"

if not exist "%AGENTLAB_DESKTOP%" (
  echo 未找到 agentlab 应用。
  echo 请先在项目目录运行 pnpm desktop:package，再双击此文件。
  echo.
  pause
  exit /b 1
)

start "" "%AGENTLAB_DESKTOP%"
if errorlevel 1 (
  echo 启动失败，请检查应用目录是否完整。
  pause
  exit /b 1
)
exit /b 0
