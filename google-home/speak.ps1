param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice = $speech.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ja-JP' } | Select-Object -First 1
  if (-not $voice) { throw 'No Japanese desktop SAPI voice installed' }
  $speech.SelectVoice($voice.VoiceInfo.Name)
  $speech.Rate = 0
  $speech.SetOutputToWaveFile($OutputFile)
  $speech.Speak([IO.File]::ReadAllText($InputFile))
} finally { $speech.Dispose() }
