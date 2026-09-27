-- DawnwalkerMapPos: feeds the local map app from inside the game.
--   pos.json   player world position + yaw, twice a second
--   pins.tsv   the game's own map pins (M map): id, type, state, world location, description; refreshed
--              every 15 s. The app matches them to the site markers and completes the finished ones.
--   quests.tsv the quest journal: guid, state (Active/Success/Failure), type, start location, title; every 60 s.
--   loot.tsv   loaded loot containers: name, class, interaction state (1 = looted), location; every 3 min.
--   owned.tsv  items in the player's inventory / shrine storage: item id, class, quantities; every 3 min.
--   dump.txt   map-relevant actors (research only, "dump" command or Ctrl+Shift+D; no periodic scans)
--   props\     property / function listings of one class (research, "props:Class" / "funcs:Class")
--   cmd.txt    commands from the app: dump | scan:on|off | classes:A,B | flags:a,b | props:Class |
--              funcs:Class | widgets | subsystems | mapinfo
-- All files live in <app_root>\src\assets\data\mod.
-- config.ini (written by install-mod.bat): app_root=<map app folder>, autostart=overlay|server|0
--   overlay.cmd  "toggle" written on Alt+CapsLock; overlay.ps1 shows/hides the web map window over the game
-- Keys: Alt+CapsLock shows/hides the map (the web app, unchanged, as a window box over the game),
-- Ctrl+Shift+M toggles tracking, Ctrl+Shift+D forces an actor dump.
-- Nothing starts at game launch: overlay.bat (server + hidden map window) starts 10 s after a save is
-- loaded (player pawn exists), or at the first Alt+CapsLock.
local UEHelpers = require("UEHelpers.UEHelpers")

local INTERVAL_MS = 500
local FIRST_DUMP_S = 15        -- after the player pawn appears (only when scans are enabled)
local DISCOVERY_DUMP_S = 120   -- first scans inspect every actor's class name (learns which classes matter)
local MAX_DISCOVERY = 2        -- after that classes are matched by address only (no string work per actor)
local CLASS_DUMP_S = 60        -- steady-state scan interval
local PROPS_EVERY_TICKS = 8    -- one class description per 4 s, spread to avoid hitches
local PINS_REFRESH_S = 180     -- full pass over the game's map pins (config.ini pins_interval, seconds)
local PINS_PER_TICK = 40       -- pins handled per 500 ms tick (283 pins = ~4 s per pass)
local QUESTS_S = 180           -- journal pass (config.ini quests_interval, seconds)
local LOOT_S = 180             -- loot container pass (config.ini loot_interval, seconds)
local LOOT_PER_TICK = 40
local ITEMS_S = 180            -- owned-item pass (config.ini items_interval, seconds)
local ITEMS_PER_TICK = 40
local scriptDir = (debug.getinfo(1, "S").source or ""):gsub("^@", ""):gsub("[\\/][^\\/]*$", "")

local function log(s) print(string.format("[DawnwalkerMapPos] %s\n", s)) end

local config = { app_root = "", autostart = "1", map_url = "http://127.0.0.1:5321/" }
local SERVER_DELAY_S = 10      -- after the player pawn first appears (save loaded)
do
    local f = io.open(scriptDir .. "\\config.ini", "r")
    if f then
        for line in f:lines() do
            local k, v = line:match("^%s*([%w_]+)%s*=%s*(.-)%s*$")
            if k then config[k] = v end
        end
        f:close()
    end
end
-- Scan intervals from config.ini (seconds); the first pass after a save loads runs at once.
PINS_REFRESH_S = tonumber(config.pins_interval) or PINS_REFRESH_S
QUESTS_S = tonumber(config.quests_interval) or QUESTS_S
LOOT_S = tonumber(config.loot_interval) or LOOT_S
ITEMS_S = tonumber(config.items_interval) or ITEMS_S
local REVEAL_CFG = tonumber(config.reveal_interval)

-- Exchange folder with the app: inside the project (src\assets\data\mod), not %LOCALAPPDATA%.
-- Sandboxed tools see a virtualised copy of the user profile, so the two sides disagreed about
-- what was on disk there; the project folder is plain.
local base
if config.app_root ~= "" then
    base = config.app_root .. "src\\assets\\data\\mod"
elseif os.getenv and os.getenv("LOCALAPPDATA") then
    base = os.getenv("LOCALAPPDATA") .. "\\DawnwalkerMap"
else
    base = scriptDir
end
os.execute('mkdir "' .. base .. '" >nul 2>nul')
local OUT = base .. "\\pos.json"
local DUMP = base .. "\\dump.txt"
local PINS = base .. "\\pins.tsv"
local QUESTS = base .. "\\quests.tsv"
local QUESTOBJ = base .. "\\questobj.tsv"
local LOOT = base .. "\\loot.tsv"
local OWNED = base .. "\\owned.tsv"
local CMD = base .. "\\cmd.txt"
local OVERLAY_CMD = base .. "\\overlay.cmd"   -- "toggle" | "show" | "hide", consumed by overlay.ps1
local CLASSES_FILE = base .. "\\classes.txt"
local PROPS_DIR = base .. "\\props"
local SUBSYSTEMS = base .. "\\subsystems.txt"
os.execute('mkdir "' .. PROPS_DIR .. '" >nul 2>nul')

-- Class-name fragments that suggest something the map tracks (discovery mode).
local WANTED = { "shrine", "fasttravel", "travel", "chest", "container", "loot", "quest", "pickup", "readable",
    "book", "altar", "camp", "bandit", "poi", "landmark", "circle", "wisp", "banner", "lair", "vendor", "merchant",
    "door", "gate", "tower", "settlement", "haunted", "manual", "recipe", "key", "corpse", "cache", "mappin", "nest" }
-- Boolean properties that mean "the player already dealt with this" (research; set with "flags:a,b").
local FLAGS = {}

local enabled = true
local pawn = nil
local classes = {}          -- restricted class list, empty = discovery mode
local pawnSeenAt = nil
local nextDumpAt = nil
local dumping = false
local propsQueue = {}       -- classes still to describe this session
local propsDone = {}
local discoveryCount = 0
local tick = 0
local classAddr = {}        -- UClass address -> class name (or false), filled while learning
local classAddrCount = 0
local scanEnabled = false   -- periodic actor scans are research only ("scan:on"); pins replace them
local serverStartAt = nil
local serverStarted = false

local function readClasses()
    local f = io.open(CLASSES_FILE, "r")
    if not f then return end
    classes = {}
    for line in f:lines() do
        local c = line:gsub("%s+", "")
        if c ~= "" then classes[#classes + 1] = c end
    end
    f:close()
end
readClasses()

local function writeFile(path, text)
    local f = io.open(path, "w")
    if not f then return false end
    f:write(text)
    f:close()
    return true
end

local function writeAtomic(path, text)
    local tmp = path .. ".tmp"
    if writeFile(tmp, text) then
        os.remove(path)
        os.rename(tmp, path)
        return true
    end
    return false
end

local function writePos(line)
    writeFile(OUT, line) -- every tick, so the file's mtime shows the game thread is alive
end

local function findPawn()
    local p = UEHelpers.GetPlayer()
    if p and p:IsValid() then return p end
    return nil
end

local FIRST_PASS_DELAY_S = 20   -- after the pawn appears: journal / pins are still empty right at load
local pinsNextAt, questsNextAt, lootNextAt, itemsNextAt = 0, 0, 0, 0   -- next pass times (pins, journal, loot, items)
local function sample()
    if not enabled then return end
    if not pawn or not pawn:IsValid() then
        pawn = findPawn()
        if pawn then
            local t = os.time() + FIRST_PASS_DELAY_S
            pinsNextAt, questsNextAt, lootNextAt, itemsNextAt = t, t, t, t
        end
    end
    if not pawn then
        writePos('{"live":false}')
        return
    end
    local ok = pcall(function()
        local loc = pawn:K2_GetActorLocation()
        local rot = pawn:K2_GetActorRotation()
        writePos(string.format('{"live":true,"x":%.1f,"y":%.1f,"z":%.1f,"yaw":%.1f}', loc.X, loc.Y, loc.Z, rot.Yaw))
    end)
    if not ok then
        pawn = nil
        writePos('{"live":false}')
    end
end

-- ---------------------------------------------------------------------------------------------
-- Game map pins. The M map keeps one WBP_Map_Mappin_C widget per known pin (under the persistent
-- WBP_Map_C in the game instance, created the first time the map is opened). Location and type
-- never change, so they are read once per pin; the state is re-read every pass.
-- ---------------------------------------------------------------------------------------------
local pinSys, pinLib, pinTypeEnum, pinStateEnum
local pinWidgets = nil      -- widgets of the pass in progress
local pinIndex = 0
local pinLines, pinSeen = {}, {}
local pinStatic = {}        -- id string -> { type, x, y, z, desc, quest }
local pinStats = { total = 0, completed = 0, at = nil, note = "" }
local pinProbeLogged = false
local liveMapName = nil

local function getPinSystem()
    if pinSys and pinSys:IsValid() then return pinSys end
    pinSys = FindFirstOf("MappinSystemImpl")
    if pinSys and not pinSys:IsValid() then pinSys = nil end
    return pinSys
end

local function getPinLib()
    if pinLib and pinLib:IsValid() then return pinLib end
    pinLib = StaticFindObject("/Script/DogwoodMap.Default__MappinSystemBlueprintLibrary")
    if pinLib and not pinLib:IsValid() then pinLib = nil end
    return pinLib
end

-- UEnum of a UFunction's ReturnValue (to print enum names instead of numbers).
local function returnEnum(fnPath)
    local e = nil
    pcall(function()
        local fn = StaticFindObject(fnPath)
        if not (fn and fn:IsValid()) then return end
        fn:ForEachProperty(function(p)
            if p:GetFName():ToString() == "ReturnValue" then pcall(function() e = p:GetEnum() end) end
        end)
    end)
    return e
end

local function enumName(e, v)
    if e then
        local ok, n = pcall(function() return e:GetNameByValue(v):ToString() end)
        if ok and type(n) == "string" then return (n:gsub("^.*::", "")) end
    end
    return tostring(v)
end

local function findLiveMap()
    for _, w in ipairs(FindAllOf("WBP_Map_C") or {}) do
        if w:IsValid() and w:GetFullName():find("GameEngine", 1, true) then return w end
    end
    return nil
end

local function asString(v)
    if type(v) == "string" then return v end
    local ok, s = pcall(function() return v:ToString() end)
    return ok and s or tostring(v)
end

local function readPin(w, sys, lib)
    if not w:IsValid() then return end
    local full = w:GetFullName()
    if full:find("Default__", 1, true) then return end
    if liveMapName and not full:find(liveMapName, 1, true) then return end
    -- The id struct lives inside the widget (stable memory); the getter's return buffer does not.
    local id = nil
    pcall(function() id = w["Pin Instance Id"] end)
    if id == nil then id = w:GetMappinId() end
    local idStr = asString(lib:GetMappinInstanceIdString(id))
    if pinSeen[idStr] then return end
    pinSeen[idStr] = true
    local st = pinStatic[idStr]
    if not st then
        local loc = lib:GetMappinInstanceLocation(sys, id)
        local ty = lib:GetMappinInstanceType(sys, id)
        local desc = ""
        pcall(function() desc = asString(lib:GetMappinInstanceDescription(sys, id)) end)
        local quest = false
        pcall(function() quest = w["Is Quest Mappin"] == true end)
        st = { type = enumName(pinTypeEnum, ty), x = loc.X, y = loc.Y, z = loc.Z,
            desc = (desc:gsub("[\t\r\n]+", " ")), quest = quest and 1 or 0 }
        pinStatic[idStr] = st
        if not pinProbeLogged then
            pinProbeLogged = true
            log(string.format("pin probe: id %s (%s) type %s at %.0f %.0f", idStr, type(id), st.type, st.x, st.y))
        end
    end
    local state = enumName(pinStateEnum, lib:GetMappinInstanceState(sys, id))
    if state:lower():find("complet", 1, true) then pinStats.completed = pinStats.completed + 1 end
    pinLines[#pinLines + 1] = string.format("%s\t%s\t%s\t%.0f\t%.0f\t%.0f\t%d\t%s",
        idStr, st.type, state, st.x, st.y, st.z, st.quest, st.desc)
end

-- The game's own "hide completed map pins" switch (the game toggles it; revealHidden flips it briefly).
local function hideCompleted()
    local sys = getPinSystem()
    if not sys then return nil end
    local ok, v = pcall(function() return sys:ShouldHideCompletedMappins() end)
    if ok then return v == true end
    return nil
end

-- The game's "hide completed pins" setting drops completed POIs from the map's widget pool at the
-- next map open, so they would be invisible to us. While the map is closed, switch the setting off,
-- rebuild the pool (RefreshMappinsAndGetPlayerId), switch it back: the pool keeps the completed pins
-- until the player opens the map again, which is enough for a pass to read them. Verified: 256 -> 341
-- widgets, Completed 76 -> 148. Never done while the map is on screen.
local REVEAL_S = 900           -- config.ini reveal_interval, seconds (full pool refresh, 15 min)
if REVEAL_CFG then REVEAL_S = REVEAL_CFG end
local revealNextAt = 0
local function revealHidden()
    if os.time() < revealNextAt then return end
    revealNextAt = os.time() + REVEAL_S
    local sys, map = getPinSystem(), findLiveMap()
    if not (sys and map) then return end
    local active = false
    pcall(function() active = map:IsActivated() end)
    if active then return end
    local hide = hideCompleted()
    if hide == nil then return end
    local ok, err = pcall(function()
        if hide then sys:ToggleDisplayingCompletedMappins() end
        map:RefreshMappinsAndGetPlayerId()
        if hide then sys:ToggleDisplayingCompletedMappins() end
    end)
    if not ok then log("reveal failed: " .. tostring(err)) end
end

local function pinStep()
    if not pawn then return end
    if not pinWidgets then
        if os.time() < pinsNextAt then return end
        local sys, lib = getPinSystem(), getPinLib()
        if not (sys and lib) then
            pinStats.note = "pin sistemi yok"
            pinsNextAt = os.time() + PINS_REFRESH_S
            return
        end
        if not pinTypeEnum then pinTypeEnum = returnEnum("/Script/DogwoodMap.MappinSystemBlueprintLibrary:GetMappinInstanceType") end
        if not pinStateEnum then pinStateEnum = returnEnum("/Script/DogwoodMap.MappinSystemBlueprintLibrary:GetMappinInstanceState") end
        revealHidden()
        local map = findLiveMap()
        -- Object path without the leading class name, so child widget names contain it.
        liveMapName = map and (map:GetFullName():gsub("^%S+%s+", "")) or nil
        pinWidgets = FindAllOf("WBP_Map_Mappin_C") or {}
        pinIndex, pinLines, pinSeen = 0, {}, {}
        pinStats.completed = 0
        if #pinWidgets == 0 then
            pinStats.note = "oyun haritasi (M) bir kez acilmali"
            pinWidgets = nil
            pinsNextAt = os.time() + PINS_REFRESH_S
            return
        end
    end
    local sys, lib = getPinSystem(), getPinLib()
    local n = 0
    while pinIndex < #pinWidgets and n < PINS_PER_TICK do
        pinIndex = pinIndex + 1
        n = n + 1
        local ok, err = pcall(readPin, pinWidgets[pinIndex], sys, lib)
        if not ok and not pinProbeLogged then
            pinProbeLogged = true
            log("pin read failed: " .. tostring(err))
        end
    end
    if pinIndex >= #pinWidgets then
        if #pinLines > 0 then
            writeAtomic(PINS, table.concat(pinLines, "\n") .. "\n")
            pinStats.total = #pinLines
            pinStats.at = os.time()
            pinStats.note = ""
            local sig = pinStats.total .. "/" .. pinStats.completed
            if sig ~= pinStats.logged then
                pinStats.logged = sig
                log(string.format("pins: %d (%d completed)", pinStats.total, pinStats.completed))
            end
        else
            pinStats.note = "pin okunamadi (UE4SS.log)"
        end
        pinWidgets = nil
        pinsNextAt = os.time() + PINS_REFRESH_S
    end
end

-- ---------------------------------------------------------------------------------------------
-- Research dumps (on demand).
-- ---------------------------------------------------------------------------------------------
local function actorFlags(a)
    if #FLAGS == 0 then return "" end
    local out = {}
    for _, name in ipairs(FLAGS) do
        local ok, v = pcall(function() return a[name] end)
        if ok and v ~= nil and type(v) == "boolean" then out[#out + 1] = name .. "=" .. (v and "1" or "0") end
    end
    return table.concat(out, ",")
end

local function wantedClass(lc)
    for _, w in ipairs(WANTED) do if lc:find(w, 1, true) then return true end end
    return false
end

-- One dump line per actor: class \t fullname \t x \t y \t z \t flags
local function dumpActors(reason)
    if dumping then return end
    dumping = true
    local ok, err = pcall(function()
        local lines = {}
        local scanned = 0
        -- One pass over all actors. Class verdicts are cached by UClass address, so after the
        -- first (learning) scans no string work happens per actor: a table lookup and a location read.
        local learning = (#classes == 0) and (discoveryCount <= MAX_DISCOVERY)
        local wantedSet = nil
        if #classes > 0 then
            wantedSet = {}
            for _, c in ipairs(classes) do wantedSet[c] = true end
        end
        for _, a in ipairs(FindAllOf("Actor") or {}) do
            scanned = scanned + 1
            if a:IsValid() then
                local clsObj = a:GetClass()
                local addr = clsObj:GetAddress()
                local cls = classAddr[addr]
                if cls == nil and (learning or wantedSet) then
                    local name = clsObj:GetFName():ToString()
                    local keep
                    if wantedSet then keep = wantedSet[name] == true else keep = wantedClass(name:lower()) end
                    cls = keep and name or false
                    classAddr[addr] = cls
                    classAddrCount = classAddrCount + 1
                end
                if cls then
                    local okLoc, loc = pcall(function() return a:K2_GetActorLocation() end)
                    if okLoc and loc then
                        lines[#lines + 1] = string.format("%s\t%s\t%.0f\t%.0f\t%.0f\t%s", cls, a:GetFullName(), loc.X, loc.Y, loc.Z, actorFlags(a))
                        if not propsDone[cls] then propsDone[cls] = true; propsQueue[#propsQueue + 1] = cls end
                    end
                end
            end
        end
        writeAtomic(DUMP, table.concat(lines, "\n") .. "\n")
        log(string.format("dump (%s): %d actors of %d scanned, %d classes cached", reason, #lines, scanned, classAddrCount))
    end)
    if not ok then log("dump failed: " .. tostring(err)) end
    dumping = false
end

-- Value of a property on an object as text, simple types only.
local function propValue(obj, prop)
    local name = prop:GetFName():ToString()
    local ok, v = pcall(function() return obj[name] end)
    if not ok or v == nil then return "?" end
    if prop:IsA(PropertyTypes.BoolProperty) then return v and "true" or "false" end
    if prop:IsA(PropertyTypes.EnumProperty) then
        local ok2, n = pcall(function() return prop:GetEnum():GetNameByValue(v):ToString() end)
        return (ok2 and n or "?") .. "(" .. tostring(v) .. ")"
    end
    if prop:IsA(PropertyTypes.NameProperty) or prop:IsA(PropertyTypes.StrProperty) or prop:IsA(PropertyTypes.TextProperty) then
        local ok2, str = pcall(function() return v:ToString() end)
        return ok2 and str or "?"
    end
    if prop:IsA(PropertyTypes.ObjectProperty) then
        local ok2, str = pcall(function() return v:IsValid() and v:GetFullName() or "null" end)
        return ok2 and str or "?"
    end
    if prop:IsA(PropertyTypes.ArrayProperty) then
        local ok2, n = pcall(function() return v:GetArrayNum() end)
        return "array[" .. (ok2 and tostring(n) or "?") .. "]"
    end
    if type(v) == "number" or type(v) == "string" then return tostring(v) end
    return type(v)
end

-- props\<Class>.txt: every property of the class chain (game classes only) with the first instance's values.
local function dumpProps(className)
    local ok, err = pcall(function()
        local inst = nil
        for _, o in ipairs(FindAllOf(className) or {}) do if o:IsValid() then inst = o break end end
        if not inst then return end
        local lines = { "instance\t" .. inst:GetFullName() }
        local cls = inst:GetClass()
        while cls and cls:IsValid() do
            local full = cls:GetFullName()
            if full:find("/Script/Engine%.") or full:find("/Script/CoreUObject%.") then break end
            lines[#lines + 1] = "== " .. full
            cls:ForEachProperty(function(prop)
                lines[#lines + 1] = string.format("%s\t%s\t%s", prop:GetClass():GetFName():ToString(), prop:GetFName():ToString(), propValue(inst, prop))
            end)
            cls = cls:GetSuperStruct()
        end
        writeFile(PROPS_DIR .. "\\" .. className .. ".txt", table.concat(lines, "\n") .. "\n")
    end)
    if not ok then log("props " .. className .. " failed: " .. tostring(err)) end
end

-- props\<Class>.funcs.txt: every UFunction of the class chain with parameter names/types (research).
local function dumpFuncs(className)
    local ok, err = pcall(function()
        local cls = StaticFindObject(className)
        if not (cls and cls:IsValid()) then
            for _, o in ipairs(FindAllOf(className) or {}) do if o:IsValid() then cls = o:GetClass() break end end
        end
        if not (cls and cls:IsValid()) then log("funcs: class not found " .. className) return end
        local lines = {}
        while cls and cls:IsValid() do
            local full = cls:GetFullName()
            if full:find("/Script/Engine%.") or full:find("/Script/CoreUObject%.") then break end
            lines[#lines + 1] = "== " .. full
            cls:ForEachFunction(function(fn)
                local params = {}
                pcall(function()
                    fn:ForEachProperty(function(p)
                        params[#params + 1] = p:GetClass():GetFName():ToString() .. " " .. p:GetFName():ToString()
                    end)
                end)
                lines[#lines + 1] = fn:GetFName():ToString() .. "(" .. table.concat(params, ", ") .. ")"
            end)
            cls = cls:GetSuperStruct()
        end
        writeFile(PROPS_DIR .. "\\" .. className:gsub("[^%w_]", "_") .. ".funcs.txt", table.concat(lines, "\n") .. "\n")
        log("funcs: " .. className .. " " .. #lines .. " lines")
    end)
    if not ok then log("funcs " .. className .. " failed: " .. tostring(err)) end
end

-- widgets.txt: live UserWidget instances (class, full name).
local function dumpWidgets()
    local ok, err = pcall(function()
        local lines = {}
        for _, w in ipairs(FindAllOf("UserWidget") or {}) do
            if w:IsValid() then lines[#lines + 1] = w:GetClass():GetFName():ToString() .. "\t" .. w:GetFullName() end
        end
        writeFile(base .. "\\widgets.txt", table.concat(lines, "\n") .. "\n")
        log("widgets: " .. #lines)
    end)
    if not ok then log("widgets failed: " .. tostring(err)) end
end

local function vec(v, keys)
    keys = keys or { "X", "Y", "Z" }
    local out = {}
    for _, k in ipairs(keys) do
        local ok, val = pcall(function() return v[k] end)
        out[#out + 1] = ok and tostring(val) or "?"
    end
    return table.concat(out, " ")
end

-- mapinfo.txt: live WBP_Map_C geometry, pin enums, a few sample pins (research).
local function dumpMapInfo()
    local lines = {}
    local function add(k, f)
        local ok, v = pcall(f)
        lines[#lines + 1] = k .. "\t" .. (ok and tostring(v) or ("ERR " .. tostring(v)))
    end
    local sys, lib = getPinSystem(), getPinLib()
    add("system", function() return sys:GetFullName() end)
    add("library", function() return lib:GetFullName() end)
    add("hideCompleted", function() return tostring(hideCompleted()) end)
    for _, fnName in ipairs({ "GetMappinInstanceType", "GetMappinInstanceState" }) do
        add(fnName .. " enum", function()
            local e = returnEnum("/Script/DogwoodMap.MappinSystemBlueprintLibrary:" .. fnName)
            local names = {}
            e:ForEachName(function(name, value) names[#names + 1] = asString(name) .. "=" .. tostring(value) end)
            return e:GetFullName() .. " " .. table.concat(names, ", ")
        end)
    end
    local map = findLiveMap()
    if map then
        add("map", function() return map:GetFullName() end)
        add("GetMapSize", function() return vec(map:GetMapSize(), { "X", "Y" }) end)
        add("OriginalMapSize", function() return vec(map.OriginalMapSize, { "X", "Y" }) end)
        add("TopLeftWorldPosition", function() return vec(map.TopLeftWorldPosition) end)
        add("BottomRightWorldPosition", function() return vec(map.BottomRightWorldPosition) end)
        add("GetCurrentZoom", function() return map:GetCurrentZoom() end)
        add("WorldToMapPosition(0,0,0)", function() return vec(map:WorldToMapPosition({ X = 0, Y = 0, Z = 0 }), { "X", "Y" }) end)
        add("WorldToMapPosition(100000,0,0)", function() return vec(map:WorldToMapPosition({ X = 100000, Y = 0, Z = 0 }), { "X", "Y" }) end)
        add("GetMappinContainer", function() local c = map:GetMappinContainer(); return c:GetFullName() .. " children=" .. tostring(c:GetChildrenCount()) end)
    else
        lines[#lines + 1] = "map\tno live WBP_Map_C (open the M map once)"
    end
    local n = 0
    for _, pin in ipairs(FindAllOf("WBP_Map_Mappin_C") or {}) do
        if pin:IsValid() and not pin:GetFullName():find("Default__", 1, true) and n < 5 then
            n = n + 1
            add("pin" .. n .. " name", function() return pin:GetFullName() end)
            add("pin" .. n .. " id", function()
                local id = pin:GetMappinId()
                return type(id) .. " " .. asString(lib:GetMappinInstanceIdString(id))
            end)
            add("pin" .. n .. " prop id", function()
                local id = pin["Pin Instance Id"]
                return type(id) .. " " .. asString(lib:GetMappinInstanceIdString(id))
            end)
            add("pin" .. n .. " type/state", function()
                local id = pin:GetMappinId()
                return tostring(lib:GetMappinInstanceType(sys, id)) .. " / " .. tostring(lib:GetMappinInstanceState(sys, id))
            end)
            add("pin" .. n .. " world", function()
                local loc = lib:GetMappinInstanceLocation(sys, pin:GetMappinId())
                return vec(loc) .. (map and (" -> map " .. vec(map:WorldToMapPosition(loc), { "X", "Y" })) or "")
            end)
            add("pin" .. n .. " desc", function() return asString(lib:GetMappinInstanceDescription(sys, pin:GetMappinId())) end)
            add("pin" .. n .. " slot", function()
                local s = pin.Slot
                return "pos=" .. vec(s:GetPosition(), { "X", "Y" }) .. " size=" .. vec(s:GetSize(), { "X", "Y" })
            end)
        end
    end
    writeFile(base .. "\\mapinfo.txt", table.concat(lines, "\n") .. "\n")
    log("mapinfo: " .. #lines .. " lines")
end

-- Generic view of a UE4SS array-ish value (Lua table or TArray userdata).
local function arrInfo(v)
    if type(v) == "table" then return #v, v[1], v[2] end
    local ok, n = pcall(function() return v:GetArrayNum() end)
    if ok then
        local a, b
        pcall(function() a = v[1]; b = v[2] end)
        return n, a, b
    end
    return nil
end

local function valStr(v)
    if v == nil then return "nil" end
    local ok, s = pcall(function() return v:ToString() end)
    if ok and type(s) == "string" then return s end
    return tostring(v)
end

-- Unwraps a UE4SS RemoteUnrealParam (array elements come back wrapped).
local function unwrap(v)
    local ok, r = pcall(function() return v:get() end)
    if ok and r ~= nil then return r end
    return v
end

local function paramStr(v)
    return valStr(unwrap(v))
end

-- ---------------------------------------------------------------------------------------------
-- Quest journal. QuestSystemImpl.Journal keeps FinishedQuests / OpenedQuests (TMap InstanceId ->
-- Quest object: Title, State EQS_Success/Failure/Active, NewType, ID guid). The start location of
-- each quest comes from the mappin system's QuestStartMappinCache DataTable (row name = quest guid,
-- MappinLocation column), read once through DataTableFunctionLibrary. Output quests.tsv:
-- guid, state, type, x, y, z, title, instance id. Once a minute.
-- ---------------------------------------------------------------------------------------------
local questStartLoc = nil       -- guid -> { x, y, z }
local questStateEnum, questTypeEnum
local questStats = { total = 0, finished = 0, located = 0 }

local function guidHex(g)
    return string.format("%08X%08X%08X%08X", g.A & 0xFFFFFFFF, g.B & 0xFFFFFFFF, g.C & 0xFFFFFFFF, g.D & 0xFFFFFFFF)
end

local function firstArray(rets)
    for i = 1, #rets do
        local n = arrInfo(rets[i])
        if n then return rets[i], n end
    end
    return nil
end

-- guid -> { x, y, z } from one of the mappin system's cache DataTables (row name = guid).
local function loadGuidTable(tableName, column)
    local sys = getPinSystem()
    local dtl = StaticFindObject("/Script/Engine.Default__DataTableFunctionLibrary")
    if not (sys and dtl and dtl:IsValid()) then return nil end
    local dt = sys[tableName]
    local names = {}
    dtl:GetDataTableRowNames(dt, names)
    local n = arrInfo(names)
    local locs, m = firstArray({ dtl:GetDataTableColumnAsString(dt, FName(column)) })
    if not (n and m and n == m) then log(string.format("%s: row/column mismatch %s/%s", tableName, tostring(n), tostring(m))) return nil end
    local out, count = {}, 0
    for i = 1, n do
        local key = paramStr(names[i]):upper()
        local x, y, z = paramStr(locs[i]):match("X=([-%d.]+),Y=([-%d.]+),Z=([-%d.]+)")
        if x then out[key] = { x = tonumber(x), y = tonumber(y), z = tonumber(z) }; count = count + 1 end
    end
    log(tableName .. ": " .. count .. " locations")
    return out
end

local questPinLoc = nil         -- QuestMappinCache: objective / start spot mappin guid -> location

local function questStep()
    if not pawn or os.time() < questsNextAt then return end
    questsNextAt = os.time() + QUESTS_S
    local ok, err = pcall(function()
        if not questStartLoc then questStartLoc = loadGuidTable("QuestStartMappinCache", "MappinLocation") end
        if not questPinLoc then questPinLoc = loadGuidTable("QuestMappinCache", "MappinLocation") end
        if not questStartLoc then return end
        if not questStateEnum then questStateEnum = StaticFindObject("/Script/Quest.EQuestState") end
        if not questTypeEnum then questTypeEnum = StaticFindObject("/Script/Quest.ENewQuestType") end
        local journal = FindFirstOf("Journal")
        if not (journal and journal:IsValid()) then return end
        local lines, seen = {}, {}
        local objLines = {}
        local total, finished, located = 0, 0, 0
        for _, prop in ipairs({ "FinishedQuests", "OpenedQuests" }) do
            journal[prop]:ForEach(function(k, v)
                local q = unwrap(v)
                pcall(function()
                    if not q:IsValid() then return end
                    local guid = guidHex(q.ID)
                    if seen[guid] then return end
                    seen[guid] = true
                    total = total + 1
                    local state = enumName(questStateEnum, q.State):gsub("^EQS_", "")
                    local qtype = enumName(questTypeEnum, q.NewType)
                    if state == "Success" or state == "Failure" then finished = finished + 1 end
                    local title = ""
                    pcall(function() title = asString(q.Title):gsub("[\t\r\n]+", " ") end)
                    -- Objective mappins (guid -> QuestMappinCache location): exported for finished quests,
                    -- also the location fallback for quests without a cached start spot.
                    local firstObjLoc = nil
                    local done = (state == "Success" or state == "Failure")
                    pcall(function()
                        local arr = q.Objectives
                        local n = arr:GetArrayNum()
                        for i = 1, n do
                            local o = arr[i]
                            pcall(function()
                                local ms = o.Mappins
                                for j = 1, ms:GetArrayNum() do
                                    local okG, g = pcall(function() return guidHex(ms[j].ID) end)
                                    local l = okG and questPinLoc and questPinLoc[g] or nil
                                    if l then
                                        firstObjLoc = firstObjLoc or l
                                        if done then objLines[#objLines + 1] = string.format("%s\t%.0f\t%.0f\t%.0f\t%s", g, l.x, l.y, l.z, title) end
                                    end
                                end
                            end)
                        end
                    end)
                    local loc = questStartLoc[guid]
                    if not loc then
                        pcall(function()
                            local g = guidHex(q.StartSpotMappin.ID)
                            loc = questPinLoc and questPinLoc[g] or nil
                        end)
                    end
                    loc = loc or firstObjLoc
                    if loc then located = located + 1 end
                    local inst = ""
                    pcall(function() inst = asString(q.InstanceId) end)
                    lines[#lines + 1] = table.concat({ guid, state, qtype,
                        loc and string.format("%.0f", loc.x) or "", loc and string.format("%.0f", loc.y) or "", loc and string.format("%.0f", loc.z) or "",
                        title, inst }, "\t")
                end)
            end)
        end
        if total == 0 then return end -- save not loaded yet; keep the previous file
        writeAtomic(QUESTS, table.concat(lines, "\n") .. "\n")
        writeAtomic(QUESTOBJ, table.concat(objLines, "\n") .. "\n")
        local sig = total .. "/" .. finished .. "/" .. located
        if sig ~= questStats.logged then
            questStats.logged = sig
            log(string.format("quests: %d in journal, %d finished, %d located, %d objective pins", total, finished, located, #objLines))
        end
        questStats.total, questStats.finished, questStats.located = total, finished, located
    end)
    if not ok then log("quests failed: " .. tostring(err)) end
end

-- ---------------------------------------------------------------------------------------------
-- Loot containers. A container's InteractableComponent.InteractableState is 4 while it can still be
-- opened and 1 (Disabled) once the player has looted it (verified: only the two looted containers of
-- a camp switched 4 -> 1). Only streamed-in actors are visible, so the server merges passes over
-- time. Dropped loot bags (Floating*) are skipped: the site map has no markers for them.
-- Output loot.tsv: actor name, class, state, x, y, z. Spread over ticks like the pin pass.
-- ---------------------------------------------------------------------------------------------
local lootActors = nil
local lootIndex = 0
local lootLines = {}
local lootStats = { total = 0, looted = 0 }

local function lootStep()
    if not pawn then return end
    if not lootActors then
        if os.time() < lootNextAt then return end
        lootActors = FindAllOf("LootContainerBase") or {}
        lootIndex, lootLines = 0, {}
        if #lootActors == 0 then lootActors = nil; lootNextAt = os.time() + LOOT_S return end
    end
    local n = 0
    while lootIndex < #lootActors and n < LOOT_PER_TICK do
        lootIndex = lootIndex + 1
        n = n + 1
        local a = lootActors[lootIndex]
        pcall(function()
            if not a:IsValid() then return end
            local cls = a:GetClass():GetFName():ToString()
            if cls:find("Floating", 1, true) then return end
            local loc = a:K2_GetActorLocation()
            local st = -1
            pcall(function() st = a.InteractableComponent.InteractableState end)
            lootLines[#lootLines + 1] = string.format("%s\t%s\t%d\t%.0f\t%.0f\t%.0f", a:GetFName():ToString(), cls, st, loc.X, loc.Y, loc.Z)
        end)
    end
    if lootIndex >= #lootActors then
        writeAtomic(LOOT, table.concat(lootLines, "\n") .. "\n")
        local looted = 0
        for _, l in ipairs(lootLines) do if l:match("\t1\t") then looted = looted + 1 end end
        local sig = #lootLines .. "/" .. looted
        if sig ~= lootStats.logged then
            lootStats.logged = sig
            log(string.format("loot: %d containers loaded, %d looted", #lootLines, looted))
        end
        lootStats.total, lootStats.looted = #lootLines, looted
        lootActors = nil
        lootNextAt = os.time() + LOOT_S
    end
end

-- ---------------------------------------------------------------------------------------------
-- Owned items. Every item definition comes from InventorySubsystem.LoadedItemMap (property TMap,
-- read once); for each non-junk definition the player inventory and the shrine storage are asked
-- GetHandleForAssetInInventory + GetItemQuantity. Function-returned arrays are never walked (that
-- crashed the game); the handle struct is used right away, like pin locations. Output owned.tsv:
-- item id, class, player quantity, storage quantity. Spread over ticks.
-- ---------------------------------------------------------------------------------------------
local itemDefs = nil        -- { { id = ItemId, asset = ItemDataAsset, cls = class } }
local itemIndex = 0
local itemLines = {}
local itemStats = {}
local SKIP_ITEM_CLASSES = { ItemJunkDataAsset = true, ItemCurrencyDataAsset = true, ItemIngredientDataAsset = true, ItemConsumableDataAsset = true }

local function loadItemDefs()
    local sys = FindFirstOf("InventorySubsystem")
    if not (sys and sys:IsValid()) then return nil end
    local defs = {}
    sys.LoadedItemMap:ForEach(function(k, v)
        local asset = unwrap(v)
        pcall(function()
            if not asset:IsValid() then return end
            local cls = asset:GetClass():GetFName():ToString()
            if SKIP_ITEM_CLASSES[cls] then return end
            defs[#defs + 1] = { id = asString(asset.ItemId), asset = asset, cls = cls }
        end)
    end)
    log("item definitions: " .. #defs)
    return defs
end

local function ownedQuantity(inv, asset)
    if not (inv and inv:IsValid()) then return 0 end
    local ok, q = pcall(function()
        local h = inv:GetHandleForAssetInInventory(asset)
        return inv:GetItemQuantity(h, true)
    end)
    if ok and type(q) == "number" then return q end
    return 0
end

local itemsRunning = false
local function itemStep()
    if not pawn then return end
    if not itemsRunning then
        if os.time() < itemsNextAt then return end
        if not itemDefs then itemDefs = loadItemDefs() end
        if not itemDefs or #itemDefs == 0 then itemDefs = nil; itemsNextAt = os.time() + ITEMS_S return end
        itemsRunning, itemIndex, itemLines = true, 0, {}
    end
    local sys = FindFirstOf("InventorySubsystem")
    local player, storage = nil, nil
    pcall(function() player = sys:GetPlayerInventoryComponent() end)
    pcall(function() storage = sys:GetPlayerStorageComponent() end)
    local n = 0
    while itemIndex < #itemDefs and n < ITEMS_PER_TICK do
        itemIndex = itemIndex + 1
        n = n + 1
        local d = itemDefs[itemIndex]
        local qp, qs = ownedQuantity(player, d.asset), ownedQuantity(storage, d.asset)
        if qp > 0 or qs > 0 then itemLines[#itemLines + 1] = string.format("%s\t%s\t%d\t%d", d.id, d.cls, qp, qs) end
    end
    if itemIndex >= #itemDefs then
        writeAtomic(OWNED, table.concat(itemLines, "\n") .. "\n")
        if #itemLines ~= itemStats.logged then
            itemStats.logged = #itemLines
            log(string.format("items: %d of %d definitions owned (inventory or storage)", #itemLines, #itemDefs))
        end
        itemsRunning = false
        itemsNextAt = os.time() + ITEMS_S
    end
end

-- libs.txt: function library classes whose name mentions quest/journal/mappin, with function names.
local function dumpLibs()
    local ok, err = pcall(function()
        local lines = {}
        for _, c in ipairs(FindAllOf("Class") or {}) do
            if c:IsValid() then
                local full = c:GetFullName()
                local lf = full:lower()
                if lf:find("quest", 1, true) or lf:find("journal", 1, true) or lf:find("mappin", 1, true) then
                    local names = {}
                    pcall(function() c:ForEachFunction(function(fn) names[#names + 1] = fn:GetFName():ToString() end) end)
                    if #names > 0 then lines[#lines + 1] = full .. "\t" .. table.concat(names, " ") end
                end
            end
        end
        writeFile(base .. "\\libs.txt", table.concat(lines, "\n") .. "\n")
        log("libs: " .. #lines)
    end)
    if not ok then log("libs failed: " .. tostring(err)) end
end

-- Struct parameters of a UFunction: struct type and its fields (research).
local function describeFn(lines, fnPath)
    local ok, err = pcall(function()
        local fn = StaticFindObject(fnPath)
        lines[#lines + 1] = "fn\t" .. fnPath .. (fn and fn:IsValid() and "" or "\tNOT FOUND")
        if not (fn and fn:IsValid()) then return end
        fn:ForEachProperty(function(p)
            local kind = p:GetClass():GetFName():ToString()
            local extra = ""
            if kind == "StructProperty" then
                local okS, st = pcall(function() return p:GetStruct() end)
                if okS and st then
                    local fields = {}
                    pcall(function() st:ForEachProperty(function(f) fields[#fields + 1] = f:GetClass():GetFName():ToString() .. " " .. f:GetFName():ToString() end) end)
                    extra = st:GetFullName() .. " {" .. table.concat(fields, ", ") .. "}"
                else
                    extra = "struct ?"
                end
            end
            lines[#lines + 1] = "  param\t" .. kind .. "\t" .. p:GetFName():ToString() .. "\t" .. extra
        end)
    end)
    if not ok then lines[#lines + 1] = "fn ERR\t" .. fnPath .. "\t" .. tostring(err) end
end

-- tables.txt: the mappin system's cache DataTables plus id/guid research (row names, columns as strings,
-- struct layouts, what the library returns for visible pins, TMap access on the map widget).
local function dumpTables()
    local sys = getPinSystem()
    local lib = getPinLib()
    local dtl = StaticFindObject("/Script/Engine.Default__DataTableFunctionLibrary")
    local lines = { "dtlib\t" .. (dtl and dtl:IsValid() and dtl:GetFullName() or "not found") }
    for _, name in ipairs({ "OpenWorldMappinCache", "QuestMappinCache", "QuestStartMappinCache", "FastTravelDestinationCache", "MapLabels" }) do
        local ok, err = pcall(function()
            local dt = sys[name]
            lines[#lines + 1] = "== " .. name .. "\t" .. dt:GetFullName()
            local cols = {}
            dt.RowStruct:ForEachProperty(function(p)
                cols[#cols + 1] = p:GetFName():ToString()
                local extra = ""
                if p:GetClass():GetFName():ToString() == "StructProperty" then
                    pcall(function() extra = p:GetStruct():GetFullName() end)
                end
                lines[#lines + 1] = "col\t" .. p:GetClass():GetFName():ToString() .. "\t" .. p:GetFName():ToString() .. "\t" .. extra
            end)
            local names = {}
            dtl:GetDataTableRowNames(dt, names)
            local n, a, b = arrInfo(names)
            lines[#lines + 1] = string.format("rows\t%s\t%s | %s", tostring(n), paramStr(a), paramStr(b))
            for _, c in ipairs(cols) do
                local rets = { pcall(function() return dtl:GetDataTableColumnAsString(dt, FName(c)) end) }
                local shown = false
                for i = 2, #rets do
                    local cand = rets[i]
                    local cn, ca, cb = arrInfo(cand)
                    if cn then lines[#lines + 1] = string.format("colvals\t%s\t%d\t%s | %s", c, cn, paramStr(ca), paramStr(cb)); shown = true end
                end
                if not shown then
                    local desc = {}
                    for i = 1, #rets do desc[#desc + 1] = type(rets[i]) .. ":" .. tostring(rets[i]) end
                    lines[#lines + 1] = "colvals\t" .. c .. "\treturns " .. table.concat(desc, ", ")
                end
            end
        end)
        if not ok then lines[#lines + 1] = "ERR\t" .. name .. "\t" .. tostring(err) end
    end
    -- Library functions that connect ids, guids and quests.
    for _, f in ipairs({ "GetOpenWorldContentMappin", "MakeMappinInstanceIdFromInt64", "GetQuestInfo", "GetMappinInstanceIdString", "GetMappinsForObjective", "GetMappinFastTravelDestination" }) do
        describeFn(lines, "/Script/DogwoodMap.MappinSystemBlueprintLibrary:" .. f)
    end
    -- What the library says about the first visible open-world pins and quest pins.
    local shown = { ow = 0, q = 0 }
    for _, w in ipairs(FindAllOf("WBP_Map_Mappin_C") or {}) do
        if shown.ow >= 3 and shown.q >= 3 then break end
        pcall(function()
            if not w:IsValid() or w:GetFullName():find("Default__", 1, true) then return end
            local id = w["Pin Instance Id"]
            local idStr = asString(lib:GetMappinInstanceIdString(id))
            local ty = lib:GetMappinInstanceType(sys, id)
            local isQuest = w["Is Quest Mappin"] == true
            if isQuest and shown.q >= 3 then return end
            if not isQuest and shown.ow >= 3 then return end
            if isQuest then shown.q = shown.q + 1 else shown.ow = shown.ow + 1 end
            lines[#lines + 1] = "pin\t" .. idStr .. "\ttype " .. enumName(pinTypeEnum, ty) .. "\tquest " .. tostring(isQuest)
            pcall(function()
                local m = lib:GetOpenWorldContentMappin(sys, id)
                for _, k in ipairs({ "MappinGuid", "Guid", "MappinLocation", "Location", "MappinType", "Type", "InstanceId", "MappinInstanceId" }) do
                    local okK, v = pcall(function() return m[k] end)
                    if okK and v ~= nil then
                        local parts = {}
                        for _, sub in ipairs({ "A", "B", "C", "D", "X", "Y", "Z", "Value", "Id" }) do
                            local okSub, sv = pcall(function() return v[sub] end)
                            if okSub and sv ~= nil then parts[#parts + 1] = sub .. "=" .. tostring(sv) end
                        end
                        lines[#lines + 1] = "  content." .. k .. "\t" .. tostring(v) .. "\t" .. table.concat(parts, " ")
                    end
                end
            end)
            pcall(function()
                local q, o = {}, {}
                local rets = { lib:GetQuestInfo(sys, id, q, o) }
                local desc = {}
                for i = 1, #rets do desc[#desc + 1] = type(rets[i]) .. ":" .. paramStr(rets[i]) end
                local qparts = {}
                for _, sub in ipairs({ "A", "B", "C", "D", "Value", "Id", "Guid", "Name" }) do
                    local okSub, sv = pcall(function() return q[sub] end)
                    if okSub and sv ~= nil then qparts[#qparts + 1] = sub .. "=" .. paramStr(sv) end
                end
                lines[#lines + 1] = "  questinfo\t" .. table.concat(desc, ", ") .. "\tq{" .. table.concat(qparts, " ") .. "}"
            end)
        end)
    end
    -- TMaps on the live map widget: MappinCache (all known pins?) and UsedMappins (widgets).
    local map = findLiveMap()
    if map then
        for _, prop in ipairs({ "MappinCache", "UsedMappins" }) do
            local ok, err = pcall(function()
                local m = map[prop]
                local count, first = 0, nil
                m:ForEach(function(k, v)
                    count = count + 1
                    if count == 1 then
                        local kk = unwrap(k)
                        local okId, idStr = pcall(function() return asString(lib:GetMappinInstanceIdString(kk)) end)
                        first = (okId and idStr or ("key " .. type(kk))) .. " -> " .. type(unwrap(v))
                    end
                end)
                lines[#lines + 1] = "tmap\t" .. prop .. "\t" .. count .. "\t" .. tostring(first)
            end)
            if not ok then lines[#lines + 1] = "tmap ERR\t" .. prop .. "\t" .. tostring(err) end
        end
    end
    writeFile(base .. "\\tables.txt", table.concat(lines, "\n") .. "\n")
    log("tables: " .. #lines .. " lines")
end

-- idmap.txt: for every visible pin, instance id (uint64), content guid / name / type from
-- GetOpenWorldContentMappin, and quest guid from GetQuestInfo (research: guid <-> id relation).
local function dumpIdMap()
    local ok, err = pcall(function()
        local sys, lib = getPinSystem(), getPinLib()
        local lines = {}
        local seen = {}
        for _, w in ipairs(FindAllOf("WBP_Map_Mappin_C") or {}) do
            pcall(function()
                if not w:IsValid() or w:GetFullName():find("Default__", 1, true) then return end
                local id = w["Pin Instance Id"]
                local idStr = asString(lib:GetMappinInstanceIdString(id))
                if seen[idStr] then return end
                seen[idStr] = true
                local raw = "?"
                pcall(function() raw = string.format("%d", id.Value) end)
                local ty = enumName(pinTypeEnum, lib:GetMappinInstanceType(sys, id))
                local guid, name, cname, istate = "", "", "", ""
                pcall(function()
                    local m = lib:GetOpenWorldContentMappin(sys, id)
                    pcall(function() guid = string.format("%08X%08X%08X%08X", m.ID.A & 0xFFFFFFFF, m.ID.B & 0xFFFFFFFF, m.ID.C & 0xFFFFFFFF, m.ID.D & 0xFFFFFFFF) end)
                    pcall(function() name = asString(m.Name) end)
                    pcall(function() cname = asString(m.MappinType) end)
                    pcall(function() istate = tostring(m.InitialState) end)
                end)
                local qguid = ""
                pcall(function()
                    local q, o = {}, {}
                    local isQ = lib:GetQuestInfo(sys, id, q, o)
                    if isQ then qguid = string.format("%08X%08X%08X%08X", q.A & 0xFFFFFFFF, q.B & 0xFFFFFFFF, q.C & 0xFFFFFFFF, q.D & 0xFFFFFFFF) end
                end)
                local loc = lib:GetMappinInstanceLocation(sys, id)
                lines[#lines + 1] = table.concat({ idStr, raw, ty, guid, name, cname, istate, qguid, string.format("%.3f %.3f %.3f", loc.X, loc.Y, loc.Z) }, "\t")
            end)
        end
        writeFile(base .. "\\idmap.txt", table.concat(lines, "\n") .. "\n")
        log("idmap: " .. #lines)
    end)
    if not ok then log("idmap failed: " .. tostring(err)) end
end

-- Pool statistics: used pin widgets and how many report Completed / Unknown / Regular.
local function poolStats()
    local sys, lib = getPinSystem(), getPinLib()
    local map = findLiveMap()
    local n, st = 0, {}
    if not (map and sys and lib) then return n, st end
    pcall(function()
        map.UsedMappins:ForEach(function(k, v)
            n = n + 1
            local id = unwrap(k)
            local ok, name = pcall(function() return enumName(pinStateEnum, lib:GetMappinInstanceState(sys, id)) end)
            name = ok and name or "?"
            st[name] = (st[name] or 0) + 1
        end)
    end)
    return n, st
end

local function statsStr(n, st)
    local parts = {}
    for k, v in pairs(st) do parts[#parts + 1] = k .. "=" .. v end
    table.sort(parts)
    return n .. " (" .. table.concat(parts, " ") .. ")"
end

-- reveal test: does turning the game's "hide completed" off and refreshing the closed map bring the
-- hidden completed pins into the pool? Restores the setting afterwards (no refresh, pool stays).
local function revealTest()
    local ok, err = pcall(function()
        local sys = getPinSystem()
        local map = findLiveMap()
        if not (sys and map) then log("reveal: no system/map") return end
        local active = false
        pcall(function() active = map:IsActivated() end)
        local hide = hideCompleted()
        local n0, s0 = poolStats()
        log(string.format("reveal: map active=%s hide=%s before %s", tostring(active), tostring(hide), statsStr(n0, s0)))
        if hide then sys:ToggleDisplayingCompletedMappins() end
        local okR, errR = pcall(function() map:RefreshMappinsAndGetPlayerId() end)
        local n1, s1 = poolStats()
        log(string.format("reveal: refresh ok=%s err=%s after %s hide now=%s", tostring(okR), tostring(errR), statsStr(n1, s1), tostring(hideCompleted())))
        if hide then sys:ToggleDisplayingCompletedMappins() end
        local n2, s2 = poolStats()
        log(string.format("reveal: restored hide=%s pool %s", tostring(hideCompleted()), statsStr(n2, s2)))
        pinsNextAt = 0
    end)
    if not ok then log("reveal failed: " .. tostring(err)) end
end

-- qfuncs.txt: UFunctions (any class) whose full name mentions quest/journal plus state/complete/...
local function dumpQuestFuncs()
    local ok, err = pcall(function()
        local lines = {}
        for _, f in ipairs(FindAllOf("Function") or {}) do
            if f:IsValid() then
                local full = f:GetFullName()
                local lf = full:lower()
                if (lf:find("quest", 1, true) or lf:find("journal", 1, true))
                    and (lf:find("complet", 1, true) or lf:find("state", 1, true) or lf:find("status", 1, true)
                        or lf:find("finish", 1, true) or lf:find("done", 1, true) or lf:find("isactive", 1, true)
                        or lf:find("progress", 1, true) or lf:find("getquest", 1, true) or lf:find("allquest", 1, true)) then
                    local params = {}
                    pcall(function()
                        f:ForEachProperty(function(p) params[#params + 1] = p:GetClass():GetFName():ToString() .. " " .. p:GetFName():ToString() end)
                    end)
                    lines[#lines + 1] = full .. "(" .. table.concat(params, ", ") .. ")"
                end
            end
        end
        table.sort(lines)
        writeFile(base .. "\\qfuncs.txt", table.concat(lines, "\n") .. "\n")
        log("qfuncs: " .. #lines)
    end)
    if not ok then log("qfuncs failed: " .. tostring(err)) end
end

-- Properties (class chain, game classes only) of one object as lines, values included.
local function describeObject(lines, obj, indent)
    indent = indent or "  "
    local cls = obj:GetClass()
    while cls and cls:IsValid() do
        local full = cls:GetFullName()
        if full:find("/Script/Engine%.") or full:find("/Script/CoreUObject%.") then break end
        lines[#lines + 1] = indent .. "== " .. full
        cls:ForEachProperty(function(prop)
            lines[#lines + 1] = indent .. string.format("%s\t%s\t%s", prop:GetClass():GetFName():ToString(), prop:GetFName():ToString(), propValue(obj, prop))
        end)
        cls = cls:GetSuperStruct()
    end
end

-- quests.txt: the quest journal's FinishedQuests / OpenedQuests maps (key and value types, first
-- entries described), plus GetQuests() per state. Research for automatic quest completion.
local function dumpQuests()
    local ok, err = pcall(function()
        local lines = {}
        local journal = FindFirstOf("Journal")
        if not (journal and journal:IsValid()) then lines[#lines + 1] = "no Journal" writeFile(base .. "\\quests.txt", table.concat(lines, "\n") .. "\n") return end
        lines[#lines + 1] = "journal\t" .. journal:GetFullName()
        for _, prop in ipairs({ "FinishedQuests", "OpenedQuests" }) do
            local okM, errM = pcall(function()
                local m = journal[prop]
                local count = 0
                m:ForEach(function(k, v)
                    count = count + 1
                    if count <= 3 then
                        local kk, vv = unwrap(k), unwrap(v)
                        lines[#lines + 1] = string.format("%s[%d]\tkey %s %s\tvalue %s %s", prop, count, type(kk), valStr(kk), type(vv), valStr(vv))
                        for _, o in ipairs({ kk, vv }) do
                            local okO = pcall(function()
                                if o:IsValid() and o:GetClass() then
                                    lines[#lines + 1] = "  object\t" .. o:GetFullName()
                                    describeObject(lines, o, "    ")
                                end
                            end)
                            if not okO then
                                -- a struct: try common fields
                                local parts = {}
                                for _, f in ipairs({ "A", "B", "C", "D", "Value", "Guid", "QuestGuid", "Name", "State", "Quest" }) do
                                    local okF, fv = pcall(function() return o[f] end)
                                    if okF and fv ~= nil then parts[#parts + 1] = f .. "=" .. valStr(fv) end
                                end
                                if #parts > 0 then lines[#lines + 1] = "  fields\t" .. table.concat(parts, " ") end
                            end
                        end
                    end
                end)
                lines[#lines + 1] = prop .. " count\t" .. count
            end)
            if not okM then lines[#lines + 1] = prop .. " ERR\t" .. tostring(errM) end
        end
        -- GetQuests(State): enum names from the parameter, then one call per value.
        pcall(function()
            local fn = StaticFindObject("/Script/Quest.Journal:GetQuests")
            local e = nil
            fn:ForEachProperty(function(p) if p:GetFName():ToString() == "State" then pcall(function() e = p:GetEnum() end) end end)
            local names = {}
            if e then e:ForEachName(function(n, v) names[#names + 1] = asString(n) .. "=" .. tostring(v) end) end
            lines[#lines + 1] = "GetQuests state enum\t" .. table.concat(names, ", ")
            for v = 0, 8 do
                local out = {}
                local okG = pcall(function() journal:GetQuests(v, out) end)
                local n, a = arrInfo(out)
                lines[#lines + 1] = string.format("GetQuests(%d)\tok=%s n=%s first=%s", v, tostring(okG), tostring(n), paramStr(a))
                if okG and n and n > 0 and v <= 4 then
                    local first = unwrap(a)
                    pcall(function()
                        lines[#lines + 1] = "  object\t" .. first:GetFullName()
                        describeObject(lines, first, "    ")
                    end)
                end
            end
        end)
        writeFile(base .. "\\quests.txt", table.concat(lines, "\n") .. "\n")
        log("quests: " .. #lines .. " lines")
    end)
    if not ok then log("quests failed: " .. tostring(err)) end
end

-- Struct value as "field=value" pairs using the struct's own property list.
local function structFields(structProp, value, depth)
    depth = depth or 0
    local parts = {}
    local okS, st = pcall(function() return structProp:GetStruct() end)
    if not (okS and st) then return "?" end
    st:ForEachProperty(function(f)
        local fname = f:GetFName():ToString()
        local kind = f:GetClass():GetFName():ToString()
        local okV, v = pcall(function() return value[fname] end)
        local shown
        if not okV or v == nil then shown = "nil"
        elseif kind == "StructProperty" and depth < 2 then shown = "{" .. structFields(f, v, depth + 1) .. "}"
        elseif kind == "ObjectProperty" then
            local okO, n = pcall(function() return v:IsValid() and v:GetFullName() or "null" end)
            shown = okO and n or "?"
        elseif kind == "ArrayProperty" then
            local okN, n = pcall(function() return v:GetArrayNum() end)
            shown = "array[" .. (okN and tostring(n) or "?") .. "]"
        else shown = valStr(v) end
        parts[#parts + 1] = fname .. "=" .. shown
    end)
    return table.concat(parts, " ")
end

-- Struct value described through its UScriptStruct (found by the value's own type name), nested
-- structs and arrays of structs included up to a small depth.
local function describeStruct(value, depth)
    depth = depth or 0
    local typeName = nil
    pcall(function() typeName = value:GetFullName():match("^ScriptStruct (.+)$") end)
    if not typeName then return valStr(value) end
    local st = StaticFindObject(typeName)
    if not (st and st:IsValid()) then return "?" .. typeName end
    local parts = {}
    st:ForEachProperty(function(f)
        local fname = f:GetFName():ToString()
        local kind = f:GetClass():GetFName():ToString()
        local okV, v = pcall(function() return value[fname] end)
        local shown
        if not okV or v == nil then shown = "nil"
        elseif kind == "StructProperty" then shown = depth < 3 and ("{" .. describeStruct(v, depth + 1) .. "}") or "{...}"
        elseif kind == "ObjectProperty" or kind == "WeakObjectProperty" then
            local okO, n = pcall(function() return v:IsValid() and v:GetFullName() or "null" end)
            shown = okO and n or "?"
        elseif kind == "ArrayProperty" then
            local okN, n = pcall(function() return v:GetArrayNum() end)
            n = okN and n or 0
            local items = {}
            for i = 1, math.min(n, 3) do
                local okE, e = pcall(function() return v[i] end)
                if okE and e ~= nil then
                    local isStruct = false
                    pcall(function() isStruct = e:GetFullName():match("^ScriptStruct ") ~= nil end)
                    items[#items + 1] = (isStruct and depth < 3) and ("{" .. describeStruct(e, depth + 1) .. "}") or valStr(e)
                end
            end
            shown = "array[" .. n .. "] " .. table.concat(items, " | ")
        elseif kind == "EnumProperty" or kind == "ByteProperty" then shown = tostring(v)
        else shown = valStr(v) end
        parts[#parts + 1] = fname .. "=" .. shown
    end)
    return table.concat(parts, " ")
end

-- queststruct.txt: StartSpotMappin and Objectives of finished quests that have no cached start location.
local function dumpQuestStruct()
    local ok, err = pcall(function()
        local lines = {}
        if not questStartLoc then questStartLoc = loadGuidTable("QuestStartMappinCache", "MappinLocation") end
        local journal = FindFirstOf("Journal")
        local shown = 0
        journal.FinishedQuests:ForEach(function(k, v)
            if shown >= 6 then return end
            local q = unwrap(v)
            pcall(function()
                local guid = guidHex(q.ID)
                if questStartLoc and questStartLoc[guid] then return end
                shown = shown + 1
                lines[#lines + 1] = "quest\t" .. asString(q.Title) .. "\t" .. asString(q.InstanceId)
                local cls = q:GetClass()
                cls:ForEachProperty(function(p)
                    local pn = p:GetFName():ToString()
                    if pn == "StartSpotMappin" then
                        lines[#lines + 1] = "  StartSpotMappin\t" .. describeStruct(q.StartSpotMappin)
                    elseif pn == "Objectives" then
                        local arr = q.Objectives
                        local n = 0
                        pcall(function() n = arr:GetArrayNum() end)
                        lines[#lines + 1] = "  Objectives\t" .. n
                        for i = 1, math.min(n, 3) do
                            local o = arr[i]
                            pcall(function() lines[#lines + 1] = "    obj[" .. i .. "]\t" .. describeStruct(o) end)
                        end
                    end
                end)
            end)
        end)
        writeFile(base .. "\\queststruct.txt", table.concat(lines, "\n") .. "\n")
        log("queststruct: " .. #lines .. " lines")
    end)
    if not ok then log("queststruct failed: " .. tostring(err)) end
end

-- chests.txt: loot containers within 30 m of the player, with inventory item count and loot table
-- (research: does a looted chest look different from an untouched one?).
local function dumpChests()
    local ok, err = pcall(function()
        local lines = {}
        if not pawn then return end
        local me = pawn:K2_GetActorLocation()
        for _, a in ipairs(FindAllOf("LootContainerBase") or {}) do
            pcall(function()
                if not a:IsValid() then return end
                local loc = a:K2_GetActorLocation()
                local d = math.sqrt((loc.X - me.X) ^ 2 + (loc.Y - me.Y) ^ 2 + (loc.Z - me.Z) ^ 2)
                if d > 6000 then return end
                local items, lootTable, locked, opened = "?", "?", "?", ""
                pcall(function()
                    local inv = a.InventoryComponent
                    local n = 0
                    inv.InventoryItems:ForEach(function() n = n + 1 end)
                    items = tostring(n)
                    pcall(function() lootTable = inv.LootTable and inv.LootTable:IsValid() and inv.LootTable:GetFName():ToString() or "null" end)
                end)
                pcall(function() locked = tostring(a.bLocked) end)
                local istate = "?"
                pcall(function()
                    local ic = a.InteractableComponent
                    istate = tostring(ic.InteractableState) .. "/" .. tostring(ic.InteractableType) .. "/pre" .. tostring(ic.CachedPreQuestInteractionState)
                end)
                -- any boolean on the actor whose name hints at opened/looted/used
                pcall(function()
                    local cls = a:GetClass()
                    local found = {}
                    while cls and cls:IsValid() do
                        local full = cls:GetFullName()
                        if full:find("/Script/Engine%.") then break end
                        cls:ForEachProperty(function(p)
                            local pn = p:GetFName():ToString()
                            local lp = pn:lower()
                            if lp:find("open") or lp:find("loot") or lp:find("used") or lp:find("empty") or lp:find("interact") or lp:find("persist") then
                                local okV, v = pcall(function() return a[pn] end)
                                found[#found + 1] = pn .. "=" .. (okV and valStr(v) or "?")
                            end
                        end)
                        cls = cls:GetSuperStruct()
                    end
                    opened = table.concat(found, " ")
                end)
                lines[#lines + 1] = string.format("%.0f\t%s\t%s\titems=%s\tloot=%s\tlocked=%s\tstate=%s\t%s", d, a:GetClass():GetFName():ToString(), a:GetFName():ToString(), items, lootTable, locked, istate, opened)
            end)
        end
        table.sort(lines, function(x, y) return tonumber(x:match("^(%d+)")) < tonumber(y:match("^(%d+)")) end)
        -- Nearest container in depth: inventory entries, interactable and persistency components.
        local nearestA, nearestD = nil, math.huge
        for _, a in ipairs(FindAllOf("LootContainerBase") or {}) do
            pcall(function()
                if not a:IsValid() then return end
                local loc = a:K2_GetActorLocation()
                local d = math.sqrt((loc.X - me.X) ^ 2 + (loc.Y - me.Y) ^ 2 + (loc.Z - me.Z) ^ 2)
                if d < nearestD then nearestA, nearestD = a, d end
            end)
        end
        if nearestA then
            lines[#lines + 1] = "== nearest\t" .. nearestA:GetFullName()
            pcall(function()
                local inv = nearestA.InventoryComponent
                lines[#lines + 1] = "inventory\t" .. inv:GetFullName()
                describeObject(lines, inv, "  ")
                local i = 0
                inv.InventoryItems:ForEach(function(k, v)
                    i = i + 1
                    local kk, vv = unwrap(k), unwrap(v)
                    lines[#lines + 1] = string.format("  item[%d]\tkey %s %s\tvalue %s %s", i, type(kk), valStr(kk), type(vv), valStr(vv))
                    pcall(function() lines[#lines + 1] = "    keyfields\t" .. describeStruct(kk) end)
                    pcall(function() lines[#lines + 1] = "    valfields\t" .. describeStruct(vv) end)
                    pcall(function() if vv:IsValid() then describeObject(lines, vv, "    ") end end)
                end)
            end)
            for _, comp in ipairs({ "InteractableComponent", "PersistencyComponent" }) do
                pcall(function()
                    local c = nearestA[comp]
                    lines[#lines + 1] = comp .. "\t" .. c:GetFullName()
                    describeObject(lines, c, "  ")
                end)
            end
        end
        writeFile(base .. "\\chests.txt", table.concat(lines, "\n") .. "\n")
        log("chests: " .. #lines)
    end)
    if not ok then log("chests failed: " .. tostring(err)) end
end

-- items.txt: InventorySubsystem.LoadedItemMap (property TMap, stable memory): every known item asset
-- with its class and display name. Research for matching site item markers by name.
-- NOTE: arrays returned by UFunctions (GetCurrentItems) point into a freed buffer; iterating them
-- crashed the game. Only property maps/arrays and out-parameter tables are safe to walk.
local function dumpItems()
    local ok, err = pcall(function()
        local lines = {}
        local sys = FindFirstOf("InventorySubsystem")
        if not (sys and sys:IsValid()) then writeFile(base .. "\\items.txt", "no InventorySubsystem\n") return end
        local n = 0
        sys.LoadedItemMap:ForEach(function(k, v)
            n = n + 1
            local key, asset = unwrap(k), unwrap(v)
            local kname, aname, cls, disp = "?", "?", "?", ""
            pcall(function() kname = valStr(key) end)
            pcall(function() aname = asset:GetFName():ToString() end)
            pcall(function() cls = asset:GetClass():GetFName():ToString() end)
            for _, f in ipairs({ "DisplayName", "ItemName", "Name", "Title" }) do
                local okF, fv = pcall(function() return asset[f] end)
                if okF and fv ~= nil then local sv = asString(fv); if sv ~= "" and sv ~= "?" then disp = f .. "=" .. sv break end end
            end
            lines[#lines + 1] = table.concat({ kname, aname, cls, disp }, "\t")
            if n == 1 then pcall(function() describeObject(lines, asset, "    ") end) end
        end)
        lines[#lines + 1] = "count\t" .. n
        writeFile(base .. "\\items.txt", table.concat(lines, "\n") .. "\n")
        log("items: " .. n)
    end)
    if not ok then log("items failed: " .. tostring(err)) end
end

local function dumpSubsystems()
    local ok, err = pcall(function()
        local lines = {}
        for _, baseCls in ipairs({ "GameInstanceSubsystem", "WorldSubsystem", "LocalPlayerSubsystem", "EngineSubsystem" }) do
            for _, o in ipairs(FindAllOf(baseCls) or {}) do
                if o:IsValid() then lines[#lines + 1] = baseCls .. "\t" .. o:GetClass():GetFName():ToString() .. "\t" .. o:GetFullName() end
            end
        end
        writeFile(SUBSYSTEMS, table.concat(lines, "\n") .. "\n")
        log("subsystems: " .. #lines)
    end)
    if not ok then log("subsystems failed: " .. tostring(err)) end
end

-- Commands dropped into cmd.txt by the map app (no in-game key press needed).
local function pollCmd()
    local c = io.open(CMD, "r")
    if not c then return end
    local cmd = (c:read("*a") or ""):gsub("^%s+", ""):gsub("%s+$", "")
    c:close()
    os.remove(CMD)
    if cmd == "dump" then
        dumpActors("cmd")
    elseif cmd == "scan:off" then
        scanEnabled = false
        log("periodic scans off")
    elseif cmd == "scan:on" then
        scanEnabled = true
        nextDumpAt = os.time()
        log("periodic scans on")
    elseif cmd == "pins" then
        pinsNextAt = 0
        questsNextAt = 0
        lootNextAt = 0
        itemsNextAt = 0
    elseif cmd:sub(1, 6) == "props:" then
        dumpProps(cmd:sub(7))
    elseif cmd:sub(1, 6) == "funcs:" then
        dumpFuncs(cmd:sub(7))
    elseif cmd == "widgets" then
        dumpWidgets()
    elseif cmd == "subsystems" then
        dumpSubsystems()
    elseif cmd == "mapinfo" then
        local ok, err = pcall(dumpMapInfo)
        if not ok then log("mapinfo failed: " .. tostring(err)) end
    elseif cmd == "libs" then
        dumpLibs()
    elseif cmd == "idmap" then
        dumpIdMap()
    elseif cmd == "reveal" then
        revealTest()
    elseif cmd == "qfuncs" then
        dumpQuestFuncs()
    elseif cmd == "quests" then
        dumpQuests()
    elseif cmd == "queststruct" then
        dumpQuestStruct()
    elseif cmd == "chests" then
        dumpChests()
    elseif cmd == "items" then
        dumpItems()
    elseif cmd == "tables" then
        local ok, err = pcall(dumpTables)
        if not ok then log("tables failed: " .. tostring(err)) end
    elseif cmd:sub(1, 6) == "flags:" then
        FLAGS = {}
        for f in cmd:sub(7):gmatch("[^,]+") do FLAGS[#FLAGS + 1] = f end
        log("flags set: " .. table.concat(FLAGS, ", "))
    elseif cmd:sub(1, 8) == "classes:" then
        writeFile(CLASSES_FILE, (cmd:sub(9):gsub(",", "\n")))
        readClasses()
        classAddr = {}
        classAddrCount = 0
        log("classes set: " .. table.concat(classes, ", "))
        nextDumpAt = os.time()
    end
end

-- Periodic actor dumps, research only (off unless "scan:on").
local function scheduleDumps()
    if not pawn then pawnSeenAt = nil return end
    local now = os.time()
    if not pawnSeenAt then pawnSeenAt = now; nextDumpAt = now + FIRST_DUMP_S return end
    if scanEnabled and nextDumpAt and now >= nextDumpAt then
        if not propsDone["__subsystems"] then propsDone["__subsystems"] = true; dumpSubsystems() end
        if discoveryCount < MAX_DISCOVERY then
            discoveryCount = discoveryCount + 1
            dumpActors("discovery " .. discoveryCount)
            nextDumpAt = now + DISCOVERY_DUMP_S
        else
            dumpActors("auto")
            nextDumpAt = now + CLASS_DUMP_S
        end
    end
end

-- The overlay (web map window over the game, src\overlay.ps1) starts once the save is loaded, plus a
-- short delay, never at the main menu. It launches hidden; Alt+CapsLock shows/hides it.
local function startOverlay(reason)
    if serverStarted or config.autostart == "0" or config.app_root == "" or not os.execute then return end
    serverStarted = true
    local bat = config.app_root .. (config.autostart == "server" and "server.bat" or "overlay.bat")
    log("starting " .. bat .. " (" .. reason .. ")")
    -- "start x.bat" keeps a cmd /K window open; run it through cmd /c so the window closes with the batch.
    os.execute('start "" /min cmd /c ""' .. bat .. '""')
end

local function scheduleOverlay()
    if serverStarted then return end
    if not pawn then serverStartAt = nil return end
    local now = os.time()
    if not serverStartAt then serverStartAt = now + SERVER_DELAY_S return end
    if now >= serverStartAt then startOverlay("save loaded") end
end

-- Alt+CapsLock: the mod owns the key (UE4SS keybinds work while the game is elevated), the overlay
-- script polls overlay.cmd and shows/hides the window with focus handoff. Before a save is loaded
-- the key does nothing.
local function toggleOverlay()
    ExecuteInGameThread(function()
        if not pawn then log("overlay key ignored: no save loaded yet") return end
        writeFile(OVERLAY_CMD, "toggle")
        startOverlay("key")
    end)
end
local okKey = pcall(function() RegisterKeyBind(Key.CAPS_LOCK, { ModifierKey.ALT }, toggleOverlay) end)
if not okKey then
    log("Key.CAPS_LOCK unavailable, overlay on Alt+F8")
    RegisterKeyBind(Key.F8, { ModifierKey.ALT }, toggleOverlay)
end

RegisterKeyBind(Key.M, { ModifierKey.CONTROL, ModifierKey.SHIFT }, function()
    enabled = not enabled
    if not enabled then writePos('{"live":false}') end
    log("tracking " .. (enabled and "on" or "off"))
end)

RegisterKeyBind(Key.D, { ModifierKey.CONTROL, ModifierKey.SHIFT }, function()
    ExecuteInGameThread(function() dumpActors("key") end)
end)

log("writing " .. OUT .. (#classes > 0 and (", classes: " .. table.concat(classes, ", ")) or ""))
LoopAsync(INTERVAL_MS, function()
    ExecuteInGameThread(function()
        tick = tick + 1
        sample()
        pollCmd()
        pinStep()
        questStep()
        lootStep()
        itemStep()
        scheduleDumps()
        scheduleOverlay()
        if #propsQueue > 0 and tick % PROPS_EVERY_TICKS == 0 then dumpProps(table.remove(propsQueue, 1)) end
    end)
    return false
end)
