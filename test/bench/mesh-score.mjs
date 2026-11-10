// Compares a generated mesh with a ground-truth mesh the way CADPrompt
// (Alrashedy et al., ICLR 2025) does: both are scaled into the unit cube,
// sampled to 1,000 surface points, aligned with ICP, then scored by
//   pc     point-cloud distance: the mean nearest-neighbour distance, averaged
//          over both directions (lower is better; a failed model counts √3)
//   haus   Hausdorff distance: the worst nearest-neighbour distance
//   iogt   the generated bounding box's overlap with the ground truth's,
//          over the ground truth's volume (higher is better; failed = 0)
// Written from the paper's description; it ships no scoring code, so small
// differences from the published numbers are possible.
// Usage: node test/bench/mesh-score.mjs generated.stl ground_truth.stl
import { readFileSync } from "node:fs";

export const FAILED = { pc: Math.sqrt(3), haus: Math.sqrt(3), iogt: 0 };

// ---- STL reading (binary or ASCII) -> flat triangle list [x,y,z × 3] ----
export function readSTL(path) {
  const buf = readFileSync(path);
  const n = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
  if (buf.length === 84 + n * 50) {
    const tris = new Float64Array(n * 9);
    for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) tris[i * 9 + k] = buf.readFloatLE(84 + i * 50 + 12 + k * 4);
    return tris;
  }
  const nums = [];
  for (const m of buf.toString("latin1").matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) nums.push(+m[1], +m[2], +m[3]);
  return Float64Array.from(nums);
}

// A small seeded random source, so scores repeat exactly.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s + 0x6d2b79f5) >>> 0), (((s ^ (s >>> 15)) * (s | 1)) >>> 0) / 4294967296);
}

// Points spread over the surface in proportion to area.
export function sample(tris, count = 1000, seed = 1) {
  const n = tris.length / 9, cum = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    total += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    cum[i] = total;
  }
  const r = rng(seed), pts = [];
  for (let k = 0; k < count; k++) {
    const t = r() * total;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < t) lo = mid + 1; else hi = mid; }
    let a = r(), b = r();
    if (a + b > 1) { a = 1 - a; b = 1 - b; }
    const o = lo * 9;
    pts.push([0, 1, 2].map((j) => tris[o + j] + a * (tris[o + 3 + j] - tris[o + j]) + b * (tris[o + 6 + j] - tris[o + j])));
  }
  return pts;
}

const bounds = (pts) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let j = 0; j < 3; j++) { min[j] = Math.min(min[j], p[j]); max[j] = Math.max(max[j], p[j]); }
  return { min, max };
};

// Centre on the bounding box and scale the longest side to 1.
export function normalise(pts) {
  const { min, max } = bounds(pts);
  const c = min.map((v, j) => (v + max[j]) / 2), s = Math.max(...max.map((v, j) => v - min[j])) || 1;
  return pts.map((p) => p.map((v, j) => (v - c[j]) / s));
}

function nearest(a, b) {
  const idx = new Int32Array(a.length), dist = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const [x, y, z] = a[i];
    let best = Infinity, bi = 0;
    for (let k = 0; k < b.length; k++) {
      const dx = b[k][0] - x, dy = b[k][1] - y, dz = b[k][2] - z, d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; bi = k; }
    }
    idx[i] = bi;
    dist[i] = Math.sqrt(best);
  }
  return { idx, dist };
}

// Largest eigenvector of a symmetric 4x4 matrix (Jacobi rotations).
function topEigen(m) {
  const a = m.map((r) => r.slice()), v = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 4; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 4; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return [0, 1, 2, 3].map((k) => v[k][best]);
}

// The rotation and shift that best move points `src` onto `dst` (Horn 1987).
function rigid(src, dst) {
  const n = src.length, cs = [0, 0, 0], cd = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) { cs[j] += src[i][j] / n; cd[j] += dst[i][j] / n; }
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += (src[i][r] - cs[r]) * (dst[i][c] - cd[c]);
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const [w, x, y, z] = topEigen([
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ]);
  const R = [
    [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
  ];
  const t = [0, 1, 2].map((r) => cd[r] - (R[r][0] * cs[0] + R[r][1] * cs[1] + R[r][2] * cs[2]));
  return (p) => [0, 1, 2].map((r) => R[r][0] * p[0] + R[r][1] * p[1] + R[r][2] * p[2] + t[r]);
}

export function icp(src, dst, iterations = 40) {
  let cur = src, last = Infinity;
  for (let it = 0; it < iterations; it++) {
    const { idx, dist } = nearest(cur, dst);
    const err = dist.reduce((s, d) => s + d, 0) / dist.length;
    if (Math.abs(last - err) < 1e-7) break;
    last = err;
    const move = rigid(cur, Array.from(idx, (k) => dst[k]));
    cur = cur.map(move);
  }
  return cur;
}

export function metrics(gen, gt) {
  const a = nearest(gen, gt).dist, b = nearest(gt, gen).dist;
  const mean = (d) => d.reduce((s, v) => s + v, 0) / d.length;
  const bg = bounds(gen), bt = bounds(gt);
  let inter = 1, vol = 1;
  for (let j = 0; j < 3; j++) {
    inter *= Math.max(0, Math.min(bg.max[j], bt.max[j]) - Math.max(bg.min[j], bt.min[j]));
    vol *= Math.max(bt.max[j] - bt.min[j], 1e-9);
  }
  return { pc: (mean(a) + mean(b)) / 2, haus: Math.max(...a, ...b), iogt: Math.min(1, inter / vol) };
}

// The 24 ways to turn a box onto its faces, as starting poses for ICP.
const TURNS = (() => {
  const out = [], seen = new Set();
  const rx = (p) => [p[0], -p[2], p[1]], ry = (p) => [p[2], p[1], -p[0]], rz = (p) => [-p[1], p[0], p[2]];
  const queue = [(p) => p];
  while (queue.length) {
    const f = queue.shift(), key = JSON.stringify([f([1, 2, 3])]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
    for (const r of [rx, ry, rz]) queue.push((p) => r(f(p)));
  }
  return out;
})();

// Scores one pair. `as_built` starts ICP from the model's own orientation (the
// CADPrompt protocol); `any_turn` also tries the 23 other right-angle turns
// and keeps the best, for when a part was built standing on another face.
export function score(genPath, gtPath) {
  const gt = normalise(sample(readSTL(gtPath), 1000, 2));
  const gen = normalise(sample(readSTL(genPath), 1000, 1));
  const asBuilt = metrics(icp(gen, gt), gt);
  let anyTurn = asBuilt;
  for (const turn of TURNS.slice(1)) {
    const m = metrics(icp(gen.map(turn), gt), gt);
    if (m.pc < anyTurn.pc) anyTurn = m;
  }
  return { as_built: asBuilt, any_turn: anyTurn };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [gen, gt] = process.argv.slice(2);
  if (!gen || !gt) {
    console.error("Usage: node test/bench/mesh-score.mjs generated.stl ground_truth.stl");
    process.exit(2);
  }
  console.log(JSON.stringify(score(gen, gt), null, 1));
}
