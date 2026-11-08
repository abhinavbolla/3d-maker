// How parts fit together: where two solids pass into each other (how much,
// how deep and where), and how close two parts come. Works on the distance
// functions directly, so it needs no meshes: space is split into boxes, and a
// box is settled as soon as the distances at its centre show it is wholly
// inside both parts, or outside one of them.
//
// For exact distance functions, the deepest point of an overlap is inside
// both parts by half the overlap's thickness, and the nearest point between
// two apart parts is half the gap from each. So with m = min over space of
// max(fa, fb): overlap thickness = -2m, gap = 2m.
import { compileForFit } from "./sdf.js";

// Pose matrices (3x4, rest -> world) and their inverses (rigid motions).
const invert = (m) => [
  m[0], m[4], m[8], -(m[0] * m[3] + m[4] * m[7] + m[8] * m[11]),
  m[1], m[5], m[9], -(m[1] * m[3] + m[5] * m[7] + m[9] * m[11]),
  m[2], m[6], m[10], -(m[2] * m[3] + m[6] * m[7] + m[10] * m[11]),
];
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const mul = (a, b) => {
  const o = new Array(12);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++) o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
  return o;
};
export function posed(f, m) {
  if (!m) return f;
  const w = invert(m);
  return (x, y, z) => f(w[0] * x + w[1] * y + w[2] * z + w[3], w[4] * x + w[5] * y + w[6] * z + w[7], w[8] * x + w[9] * y + w[10] * z + w[11]);
}
export function worldBox(b, m) {
  if (!m) return b;
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]];
    for (let r = 0; r < 3; r++) {
      const v = m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3];
      out[r] = Math.min(out[r], v);
      out[r + 3] = Math.max(out[r + 3], v);
    }
  }
  return out;
}
export const boxesMeet = (a, b, pad = 0) => a[0] <= b[3] + pad && b[0] <= a[3] + pad && a[1] <= b[4] + pad && b[1] <= a[4] + pad && a[2] <= b[5] + pad && b[2] <= a[5] + pad;

// The lowest value of max(fa, fb) within region, to within cell / 4, and
// where it is: below 0 the parts overlap, above 0 they are apart. Boxes are
// searched most promising first, and boxes that cannot hold anything lower
// are dropped, so this takes a few thousand steps. With gap: false it stops
// as soon as it is clear the parts do not overlap.
export function deepest(fa, fb, region, { cell, gap = false, maxEvals = 300000 }) {
  let best = Infinity, at = null, evals = 0;
  const tol = cell / 4;
  const heap = new Heap();
  heap.push(region, -Infinity);
  while (heap.size && evals < maxEvals) {
    const floor = gap ? best - tol : Math.min(best - tol, 0);
    if (heap.peekKey() >= floor) break;
    const b = heap.pop();
    const [cx, cy, cz, r, big, hx, hy, hz] = centre(b);
    const a = fa(cx, cy, cz);
    evals++;
    if (a - r >= floor) continue;
    const c = fb(cx, cy, cz);
    evals++;
    const m = Math.max(a, c);
    if (m < best) (best = m), (at = [cx, cy, cz]);
    if (big * 2 <= cell) continue;
    // Each child's lower bound: this box's value less the distance to the
    // child's far corner.
    const kids = [];
    split(b, kids, hx, hy, hz, big);
    for (const k of kids) {
      const [kx, ky, kz, kr] = centre(k);
      const lower = m - Math.hypot(kx - cx, ky - cy, kz - cz) - kr;
      if (lower < (gap ? best - tol : Math.min(best - tol, 0))) heap.push(k, lower);
    }
  }
  return { m: best, at, complete: evals < maxEvals };
}

// A binary min-heap of boxes keyed by a lower bound.
class Heap {
  constructor() {
    this.items = [];
    this.keys = [];
  }
  get size() {
    return this.items.length;
  }
  peekKey() {
    return this.keys[0];
  }
  push(item, key) {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      items[i] = items[p];
      keys[i] = keys[p];
      i = p;
    }
    items[i] = item;
    keys[i] = key;
  }
  pop() {
    const { items, keys } = this;
    const top = items[0];
    const item = items.pop(), key = keys.pop();
    if (items.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= items.length) break;
        if (c + 1 < items.length && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        items[i] = items[c];
        keys[i] = keys[c];
        i = c;
      }
      items[i] = item;
      keys[i] = key;
    }
    return top;
  }
}

// The volume of the overlap of two solids within region (mm3), and the box
// around it. Space is split level by level down to boxes of edge cell where
// the overlap's surface is; if the next level would take more than maxEvals,
// the boxes reached so far are counted as they are, so the answer always
// covers the whole region.
export function overlapVolume(fa, fb, region, { cell, maxEvals = 400000 }) {
  let volume = 0, evals = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let level = [region];
  while (level.length) {
    const next = [];
    const last = evals + level.length * 32 > maxEvals;
    for (const b of level) {
      const [cx, cy, cz, r, big, hx, hy, hz] = centre(b);
      const a = fa(cx, cy, cz);
      evals++;
      if (a > r) continue;
      const c = fb(cx, cy, cz);
      evals++;
      const m = Math.max(a, c);
      if (m > r) continue;
      if (m >= -r && big * 2 > cell && !last) {
        split(b, next, hx, hy, hz, big);
        continue;
      }
      // A box the overlap's surface passes through counts by the share of
      // its eight octant centres inside both parts. (Where two faces just
      // touch, none are.)
      let share = 1;
      if (m >= -r) {
        share = 0;
        for (let i = 0; i < 8; i++) {
          const x = cx + (i & 1 ? hx : -hx) / 2, y = cy + (i & 2 ? hy : -hy) / 2, z = cz + (i & 4 ? hz : -hz) / 2;
          if (fa(x, y, z) < 0 && fb(x, y, z) < 0) share += 1 / 8;
        }
        evals += 16;
      }
      if (share > 0) {
        volume += 8 * hx * hy * hz * share;
        for (let i = 0; i < 3; i++) (lo[i] = Math.min(lo[i], b[i])), (hi[i] = Math.max(hi[i], b[i + 3]));
      }
    }
    level = next;
  }
  return { volume, box: volume > 0 ? [...lo, ...hi] : null };
}

function centre(b) {
  const hx = (b[3] - b[0]) / 2, hy = (b[4] - b[1]) / 2, hz = (b[5] - b[2]) / 2;
  return [b[0] + hx, b[1] + hy, b[2] + hz, Math.hypot(hx, hy, hz), Math.max(hx, hy, hz), hx, hy, hz];
}
// Halves the long sides, so boxes stay about cube-shaped.
function split(b, stack, hx, hy, hz, big) {
  const cuts = [hx > big / 1.5, hy > big / 1.5, hz > big / 1.5];
  const mid = [b[0] + hx, b[1] + hy, b[2] + hz];
  for (let i = 0; i < 8; i++) {
    if ((i & 1 && !cuts[0]) || (i & 2 && !cuts[1]) || (i & 4 && !cuts[2])) continue;
    const k = b.slice();
    for (let d = 0; d < 3; d++) if (cuts[d]) i & (1 << d) ? (k[d] = mid[d]) : (k[d + 3] = mid[d]);
    stack.push(k);
  }
}

const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;
const sig3 = (v) => Number(v.toPrecision(3));
// Overlaps thinner than this are surfaces that touch, not parts passing into each other.
export const TOUCH_MM = 0.1;

// Checks pairs of parts for overlap, and for one pair the closest approach.
// parts: [{ name, node, box, frames (Float32Array n x 12 or null) }]
// pairs: [[i, j], ...]; frames: frame indices to test (for moving parts);
// loop: seconds, frameCount: frames in the loop.
// joints: [{ a, b, point }] from the script. Two parts joined at a point are
// pinned together there, so their overlap close around it is left out: within
// twice the depth of the point inside either part.
export function checkPairs(parts, pairs, { frames = [0], frameCount = 0, loop = 0, gap = false, joints = [] } = {}) {
  const compiled = parts.map((p) => compileForFit(p.node));
  const poseAt = (p, i) => (p.frames && frameCount ? Array.from(p.frames.subarray(i * 12, i * 12 + 12)) : null);
  const out = [];
  for (const [i, j] of pairs) {
    const A = parts[i], B = parts[j];
    // Parts that move together (a blade and the hub it follows) only need
    // checking once.
    let times = [0];
    if ((A.frames || B.frames) && frameCount) {
      const rel = (t) => mul(invert(poseAt(A, t) ?? ID), poseAt(B, t) ?? ID);
      const r0 = rel(frames[0]);
      const size = Math.max(...[A.box, B.box].map((b) => Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2])), 1);
      if (frames.some((t) => rel(t).some((v, k) => Math.abs(v - r0[k]) * (k % 4 === 3 ? 1 : size) > 1e-3))) times = frames;
    }
    const moving = times.length > 1;
    // The finest detail worth finding: 1/200 of the smaller part, at least 0.05 mm.
    const size = (b) => Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    const cell = Math.max(0.05, Math.min(size(A.box), size(B.box)) / 200);
    const pins = joints
      .filter((q) => (q.a === A.name && q.b === B.name) || (q.a === B.name && q.b === A.name))
      .map((q) => ({ point: q.point, r: 2 * Math.max(0, -compiled[i].f(...q.point), -compiled[j].f(...q.point)) + cell }));
    let worst = null;
    for (const t of times) {
      const ma = poseAt(A, t), mb = poseAt(B, t);
      const ba = worldBox(A.box, ma), bb = worldBox(B.box, mb);
      if (!gap && !boxesMeet(ba, bb)) continue;
      const meet = [0, 1, 2].map((d) => Math.max(ba[d], bb[d])).concat([3, 4, 5].map((d) => Math.min(ba[d], bb[d])));
      const around = [0, 1, 2].map((d) => Math.min(ba[d], bb[d])).concat([3, 4, 5].map((d) => Math.max(ba[d], bb[d])));
      let fa = posed(compiled[i].f, ma);
      const fb = posed(compiled[j].f, mb);
      for (const p of pins) {
        const [px, py, pz] = ma ? [0, 1, 2].map((r) => ma[r * 4] * p.point[0] + ma[r * 4 + 1] * p.point[1] + ma[r * 4 + 2] * p.point[2] + ma[r * 4 + 3]) : p.point;
        const f0 = fa;
        fa = (x, y, z) => Math.max(f0(x, y, z), p.r - Math.hypot(x - px, y - py, z - pz));
      }
      // Over many moments, a quick look at each (the deepest overlaps are
      // searched first), then a full search at the worst one.
      const region = gap ? around : meet;
      const r = deepest(fa, fb, region, { cell, gap, maxEvals: moving ? 1500 : undefined });
      if (!worst || r.m < worst.m) worst = { ...r, frame: t, fa, fb, region, meet };
    }
    if (worst && moving) worst = { ...worst, ...deepest(worst.fa, worst.fb, worst.region, { cell, gap }) };
    if (!worst) continue;
    const res = { a: A.name, b: B.name };
    if (pins.length) res.joints = pins.length;
    const thick = -2 * worst.m;
    if (thick > TOUCH_MM) {
      // Volume at the worst moment, in boxes half as big as the overlap is thick,
      // but no coarser than 1/50 of the region.
      const reg = worst.meet;
      const vcell = Math.max(cell, Math.min(thick / 2, Math.max(reg[3] - reg[0], reg[4] - reg[1], reg[5] - reg[2]) / 50));
      const v = overlapVolume(worst.fa, worst.fb, reg, { cell: vcell });
      res.overlap_mm = r2(thick);
      res.volume_cm3 = sig3(v.volume / 1000);
      if (v.box) res.where = { min: v.box.slice(0, 3).map(r1), max: v.box.slice(3).map(r1) };
    } else if (gap) res.gap_mm = r2(Math.max(0, 2 * worst.m));
    else continue;
    if (moving && frameCount) res.at_seconds = r2((worst.frame / frameCount) * loop);
    out.push(res);
  }
  return out;
}
