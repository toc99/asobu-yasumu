$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$mutex = [System.Threading.Mutex]::new($false, 'Global\AsobuYasumuGoogleHomeBridge')
$owned = $false
$code = 1
try {
  try { $owned = $mutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) {
    Write-Host 'Google Home bridge is already running. No second instance started.'
    $code = 0
  } else {
    Set-Location $root
    if (-not (Test-Path (Join-Path $PSScriptRoot '.env.local'))) { throw 'Configure google-home/.env.local first.' }
    $env:GH_PYTHON = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path $env:GH_PYTHON)) { throw 'Run google-home/setup.ps1 first.' }
    & node --env-file=google-home/.env.local google-home/bridge.mjs
    $code = $LASTEXITCODE
  }
} catch {
  Write-Error -ErrorAction Continue 'Google Home bridge startup failed. Check local setup and log.'
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
exit $code
