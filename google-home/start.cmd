@echo off
cd /d "%~dp0.."
if not exist "google-home\.env.local" (
  echo Configure google-home\.env.local first.
  exit /b 1
)
if not exist "google-home\.venv\Scripts\python.exe" (
  echo Run google-home\setup.ps1 first.
  exit /b 1
)
set "GH_PYTHON=%~dp0.venv\Scripts\python.exe"
node --env-file=google-home/.env.local google-home/bridge.mjs
exit /b %ERRORLEVEL%
