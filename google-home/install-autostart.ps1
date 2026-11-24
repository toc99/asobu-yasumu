param([switch]$Remove, [switch]$StartNow)
$ErrorActionPreference = 'Stop'
$name = 'AsobuYasumu-GoogleHome'
if ($Remove) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
  }
  Write-Host 'Automatic startup removed. Manual start.cmd remains available.'
  exit 0
}
if (-not (Test-Path (Join-Path $PSScriptRoot '.env.local')) -or
    -not (Test-Path (Join-Path $PSScriptRoot '.venv\Scripts\python.exe'))) {
  throw 'Complete setup and verify manual playback first.'
}
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$script = Join-Path $PSScriptRoot 'run.ps1'
$exe = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path $exe)) { $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + $script + '"'
$action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Local Asobu Yasumu Google Home notification bridge' -Force | Out-Null
Write-Host 'Registered: start after this Windows user signs in; retry on abnormal exit.'
if ($StartNow) { Start-ScheduledTask -TaskName $name }
Write-Host 'Stop manual start.cmd before starting the scheduled task.'
