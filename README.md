# Vale Sangora Live Map

Interactive map for **The Blood of Dawnwalker**. It opens over the game with Alt+CapsLock, follows your character and marks finished shrines, camps, quests and chests by itself.

Everything here is plain text (Lua, JavaScript, batch, PowerShell). Nothing is compiled. You can read every file before you run it.

## Requirements

- The Blood of Dawnwalker, **Borderless Windowed** mode
- [UE4SS](https://github.com/UE4SS-RE/RE-UE4SS) installed in `Dawnwalker\Binaries\Win64\ue4ss`
- [Node.js LTS](https://nodejs.org)
- Chrome, Brave or Edge

Download this repository (Code > Download ZIP) and extract it to any folder, for example `D:\DawnwalkerMap`. Keep it there. Then choose **one** of the two ways below.

## Way 1: automatic (install.bat)

1. Run `install.bat`. Type your game folder when asked.
   It copies the mod and downloads the map data (about 300 MB, once).
2. Start the game and load a save. Wait about 10 seconds.
3. Press **Alt+CapsLock** to show or hide the map.

## Way 2: manual (no .bat files)

1. **Copy the mod.** Copy the folder `src\mod\DawnwalkerMapPos` into
   `<game folder>\Dawnwalker\Binaries\Win64\ue4ss\Mods\`

2. **Create the mod settings.** In `...\ue4ss\Mods\DawnwalkerMapPos\Scripts\` make a text file named `config.ini`:

   ```ini
   app_root=D:\DawnwalkerMap\
   autostart=0
   ```

   `app_root` is the folder you extracted this repository to (keep the `\` at the end).
   `autostart=0` means the mod starts nothing by itself; it only reads the game.

3. **Download the map data** (once, about 300 MB). Open a terminal in the extracted folder:

   ```
   node src\services\fetch.js
   ```

4. **Open the map.** In the same folder:

   ```
   node src\main.js
   ```

   The map opens in a browser window and follows you while the game runs.

5. **Optional, Alt+CapsLock over the game:** instead of step 4, run

   ```
   powershell -ExecutionPolicy Bypass -File src\overlay.ps1
   ```

   The map window stays hidden until you press Alt+CapsLock in game.

## Open and close

- In game: **Alt+CapsLock** shows the map, Alt+CapsLock again hides it.
- Without the game: `start.bat` or `node src\main.js`.
- Close everything: `stop.bat`, or close the map window and the terminal.

Your progress is saved in `src\assets\data\state.json`.

## Uninstall

Delete `...\ue4ss\Mods\DawnwalkerMapPos` and the extracted folder.
