'use strict';

const MAP_ID = 496;
const LAYER_ID = 804;
const PER_PIXEL = 360 / 67108864; // degrees per native pixel (256 * 2^18 world)
const PIN_LAYERS = ['pin-circle', 'pin-icon'];
// Pinned: always full. Collected: faded. Others: slightly transparent when zoomed out.
const opacityAt = (base, fadeDone) => ['case', ['get', 'pinned'], 1, ['get', 'collected'], fadeDone ? 0.3 : base, base];
const pinOpacity = fadeDone => ['interpolate', ['linear'], ['zoom'], 12, opacityAt(0.8, fadeDone), 15, opacityAt(0.9, fadeDone), 17, opacityAt(1, fadeDone)];
const PIN_OPACITY = pinOpacity(true);

let map, mapData, gj, state;
const flat = {};      // catId -> category
const parentOf = {};  // sub catId -> parent catId
const byId = new Map(); // markerId -> original feature
let markersData;      // FeatureCollection rendered on the map
let visible = new Set();
let doneMode = 'faded'; // completed markers: 'faded' (30% opacity), 'hide', 'only' (nothing else)
let currentId = null;
let saveTimer = null;
let hoverPopup = null;
let calib = null;     // affine world(cm) -> map pixel, from state.calibPoints
let lastPos = null;   // last /pos payload

const $ = (sel, q) => q ? document.querySelector(sel) : document.getElementById(sel);
const toLngLat = (x, y) => [x * PER_PIXEL, -y * PER_PIXEL];
const titleOf = p => p.displayTitle || p.title || (p.item && p.item.title) || 'Marker';
const catPath = catId => {
  const sub = flat[catId];
  if (!sub) return '';
  const par = flat[parentOf[catId]];
  return par ? `${par.title} / ${sub.title}` : sub.title;
};

/* ---------- state ---------- */

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) })
      .catch(() => console.error('state save failed'));
  }, 300);
}

function saveFilters() {
  localStorage.setItem('filters', JSON.stringify({ visible: [...visible], doneMode }));
}

const isCollected = id => state.collected.includes(id);
const isPinned = id => state.pinned.includes(id);

function setCollected(id, on) {
  state.collected = state.collected.filter(x => x !== id);
  if (on) state.collected.push(id);
  // Undoing an automatic completion by hand is remembered so the scan does not put it back.
  state.autoUndone = (state.autoUndone || []).filter(x => x !== id);
  if (!on && (state.autoDone || []).includes(id)) state.autoUndone.push(id);
  syncFeature(id);
  saveState();
}

function setPinned(id, on) {
  state.pinned = state.pinned.filter(x => x !== id);
  if (on) state.pinned.push(id);
  syncFeature(id);
  saveState();
}

function syncFeature(id) {
  const f = markersData.features.find(x => x.id === id);
  if (f) { f.properties.collected = isCollected(id); f.properties.pinned = isPinned(id); }
  const src = map && map.getSource('markers');
  if (src) src.setData(markersData);
  refreshCounts();
  renderPinned();
  if (currentId === id) refreshDetailButtons();
}

/* ---------- boot ---------- */

async function boot() {
  let extra;
  [mapData, gj, state, extra] = await Promise.all([
    fetch('/mapdata.json').then(r => r.json()),
    fetch(`/map/${MAP_ID}/geojson`).then(r => r.json()),
    fetch('/state').then(r => r.json()),
    fetch('/extra/mapgenie.json').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (extra) mergeExtra(extra);
  state.collected = state.collected || [];
  state.pinned = state.pinned || [];
  state.notes = state.notes || {};
  state.subItems = state.subItems || [];
  state.calibPoints = state.calibPoints || [];
  calib = solveCalib(state.calibPoints) || (state.calibAuto && Number.isFinite(state.calibAuto.a) ? state.calibAuto : null);

  mapData.cats.forEach(c => {
    flat[c.marker_cat_id] = c;
    (c.children || []).forEach(s => { flat[s.marker_cat_id] = s; parentOf[s.marker_cat_id] = c.marker_cat_id; });
  });

  const saved = JSON.parse(localStorage.getItem('filters') || 'null');
  visible = new Set(saved ? saved.visible : Object.keys(flat));
  doneMode = saved ? (saved.doneMode || (saved.hideCollected ? 'hide' : 'faded')) : 'faded';
  renderDoneMode();

  buildMarkers();
  buildCats();
  renderPinned();
  refreshCounts();
  bindUi();
  await buildMap();
}

// Markers another community map has and ours lacks (src/services/import-mapgenie.js). Known
// categories get the extra markers directly; unknown ones go under a "MapGenie" group whose icons
// are borrowed from the closest category of ours.
function mergeExtra(extra) {
  // A category we do not have becomes a child of the parent it belongs to (Vendors / Food Vendor,
  // Items / Legendary Equipment, Loot / Hidden Treasure, Enemies / Headhunters...), with the
  // parent's icon and colour, so imported markers sit in the same tree as everything else.
  const parentFor = c => {
    if (/Treasure/i.test(c.title)) return 'Loot';
    if (/Headhunter/i.test(c.title)) return 'Enemies';
    if (/Equipment/i.test(c.title)) return 'Items';
    if (/Egg/i.test(c.title)) return 'Miscellaneous';
    return { Vendors: 'Vendors', Activities: 'Activities', Items: 'Items', Landmarks: 'Landmarks', Other: 'Miscellaneous' }[c.group] || 'Landmarks';
  };
  (extra.categories || []).forEach(c => {
    const par = mapData.cats.find(x => x.title.trim() === parentFor(c)) || mapData.cats[0];
    par.children = par.children || [];
    par.children.push({ marker_cat_id: c.id, title: c.title, icon: par.icon, pin_color: par.pin_color, parent: par.marker_cat_id });
  });
  (extra.markers || []).forEach(m => {
    gj.markers.features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: toLngLat(m.px, m.py) },
      properties: {
        markerId: m.id, catId: m.catId, title: m.title, displayTitle: m.title, origPoints: [[m.px, m.py]],
        source: m.source, extraDescription: m.description || '', mgCategory: m.mgCategory,
        data: { links: [{ title: 'MapGenie', url: `https://mapgenie.io/the-blood-of-dawnwalker/maps/vale-sangora?locationIds=${m.id - 9000000}` }] },
      },
    });
  });
}

function buildMarkers() {
  markersData = {
    type: 'FeatureCollection',
    features: gj.markers.features.map(f => {
      const p = f.properties;
      byId.set(p.markerId, f);
      const par = flat[parentOf[p.catId]];
      const own = flat[p.catId];
      return {
        type: 'Feature',
        id: p.markerId,
        geometry: f.geometry,
        properties: {
          markerId: p.markerId,
          catId: p.catId,
          title: titleOf(p),
          search: (p.searchTitle || titleOf(p)).toLowerCase(),
          icon: (p.customIcon && p.customIcon.path) || (own && own.icon) || '',
          pinColor: (own && own.pin_color) || (par && par.pin_color) || '#666666',
          collected: isCollected(p.markerId),
          pinned: isPinned(p.markerId),
        },
      };
    }),
  };
}

/* ---------- map ---------- */

async function buildMap() {
  const z18 = await fetch(`/assets/maps/${MAP_ID}/${LAYER_ID}/18/60-60.png`, { method: 'HEAD' }).then(r => r.ok).catch(() => false);
  const w = mapData.width * PER_PIXEL, h = mapData.height * PER_PIXEL;

  map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': mapData.bgcolor || '#1c1414' } }] },
    center: toLngLat(mapData.focus_x, mapData.focus_y),
    zoom: mapData.focus_zoom || 13,
    minZoom: 11.5,
    maxZoom: 19,
    maxBounds: [[-0.03, -h - 0.03], [w + 0.03, 0.03]],
    renderWorldCopies: false,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    transformRequest: url => {
      const m = url.match(/\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
      if (!m) return { url };
      const z = +m[1], off = 2 ** (z - 1);
      return { url: `${location.origin}/assets/maps/${MAP_ID}/${LAYER_ID}/${z}/${+m[2] - off}-${+m[3] - off}.png` };
    },
  });
  map.touchZoomRotate.disableRotation();
  setZoomAround($('follow-me').checked); // setFollow ran before the map existed
  map.on('zoomend', () => { if ($('follow-me').checked) centerOnPlayer(false); });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  map.on('load', async () => {
    map.addSource('tiles', {
      type: 'raster',
      tiles: [`${location.origin}/tiles/{z}/{x}/{y}.png`],
      tileSize: mapData.tile_size || 256,
      minzoom: 12,
      maxzoom: z18 ? 18 : 17,
      bounds: [0, -h, w, 0],
    });
    map.addLayer({ id: 'tiles', type: 'raster', source: 'tiles' });

    await loadIcons();
    buildLabels();

    map.addSource('markers', { type: 'geojson', data: markersData });
    map.addLayer({
      id: 'pin-ring', type: 'circle', source: 'markers',
      filter: ['==', ['get', 'pinned'], true],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 8, 14, 12, 17, 22],
        'circle-color': 'rgba(255,213,74,0.25)',
        'circle-stroke-color': '#ffd54a',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 17, 3],
      },
    });
    map.addLayer({
      id: 'pin-circle', type: 'circle', source: 'markers',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 14, 7, 17, 15],
        'circle-color': ['get', 'pinColor'],
        'circle-stroke-color': '#0b0806',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 17, 1.5],
        'circle-opacity': PIN_OPACITY,
        'circle-stroke-opacity': PIN_OPACITY,
      },
    });
    map.addLayer({
      id: 'pin-icon', type: 'symbol', source: 'markers',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.05, 14, 0.09, 17, 0.19],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': PIN_OPACITY },
    });
    applyFilter();
    addPlayerLayers();

    setFollow($('follow-me').checked);
    map.on('mousemove', onHover);
    map.on('click', onClick);
    map.on('contextmenu', onRightClick);
    map.getContainer().addEventListener('contextmenu', e => e.preventDefault());
  });
}

/* ---------- live position (UE4SS mod) ---------- */

function addPlayerLayers() {
  // Arrow icon drawn on a canvas, points up; rotated by heading at render time.
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.translate(32, 32); g.beginPath(); g.moveTo(0, -26); g.lineTo(18, 22); g.lineTo(0, 12); g.lineTo(-18, 22); g.closePath();
  g.fillStyle = '#4fc3f7'; g.fill(); g.lineWidth = 4; g.strokeStyle = '#04263a'; g.stroke();
  map.addImage('player-arrow', g.getImageData(0, 0, 64, 64), { pixelRatio: 2 });
  map.addSource('player', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'player-ring', type: 'circle', source: 'player',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 14, 17, 30], 'circle-color': 'rgba(79,195,247,0.18)', 'circle-stroke-color': '#4fc3f7', 'circle-stroke-width': 2 },
  });
  map.addLayer({
    id: 'player-arrow', type: 'symbol', source: 'player',
    layout: { 'icon-image': 'player-arrow', 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 17, 1.1], 'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
  });
  setInterval(pollPos, 500);
  updateCalInfo();
}

// Least-squares affine fit: px = a*x + b*y + c, py = d*x + e*y + f. Needs 3+ points.
function solveCalib(points) {
  if (!points || points.length < 3) return null;
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], rx = [0, 0, 0], ry = [0, 0, 0];
  points.forEach(({ wx, wy, px, py }) => {
    const v = [wx, wy, 1];
    for (let i = 0; i < 3; i++) { rx[i] += v[i] * px; ry[i] += v[i] * py; for (let j = 0; j < 3; j++) M[i][j] += v[i] * v[j]; }
  });
  const A = solve3(M, rx), B = solve3(M, ry);
  if (!A || !B) return null;
  const t = { a: A[0], b: A[1], c: A[2], d: B[0], e: B[1], f: B[2] };
  t.err = Math.sqrt(points.reduce((sum, q) => { const [x, y] = worldToPixel(q.wx, q.wy, t); return sum + (x - q.px) ** 2 + (y - q.py) ** 2; }, 0) / points.length);
  return t;
}

function solve3(M, r) {
  const m = M.map((row, i) => [...row, r[i]]);
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[piv][i])) piv = k;
    [m[i], m[piv]] = [m[piv], m[i]];
    if (Math.abs(m[i][i]) < 1e-9) return null;
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = m[k][i] / m[i][i];
      for (let j = i; j < 4; j++) m[k][j] -= f * m[i][j];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

const worldToPixel = (x, y, t) => [t.a * x + t.b * y + t.c, t.d * x + t.e * y + t.f];

async function pollPos() {
  let p = null;
  try { p = await fetch('/pos').then(r => r.json()); } catch { p = null; }
  // A position stays on the map until the game has clearly gone (file untouched for 10 minutes).
  const fresh = !!(p && p.live && p.age !== null && p.age < 5000);
  if (p && p.live && p.age < 600000) lastPos = p;
  else if (!p || p.age === null || p.age >= 600000) lastPos = null;
  const live = !!(lastPos && lastPos.live);
  const st = $('pos-status');
  if (fresh) st.innerHTML = `<b>X:</b> ${Math.round(p.x)}<i>|</i><b>Y:</b> ${Math.round(p.y)}`;
  else if (live) st.textContent = t('paused');
  else if (p && p.age !== null && p.age < 5000) st.textContent = t('waitingSave');
  else if (p && p.age !== null) st.textContent = t('gameClosed');
  else st.textContent = t('noMod');
  st.classList.toggle('live', fresh);
  $('btn-here').disabled = !(fresh && currentId);
  $('cal-hint').hidden = !(live && !calib && !(typeof actorsAll !== 'undefined' && Object.keys(actorsAll).length));
  const src = map.getSource('player');
  if (!src) return;
  if (!live || !calib) { src.setData({ type: 'FeatureCollection', features: [] }); return; }
  const [px, py] = worldToPixel(lastPos.x, lastPos.y, calib);
  // Heading: rotate the UE forward vector through the linear part of the fit.
  const yaw = (lastPos.yaw || 0) * Math.PI / 180;
  const fx = Math.cos(yaw), fy = Math.sin(yaw);
  const hx = calib.a * fx + calib.b * fy, hy = calib.d * fx + calib.e * fy;
  const heading = Math.atan2(hy, hx) * 180 / Math.PI + 90;
  const coords = toLngLat(px, py);
  // Redraw only on real change: turning in place touches the arrow, not the map view.
  const last = pollPos.last || {};
  const moved = Math.hypot(px - (last.px || 0), py - (last.py || 0));
  if (moved > 0.5 || Math.abs(heading - (last.heading || 0)) > 2) {
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: { heading } }] });
    pollPos.last = { px, py, heading };
  }
  if ($('follow-me').checked) {
    // The player sits on the exact centre pixel of the map: no easing, the view is set outright.
    if (!pollPos.centered) { pollPos.centered = true; map.jumpTo({ center: coords, zoom: Math.max(map.getZoom(), 15) }); }
    else if (moved > 0.5) map.jumpTo({ center: coords });
  }
}

function addCalibPoint() {
  if (!currentId || !lastPos || !lastPos.live) return;
  const f = byId.get(currentId);
  const [px, py] = f.properties.origPoints[0];
  state.calibPoints = state.calibPoints.filter(q => q.markerId !== currentId);
  state.calibPoints.push({ markerId: currentId, title: titleOf(f.properties), wx: lastPos.x, wy: lastPos.y, px, py });
  calib = solveCalib(state.calibPoints);
  saveState();
  updateCalInfo();
}

// Re-calibration: drop manual points and the stored automatic fit, then let the game pins find it again.
function resetCalib() {
  if (!confirm(t('recalConfirm'))) return;
  state.calibPoints = [];
  delete state.calibAuto;
  calib = null;
  if (typeof autoResult !== 'undefined') autoResult = null;
  saveState();
  updateCalInfo();
  if (typeof runAutoCalib === 'function') runAutoCalib();
}

let pushedCalib = '';
// Hand the transform to the mod (in-game minimap) and keep it in state for the next start.
function pushCalib(t) {
  const key = ['a', 'b', 'c', 'd', 'e', 'f'].map(k => t[k].toPrecision(8)).join(' ');
  if (key === pushedCalib) return;
  pushedCalib = key;
  state.calibAuto = { a: t.a, b: t.b, c: t.c, d: t.d, e: t.e, f: t.f };
  saveState();
  fetch('/calib', { method: 'POST', body: JSON.stringify(state.calibAuto) }).catch(() => {});
}

function updateCalInfo() {
  const n = state.calibPoints.length;
  const el = $('cal-info');
  const manual = solveCalib(state.calibPoints);
  const auto = (typeof autoResult !== 'undefined') ? autoResult : null;
  if (!manual && auto) calib = auto.t;
  el.classList.toggle('ok', !!calib);
  if (calib) pushCalib(calib);
  // one short badge on the line, the full sentence as tooltip
  // error in metres: the fit's scale is px per cm, so 1 px = 1 / (100 * scale) m
  const pxToM = (tr, px) => { const sc = Math.hypot(tr.a, tr.d) || 0.0378; return Math.max(1, Math.round(px / sc / 100)); };
  if (manual) { el.textContent = t('calManual', n, pxToM(manual, manual.err)); el.title = state.calibPoints.map(q => q.title).join(', '); }
  else if (auto) { el.textContent = t('calAuto', (flat[auto.catId] || {}).title || auto.catId, auto.inliers, auto.n, pxToM(auto.t, auto.err)); el.title = el.textContent; }
  else { el.textContent = t('calWait'); el.title = el.textContent; }
  $('cal-hint').hidden = !!calib; // manual calibration only matters without a working fit
  if (typeof updateAutoInfo === 'function') updateAutoInfo();
}

async function loadIcons() {
  const urls = new Set(markersData.features.map(f => f.properties.icon).filter(Boolean));
  await Promise.all([...urls].map(async url => {
    try {
      const { data } = await map.loadImage(url);
      if (!map.hasImage(url)) map.addImage(url, data);
    } catch { /* icon missing in mirror, marker shows as plain circle */ }
  }));
}

function buildLabels() {
  const feats = (gj.labels && gj.labels.features) || [];
  if (!feats.length) return;
  const scale = 2;
  feats.forEach(f => {
    const d = f.properties.data || {};
    const size = Math.round(26 * (d['text-marker-size'] || 1)) * scale;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = `${d['text-marker-italic'] ? 'italic ' : ''}${d['text-marker-bold'] ? 'bold ' : ''}${size}px Georgia, "Times New Roman", serif`;
    ctx.font = font;
    const tw = ctx.measureText(f.properties.title).width;
    canvas.width = Math.ceil(tw + 12 * scale);
    canvas.height = size + 8 * scale;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4 * scale;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(f.properties.title, canvas.width / 2, canvas.height / 2);
    ctx.fillStyle = d['text-marker-color'] || '#f0d8b0';
    ctx.fillText(f.properties.title, canvas.width / 2, canvas.height / 2);
    map.addImage(f.properties.iconImage, ctx.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio: scale });
  });
  map.addSource('labels', { type: 'geojson', data: gj.labels });
  map.addLayer({
    id: 'labels', type: 'symbol', source: 'labels', minzoom: 12.5,
    layout: {
      'icon-image': ['get', 'iconImage'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.7, 16, 1.3],
      'icon-allow-overlap': true,
    },
  });
}

function renderDoneMode() {
  $('done-mode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === doneMode));
}

function applyFilter() {
  const base = ['all', ['in', ['get', 'catId'], ['literal', [...visible]]]];
  if (doneMode === 'hide') base.push(['!', ['get', 'collected']]);
  if (doneMode === 'only') base.push(['get', 'collected']);
  const f = ['any', ['==', ['get', 'pinned'], true], base];
  PIN_LAYERS.forEach(l => map.setFilter(l, f));
  const op = pinOpacity(doneMode !== 'only');
  map.setPaintProperty('pin-circle', 'circle-opacity', op);
  map.setPaintProperty('pin-circle', 'circle-stroke-opacity', op);
  map.setPaintProperty('pin-icon', 'icon-opacity', op);
}

function onHover(e) {
  const hit = map.queryRenderedFeatures(e.point, { layers: PIN_LAYERS })[0];
  map.getCanvas().style.cursor = hit ? 'pointer' : '';
  if (!hit) { if (hoverPopup) { hoverPopup.remove(); hoverPopup = null; } return; }
  if (!hoverPopup) hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 }).addTo(map);
  hoverPopup.setLngLat(hit.geometry.coordinates).setText(hit.properties.title);
}

function onClick(e) {
  const hit = map.queryRenderedFeatures(e.point, { layers: PIN_LAYERS })[0];
  if (hit) openDetail(hit.properties.markerId);
}

function onRightClick(e) {
  const hits = map.queryRenderedFeatures(e.point, { layers: PIN_LAYERS });
  if (!hits.length) return;
  // Overlapping markers: prefer the one already open in the detail panel.
  const hit = hits.find(h => h.properties.markerId === currentId) || hits[0];
  const id = hit.properties.markerId;
  setCollected(id, !isCollected(id));
}

// Follow lock: the map stays centred on the player; only zoom is allowed while locked.
// Locked: every zoom (wheel, buttons, pinch) happens around the centre, so the player never leaves it.
// MapLibre's enable(options) is a no-op while already enabled, hence the disable first.
function setZoomAround(locked) {
  if (!map) return;
  const opts = locked ? { around: 'center' } : undefined;
  map.scrollZoom.disable(); map.scrollZoom.enable(opts);
  map.touchZoomRotate.disable(); map.touchZoomRotate.enable(opts); map.touchZoomRotate.disableRotation();
}

// Called by the language button: dynamic texts are rebuilt, static ones are done by applyI18n.
function onLangChange() {
  updateCalInfo();
  renderPinned();
  refreshCounts();
  if (currentId) refreshDetailButtons();
  setFollow($('follow-me').checked);
}

function setFollow(on) {
  localStorage.setItem('follow', on ? '1' : '0');
  $('btn-lock').classList.toggle('on', on);
  $('btn-lock').title = on ? t('lockOn') : t('lockOff');
  // open shackle when free
  const sh = document.getElementById('lock-shackle');
  if (sh) sh.setAttribute('d', on ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 8 0');
  if (!map) return;
  setZoomAround(on);
  if (on) { map.dragPan.disable(); map.keyboard.disable(); centerOnPlayer(true); }
  else { map.dragPan.enable(); map.keyboard.enable(); }
}

function centerOnPlayer(jump) {
  if (!lastPos || !lastPos.live || !calib) return;
  const [px, py] = worldToPixel(lastPos.x, lastPos.y, calib);
  const coords = toLngLat(px, py);
  if (jump) map.jumpTo({ center: coords, zoom: Math.max(map.getZoom(), 15) });
  else map.jumpTo({ center: coords });
}

function flyToMarker(id) {
  if ($('follow-me').checked) { openDetail(id); return; } // locked: do not move the map
  const f = byId.get(id);
  if (!f) return;
  map.flyTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), 15.5), duration: 700 });
}

/* ---------- sidebar ---------- */

function buildCats() {
  const box = $('cats');
  box.innerHTML = '';
  mapData.cats.forEach(c => {
    const el = document.createElement('div');
    el.className = 'cat';
    el.dataset.cat = c.marker_cat_id;
    el.innerHTML = `<div class="cat-row"><span class="arrow">&#9654;</span><img src="${c.icon}" style="background:${c.pin_color || '#555'}" alt=""><span class="title">${c.title}</span><span class="cnt"></span></div><div class="subs"></div>`;
    const subs = el.querySelector('.subs');
    (c.children || []).forEach(s => {
      const r = document.createElement('div');
      r.className = 'sub-row';
      r.dataset.cat = s.marker_cat_id;
      r.innerHTML = `<img src="${s.icon}" style="background:${c.pin_color || '#555'}" alt=""><span class="title">${s.title}</span><span class="cnt"></span>`;
      r.addEventListener('click', () => toggleCat(s.marker_cat_id));
      subs.appendChild(r);
    });
    el.querySelector('.arrow').addEventListener('click', ev => { ev.stopPropagation(); el.classList.toggle('open'); });
    el.querySelector('.cat-row').addEventListener('click', () => toggleParent(c));
    box.appendChild(el);
  });
  refreshCatClasses();
}

function toggleCat(id) {
  if (visible.has(id)) visible.delete(id); else visible.add(id);
  afterFilterChange();
}

function toggleParent(c) {
  const ids = [c.marker_cat_id, ...(c.children || []).map(s => s.marker_cat_id)];
  const anyOn = ids.some(id => visible.has(id));
  ids.forEach(id => anyOn ? visible.delete(id) : visible.add(id));
  afterFilterChange();
}

function afterFilterChange() {
  refreshCatClasses();
  saveFilters();
  if (map && map.getLayer('pin-icon')) applyFilter();
}

function refreshCatClasses() {
  document.querySelectorAll('[data-cat]').forEach(el => el.classList.toggle('off', !visible.has(el.dataset.cat)));
}

function refreshCounts() {
  const total = {}, done = {};
  markersData.features.forEach(f => {
    const c = f.properties.catId;
    total[c] = (total[c] || 0) + 1;
    if (f.properties.collected) done[c] = (done[c] || 0) + 1;
  });
  mapData.cats.forEach(c => {
    let t = total[c.marker_cat_id] || 0, d = done[c.marker_cat_id] || 0;
    (c.children || []).forEach(s => {
      const st = total[s.marker_cat_id] || 0, sd = done[s.marker_cat_id] || 0;
      t += st; d += sd;
      setCnt(s.marker_cat_id, sd, st);
    });
    setCnt(c.marker_cat_id, d, t);
  });
  const all = markersData.features.length, got = state.collected.length;
  $('progress-fill').style.width = all ? (100 * got / all).toFixed(1) + '%' : '0';
  $('progress-text').textContent = `${got} / ${all}`;
}

function setCnt(catId, d, t) {
  const el = document.querySelector(`[data-cat="${catId}"] > .cnt, [data-cat="${catId}"] > .cat-row > .cnt`);
  if (!el) return;
  el.innerHTML = `<span class="d">${d}</span>/<span class="r">${t}</span>`;
  el.classList.toggle('done', t > 0 && d === t);
}

function renderPinned() {
  const ul = $('pinned-list');
  ul.innerHTML = '';
  $('pinned-box').classList.toggle('has', state.pinned.length > 0);
  $('pinned-box').style.display = state.pinned.length ? '' : 'none';
  $('pinned-count').textContent = state.pinned.length ? `(${state.pinned.length})` : '';
  state.pinned.forEach(id => {
    const f = markersData.features.find(x => x.id === id);
    if (!f) return;
    const li = document.createElement('li');
    li.innerHTML = `<img src="${f.properties.icon}" style="background:${f.properties.pinColor};border-radius:50%" alt=""><span class="${f.properties.collected ? 'done' : ''}">${f.properties.title}</span><button class="unpin" title="${t('unpin')}">&times;</button>`;
    li.addEventListener('click', () => { flyToMarker(id); openDetail(id); });
    li.querySelector('.unpin').addEventListener('click', ev => { ev.stopPropagation(); setPinned(id, false); });
    ul.appendChild(li);
  });
}

function bindUi() {
  $('show-all').addEventListener('click', () => { visible = new Set(Object.keys(flat)); afterFilterChange(); });
  $('hide-all').addEventListener('click', () => { visible = new Set(); afterFilterChange(); });
  $('done-mode').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { doneMode = b.dataset.mode; renderDoneMode(); afterFilterChange(); }));
  $('follow-me').checked = localStorage.getItem('follow') !== '0';
  $('follow-me').addEventListener('change', () => setFollow($('follow-me').checked));
  $('btn-lock').addEventListener('click', () => { $('follow-me').checked = !$('follow-me').checked; setFollow($('follow-me').checked); });
  $('detail-close').addEventListener('click', closeDetail);
  $('btn-collected').addEventListener('click', () => setCollected(currentId, !isCollected(currentId)));
  $('btn-pinned').addEventListener('click', () => setPinned(currentId, !isPinned(currentId)));
  $('btn-goto').addEventListener('click', () => flyToMarker(currentId));
  $('btn-here').addEventListener('click', addCalibPoint);
  $('btn-cal-reset').addEventListener('click', resetCalib);
  // Yenile: ask the mod for an immediate pass (pins, journal, containers, items), give it a moment
  // to write and the server to merge, then reload the page.
  $('btn-refresh-map').addEventListener('click', () => $('btn-reload').click());
  $('auto-complete').addEventListener('change', e => {
    if (e.target.checked && !localStorage.getItem('autoWarned')) {
      if (!confirm(t('autoWarn'))) { e.target.checked = false; localStorage.setItem('autoComplete', '0'); return; }
      localStorage.setItem('autoWarned', '1');
    }
  }, true);
  $('btn-reload').addEventListener('click', () => {
    const b = $('btn-reload');
    b.disabled = true;
    b.title = t('scanning');
    fetch('/cmd', { method: 'POST', body: 'pins' }).catch(() => {}).then(() => setTimeout(() => location.reload(), 8000));
  });
  $('detail-note').addEventListener('input', e => {
    if (e.target.value.trim()) state.notes[currentId] = e.target.value; else delete state.notes[currentId];
    saveState();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDetail(); hideSearch(); } });

  const input = $('search');
  input.addEventListener('input', () => runSearch(input.value.trim().toLowerCase()));
  input.addEventListener('focus', () => runSearch(input.value.trim().toLowerCase()));
  document.addEventListener('click', e => { if (!e.target.closest('.side-head')) hideSearch(); });
}

function runSearch(q) {
  const box = $('search-results');
  if (q.length < 2) { box.hidden = true; return; }
  const hits = markersData.features.filter(f => f.properties.search.includes(q)).slice(0, 40);
  box.innerHTML = '';
  hits.forEach(f => {
    const d = document.createElement('div');
    d.innerHTML = `<img src="${f.properties.icon}" style="background:${f.properties.pinColor};border-radius:50%" alt=""><span>${f.properties.title}</span><small>${(flat[f.properties.catId] || {}).title || ''}</small>`;
    d.addEventListener('click', () => { flyToMarker(f.id); openDetail(f.id); hideSearch(); });
    box.appendChild(d);
  });
  if (!hits.length) box.innerHTML = `<div><small>${t('noResults')}</small></div>`;
  box.hidden = false;
}

function hideSearch() { $('search-results').hidden = true; }

/* ---------- detail panel ---------- */

async function openDetail(id) {
  const f = byId.get(id);
  if (!f) return;
  currentId = id;
  const p = f.properties;
  $('detail').hidden = false;
  $('btn-here').disabled = !(lastPos && lastPos.live);

  $('detail-cat').textContent = catPath(p.catId);
  $('detail-title').textContent = titleOf(p);
  $('detail-note').value = state.notes[id] || '';
  refreshDetailButtons();

  const img = $('detail-img');
  if (p.image) { img.src = `/images/marker-thumb/${id}/${p.image.filename}.jpeg`; img.hidden = false; }
  else { img.hidden = true; img.removeAttribute('src'); }
  $('.detail-scroll', true).scrollTop = 0;

  const meta = [];
  if (p.item && p.item.title && p.item.title !== titleOf(p)) meta.push([t('item'), p.item.title]);
  meta.push([t('category'), catPath(p.catId)]);
  if (p.origPoints && p.origPoints[0]) meta.push([t('position'), `X ${p.origPoints[0][0]}  Y ${p.origPoints[0][1]}`]);
  meta.push([t('marker'), '#' + id]);
  $('detail-meta').innerHTML = meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  const links = $('detail-links');
  links.innerHTML = '';
  const q = encodeURIComponent('The Blood of Dawnwalker ' + titleOf(p));
  const ext = ((p.data && p.data.links) || []).map(l => [l.title || t('guide'), l.url]);
  if (p.item && p.item.path) ext.push([t('ggPage'), 'https://www.gamerguides.com/the-blood-of-dawnwalker/database' + p.item.path]);
  ext.push(['Google', 'https://www.google.com/search?q=' + q]);
  ext.push(['Wiki', 'https://dawnwalker.fandom.com/wiki/Special:Search?query=' + encodeURIComponent(titleOf(p))]);
  ext.forEach(([label, url]) => {
    const a = document.createElement('a');
    a.href = url; a.textContent = label;
    a.addEventListener('click', ev => { ev.preventDefault(); fetch('/open?url=' + encodeURIComponent(url)); });
    links.appendChild(a);
  });

  $('detail-body').innerHTML = `<p class="muted">${t('loading')}</p>`;
  $('detail-items').innerHTML = '';
  if (p.source) {
    // imported marker: the description travelled with it, no mirror popup exists
    const d = document.createElement('p');
    d.textContent = p.extraDescription || '';
    $('detail-body').innerHTML = '';
    $('detail-body').appendChild(d);
    const src = document.createElement('p');
    src.className = 'muted';
    src.textContent = `${t('source')}: ${p.source}${p.mgCategory ? ' / ' + p.mgCategory : ''}`;
    $('detail-body').appendChild(src);
    return;
  }
  try {
    const url = `/json/marker_popup/${MAP_ID}/${id}` + (p.item ? '/item' : '');
    const j = await fetch(url).then(r => r.ok ? r.json() : null);
    if (currentId !== id) return;
    $('detail-body').innerHTML = j && j.description_html ? sanitize(j.description_html) : '';
    renderContainerItems(id, (j && j.container_items) || []);
  } catch {
    $('detail-body').innerHTML = '';
  }
}

function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, iframe, style').forEach(n => n.remove());
  doc.querySelectorAll('a').forEach(a => {
    const s = doc.createElement('span');
    s.className = a.className;
    s.style.cssText = a.style.cssText;
    s.innerHTML = a.innerHTML;
    a.replaceWith(s);
  });
  doc.querySelectorAll('img').forEach(i => { i.loading = 'lazy'; i.onerror = null; i.setAttribute('onerror', 'this.remove()'); });
  return doc.body.innerHTML;
}

function renderContainerItems(id, items) {
  const box = $('detail-items');
  box.innerHTML = '';
  if (!items.length) return;
  const h = document.createElement('h3');
  h.textContent = t('contents');
  box.appendChild(h);
  items.forEach(it => {
    const key = `${id}:${it.cid}`;
    const lab = document.createElement('label');
    const on = state.subItems.includes(key);
    lab.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}>${it.icon ? `<img src="${it.icon.path}" alt="">` : ''}<span class="${on ? 'done' : ''}">${it.title}${it.max_qty > 1 ? ` x${it.max_qty}` : ''}</span>`;
    lab.querySelector('input').addEventListener('change', e => {
      state.subItems = state.subItems.filter(k => k !== key);
      if (e.target.checked) state.subItems.push(key);
      lab.querySelector('span').classList.toggle('done', e.target.checked);
      saveState();
    });
    box.appendChild(lab);
  });
}

function refreshDetailButtons() {
  $('btn-collected').classList.toggle('on', isCollected(currentId));
  $('btn-collected').textContent = isCollected(currentId) ? t('doneOn') : t('done');
  $('btn-pinned').classList.toggle('on', isPinned(currentId));
  $('btn-pinned').textContent = isPinned(currentId) ? t('pinOn') : t('pin');
}

function closeDetail() {
  if ($('detail').hidden) return;
  $('detail').hidden = true;
  currentId = null;
  $('btn-here').disabled = true;
}

const glCheck = document.createElement('canvas');
if (!glCheck.getContext('webgl2')) {
  document.body.insertAdjacentHTML('afterbegin', '<div style="position:fixed;inset:0;z-index:99;background:#17110f;color:#e8dccb;font:18px Segoe UI;padding:40px">Bu tarayici WebGL2 desteklemiyor, harita cizilemez. (UE4SS.log / CEF)</div>');
}
boot().catch(err => { console.error(err); alert('Harita yuklenemedi: ' + err.message); });
