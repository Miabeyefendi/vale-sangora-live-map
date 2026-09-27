# Vale Sangora Live Map

Interactive map for **The Blood of Dawnwalker**. Press **Alt+CapsLock** in the game and the map appears over the game. It shows where you are and marks finished shrines, camps, quests and chests by itself.

Everything here is plain text. Nothing is compiled. You can open every file with Notepad and read it.

---

## Before you start (do this once)

### A. Install Node.js

1. Go to https://nodejs.org
2. Click the big green button that says **LTS**.
3. Open the downloaded file and click **Next** until it finishes. Keep all the default options.
4. Restart your PC.

### B. Install UE4SS in the game

If you already use other Dawnwalker mods, you probably have it. Check: open your game folder, then `Dawnwalker\Binaries\Win64`. If there is a folder named **ue4ss** there, skip this part.

1. Go to https://github.com/UE4SS-RE/RE-UE4SS/releases
2. Download the file whose name starts with **UE4SS_v3** and ends with **.zip** (not the one with "zDEV" in the name).
3. Open the zip and copy **everything** inside it into `Dawnwalker\Binaries\Win64` in your game folder.

### C. Set the game to Borderless

In the game: **Settings > Display > Window Mode > Borderless**. The map cannot appear over "Fullscreen".

### D. Find your game folder

You will need its address. Examples:
- Steam: `C:\Program Files (x86)\Steam\steamapps\common\The Blood of Dawnwalker`
- Other: the folder that contains **Dawnwalker.exe** and a folder named **Dawnwalker**

Tip: open the folder, click the address bar at the top, the full address appears. Copy it with Ctrl+C.

### E. Download this map

1. On this page, click the green **Code** button, then **Download ZIP**.
2. Make a new folder, for example `D:\DawnwalkerMap`.
3. Open the zip and copy everything inside `vale-sangora-live-map-main` into `D:\DawnwalkerMap`.
   When you open `D:\DawnwalkerMap` you must see `install.bat`, `start.bat` and a folder named `src`.
4. Do not move or delete this folder later. The map lives here.

---

## Install: easy way

1. Open `D:\DawnwalkerMap` and double-click **install.bat**.
   If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**.
2. A black window asks for your game folder. Paste the address from step D (right-click pastes) and press Enter.
3. Wait. It downloads the map pictures (about 300 MB). When it says **Done**, press any key.

Finished. Go to **How to use**.

---

## Install: manual way (no .bat files)

Follow every step exactly.

### Step 1: copy the mod into the game

1. Open `D:\DawnwalkerMap\src\mod`. You see a folder named **DawnwalkerMapPos**.
2. Copy that folder (right-click > Copy).
3. Open your game folder, then `Dawnwalker\Binaries\Win64\ue4ss\Mods`.
4. Paste it there (right-click > Paste).

You now have: `...\ue4ss\Mods\DawnwalkerMapPos\Scripts\main.lua`

### Step 2: create the settings file

1. Open `...\ue4ss\Mods\DawnwalkerMapPos\Scripts`
2. Open **Notepad** (press the Windows key, type `notepad`, press Enter).
3. Type these two lines. Change `D:\DawnwalkerMap\` to your own map folder from step E. Keep the `\` at the end.

   ```
   app_root=D:\DawnwalkerMap\
   autostart=0
   ```

4. Click **File > Save As**.
5. Go to the `Scripts` folder from point 1.
6. At **Save as type**, choose **All files (\*.\*)**. This is important.
7. At **File name**, type `config.ini` and click **Save**.

Check: the `Scripts` folder now has `main.lua` and `config.ini`. If you see `config.ini.txt`, delete it and do step 2 again, choosing **All files**.

### Step 3: download the map pictures (only once)

1. Open `D:\DawnwalkerMap`.
2. Click the address bar at the top, delete what is there, type `cmd` and press Enter. A black window opens.
3. Type this and press Enter:

   ```
   node src\services\fetch.js
   ```

4. Wait until it stops writing and shows the blinking cursor again (a few minutes, about 300 MB). Close the window.

If it says `'node' is not recognized`, Node.js is not installed. Do part A again and restart your PC.

---

## How to use

### Easy way

1. Start the game and load your save.
2. Wait about 10 seconds.
3. Press **Alt+CapsLock**. The map appears. Press **Alt+CapsLock** again to hide it and go back to the game.

### Manual way

The manual way does not start anything by itself. Every time you play:

1. Open `D:\DawnwalkerMap`, click the address bar, type `cmd`, press Enter.
2. Type this and press Enter:

   ```
   node src\main.js
   ```

3. The map opens in its own window. Keep the black window open while you play; closing it closes the map.
4. Start the game and load your save. Your position appears on the map.

To show and hide the map over the game with **Alt+CapsLock** instead, type this in point 2:

```
powershell -ExecutionPolicy Bypass -File src\overlay.ps1
```

---

## On the map

- **Left click** a marker: details and your own note.
- **Right click** a marker: mark as done / not done.
- **Lock** button (top left): keeps you in the centre. Click to move the map freely.
- **Refresh** button: reads the game again right now.
- **EN / TR** button (top right): language.
- **Show: All | Finished | Ongoing**: which markers you see.
- **Automatic marking**: hover the (i) icon and read it once. If something gets marked by mistake, right-click it.

Your progress is saved in `D:\DawnwalkerMap\src\assets\data\state.json`. Copy this file somewhere safe from time to time.

---

## Problems

| What you see | What to do |
|---|---|
| Alt+CapsLock does nothing | Load a save first and wait 10 seconds. The map is not active in the main menu. |
| Map shows over the game but the game is black | Set Window Mode to **Borderless** (part C). |
| `'node' is not recognized` | Install Node.js (part A) and restart the PC. |
| Map opens, but no position | The mod is not in `ue4ss\Mods` or `config.ini` is wrong. Check manual step 1 and 2. |
| Grey map without pictures | The download did not finish. Run install.bat again, or manual step 3 again. |

## Uninstall

1. Delete `...\ue4ss\Mods\DawnwalkerMapPos` in the game folder.
2. Delete `D:\DawnwalkerMap`.
