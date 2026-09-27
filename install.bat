@echo off
setlocal
rem Vale Sangora Live Map - installer
rem 1. asks for the game folder, 2. copies the UE4SS Lua mod into ue4ss\Mods, 3. downloads the map data.
cd /d "%~dp0"
echo.
echo  Vale Sangora Live Map - install
echo  ================================
echo.

rem --- Node.js ---
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found. Install the LTS version from https://nodejs.org and run install.bat again.
  echo.
  pause
  exit /b 1
)

rem --- game folder ---
set "GAME="
if exist "src\configs\game-path.txt" set /p GAME=<src\configs\game-path.txt
if not "%GAME%"=="" if not exist "%GAME%\Dawnwalker\Binaries\Win64" set "GAME="
if "%GAME%"=="" (
  echo  Enter the game folder, the one that contains "Dawnwalker.exe" and the "Dawnwalker" sub folder.
  echo  Example: D:\Games\The Blood of Dawnwalker
  set /p GAME=  Game folder:
)
if not exist "%GAME%\Dawnwalker\Binaries\Win64" (
  echo  "%GAME%\Dawnwalker\Binaries\Win64" does not exist. Check the path and run install.bat again.
  pause
  exit /b 1
)
set "MODS=%GAME%\Dawnwalker\Binaries\Win64\ue4ss\Mods"
if not exist "%MODS%" (
  echo  UE4SS is not installed: "%MODS%" is missing.
  echo  Install UE4SS first (see the mod page requirements), then run install.bat again.
  pause
  exit /b 1
)
> "src\configs\game-path.txt" echo %GAME%

rem --- mod copy ---
> "src\mod\DawnwalkerMapPos\Scripts\config.ini" (
  echo app_root=%~dp0
  echo autostart=overlay
  echo pins_interval=60
  echo quests_interval=60
  echo reveal_interval=900
  echo loot_interval=30
  echo items_interval=120
)
set "DEST=%MODS%\DawnwalkerMapPos"
if exist "%DEST%" (
  fsutil reparsepoint query "%DEST%" >nul 2>&1 && rmdir "%DEST%"
)
xcopy /E /I /Y "src\mod\DawnwalkerMapPos" "%DEST%" >nul
if errorlevel 1 (
  echo  Copying the mod failed. Run install.bat as administrator if the game folder is protected.
  pause
  exit /b 1
)
echo  Mod installed to %DEST%

rem --- map data (downloaded from gamerguides.com into src\assets\data\site, about 300 MB, resumable) ---
echo.
echo  Downloading the map data (tiles, markers, icons). This takes a few minutes and runs only once.
"%NODE%" src\services\fetch.js
if errorlevel 1 (
  echo  The download did not finish. Run install.bat again later; finished files are kept.
  pause
  exit /b 1
)
echo.
echo  Done. Start the game (borderless windowed), load a save and press Alt+CapsLock for the map.
echo  Without the game: start.bat opens the map in a window.
echo.
pause
