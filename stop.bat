@echo off
rem Stops every map component: overlay hotkey loops, map windows, local server.
rem Components started by the game's UE4SS mod run elevated, so this re-launches itself as admin when needed.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent();" ^
  "if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Start-Process -FilePath '%~f0' -Verb RunAs; exit }" ^
  "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'overlay.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };" ^
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(brave|chrome|msedge)\.exe$' -and $_.CommandLine -match 'DawnwalkerMap' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };" ^
  "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -match '(overlay|server)\.bat' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };" ^
  "Get-NetTCPConnection -LocalPort 5321 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue };" ^
  "Write-Host 'Map components stopped.'; Start-Sleep 2"
