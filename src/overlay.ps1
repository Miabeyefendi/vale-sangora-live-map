# Overlay mode: opens the map (the web app, unchanged) as an always-on-top window box over the
# borderless-windowed game and shows/hides it on request. Two triggers:
#   - overlay.cmd in src\assets\data\mod ("toggle" | "show" | "hide"), written by the UE4SS mod on
#     Alt+CapsLock (the mod owns the key: UE4SS keybinds work while the game runs elevated);
#   - an optional global hotkey (-Hotkey, default none), for use without the mod.
# Showing the map moves keyboard/mouse focus to it; hiding returns focus to the game.
# ASCII only in this file (PowerShell 5.1 reads BOM-less files as ANSI).
# No transparency: WS_EX_LAYERED on a Chromium window stops it from painting.
# Usage: overlay.ps1 [-Hotkey Alt+Shift+M] [-Width 0] [-Height 0] [-Corner Center]
#   Width/Height 0 = 80 percent of the primary work area.
param(
    [string]$Hotkey = '',
    [int]$Width = 0,
    [int]$Height = 0,
    [ValidateSet('Center', 'TopLeft', 'TopRight', 'BottomLeft', 'BottomRight')] [string]$Corner = 'Center'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$node = 'node'  # Node.js LTS on PATH (install.bat checks for it)
$title = 'Vale Sangora'
$gameProcess = 'Dawnwalker'
$url = 'http://127.0.0.1:5321/'
$signal = Join-Path $root 'src\assets\data\mod\overlay.cmd'

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Ov {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
    [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG m, IntPtr h, uint a, uint b, uint r);
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int px; public int py; }

    // Foreground changes from another process are normally refused; attaching to the
    // current foreground thread's input queue is the documented way around it.
    public static void Focus(IntPtr h) {
        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint me = GetCurrentThreadId();
        if (fgThread != me) AttachThreadInput(me, fgThread, true);
        SetForegroundWindow(h);
        if (fgThread != me) AttachThreadInput(me, fgThread, false);
    }
}
"@

# Minimized "cmd /K overlay.bat" windows left by earlier mod builds; done before the
# single-instance check so every launch attempt cleans them (start x.bat keeps the window).
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match '/K .*(overlay|server)\.bat' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 1. Server: reuse only if it is the current build, otherwise replace it. Done before the single-instance
# check: a mod reload (Ctrl+R) relaunches this script while the first instance still runs, and the
# replacement must happen then too. A server started here follows the game (exits with it), so a
# transient instance may leave it behind; the page reloads itself when it sees the new build.
$ownServer = $null
$listening = Get-NetTCPConnection -LocalPort 5321 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    $build = [string][math]::Floor(((Get-Item "$root\src\main.js").LastWriteTimeUtc - [datetime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)).TotalMilliseconds)
    $running = ''
    try { $running = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:5321/version').Content.Trim() } catch { $running = '' }
    if ($running -ne $build) {
        Write-Host "Replacing stale server (build $running -> $build)."
        $listening | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 800
        $listening = $null
    }
}
if (-not $listening) {
    $follow = ''
    if (Get-Process -Name $gameProcess -ErrorAction SilentlyContinue) { $follow = ' --follow-game' }
    $ownServer = Start-Process -FilePath $node -ArgumentList "`"$root\src\main.js`" --no-browser$follow" -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 1500
}

# 0. Single instance (the window may be hidden, so it cannot be found by looking).
$mutex = New-Object System.Threading.Mutex($false, 'Global\DawnwalkerMapOverlay')
if (-not $mutex.WaitOne(0)) {
    Write-Host 'Overlay already running, exiting.'
    exit 0
}

# PowerShell passes $null strings as "", which breaks FindWindow, so locate windows via Get-Process.
function Find-MapWindow {
    $p = Get-Process | Where-Object { $_.MainWindowTitle -eq $title } | Select-Object -First 1
    if ($p) { return $p.MainWindowHandle } else { return [IntPtr]::Zero }
}
function Find-GameWindow {
    $p = Get-Process -Name $gameProcess -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) { return $p.MainWindowHandle } else { return [IntPtr]::Zero }
}
function Game-Running { return [bool](Get-Process -Name $gameProcess -ErrorAction SilentlyContinue) }

# Optional hotkey string -> RegisterHotKey modifiers + virtual key. Examples: F9, Ctrl+CapsLock, Alt+Shift+M.
$vkNames = @{
    CAPSLOCK = 0x14; TAB = 0x09; SPACE = 0x20; PAUSE = 0x13; SCROLLLOCK = 0x91; INSERT = 0x2D; DELETE = 0x2E
    HOME = 0x24; END = 0x23; PAGEUP = 0x21; PAGEDOWN = 0x22; TILDE = 0xC0; BACKQUOTE = 0xC0
}
$hotkeyId = 0xD4A1
$hotkeyOn = $false
if ($Hotkey -ne '') {
    $mods = 0; $vk = 0
    foreach ($part in ($Hotkey -split '\+')) {
        $u = $part.Trim().ToUpper()
        if ($u -match '^(CTRL|CONTROL)$') { $mods = $mods -bor 0x2 }
        elseif ($u -eq 'ALT') { $mods = $mods -bor 0x1 }
        elseif ($u -eq 'SHIFT') { $mods = $mods -bor 0x4 }
        elseif ($u -eq 'WIN') { $mods = $mods -bor 0x8 }
        elseif ($u -match '^F([1-9]|1[0-9]|2[0-4])$') { $vk = 0x6F + [int]$Matches[1] }
        elseif ($u -match '^[A-Z0-9]$') { $vk = [int][char]$u }
        elseif ($vkNames.ContainsKey($u)) { $vk = $vkNames[$u] }
        else { throw "Unknown key in hotkey: $part" }
    }
    if ($vk -eq 0) { throw "Hotkey has no key: $Hotkey" }
    $hotkeyOn = [Ov]::RegisterHotKey([IntPtr]::Zero, $hotkeyId, ($mods -bor 0x4000), $vk)
    if (-not $hotkeyOn) { Write-Host "Hotkey $Hotkey is taken; only overlay.cmd will toggle the map." }
}

# 0b. Leftovers from earlier sessions: other overlay loops and their (possibly hidden) windows.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'overlay\.ps1' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(brave|chrome|msedge)\.exe$' -and $_.CommandLine -match 'DawnwalkerMap' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# A request written before this instance came up (first Alt+CapsLock starts the stack) is honoured below.

# 2. Browser and window box geometry. Same profile as start.bat, cache dropped so the UI is never stale.
$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe",
    "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Chrome / Brave / Edge not found' }
$profile = Join-Path $env:LOCALAPPDATA 'DawnwalkerMap'
foreach ($d in 'Cache', 'Code Cache') { Remove-Item -Recurse -Force (Join-Path $profile "Default\$d") -ErrorAction SilentlyContinue }

$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
if ($Width -le 0) { $Width = [int]($area.Width * 0.8) }
if ($Height -le 0) { $Height = [int]($area.Height * 0.8) }
$margin = 8
switch ($Corner) {
    'Center'      { $x = $area.Left + [int](($area.Width - $Width) / 2); $y = $area.Top + [int](($area.Height - $Height) / 2) }
    'TopLeft'     { $x = $area.Left + $margin;            $y = $area.Top + $margin }
    'TopRight'    { $x = $area.Right - $Width - $margin;  $y = $area.Top + $margin }
    'BottomLeft'  { $x = $area.Left + $margin;            $y = $area.Bottom - $Height - $margin }
    'BottomRight' { $x = $area.Right - $Width - $margin;  $y = $area.Bottom - $Height - $margin }
}

$HWND_TOPMOST = [IntPtr](-1)
$SWP_SHOWWINDOW = 0x40
[uint32]$script:mapPid = 0

# Opens the map window (or adopts an existing one), pins it on top; hidden when the game runs.
function Start-MapWindow {
    $h = Find-MapWindow
    if ($h -eq [IntPtr]::Zero) {
        Start-Process -FilePath $browser -ArgumentList "--app=$url --user-data-dir=`"$profile`" --window-size=$Width,$Height --window-position=$x,$y --disable-features=Translate" | Out-Null
        for ($i = 0; $i -lt 60 -and $h -eq [IntPtr]::Zero; $i++) {
            Start-Sleep -Milliseconds 250
            $h = Find-MapWindow
        }
        if ($h -eq [IntPtr]::Zero) { throw "Window '$title' not found" }
    }
    [Ov]::ShowWindow($h, 9) | Out-Null  # SW_RESTORE, in case it was minimized
    [Ov]::SetWindowPos($h, $HWND_TOPMOST, $x, $y, $Width, $Height, $SWP_SHOWWINDOW) | Out-Null
    if (Game-Running) {
        Start-Sleep -Milliseconds 1500  # let the page load once before hiding
        [Ov]::ShowWindow($h, 0) | Out-Null
        $g = Find-GameWindow
        if ($g -ne [IntPtr]::Zero) { [Ov]::Focus($g) }
    }
    [uint32]$owner = 0
    [Ov]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
    $script:mapPid = $owner
    return $h
}

# While the map is on screen it has the keyboard, so the game (and the mod's Alt+CapsLock keybind)
# never sees the key. Alt+CapsLock is therefore registered here only while the map is visible, and
# released when it hides, so the mod keeps opening it from inside the game.
$closeKeyId = 0xD4A2
$script:closeKeyOn = $false
function Set-CloseKey($on) {
    if ($on -and -not $script:closeKeyOn) { $script:closeKeyOn = [Ov]::RegisterHotKey([IntPtr]::Zero, $closeKeyId, (0x1 -bor 0x4000), 0x14) }
    elseif (-not $on -and $script:closeKeyOn) { [Ov]::UnregisterHotKey([IntPtr]::Zero, $closeKeyId) | Out-Null; $script:closeKeyOn = $false }
}

function Show-Map($h) {
    [Ov]::ShowWindow($h, 9) | Out-Null
    [Ov]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, 0x3 -bor $SWP_SHOWWINDOW) | Out-Null
    [Ov]::Focus($h)
    Set-CloseKey $true
}

function Hide-Map($h) {
    Set-CloseKey $false
    [Ov]::ShowWindow($h, 0) | Out-Null
    $g = Find-GameWindow
    if ($g -ne [IntPtr]::Zero) { [Ov]::Focus($g) }
}

$withGame = Game-Running
$hwnd = Start-MapWindow

# 3. Loop: act on overlay.cmd and the hotkey until the window is closed (or the game exits).
Write-Host "Overlay ready. Alt+CapsLock (via the mod) shows/hides the map."
try {
    $msg = New-Object Ov+MSG
    $tick = 0
    while ($true) {
        $tick++
        if ($withGame -and ($tick % 50) -eq 0 -and -not (Game-Running)) {
            Write-Host 'Game closed, closing the map.'
            if ($script:mapPid -ne 0) { Stop-Process -Id $script:mapPid -Force -ErrorAction SilentlyContinue }
            break
        }
        # Window closed by hand: without the game that ends the overlay; with it, the next request reopens it.
        if (-not [Ov]::IsWindow($hwnd)) {
            if (-not $withGame) { break }
            $hwnd = [IntPtr]::Zero
            Set-CloseKey $false
        }
        $action = ''
        if (Test-Path $signal) {
            try { $action = (Get-Content $signal -Raw -ErrorAction Stop).Trim().ToLower() } catch { $action = 'toggle' }
            Remove-Item $signal -Force -ErrorAction SilentlyContinue
            if ($action -eq '') { $action = 'toggle' }
        }
        while ([Ov]::PeekMessage([ref]$msg, [IntPtr]::Zero, 0, 0, 1)) {
            if ($msg.message -eq 0x0312) { $action = if ([int]$msg.wParam -eq $closeKeyId) { 'hide' } else { 'toggle' } }
        }
        if ($action -ne '') {
            if ($hwnd -eq [IntPtr]::Zero) { $hwnd = Start-MapWindow }
            $visible = [Ov]::IsWindowVisible($hwnd)
            if ($action -eq 'hide' -or ($action -eq 'toggle' -and $visible)) { Hide-Map $hwnd }
            elseif ($action -eq 'show' -or $action -eq 'toggle') { Show-Map $hwnd }
        }
        # Every ~15 s: replace the server when src\main.js changed on disk (updates without restarting the game;
        # the page reloads itself when it sees the new build).
        if (($tick % 250) -eq 0) {
            $build = [string][math]::Floor(((Get-Item "$root\src\main.js").LastWriteTimeUtc - [datetime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)).TotalMilliseconds)
            $running = ''
            try { $running = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:5321/version').Content.Trim() } catch { $running = '' }
            if ($running -ne '' -and $running -ne $build) {
                Write-Host "Server build changed ($running -> $build), restarting it."
                Get-NetTCPConnection -LocalPort 5321 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
                Start-Sleep -Milliseconds 800
                $ownServer = Start-Process -FilePath $node -ArgumentList "`"$root\src\main.js`" --no-browser --follow-game" -WindowStyle Hidden -PassThru
            }
        }
        Start-Sleep -Milliseconds 60
    }
} finally {
    if ($hotkeyOn) { [Ov]::UnregisterHotKey([IntPtr]::Zero, $hotkeyId) | Out-Null }
    Set-CloseKey $false
    if ($ownServer -and -not $ownServer.HasExited) { Stop-Process -Id $ownServer.Id -Force }
    $mutex.ReleaseMutex() | Out-Null
}
