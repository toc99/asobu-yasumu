$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
node --version
if ($LASTEXITCODE -ne 0) { throw 'Install Node.js 22 LTS first.' }
npm.cmd install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
if (-not (Test-Path 'google-home\.venv\Scripts\python.exe')) {
  py -3 -m venv 'google-home\.venv'
  if ($LASTEXITCODE -ne 0) { throw 'Install supported Python 3 (3.11 or later) first.' }
}
& 'google-home\.venv\Scripts\python.exe' -m pip install -r 'google-home\requirements.txt'
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
if (-not (Test-Path 'google-home\.env.local')) { Copy-Item 'google-home\.env.example' 'google-home\.env.local' }
Write-Host 'Setup complete. Fill google-home\.env.local locally; never commit credentials.'
