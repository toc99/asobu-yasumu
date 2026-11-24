@echo off
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0run.ps1"
exit /b %ERRORLEVEL%
