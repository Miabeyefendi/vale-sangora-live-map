'use strict';
// Automatic calibration and completion from the game's own map pins (see src/mod; /actors serves
// them as cls "Pin_<type>" with flags.completed, or legacy actor dumps when no pins exist yet).
// Calibration: no names needed. For each (pin type, marker category) pair with similar sizes,
// try the 8 axis-aligned orientations, scale by spread, then ICP with a similarity fit.
// The pair with the most inliers wins. Manual "Buradayim" points (3+) always take precedence.
// Completion: a pin the game reports as completed marks the matching site marker collected.
// The matching category of each pin type is learned by majority vote once calibrated.

const AUTO_POLL_MS = 5000;
const DONE_FLAGS = ['completed', 'bOpened', 'bIsOpened', 'bIsOpen', 'bLooted', 'bIsLooted', 'bWasLooted', 'bActivated',
  'bIsActivated', 'bDiscovered', 'bIsDiscovered', 'bUnlocked', 'bIsUnlocked', 'bCollected', 'bIsCollected', 'bUsed',
  'bIsUsed', 'bCompleted', 'bIsCompleted', 'bVisited', 'bInteracted', 'bHasBeenInteracted', 'bIsEmpty', 'bDepleted'];
const LEARN_PX = 60;        // a pin votes for the category of the nearest marker within this distance
const MATCH_PX = 80;        // completed pin -> marker of the learned category within this distance
const MATCH_QUEST_PX = 500; // the site puts a quest marker where the quest happens, up to ~130 m from its start spot
const MATCH_ANY_PX = 40;    // no learned category: nearest marker of any category within this distance
const MATCH_ALT_PX = 300;   // quest marker found through one of the quest's objective locations
const LOOT_ITEM_PX = 45;    // an item marker within this of its NEAREST loaded container was inside it (~12 m)
let actorsSeenVersion = -1;
let serverBuild = null;
let actorsAll = {};
let autoResult = null;      // { t, cls, catId, inliers, err, n, m }
let autoBusy = false;
let typeCat = {};           // pin type (cls) -> majority category id

const autoEnabled = () => localStorage.getItem('autoComplete') !== '0';
// Per-source switches (localStorage): places (POI pins), quests (journal + objectives), quest loot (off by default).
const AUTO_OPTS = { 'auto-poi': ['autoPoi', true], 'auto-quest': ['autoQuest', true], 'auto-chest': ['autoChest', true], 'auto-loot': ['autoLoot', false], 'auto-item': ['autoItem', false] };
const optOn = key => { const v = localStorage.getItem(key); return v === null ? AUTO_OPTS[Object.keys(AUTO_OPTS).find(k => AUTO_OPTS[k][0] === key)][1] : v !== '0'; };

function markerPixels(catId) {
  const out = [];
  markersData.features.forEach(f => {
    if (catId && f.properties.catId !== catId) return;
    const op = byId.get(f.id).properties.origPoints;
    if (op && op[0]) out.push({ id: f.id, x: op[0][0], y: op[0][1], catId: f.properties.catId });
  });
  return out;
}

let calibWorker = null;
let calibBusy = false;

function runAutoCalib() {
  if (calibBusy) return;
  const byClass = {};
  Object.values(actorsAll).forEach(a => {
    if (a.quest || a.cls === 'QuestObj' || a.cls === 'Loot') return; // objectives move; containers are partial
    (byClass[a.cls] = byClass[a.cls] || []).push({ x: a.x, y: a.y });
  });
  const cats = Object.keys(flat).map(id => ({ id, pts: markerPixels(id) })).filter(c => c.pts.length >= 4);
  if (!calibWorker) {
    calibWorker = new Worker('calib-core.js');
    calibWorker.onmessage = e => {
      calibBusy = false;
      if (e.data) autoResult = e.data;
      updateCalInfo();
      runAutoComplete();
    };
    calibWorker.onerror = () => { calibBusy = false; };
  }
  calibBusy = true;
  calibWorker.postMessage({ byClass, cats, prev: autoResult, budgetMs: 40000 });
}

// Markers a pin type may land on. Camps and nests are full of chests, so a POI pin must only look
// at activity / landmark markers, a vendor pin at vendor markers; otherwise the nearest chest wins.
const parentOfMarker = m => ((flat[parentOf[m.catId]] || {}).title || '').trim();
function poolFor(cls, all) {
  if (/^Pin_(NanoPoi|FastTravel|House|Village|TimeSkip|Pillory)/.test(cls)) return all.filter(m => ['Activities', 'Landmarks'].includes(parentOfMarker(m)));
  if (/^Pin_NPC/.test(cls)) return all.filter(m => parentOfMarker(m) === 'Vendors');
  return all;
}

// Which site category each pin type lands on: majority of nearest markers within LEARN_PX.
function learnTypeCats(all) {
  const votes = {};
  const pools = {};
  for (const a of Object.values(actorsAll)) {
    if (a.quest || a.cls === 'QuestObj' || a.cls === 'Loot') continue;
    const pool = pools[a.cls] || (pools[a.cls] = poolFor(a.cls, all));
    const { p: m, d } = nearest(applyT(calib, { x: a.x, y: a.y }), pool);
    if (!m || d > LEARN_PX) continue;
    const v = votes[a.cls] = votes[a.cls] || {};
    v[m.catId] = (v[m.catId] || 0) + 1;
  }
  typeCat = {};
  for (const [cls, v] of Object.entries(votes)) {
    const [catId, n] = Object.entries(v).sort((x, y) => y[1] - x[1])[0];
    const total = Object.values(v).reduce((s, k) => s + k, 0);
    if (n >= 2 && n * 2 > total) typeCat[cls] = catId;
  }
}

function runAutoComplete() {
  if (!autoEnabled() || !calib) return;
  state.autoDone = state.autoDone || [];
  const all = markerPixels(null);
  learnTypeCats(all);
  const byCat = {};
  all.forEach(m => { (byCat[m.catId] = byCat[m.catId] || []).push(m); });
  const parentTitle = id => (flat[parentOf[id]] || {}).title;
  const journalMarkers = all.filter(m => parentTitle(m.catId) === 'Journal' && flat[m.catId].title !== 'Quest Objective');
  const poiMarkers = all.filter(m => parentTitle(m.catId) === 'Activities' || parentTitle(m.catId) === 'Landmarks');
  let added = 0;
  const wantPoi = optOn('autoPoi'), wantQuest = optOn('autoQuest'), wantLoot = optOn('autoLoot'), wantChest = optOn('autoChest');
  const lootMarkers = all.filter(m => parentTitle(m.catId) === 'Loot');
  // Items the site places at the chest that holds them (books, amulets, armour...): a looted
  // container completes those within a few metres as well.
  const ITEM_PARENTS = ['Books', 'Items', 'Accessories', 'Armour', 'Weaponry', 'Manuals and Recipes', 'Perks', 'Miscellaneous'];
  const itemMarkers = all.filter(m => ITEM_PARENTS.includes((parentTitle(m.catId) || '').trim()));
  // Ambient junk containers (BP_ALC_*: sacks, barrels, crates) are not what the site maps; they must
  // not claim an item marker away from the real chest next to it.
  const isChest = x => !/^BP_ALC_/.test(x.kind || '');
  const containers = Object.values(actorsAll).filter(x => x.cls === 'Loot' && isChest(x)).map(x => ({ a: x, p: applyT(calib, { x: x.x, y: x.y }) }));
  const nearestContainer = mk => {
    let best = null, bd = Infinity;
    for (const c of containers) { const d = Math.hypot(c.p.x - mk.x, c.p.y - mk.y); if (d < bd) { bd = d; best = c.a; } }
    return best;
  };
  // autoDone only records the source; a marker the user undid by hand is in autoUndone and stays
  // undone. Anything else the game reports as done is (re)marked, which also repairs lost saves.
  const undone = new Set(state.autoUndone || []);
  const markDone = m => {
    if (isCollected(m.id) || undone.has(m.id)) return false;
    if (!state.autoDone.includes(m.id)) state.autoDone.push(m.id);
    state.collected.push(m.id);
    const f = markersData.features.find(x => x.id === m.id);
    if (f) f.properties.collected = true;
    return true;
  };
  for (const a of Object.values(actorsAll)) {
    if (!DONE_FLAGS.some(k => a.flags && a.flags[k] === true)) continue;
    const q = applyT(calib, { x: a.x, y: a.y });
    let m, d, limit;
    if (a.cls === 'Loot') {
      // A looted container (interaction disabled in the game): the site's chest marker within 40 px
      // is done, and so is every item marker whose nearest loaded container this one is (within
      // 45 px). Dense areas: an item goes with the closest chest only.
      if (!wantChest || !isChest(a)) continue;
      const dist = mk => Math.hypot(mk.x - q.x, mk.y - q.y);
      for (const mk of lootMarkers) if (dist(mk) <= MATCH_ANY_PX && markDone(mk)) added++;
      for (const mk of itemMarkers) {
        const d0 = dist(mk);
        if (d0 > LOOT_ITEM_PX || nearestContainer(mk) !== a) continue;
        if (markDone(mk)) added++;
      }
      continue;
    } else if (a.cls === 'QuestObj') {
      // Objective pin of a finished quest sitting on a loot container: the quest's chest.
      if (!wantLoot) continue;
      ({ p: m, d } = nearest(q, lootMarkers));
      limit = MATCH_ANY_PX;
    } else if (a.cls.startsWith('Quest_')) {
      if (!wantQuest) continue;
      // Journal quests: story quests sit on the site's Quests / Court markers, NanoPOI quests on the
      // activity or landmark they belong to (never on loot, which may just be nearby).
      const pool = a.cls === 'Quest_NanoPOI' ? poiMarkers : journalMarkers;
      ({ p: m, d } = nearest(q, pool));
      limit = a.cls === 'Quest_NanoPOI' ? MATCH_PX : MATCH_QUEST_PX;
      // The site may put the quest marker at one of its objectives instead of the start spot.
      if (a.alt && (!m || d > MATCH_ALT_PX)) {
        for (const [ax, ay] of a.alt) {
          const r = nearest(applyT(calib, { x: ax, y: ay }), pool);
          if (r.p && r.d <= MATCH_ALT_PX && (!m || r.d < d)) { m = r.p; d = r.d; limit = MATCH_ALT_PX; }
        }
      }
    } else {
      if (!wantPoi) continue;
      const cat = typeCat[a.cls];
      ({ p: m, d } = cat ? nearest(q, byCat[cat] || []) : nearest(q, poolFor(a.cls, all)));
      limit = cat ? MATCH_PX : MATCH_ANY_PX;
    }
    if (!m || d > limit) continue;
    if (markDone(m)) added++;
  }
  // A finished quest finishes its objectives: "Quest Objective" markers carry the quest's title
  // (or "<title>: <step>"), so every collected Quests / Court marker completes them too.
  const titleOf = m => String(m.properties.displayTitle || m.properties.title || '').trim();
  const doneQuestTitles = new Set(markersData.features
    .filter(f => f.properties.collected && parentTitle(f.properties.catId) === 'Journal' && flat[f.properties.catId].title !== 'Quest Objective')
    .map(titleOf).filter(Boolean));
  for (const f of markersData.features) {
    if (!wantQuest) break;
    if (f.properties.collected || (flat[f.properties.catId] || {}).title !== 'Quest Objective') continue;
    const t = titleOf(f);
    const quest = doneQuestTitles.has(t) ? t : [...doneQuestTitles].find(q => t.startsWith(q + ':'));
    if (!quest || undone.has(f.id)) continue;
    if (!state.autoDone.includes(f.id)) state.autoDone.push(f.id);
    state.collected.push(f.id);
    f.properties.collected = true;
    added++;
  }
  if (added) {
    const src = map.getSource('markers');
    if (src) src.setData(markersData);
    refreshCounts();
    renderPinned();
    saveState();
  }
  updateAutoInfo();
}

function updateAutoInfo() {
  const el = $('auto-info');
  if (!el) return;
  const list = Object.values(actorsAll);
  const n = list.length;
  const done = (state.autoDone || []).length;
  const completed = list.filter(a => a.flags && a.flags.completed).length;
  const quests = list.filter(a => a.cls.startsWith('Quest_')).length;
  const objs = list.filter(a => a.cls === 'QuestObj').length;
  const chests = list.filter(a => a.cls === 'Loot');
  const lootedChests = chests.filter(a => a.looted).length;
  // the info icon next to "Aciklama" carries the numbers as its tooltip
  el.dataset.tip = !n ? t('autoInfoWait') : t('autoInfo', n - quests - objs - chests.length, quests, chests.length, completed - objs - lootedChests, lootedChests, done);
}

// Owned items (inventory + shrine storage) -> site item markers with the same name. The game's item
// ids read like "POI124_CollectorsPendant"; the site says "Collector's Pendant". Both are reduced to
// letters and digits, the id's numeric prefix dropped, then compared for equality or containment.
let ownedSeenVersion = -1;
let ownedItems = {};
const normName = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const idKeys = id => {
  const bare = id.replace(/^[A-Za-z]*\d+[A-Za-z0-9]*_/, '');
  return [normName(id), normName(bare)].filter(k => k.length >= 6);
};
function runItemComplete() {
  if (!autoEnabled() || !optOn('autoItem')) return;
  state.autoDone = state.autoDone || [];
  const keys = new Set();
  Object.keys(ownedItems).forEach(id => idKeys(id).forEach(k => keys.add(k)));
  if (!keys.size) return;
  const parentTitle = id => ((flat[parentOf[id]] || {}).title || '').trim();
  const ITEM_PARENTS = ['Books', 'Items', 'Accessories', 'Armour', 'Weaponry', 'Manuals and Recipes', 'Perks', 'Miscellaneous'];
  let added = 0;
  for (const f of markersData.features) {
    const p = f.properties;
    if (p.collected || !ITEM_PARENTS.includes(parentTitle(p.catId))) continue;
    const n = normName(p.displayTitle || p.title || (p.item && p.item.title));
    if (n.length < 8) continue; // generic names ("Chest", "Key") would match anything
    let hit = keys.has(n);
    if (!hit) for (const k of keys) { if (k.includes(n) || n.includes(k)) { hit = true; break; } }
    if (!hit || (state.autoUndone || []).includes(f.id)) continue;
    if (!state.autoDone.includes(f.id)) state.autoDone.push(f.id);
    state.collected.push(f.id);
    p.collected = true;
    added++;
  }
  if (added) {
    const src = map.getSource('markers');
    if (src) src.setData(markersData);
    refreshCounts();
    renderPinned();
    saveState();
  }
}

async function pollOwned() {
  try {
    const r = await fetch('/owned').then(x => x.json());
    if (r.version !== ownedSeenVersion) {
      ownedSeenVersion = r.version;
      ownedItems = r.items || {};
      runItemComplete();
    }
  } catch { /* server gone */ }
}

async function pollActors() {
  if (autoBusy) return;
  autoBusy = true;
  try {
    const r = await fetch('/actors').then(x => x.json());
    // A replaced server (new build) means new UI files too: reload once instead of running stale code.
    if (r.build) {
      if (serverBuild && r.build !== serverBuild) { location.reload(); return; }
      serverBuild = r.build;
    }
    if (r.version !== actorsSeenVersion) {
      actorsSeenVersion = r.version;
      actorsAll = r.actors || {};
      updateAutoInfo();
      runAutoCalib();    // completion follows in the worker callback
    }
  } catch { /* server gone */ }
  autoBusy = false;
}

document.addEventListener('DOMContentLoaded', () => {
  const cb = $('auto-complete');
  if (cb) {
    cb.checked = autoEnabled();
    cb.addEventListener('change', () => { localStorage.setItem('autoComplete', cb.checked ? '1' : '0'); runAutoComplete(); });
  }
  Object.entries(AUTO_OPTS).forEach(([id, [key]]) => {
    const el = $(id);
    if (!el) return;
    el.checked = optOn(key);
    el.addEventListener('change', () => { localStorage.setItem(key, el.checked ? '1' : '0'); runAutoComplete(); if (id === 'auto-item') runItemComplete(); });
  });
});
setTimeout(() => { pollActors(); setInterval(pollActors, AUTO_POLL_MS); }, 4000);
setTimeout(() => { pollOwned(); setInterval(pollOwned, AUTO_POLL_MS * 3); }, 6000);
