# Vale Sangora Live Map

Interactive map for **The Blood of Dawnwalker**. It opens over the game with Alt+CapsLock, follows your character and marks finished shrines, camps, quests and chests by itself.

Everything here is plain text (Lua, JavaScript, batch, PowerShell). Nothing is compiled.

## Requirements

- The Blood of Dawnwalker, **Borderless Windowed** mode
- [UE4SS](https://github.com/UE4SS-RE/RE-UE4SS) installed in `Dawnwalker\Binaries\Win64\ue4ss`
- [Node.js LTS](https://nodejs.org)
- Chrome, Brave or Edge

## Install

1. Download this repository (Code > Download ZIP) and extract it to any folder. Keep it there.
2. Run `install.bat`. Type your game folder when asked. It copies the mod and downloads the map data (about 300 MB, once).
3. Start the game and load a save. Wait about 10 seconds.

## Open

- In game: press **Alt+CapsLock** to show or hide the map.
- Without the game: run `start.bat`.
- To close everything: `stop.bat`.

Your progress is saved in `src\assets\data\state.json`.
