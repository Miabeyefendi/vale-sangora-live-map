@echo off
cd /d "%~dp0"
rem Usage: overlay.bat [Hotkey] [width] [height] [Center|TopLeft|TopRight|BottomLeft|BottomRight]
rem Started by the UE4SS mod 10 s after a save is loaded (see install-mod.bat); Alt+CapsLock in the
rem game shows/hides the map window (the mod writes src\assets\data\mod\overlay.cmd).
rem Hotkey is optional (none by default); width/height 0 = 80 percent of the screen, centered.
set "KEY=%~1"
set "W=%~2"
if "%W%"=="" set "W=0"
set "H=%~3"
if "%H%"=="" set "H=0"
set "C=%~4"
if "%C%"=="" set "C=Center"
start "" /min powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "src\overlay.ps1" -Hotkey "%KEY%" -Width %W% -Height %H% -Corner %C%
