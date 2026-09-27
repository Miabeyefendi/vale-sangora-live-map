// Local server for the mirrored map + Chromium app window launcher.
// Serves src/core (UI) and src/assets/data/site (mirrored site paths) and
// persists pin/collected state to src/assets/data/state.json.
// Usage: node src/main.js [--no-browser] [--follow-game]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile, execSync } = require('child_process');

const PORT = +process.env.DW_PORT || 5321;
const UI = path.join(__dirname, 'core');
const SITE = path.join(__dirname, 'assets', 'data', 'site');
const DATA = path.join(__dirname, 'assets', 'data');
const STATE = path.join(DATA, 'state.json');
const OPEN_HOSTS = ['gamerguides.com', 'google.com', 'fandom.com', 'mapgenie.io'];
// Written by the UE4SS Lua mod (src/mod/DawnwalkerMapPos) twice a second.
const MODDIR = path.join(DATA, 'mod'); // exchange folder with the UE4SS mod (inside the project on purpose)
const POS = path.join(MODDIR, 'pos.json');
const DUMP = path.join(MODDIR, 'dump.txt');
const PINS = path.join(MODDIR, 'pins.tsv');        // the game's own map pins, written by the mod
const QUESTS = path.join(MODDIR, 'quests.tsv');    // the quest journal (finished / opened), written by the mod
const QUESTOBJ = path.join(MODDIR, 'questobj.tsv'); // objective pins of finished quests (guid, x, y, z, quest title)
const LOOT = path.join(MODDIR, 'loot.tsv');        // loaded loot containers (name, class, state, x, y, z)
const LOOT_JSON = path.join(DATA, 'loot.json');     // containers merged over sessions (streaming shows only nearby ones)
const OWNED = path.join(MODDIR, 'owned.tsv');      // items in the player's inventory / shrine storage
const CMD = path.join(MODDIR, 'cmd.txt');
const ACTORS = path.join(DATA, 'actors.json');
const MARKERS_TSV = path.join(MODDIR, 'markers.tsv'); // read by the in-game minimap (mod)
const CALIB_TXT = path.join(MODDIR, 'calib.txt');     // world(cm) -> map pixel affine, for the mod
const ACTIONS = path.join(MODDIR, 'actions.txt');     // written by the in-game map: "done <id> 1|0" per line
const BUILD = Math.floor(fs.statSync(__filename).mtimeMs); // a server whose build differs gets replaced

// Actor dumps are partial (world streaming loads what is near the player), so merge them
// by full name over time. Flags keep the latest value seen.
let actors = {};
let actorsVersion = 0;
let dumpMtime = 0;
try { actors = JSON.parse(fs.readFileSync(ACTORS, 'utf8')); } catch { actors = {}; }

function mergeDump() {
  let st;
  try { st = fs.statSync(DUMP); } catch { return; }
  if (st.mtimeMs === dumpMtime) return;
  dumpMtime = st.mtimeMs;
  let text = '';
  try { text = fs.readFileSync(DUMP, 'utf8'); } catch { return; }
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const [cls, name, x, y, z, flags] = line.split('\t');
    if (!cls || !name) continue;
    const f = {};
    (flags || '').split(',').forEach(kv => { const [k, v] = kv.split('='); if (k) f[k] = v === '1'; });
    actors[name] = { cls, x: +x, y: +y, z: +z, flags: f, seen: Date.now() };
    n++;
  }
  if (n) {
    actorsVersion++;
    fs.writeFile(ACTORS, JSON.stringify(actors), () => {});
  }
}
setInterval(mergeDump, 3000);
mergeDump();

// pins.tsv: the game's own map pins (id, type, state, x, y, z, quest, description), rewritten by the
// mod every 15 s. Served through /actors in the same shape as actor dumps (cls = "Pin_<type>",
// flags.completed) so calibration and auto-completion work on them unchanged.
let pins = {};
let pinsMtime = 0;
let pinsText = '';
function mergePins() {
  let st;
  try { st = fs.statSync(PINS); } catch { return; }
  if (st.mtimeMs === pinsMtime) return;
  pinsMtime = st.mtimeMs;
  let text = '';
  try { text = fs.readFileSync(PINS, 'utf8'); } catch { return; }
  if (text === pinsText) return; // rewritten every 15 s, usually unchanged
  pinsText = text;
  const next = {};
  for (const line of text.split(/\r?\n/)) {
    const [id, type, state, x, y, z, quest, desc] = line.split('\t');
    if (!id || !type || type === 'None' || type === 'Player') continue; // the player's own pin and an empty slot
    next['pin:' + id] = { cls: 'Pin_' + type, x: +x, y: +y, z: +z, state, quest: quest === '1', desc: desc || '',
      flags: { completed: /complet/i.test(state || '') }, seen: Date.now() };
  }
  if (Object.keys(next).length) { pins = next; actorsVersion++; }
}
setInterval(mergePins, 3000);
mergePins();

// quests.tsv: guid, state (Active/Success/Failure), type, start x, y, z, title, instance id. Served with
// the pins as cls "Quest_<type>", flags.completed when the quest is over; quests without a cached
// start location cannot be placed and are skipped.
let quests = {};
let questsText = '';
function mergeQuests() {
  let text = '';
  try { text = fs.readFileSync(QUESTS, 'utf8'); } catch { return; }
  if (text === questsText) return;
  questsText = text;
  const next = {};
  for (const line of text.split(/\r?\n/)) {
    const [guid, state, type, x, y, z, title] = line.split('\t');
    if (!guid || !x) continue;
    next['quest:' + guid] = { cls: 'Quest_' + (type || 'Story'), x: +x, y: +y, z: +z, state, desc: title || '',
      flags: { completed: state === 'Success' || state === 'Failure' }, seen: Date.now() };
  }
  quests = next;
  actorsVersion++;
}
setInterval(mergeQuests, 3000);
mergeQuests();

// questobj.tsv: objective pin locations of finished quests; served as cls "QuestObj", completed, so the
// page can complete the loot container the objective pointed at (optional, off by default).
let questObj = {};
let questObjText = '';
function mergeQuestObj() {
  let text = '';
  try { text = fs.readFileSync(QUESTOBJ, 'utf8'); } catch { return; }
  if (text === questObjText) return;
  questObjText = text;
  const next = {};
  for (const line of text.split(/\r?\n/)) {
    const [guid, x, y, z, title] = line.split('\t');
    if (!guid || !x) continue;
    next['questobj:' + guid] = { cls: 'QuestObj', x: +x, y: +y, z: +z, desc: title || '', flags: { completed: true }, seen: Date.now() };
  }
  questObj = next;
  actorsVersion++;
}
// Objective locations grouped by quest title: alternative positions for matching a quest marker.
function questAlternatives() {
  const byTitle = {};
  for (const o of Object.values(questObj)) { if (o.desc) (byTitle[o.desc] = byTitle[o.desc] || []).push([o.x, o.y]); }
  const out = {};
  for (const [k, q] of Object.entries(quests)) { const alt = byTitle[q.desc]; if (alt) out[k] = { ...q, alt: alt.slice(0, 30) }; }
  return { ...quests, ...out };
}
setInterval(mergeQuestObj, 3000);
mergeQuestObj();

// loot.tsv: containers currently loaded around the player; interaction state 1 = looted. Merged by
// actor name over time (world streaming), served as cls "Loot" with flags.completed.
let loot = {};
let lootText = '';
try { loot = JSON.parse(fs.readFileSync(LOOT_JSON, 'utf8')); } catch { loot = {}; }
function mergeLoot() {
  let text = '';
  try { text = fs.readFileSync(LOOT, 'utf8'); } catch { return; }
  if (text === lootText) return;
  lootText = text;
  let changed = false;
  for (const line of text.split(/\r?\n/)) {
    const [name, cls, state, x, y, z] = line.split('\t');
    if (!name || !x) continue;
    const looted = state === '1';
    const prev = loot[name];
    if (prev && (prev.looted === looted || prev.looted)) continue; // looted is sticky: the game never refills
    loot[name] = { cls: 'Loot', kind: cls, x: +x, y: +y, z: +z, looted, flags: { completed: looted }, seen: Date.now() };
    changed = true;
  }
  if (changed) { actorsVersion++; fs.writeFile(LOOT_JSON, JSON.stringify(loot), () => {}); }
}
setInterval(mergeLoot, 3000);
mergeLoot();

// owned.tsv: item id, class, quantity on the player, quantity in storage. Served by /owned; the page
// matches item ids to the site's item markers by name (optional, off by default).
let owned = {};
let ownedText = '';
let ownedVersion = 0;
function mergeOwned() {
  let text = '';
  try { text = fs.readFileSync(OWNED, 'utf8'); } catch { return; }
  if (text === ownedText) return;
  ownedText = text;
  const next = {};
  for (const line of text.split(/\r?\n/)) {
    const [id, cls, player, storage] = line.split('\t');
    if (!id) continue;
    next[id] = { cls, player: +player || 0, storage: +storage || 0 };
  }
  owned = next;
  ownedVersion++;
}
setInterval(mergeOwned, 3000);
mergeOwned();

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { collected: [], pinned: [], notes: {} }; }
}

// markers.tsv: id, map px, py, colour, state (0 open, 1 done, 2 followed), title; for the in-game minimap.
let markersTimer = null;
function writeMarkersTsv() {
  try {
    const md = JSON.parse(fs.readFileSync(path.join(DATA, 'mapdata.json'), 'utf8'));
    const gj = JSON.parse(fs.readFileSync(path.join(SITE, 'map', String(md.map_id), 'geojson'), 'utf8'));
    const st = readState();
    const done = new Set(st.collected || []), pinned = new Set(st.pinned || []);
    // Columns: id, px, py, colour, state, title, icon path, category path, popup json path (mirror-relative).
    const color = {}, catName = {}, catIcon = {};
    md.cats.forEach(c => {
      color[c.marker_cat_id] = c.pin_color || '#666666'; catName[c.marker_cat_id] = c.title; catIcon[c.marker_cat_id] = c.icon || '';
      (c.children || []).forEach(k => {
        color[k.marker_cat_id] = k.pin_color || c.pin_color || '#666666';
        catName[k.marker_cat_id] = c.title + ' / ' + k.title;
        catIcon[k.marker_cat_id] = k.icon || c.icon || '';
      });
    });
    const clean = t => String(t || '').replace(/[\t\r\n]/g, ' ');
    const lines = gj.markers.features.map(f => {
      const p = f.properties, op = p.origPoints && p.origPoints[0];
      if (!op) return null;
      const state = pinned.has(p.markerId) ? 2 : (done.has(p.markerId) ? 1 : 0);
      const icon = (p.customIcon && p.customIcon.path) || catIcon[p.catId] || '';
      const popup = `json/marker_popup/${md.map_id}/${p.markerId}` + (p.item ? '/item' : '');
      const title = clean(p.displayTitle || p.title || (p.item && p.item.title));
      return [p.markerId, op[0], op[1], color[p.catId] || '#666666', state, title, icon, clean(catName[p.catId]), popup].join('\t');
    }).filter(Boolean);
    fs.mkdirSync(MODDIR, { recursive: true });
    fs.writeFileSync(MARKERS_TSV, lines.join('\n') + '\n');
  } catch (e) { console.error('markers.tsv failed', e.message); }
}
function scheduleMarkersTsv() { clearTimeout(markersTimer); markersTimer = setTimeout(writeMarkersTsv, 500); }
writeMarkersTsv();

// actions.txt from the in-game map: "done <id> 0|1" lines are applied to state.json, then markers.tsv is refreshed.
let stateVersion = 0;
function applyActions() {
  let text = '';
  try { text = fs.readFileSync(ACTIONS, 'utf8'); } catch { return; }
  try { fs.unlinkSync(ACTIONS); } catch { /* the mod may be rewriting it */ }
  const st = readState();
  st.collected = st.collected || [];
  let changed = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^done\s+(\d+)\s+([01])$/);
    if (!m) continue;
    const id = +m[1], on = m[2] === '1';
    const has = st.collected.includes(id);
    if (on && !has) { st.collected.push(id); changed = true; }
    if (!on && has) { st.collected = st.collected.filter(x => x !== id); changed = true; }
  }
  if (changed) { fs.writeFileSync(STATE, JSON.stringify(st)); stateVersion++; scheduleMarkersTsv(); }
}
setInterval(applyActions, 1500);
try { const st = readState(); if (st.calibAuto) fs.writeFileSync(CALIB_TXT, ['a', 'b', 'c', 'd', 'e', 'f'].map(k => st.calibAuto[k]).join(' ')); } catch { /* none yet */ }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain', 'Cache-Control': 'no-cache' });
  res.end(body);
}

function serveFile(res, file, cache) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found');
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/json', 'Cache-Control': cache ? 'max-age=86400' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req, cb) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => cb(body));
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url.includes('..')) return send(res, 400, 'bad path');

  if (url === '/state') {
    if (req.method === 'GET') return send(res, 200, JSON.stringify(readState()), 'application/json');
    if (req.method === 'POST') {
      return readBody(req, body => {
        try {
          JSON.parse(body);
          fs.writeFileSync(STATE, body);
          scheduleMarkersTsv();
          send(res, 200, '{"ok":true}', 'application/json');
        } catch { send(res, 400, 'bad json'); }
      });
    }
  }
  if (url === '/version') return send(res, 200, String(BUILD), 'text/plain');
  if (url === '/state-version') return send(res, 200, String(stateVersion), 'text/plain');
  if (url === '/calib' && req.method === 'POST') {
    return readBody(req, body => {
      try {
        const t = JSON.parse(body);
        const vals = ['a', 'b', 'c', 'd', 'e', 'f'].map(k => +t[k]);
        if (vals.some(v => !Number.isFinite(v))) return send(res, 400, 'bad calib');
        fs.mkdirSync(MODDIR, { recursive: true });
        fs.writeFileSync(CALIB_TXT, vals.join(' '));
        send(res, 200, '{"ok":true}', 'application/json');
      } catch { send(res, 400, 'bad json'); }
    });
  }
  if (url === '/owned') {
    return send(res, 200, JSON.stringify({ version: ownedVersion, count: Object.keys(owned).length, items: owned }), 'application/json');
  }
  if (url === '/actors') {
    // Pins replace actor scans once the mod delivers them; actor dumps stay for research.
    const src = Object.keys(pins).length ? { ...pins, ...questAlternatives(), ...questObj, ...loot } : actors;
    return send(res, 200, JSON.stringify({ version: actorsVersion, build: BUILD, count: Object.keys(src).length, pins: Object.keys(pins).length, quests: Object.keys(quests).length, questObj: Object.keys(questObj).length, loot: Object.keys(loot).length, actors: src }), 'application/json');
  }
  if (url === '/cmd' && req.method === 'POST') {
    return readBody(req, body => {
      const cmd = body.trim();
      if (!/^(dump|subsystems|widgets|mapinfo|pins|scan:(on|off)|classes:[A-Za-z0-9_,]+|flags:[A-Za-z0-9_,]+|props:[A-Za-z0-9_]+|funcs:[A-Za-z0-9_./]+)$/.test(cmd)) return send(res, 400, 'bad cmd');
      try { fs.mkdirSync(MODDIR, { recursive: true }); fs.writeFileSync(CMD, cmd); send(res, 200, '{"ok":true}', 'application/json'); }
      catch { send(res, 500, 'write failed'); }
    });
  }
  if (url === '/pos') {
    // Content of pos.json plus its age in ms. The mod rewrites it every 500 ms while the game
    // thread runs; a large age means the game is paused (menu, focus lost) or closed.
    let out = { live: false, age: null };
    try {
      const st = fs.statSync(POS);
      out = JSON.parse(fs.readFileSync(POS, 'utf8'));
      out.age = Math.round(Date.now() - st.mtimeMs);
    } catch { /* mod not installed or never ran */ }
    return send(res, 200, JSON.stringify(out), 'application/json');
  }
  if (url === '/open') {
    // Open an external page in the user's default browser (not the app window).
    const target = new URL(req.url, 'http://x').searchParams.get('url') || '';
    let host = '';
    try { host = new URL(target).hostname; } catch { /* invalid */ }
    if (!/^https:\/\//.test(target) || !OPEN_HOSTS.some(h => host === h || host.endsWith('.' + h))) return send(res, 400, 'not allowed');
    spawn('cmd.exe', ['/c', 'start', '', target], { stdio: 'ignore', detached: true }).unref();
    return send(res, 200, '{"ok":true}', 'application/json');
  }
  if (url === '/mapdata.json') return serveFile(res, path.join(DATA, 'mapdata.json'));
  // Community map imports (src/services/import-*.js): merged into the marker list by the page.
  const extra = url.match(/^\/extra\/([a-z0-9-]+\.json)$/);
  if (extra) return serveFile(res, path.join(DATA, 'extra', extra[1]));
  if (url === '/' || url === '/index.html') return serveFile(res, path.join(UI, 'index.html'));

  const ui = path.join(UI, url);
  if (fs.existsSync(ui) && fs.statSync(ui).isFile()) return serveFile(res, ui);
  return serveFile(res, path.join(SITE, url), true);
});

function findBrowser() {
  const candidates = [
    process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    process.env['PROGRAMFILES'] + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find(p => fs.existsSync(p));
}

// --follow-game: exit when the game process is gone (the mod starts us without a window to close).
if (process.argv.includes('--follow-game')) {
  let graceUntil = Date.now() + 90000;
  setInterval(() => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Dawnwalker.exe', '/NH'], (err, out) => {
      if (err) return;
      const running = /Dawnwalker\.exe/i.test(out);
      if (running) graceUntil = 0;
      else if (graceUntil === 0 || Date.now() > graceUntil) { console.log('game closed, exiting'); process.exit(0); }
    });
  }, 10000);
}

// Port already taken: an older server may still be running (it stays alive across game sessions
// when nothing closes it). Replace it if its build differs, otherwise leave it and exit.
let retried = false;
server.on('error', async err => {
  if (err.code !== 'EADDRINUSE' || retried) { console.error(err); process.exit(1); }
  retried = true;
  let running = '';
  try { running = await (await fetch(`http://127.0.0.1:${PORT}/version`)).text(); } catch { /* not ours */ }
  if (running.trim() === String(BUILD)) { console.log('server already running (same build)'); process.exit(0); }
  try {
    const rows = execSync('netstat -ano -p tcp', { encoding: 'utf8' }).split(/\r?\n/)
      .filter(l => l.includes(`127.0.0.1:${PORT}`) && /LISTENING/.test(l));
    const pids = [...new Set(rows.map(l => l.trim().split(/\s+/).pop()))];
    pids.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch { /* no rights */ } });
    console.log('replaced stale server ' + pids.join(','));
  } catch { /* nothing to do */ }
  setTimeout(() => server.listen(PORT, '127.0.0.1'), 1200);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log('Dawnwalker map: ' + url);
  if (process.argv.includes('--no-browser') || process.argv.includes('--follow-game')) return;
  const browser = findBrowser();
  if (!browser) { console.log('Chrome/Edge not found, open the URL manually.'); return; }
  const profile = path.join(process.env['LOCALAPPDATA'] || DATA, 'DawnwalkerMap');
  // The profile is ours alone; drop its HTTP cache so UI changes are never stale.
  for (const dir of ['Cache', 'Code Cache']) fs.rmSync(path.join(profile, 'Default', dir), { recursive: true, force: true });
  const child = spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1600,950', '--disable-features=Translate'], { stdio: 'ignore' });
  child.on('exit', () => { server.close(); process.exit(0); });
});
