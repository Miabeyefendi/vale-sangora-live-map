@echo off
rem Starts the local map server hidden (no window). Started by the UE4SS mod at game launch;
rem with --follow-game the server exits by itself once Dawnwalker.exe is gone.
cd /d "%~dp0"
set "NODE=node"
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%NODE%' -ArgumentList 'src\main.js','--no-browser','--follow-game' -WindowStyle Hidden -WorkingDirectory '%~dp0'"
