// Imports the community map from mapgenie.io and keeps what our mirror lacks.
// Usage: node src/services/import-mapgenie.js [--offline]
//   1. GET https://mapgenie.io/api/v1/maps/995/data (public; cached in src/assets/data/extra/mapgenie-raw.json)
//   2. Align its lat/lng grid to our pixel grid with a similarity fit on shrines (RANSAC + refinement).
//   3. Every mapgenie location is mapped to one of our categories (same title) or to a new
//      "MapGenie / <category>" one; a location with one of our markers of that category within
//      MATCH_PX is a duplicate and dropped. The rest go to src/assets/data/extra/mapgenie.json,
//      which the page merges into the marker list (ids 9000000 + mapgenie id).
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA = path.join(__dirname, '..', 'assets', 'data');
const EXTRA = path.join(DATA, 'extra');
const RAW = path.join(EXTRA, 'mapgenie-raw.json');
const OUT = path.join(EXTRA, 'mapgenie.json');
const API = 'https://mapgenie.io/api/v1/maps/995/data';
const PAGE = 'https://mapgenie.io/the-blood-of-dawnwalker/maps/vale-sangora'; // groups + categories live in the page's window.mapData
const RAW_PAGE = path.join(EXTRA, 'mapgenie-page.html');
const MATCH_PX = 60;
const normTitle = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ID_BASE = 9000000;

// mapgenie category title -> our "Parent / Child" title. Missing entries become "MapGenie / <title>".
const CAT_MAP = {
  'Manual': 'Manuals and Recipes / Character Development',
  'Shrine': 'Landmarks / Shrine',
  'Side Quest': 'Journal / Quests',
  'Main Quest': 'Journal / Quests',
  'Court Quest': 'Journal / Court',
  "Monster's Lair": "Activities / Monster's Lair",
  'Soldier Picket': 'Activities / Soldier Picket',
  'Destroyed Shrine': 'Landmarks / Destroyed Shrine',
  'Building': 'Landmarks / Building(s)',
  'Bandit Camp': 'Activities / Bandit Camp',
  'Person in Danger': 'Activities / Person in Danger',
  'Ancient Circle': 'Activities / Ancient Circle',
  'Soldier Camp': 'Activities / Soldier Camp',
  'Tower': 'Landmarks / Tower',
  'Settlement': 'Landmarks / Settlement',
  'General Store': 'Vendors / General Store',
  'Blacksmith': 'Vendors / Blacksmith',
  'Will-o-the-Wisps': 'Activities / Will-o-the-Wisps',
  'Curious House': 'Activities / Curious House',
  'Tavern': 'Vendors / Tavern',
  "Brencis's Banner": "Activities / Brencis's Banner",
  'Armourer': 'Vendors / Armourer',
  'Medic': 'Vendors / Medic',
  'Swordmastery Teacher': 'Vendors / Swordmastery Teacher',
  'Haunted Site': 'Activities / Haunted Site',
  'Witchcraft Vendor': 'Vendors / Witchcraft Vendor',
  'Gate': 'Landmarks / Gate',
  'Silver Trader': 'Vendors / Silver Trader',
  'Miscellaneous': 'Landmarks / Point of Interest',
};

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: 'https://mapgenie.io/the-blood-of-dawnwalker/maps/vale-sangora' } }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error('HTTP ' + res.statusCode))));
    }).on('error', reject);
  });
}

// window.mapData = {...}; in the page: take the balanced object literal after the assignment.
function extractMapData(html) {
  const start = html.indexOf('window.mapData = ');
  if (start < 0) throw new Error('window.mapData not found in page');
  let i = html.indexOf('{', start), depth = 0, inStr = false, esc = false;
  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(html.slice(i, j + 1)); }
  }
  throw new Error('unterminated window.mapData');
}

// --- similarity fit (scale, rotation, optional reflection, translation) on unpaired point sets ---
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const apply = (t, p) => ({ x: t.a * p.x + t.b * p.y + t.c, y: t.d * p.x + t.e * p.y + t.f });
function fitFromPairs(pairs) {
  // least squares similarity without reflection; reflection handled by mirroring the source first
  const n = pairs.length;
  let cpx = 0, cpy = 0, cqx = 0, cqy = 0;
  pairs.forEach(({ p, q }) => { cpx += p.x; cpy += p.y; cqx += q.x; cqy += q.y; });
  cpx /= n; cpy /= n; cqx /= n; cqy /= n;
  let sa = 0, sb = 0, sp = 0;
  pairs.forEach(({ p, q }) => {
    const px = p.x - cpx, py = p.y - cpy, qx = q.x - cqx, qy = q.y - cqy;
    sa += px * qx + py * qy; sb += px * qy - py * qx; sp += px * px + py * py;
  });
  if (!sp) return null;
  const th = Math.atan2(sb, sa), s = (sa * Math.cos(th) + sb * Math.sin(th)) / sp;
  const a = s * Math.cos(th), b = -s * Math.sin(th), d = s * Math.sin(th), e = s * Math.cos(th);
  return { a, b, c: cqx - (a * cpx + b * cpy), d, e, f: cqy - (d * cpx + e * cpy) };
}
function nearest(q, pts) {
  let best = null, bd = Infinity;
  for (const p of pts) { const dd = dist(p, q); if (dd < bd) { bd = dd; best = p; } }
  return { p: best, d: bd };
}
function inliers(t, src, dst, px) {
  const pairs = [];
  for (const p of src) { const { p: m, d } = nearest(apply(t, p), dst); if (m && d <= px) pairs.push({ p, q: m }); }
  return pairs;
}
function ransac(src, dst, iterations, px) {
  let best = null, bestN = 0;
  for (let i = 0; i < iterations; i++) {
    const p1 = src[Math.floor(Math.random() * src.length)], p2 = src[Math.floor(Math.random() * src.length)];
    const q1 = dst[Math.floor(Math.random() * dst.length)], q2 = dst[Math.floor(Math.random() * dst.length)];
    if (p1 === p2 || q1 === q2) continue;
    const t = fitFromPairs([{ p: p1, q: q1 }, { p: p2, q: q2 }]);
    if (!t) continue;
    const n = inliers(t, src, dst, px).length;
    if (n > bestN) { bestN = n; best = t; }
  }
  return best;
}
// Full affine (6 parameters) least squares on paired points: absorbs a slightly different aspect
// ratio between the two map images, which a similarity cannot.
function fitAffine(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  // normal equations for x' = a x + b y + c and y' = d x + e y + f
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, s1 = n;
  let sxu = 0, syu = 0, su = 0, sxv = 0, syv = 0, sv = 0;
  pairs.forEach(({ p, q }) => {
    sxx += p.x * p.x; sxy += p.x * p.y; sx += p.x; syy += p.y * p.y; sy += p.y;
    sxu += p.x * q.x; syu += p.y * q.x; su += q.x; sxv += p.x * q.y; syv += p.y * q.y; sv += q.y;
  });
  const solve = (r1, r2, r3) => {
    // 3x3 system [sxx sxy sx; sxy syy sy; sx sy s1] * [a b c] = [r1 r2 r3]
    const m = [[sxx, sxy, sx, r1], [sxy, syy, sy, r2], [sx, sy, s1, r3]];
    for (let i = 0; i < 3; i++) {
      let piv = i;
      for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[piv][i])) piv = k;
      [m[i], m[piv]] = [m[piv], m[i]];
      if (Math.abs(m[i][i]) < 1e-12) return null;
      for (let k = 0; k < 3; k++) {
        if (k === i) continue;
        const f = m[k][i] / m[i][i];
        for (let j = i; j < 4; j++) m[k][j] -= f * m[i][j];
      }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  };
  const A = solve(sxu, syu, su), B = solve(sxv, syv, sv);
  if (!A || !B) return null;
  return { a: A[0], b: A[1], c: A[2], d: B[0], e: B[1], f: B[2] };
}

function refine(t, src, dst, px) {
  for (let i = 0; i < 10; i++) {
    const pairs = inliers(t, src, dst, px);
    if (pairs.length < 3) break;
    const nt = fitFromPairs(pairs);
    if (!nt) break;
    t = nt;
  }
  return t;
}

async function main() {
  fs.mkdirSync(EXTRA, { recursive: true });
  let raw;
  if (process.argv.includes('--offline') && fs.existsSync(RAW)) raw = fs.readFileSync(RAW, 'utf8');
  else { raw = await get(API); fs.writeFileSync(RAW, raw); }
  const mg = JSON.parse(raw);
  let page;
  if (process.argv.includes('--offline') && fs.existsSync(RAW_PAGE)) page = fs.readFileSync(RAW_PAGE, 'utf8');
  else { page = await get(PAGE); fs.writeFileSync(RAW_PAGE, page); }
  const pageData = extractMapData(page);
  const mgCats = {};
  (pageData.groups || []).forEach(g => (g.categories || []).forEach(c => { mgCats[c.id] = { title: c.title, group: g.title, info: c.info }; }));
  if (!Object.keys(mgCats).length) throw new Error('no categories in mapgenie data');

  const md = JSON.parse(fs.readFileSync(path.join(DATA, 'mapdata.json'), 'utf8'));
  const gj = JSON.parse(fs.readFileSync(path.join(DATA, 'site', 'map', String(md.map_id), 'geojson'), 'utf8'));
  const ourCatByTitle = {};
  md.cats.forEach(c => (c.children || []).forEach(k => { ourCatByTitle[c.title.trim() + ' / ' + k.title.trim()] = k.marker_cat_id; }));
  const ours = gj.markers.features.map(f => f.properties).filter(p => p.origPoints && p.origPoints[0])
    .map(p => ({ id: p.markerId, x: p.origPoints[0][0], y: p.origPoints[0][1], catId: p.catId, t: normTitle(p.displayTitle || p.title || (p.item && p.item.title)) }));

  // Alignment on shrines: mapgenie (lng, lat) -> our px. Reflection: the y axis may be flipped.
  const shrineCat = Object.keys(mgCats).find(id => mgCats[id].title === 'Shrine');
  const src = mg.locations.filter(l => String(l.category_id) === String(shrineCat)).map(l => ({ x: +l.longitude, y: +l.latitude }));
  const dst = ours.filter(m => m.catId === ourCatByTitle['Landmarks / Shrine']);
  if (src.length < 4 || dst.length < 4) throw new Error('not enough shrines to align');
  let best = null, bestN = 0;
  for (const flip of [1, -1]) {
    const s = src.map(p => ({ x: p.x, y: flip * p.y }));
    const scale0 = 1; // RANSAC on raw coordinates; the fit finds the scale itself
    let t = ransac(s, dst, 40000, 60);
    if (!t) continue;
    t = refine(t, s, dst, 40);
    const n = inliers(t, s, dst, 30).length;
    if (n > bestN) { bestN = n; best = { t, flip }; }
    void scale0;
  }
  if (!best || bestN < 6) throw new Error('alignment failed, inliers ' + bestN);
  // Second stage: full affine on every category both maps share (same title), inliers within 60 px.
  const shared = Object.keys(CAT_MAP).filter(k => ourCatByTitle[CAT_MAP[k]] && !/Quest|Manual|Miscellaneous/.test(k));
  const srcAll = [], dstAll = [];
  for (const title of shared) {
    const mgId = Object.keys(mgCats).find(id => mgCats[id].title === title);
    if (!mgId) continue;
    mg.locations.filter(l => String(l.category_id) === mgId).forEach(l => srcAll.push({ x: +l.longitude, y: best.flip * +l.latitude, cat: title }));
    ours.filter(m => m.catId === ourCatByTitle[CAT_MAP[title]]).forEach(m => dstAll.push({ ...m, cat: title }));
  }
  for (let i = 0; i < 6; i++) {
    const pairs = [];
    for (const p of srcAll) {
      const { p: m, d } = nearest(apply(best.t, p), dstAll.filter(q => q.cat === p.cat));
      if (m && d <= 60) pairs.push({ p, q: m });
    }
    const nt = fitAffine(pairs);
    if (!nt) break;
    best.t = nt;
  }
  const toPx = l => apply(best.t, { x: +l.longitude, y: best.flip * +l.latitude });
  const errs = inliers(best.t, src.map(p => ({ x: p.x, y: best.flip * p.y })), dst, 40).map(({ p, q }) => dist(apply(best.t, p), q));
  errs.sort((a, b) => a - b);
  const medianErr = errs[Math.floor(errs.length / 2)];
  console.log(`alignment: ${errs.length}/${src.length} shrines within 40 px, median error ${medianErr.toFixed(1)} px, p90 ${errs[Math.floor(errs.length * 0.9)].toFixed(1)} px, flip ${best.flip}`);

  // Categories and markers.
  const newCats = {};   // title -> { id, title, group }
  const byCat = {};
  ours.forEach(m => { (byCat[m.catId] = byCat[m.catId] || []).push(m); });
  const markers = [];
  const stats = {};
  for (const l of mg.locations) {
    const mc = mgCats[l.category_id];
    if (!mc) continue;
    const ourTitle = CAT_MAP[mc.title];
    let catId = ourTitle ? ourCatByTitle[ourTitle] : null;
    if (ourTitle && !catId) console.warn('unknown category mapping', ourTitle);
    if (!catId) {
      const key = mc.title;
      if (!newCats[key]) newCats[key] = { id: 'mg-' + l.category_id, title: mc.title, group: mc.group, info: mc.info || '' };
      catId = newCats[key].id;
    }
    const p = toPx(l);
    const pool = byCat[catId] || (ourTitle ? [] : ours);
    const { d } = nearest(p, pool);
    const st = stats[mc.title] = stats[mc.title] || { total: 0, dup: 0, added: 0 };
    st.total++;
    // Duplicate: our marker of the same category within the category's radius (quests are placed
    // differently on each site; residual alignment error is ~60 px), or the same title anywhere near.
    const radius = /Quest/.test(mc.title) ? 400 : (ourTitle && !/Manual/.test(mc.title) ? 120 : MATCH_PX);
    const t = normTitle(l.title);
    const sameTitle = t.length >= 6 && ours.some(m => m.t === t && dist(m, p) <= 600);
    if (d <= radius || sameTitle) { st.dup++; continue; }
    st.added++;
    markers.push({
      id: ID_BASE + l.id, catId, px: Math.round(p.x), py: Math.round(p.y),
      title: l.title || mc.title, description: l.description || '', source: 'mapgenie', mgCategory: mc.title,
    });
  }
  const out = { source: 'mapgenie.io', mapId: mg.map.id, fetched: new Date().toISOString(), transform: best.t, flip: best.flip,
    categories: Object.values(newCats), markers, stats };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`markers: ${mg.locations.length} on mapgenie, ${markers.length} added (${Object.keys(newCats).length} new categories)`);
  Object.entries(stats).sort((a, b) => b[1].added - a[1].added).forEach(([k, v]) => console.log(`  ${k}: ${v.total} total, ${v.dup} duplicates, ${v.added} added`));
}

main().catch(e => { console.error(e.message); process.exit(1); });
