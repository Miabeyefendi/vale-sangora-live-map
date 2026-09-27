![Vale Sangora Live Map for The Blood of Dawnwalker](https://raw.githubusercontent.com/Miabeyefendi/vale-sangora-live-map/main/docs/banner.jpg)

# Vale Sangora Live Map

A map for **The Blood of Dawnwalker**.

- Press **Alt+CapsLock** in the game. The map opens over the game.
- The map shows where you are.
- When you finish a shrine, a camp, a quest or a chest, the map marks it for you.

You do not need to know anything about code. Just follow the steps, one by one.

---

## Part 1. Download the map

1. Go to the **Releases** page: https://github.com/Miabeyefendi/vale-sangora-live-map/releases/latest
2. Under **Assets**, click the file **ValeSangoraLiveMap-x.x.x.zip**. It downloads.
3. Make a new folder. Example: `D:\DawnwalkerMap`
4. Open the zip file. Select everything inside. Copy it.
5. Paste it into your new folder `D:\DawnwalkerMap`.

**Check:** open `D:\DawnwalkerMap`. You must see these:
- `install.bat`
- `start.bat`
- a folder named `src`

Do not move or delete this folder later. The map lives here.

---

## Part 2. Install Node.js

The map needs a free program called Node.js.

1. Go to https://nodejs.org
2. Click the green button with **LTS** on it. A file downloads.
3. Open the file.
4. Click **Next**, **Next**, **Next**... until **Finish**. Do not change anything.
5. **Restart your PC.**

---

## Part 3. Install UE4SS

UE4SS lets mods run inside the game.

**Do you already have it?**
1. Open your game folder.
2. Open `Dawnwalker`, then `Binaries`, then `Win64`.
3. Do you see a folder named `ue4ss`?
   - **Yes:** skip Part 3. Go to Part 4.
   - **No:** do the steps below.

**Install it:**
1. Go to https://github.com/UE4SS-RE/RE-UE4SS/releases
2. Find the newest version. Under **Assets**, download the file named like `UE4SS_v3.0.1.zip`.
   Do **not** take the file that starts with `zDEV`.
3. Open the zip. Copy everything inside.
4. Paste it into your game folder, into `Dawnwalker\Binaries\Win64`.

---

## Part 4. Find your game folder

You need the address of your game folder in Part 5.

1. Open the folder where the game is installed.
   It is the folder with **Dawnwalker.exe** in it.
2. Click on the address bar at the top of the window.
3. The full address appears. Example: `C:\Games\The Blood of Dawnwalker`
4. Press **Ctrl+C** to copy it.

---

## Part 5. Install the map

1. Open `D:\DawnwalkerMap`.
2. Double-click **install.bat**.
3. Windows may show a blue box: "Windows protected your PC".
   Click **More info**, then click **Run anyway**.
   (This is normal for .bat files. You can open install.bat with Notepad and read it.)
4. A black window opens. It asks for your game folder.
5. **Right-click** in the black window. Your address from Part 4 appears.
6. Press **Enter**.
7. Wait. It downloads the map pictures (about 300 MB). This can take a few minutes.
8. When you see **Done**, press any key. The window closes.

The install is finished.

---

## Part 6. Set the game window

The map cannot show over a full screen game.

1. Start the game.
2. Go to **Settings**, then **Display**.
3. Set **Window Mode** to **Borderless**.

You only do this once.

---

## Part 7. Play

1. Start the game.
2. Load your save.
3. Wait 10 seconds.
4. Press **Alt+CapsLock**. The map opens.
5. Press **Alt+CapsLock** again. The map closes and you are back in the game.

---

## Part 8. Buttons on the map

| Button | What it does |
|---|---|
| Lock (top left) | Keeps you in the middle of the map. Click it to move the map with the mouse. |
| Refresh (top left) | Reads the game again now. |
| EN / TR (top right) | Changes the language. |
| All / Finished / Ongoing | Choose which markers you see. |
| Left click on a marker | Shows information about it. You can write your own note. |
| Right click on a marker | Marks it as done. Right click again to undo. |

**Automatic marking:** the map marks things you finished in the game. Sometimes it marks the wrong marker near it. If that happens, right-click that marker. It will not come back.

---

## Part 9. Use the map without the game

Double-click **start.bat**. The map opens in a window.

To close everything, double-click **stop.bat**.

---

## Part 10. Keep your progress safe

Your progress is in this file: `D:\DawnwalkerMap\src\assets\data\state.json`

Copy this file to a safe place sometimes.

---

## Part 11. Problems

**Alt+CapsLock does nothing.**
Load a save first. Wait 10 seconds. It does not work in the main menu.

**The map opens, but the game behind it is black.**
Set Window Mode to Borderless (Part 6).

**The black window says `'node' is not recognized`.**
Node.js is not installed. Do Part 2 again and restart your PC.

**The black window says "UE4SS is not installed".**
Do Part 3 again.

**The map is grey, no pictures.**
The download did not finish. Double-click install.bat again. It continues where it stopped.

**The map works, but my position is not shown.**
Start the game and load a save. Your position appears only while you play.

---

## Part 12. Remove the map

1. In your game folder, open `Dawnwalker\Binaries\Win64\ue4ss\Mods`.
2. Delete the folder `DawnwalkerMapPos`.
3. Delete your map folder `D:\DawnwalkerMap`.

---

## For advanced users: install without .bat files

1. Copy `src\mod\DawnwalkerMapPos` into `<game>\Dawnwalker\Binaries\Win64\ue4ss\Mods\`
2. In `...\Mods\DawnwalkerMapPos\Scripts\` create `config.ini` (in Notepad choose "Save as type: All files"):
   ```
   app_root=D:\DawnwalkerMap\
   autostart=0
   ```
3. In `D:\DawnwalkerMap`, type `cmd` in the address bar, press Enter, then run: `node src\services\fetch.js`
4. Every time you play, in the same way run: `node src\main.js`
   (or `powershell -ExecutionPolicy Bypass -File src\overlay.ps1` for Alt+CapsLock over the game)
