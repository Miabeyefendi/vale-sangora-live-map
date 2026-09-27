// Mirrors the Vale Sangora map data from gamerguides.com into src/assets/data/site,
// keeping the original URL paths so the local server can serve them as-is.
// Resumable: existing files are skipped. Usage: node src/services/fetch.js [--z18]
'use strict';
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://www.gamerguides.com';
const MAP_ID = 496;
const LAYER_ID = 804;
const PAGE = '/the-blood-of-dawnwalker/maps/vale-sangora';
const ROOT = path.join(__dirname, '..', 'assets', 'data');
const SITE = path.join(ROOT, 'site');
const CONCURRENCY = 8;
const MAX_ZOOM = process.argv.includes('--z18') ? 18 : 17;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Referer': ORIGIN + PAGE,
};

let done = 0, skipped = 0, failed = 0, total = 0;
const failures = [];

const localPath = (urlPath) => path.join(SITE, decodeURIComponent(urlPath.split('?')[0]));

async function download(urlPath) {
  const file = localPath(urlPath);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) { skipped++; return file; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(ORIGIN + encodeURI(urlPath), { headers: HEADERS });
      if (res.status === 404) { failed++; failures.push(urlPath + ' 404'); return null; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      done++;
      return file;
    } catch (err) {
      if (attempt === 3) { failed++; failures.push(urlPath + ' ' + err.message); return null; }
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  return null;
}

async function pool(items, worker) {
  let i = 0;
  const run = async () => { while (i < items.length) { const it = items[i++]; await worker(it); } };
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
}

function progress(label) {
  process.stdout.write(`\r${label}: ${done + skipped + failed}/${total} (new ${done}, skipped ${skipped}, failed ${failed})    `);
}

async function fetchList(label, urls) {
  total += urls.length;
  const timer = setInterval(() => progress(label), 500);
  await pool(urls, download);
  clearInterval(timer);
  progress(label);
  process.stdout.write('\n');
}

async function main() {
  fs.mkdirSync(SITE, { recursive: true });

  // 1. Map config: GG.mapData is inlined in the page HTML.
  console.log('Map config');
  const html = await (await fetch(ORIGIN + PAGE, { headers: HEADERS })).text();
  const m = html.match(/GG\.mapData = (\{.*?\});\s*\n/s);
  if (!m) throw new Error('GG.mapData not found in page');
  const mapData = JSON.parse(m[1]);
  fs.writeFileSync(path.join(ROOT, 'mapdata.json'), JSON.stringify(mapData, null, 2));

  // 2. Markers, labels, lines, routes.
  console.log('GeoJSON');
  const gjPath = `/map/${MAP_ID}/geojson`;
  await download(gjPath);
  const gj = JSON.parse(fs.readFileSync(localPath(gjPath), 'utf8'));
  const markers = gj.markers.features;
  console.log(`  markers: ${markers.length}`);

  // 3. Icons: marker custom icons + category icons.
  const icons = new Set();
  markers.forEach(f => f.properties.customIcon && icons.add(f.properties.customIcon.path));
  const walk = c => {
    if (c.icon) icons.add(c.icon);
    (c.items || []).forEach(i => i.customIcon && icons.add(i.customIcon.path));
    (c.children || []).forEach(walk);
  };
  mapData.cats.forEach(walk);
  await fetchList('Icons', [...icons]);

  // 4. Popups and thumbnails.
  const popups = markers.map(f => `/json/marker_popup/${MAP_ID}/${f.properties.markerId}` + (f.properties.item ? '/item' : ''));
  await fetchList('Popups', popups);
  const thumbs = markers.filter(f => f.properties.image)
    .map(f => `/images/marker-thumb/${f.properties.markerId}/${f.properties.image.filename}.jpeg`);
  await fetchList('Thumbs', thumbs);

  // 5. Inline item icons referenced inside popup descriptions.
  const inline = new Set();
  for (const p of popups) {
    const file = localPath(p);
    if (!fs.existsSync(file)) continue;
    let html = '';
    try { html = JSON.parse(fs.readFileSync(file, 'utf8')).description_html || ''; } catch { continue; }
    for (const mm of html.matchAll(/src="(\/images\/db-item-inline\/[^"]+)"/g)) inline.add(mm[1]);
  }
  await fetchList('Inline icons', [...inline]);

  // 6. Tiles. Zoom z covers ceil(width / (256 * 2^(18-z))) tiles per side.
  const tiles = [];
  for (let z = 12; z <= MAX_ZOOM; z++) {
    const n = Math.ceil(mapData.width / (mapData.tile_size * Math.pow(2, 18 - z)));
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) tiles.push(`/assets/maps/${MAP_ID}/${LAYER_ID}/${z}/${x}-${y}.png`);
  }
  await fetchList(`Tiles z12-z${MAX_ZOOM}`, tiles);

  if (failures.length) {
    fs.writeFileSync(path.join(ROOT, 'fetch-failures.txt'), failures.join('\n'));
    console.log(`${failures.length} failures written to fetch-failures.txt`);
  }
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
