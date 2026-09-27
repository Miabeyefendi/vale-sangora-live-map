'use strict';
// Pure geometry for automatic calibration. Loaded by the page (auto.js) and by calib-worker.js.
// Finds an affine world(cm) -> map pixel transform by registering an actor point set against a
// marker point set with no correspondences: RANSAC over (2 actors, 2 markers) for each of the
// 8 axis-aligned orientations, then ICP with a scale-guarded similarity fit.

const INLIER_PX = 50;
const ORIENTATIONS = [
  [1, 0, 0, 1], [-1, 0, 0, 1], [1, 0, 0, -1], [-1, 0, 0, -1],
  [0, 1, 1, 0], [0, -1, 1, 0], [0, 1, -1, 0], [0, -1, -1, 0],
];

function centroid(pts) {
  let x = 0, y = 0;
  pts.forEach(p => { x += p.x; y += p.y; });
  return { x: x / pts.length, y: y / pts.length };
}

function spread(pts, c) {
  let s = 0;
  pts.forEach(p => { s += (p.x - c.x) ** 2 + (p.y - c.y) ** 2; });
  return Math.sqrt(s / pts.length);
}

const applyT = (t, p) => ({ x: t.a * p.x + t.b * p.y + t.c, y: t.d * p.x + t.e * p.y + t.f });

function nearest(q, pts) {
  let best = null, bd = Infinity;
  for (const p of pts) {
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return { p: best, d: Math.sqrt(bd) };
}

// Least-squares similarity (scale, rotation, translation) from paired points.
function fitSimilarity(pairs) {
  const cp = centroid(pairs.map(x => x.p)), cq = centroid(pairs.map(x => x.q));
  let sa = 0, sb = 0, sp = 0;
  pairs.forEach(({ p, q }) => {
    const px = p.x - cp.x, py = p.y - cp.y, qx = q.x - cq.x, qy = q.y - cq.y;
    sa += px * qx + py * qy;
    sb += px * qy - py * qx;
    sp += px * px + py * py;
  });
  if (sp === 0) return null;
  const th = Math.atan2(sb, sa);
  const s = (sa * Math.cos(th) + sb * Math.sin(th)) / sp;
  const a = s * Math.cos(th), b = -s * Math.sin(th), d = s * Math.sin(th), e = s * Math.cos(th);
  return { a, b, c: cq.x - (a * cp.x + b * cp.y), d, e, f: cq.y - (d * cp.x + e * cp.y) };
}

// Spatial hash for nearest-marker lookups.
function buildGrid(M) {
  const cell = INLIER_PX * 2, g = new Map();
  M.forEach(p => { const k = Math.floor(p.x / cell) + ',' + Math.floor(p.y / cell); (g.get(k) || g.set(k, []).get(k)).push(p); });
  return { cell, g };
}
function nearestGrid(q, grid) {
  const cx = Math.floor(q.x / grid.cell), cy = Math.floor(q.y / grid.cell);
  let best = null, bd = Infinity;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const list = grid.g.get((cx + i) + ',' + (cy + j));
    if (!list) continue;
    for (const p of list) { const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2; if (d < bd) { bd = d; best = p; } }
  }
  return { p: best, d: Math.sqrt(bd) };
}

function scoreT(t, A, grid) {
  const hit = new Map();
  for (const p of A) {
    const { p: m, d } = nearestGrid(applyT(t, p), grid);
    if (m && d < INLIER_PX && (!hit.has(m.id) || hit.get(m.id) > d)) hit.set(m.id, d);
  }
  let se = 0;
  hit.forEach(d => { se += d * d; });
  return { inliers: hit.size, err: hit.size ? Math.sqrt(se / hit.size) : Infinity };
}

// RANSAC over (two actors, two markers) with the 8 axis-aligned orientations: gives scale and
// translation directly, works with partial actor sets, no centroid assumptions.
const BUCKET = Math.PI / 36; // 5 degrees
function registerSets(A, M, deadline) {
  const grid = buildGrid(M);
  // Marker pairs bucketed by direction (both orderings).
  const buckets = new Map();
  for (let k = 0; k < M.length; k++) for (let l = 0; l < M.length; l++) {
    if (k === l) continue;
    const dx = M[l].x - M[k].x, dy = M[l].y - M[k].y, len = Math.hypot(dx, dy);
    if (len < 300) continue;
    const b = Math.floor(((Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI)) / BUCKET);
    (buckets.get(b) || buckets.set(b, []).get(b)).push({ k, l, len });
  }
  // Longest actor baselines first (best scale accuracy), capped.
  const aPairs = [];
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) aPairs.push({ i, j, len: Math.hypot(A[j].x - A[i].x, A[j].y - A[i].y) });
  aPairs.sort((x, y) => y.len - x.len);
  const usePairs = aPairs.slice(0, 24);
  let best = null;
  const nb = Math.round(2 * Math.PI / BUCKET);
  outer:
  for (const [r0, r1, r2, r3] of ORIENTATIONS) {
    for (const { i, j, len } of usePairs) {
      if (len < 1) continue;
      const vx = r0 * (A[j].x - A[i].x) + r1 * (A[j].y - A[i].y);
      const vy = r2 * (A[j].x - A[i].x) + r3 * (A[j].y - A[i].y);
      const b = Math.floor(((Math.atan2(vy, vx) + 2 * Math.PI) % (2 * Math.PI)) / BUCKET);
      if (deadline && Date.now() > deadline) break outer;
      for (const bb of [b - 1, b, b + 1]) {
        const cands = buckets.get((bb + nb) % nb);
        if (!cands) continue;
        const step = Math.max(1, Math.floor(cands.length / 80));
        for (let ci = 0; ci < cands.length; ci += step) {
          const { k, len: lm } = cands[ci];
          const s = lm / len;
          if (s < 0.005 || s > 0.2) continue; // px per cm sanity: 5 cm .. 2 m per pixel
          const t = { a: s * r0, b: s * r1, d: s * r2, e: s * r3 };
          t.c = M[k].x - (t.a * A[i].x + t.b * A[i].y);
          t.f = M[k].y - (t.d * A[i].x + t.e * A[i].y);
          const sc = scoreT(t, A, grid);
          if (!best || sc.inliers > best.inliers || (sc.inliers === best.inliers && sc.err < best.err)) best = { t, ...sc };
          if (best.inliers >= 0.85 * A.length) break outer;
        }
      }
    }
  }
  if (!best || best.inliers < 3) return best;
  // Refine with ICP (similarity fit), keeping the scale near the RANSAC estimate.
  const s0 = Math.hypot(best.t.a, best.t.d);
  let t = best.t;
  for (const thr of [120, 80, INLIER_PX, INLIER_PX]) {
    const pairs = [];
    for (const p of A) { const { p: m, d } = nearestGrid(applyT(t, p), grid); if (m && d < thr) pairs.push({ p, q: m }); }
    if (pairs.length < 3) break;
    const nt = fitSimilarity(pairs);
    if (!nt) break;
    const sc = Math.hypot(nt.a, nt.d);
    if (sc < s0 * 0.7 || sc > s0 * 1.4) break;
    t = nt;
  }
  const refined = { t, ...scoreT(t, A, grid) };
  return refined.inliers >= best.inliers ? refined : best;
}


// Global consistency: the true transform is shared by every class, so count how many actors of
// any (reasonably sized) class land on a distinct marker of any category.
function globalHits(t, byClass, allGrid) {
  const hit = new Set();
  for (const [, A] of Object.entries(byClass)) {
    if (A.length > 400) continue;
    for (const p of A) {
      const { p: m, d } = nearestGrid(applyT(t, p), allGrid);
      if (m && d < INLIER_PX) hit.add(m.id);
    }
  }
  return hit.size;
}

// Search every (class, category) pair within a time budget. Map-pin classes go first; a strong
// early hit among them ends the search. Candidates are ranked by global consistency, then inliers.
// Returns the best {t, inliers, err, cls, catId, n, m, hits} or null.
function searchCalibration(byClass, cats, budgetMs) {
  const started = Date.now();
  const isPin = name => /mappin|fasttravel|shrine|poi|nest/i.test(name);
  const order = Object.entries(byClass).filter(([, A]) => A.length >= 4 && A.length <= 400)
    .sort((x, y) => (isPin(y[0]) ? 1 : 0) - (isPin(x[0]) ? 1 : 0) || x[1].length - y[1].length);
  const allPts = [];
  cats.forEach(c => c.pts.forEach(p => allPts.push(p)));
  const allGrid = buildGrid(allPts);
  const candidates = [];
  for (const [cls, A] of order) {
    let strong = false;
    for (const cat of cats) {
      if (Date.now() - started > budgetMs) break;
      const ratio = A.length / cat.pts.length;
      if (ratio < 0.03 || ratio > 4) continue;
      const r = registerSets(A, cat.pts, Date.now() + (A.length <= 40 ? 2500 : 1000));
      if (!r || r.inliers < 4 || r.inliers / A.length < 0.7) continue;
      candidates.push({ ...r, cls, catId: cat.id, n: A.length, m: cat.pts.length, hits: globalHits(r.t, byClass, allGrid) });
      if (isPin(cls) && r.inliers >= 8 && r.inliers / A.length >= 0.9) strong = true;
    }
    if (strong || Date.now() - started > budgetMs) break;
  }
  if (!candidates.length) return null;
  candidates.sort((x, y) => y.hits - x.hits || y.inliers - x.inliers || x.err - y.err);
  return candidates[0];
}

if (typeof self !== 'undefined' && typeof window === 'undefined') {
  // Worker context: one job at a time.
  self.onmessage = e => {
    const { byClass, cats, prev, budgetMs } = e.data;
    let result = null;
    if (prev && byClass[prev.cls] && cats.find(c => c.id === prev.catId)) {
      const A = byClass[prev.cls], pts = cats.find(c => c.id === prev.catId).pts;
      const r = registerSets(A, pts, Date.now() + 3000);
      result = (r && r.inliers >= Math.min(prev.inliers, A.length * 0.7)) ? { ...r, cls: prev.cls, catId: prev.catId, n: A.length, m: pts.length } : prev;
    } else {
      result = searchCalibration(byClass, cats, budgetMs || 20000);
    }
    self.postMessage(result);
  };
}
