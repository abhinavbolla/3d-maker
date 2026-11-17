// Measuring parts from their distance functions, not from their meshes: the
// volume and centre of mass of a solid, and how close two solids come and
// where. Both search space in boxes the way the fit checks do (fit.js): a box
// whose centre is further from the surface than its own half-diagonal is
// wholly inside or wholly outside, and is settled without looking closer.
import { centre, split, deepest } from "./fit.js";
import { compile } from "./sdf.js";

// A worker's measuring job. what "solid": one part's volume and centre of
// mass ({ node }); what "gap": how close two parts come ({ a, b } nodes).
export function measureJob(job) {
  if (job.what === "solid") {
    const { f, box } = compile(job.node);
    if (!box.every(Number.isFinite) || !(box[3] > box[0])) return { volume: 0, centre: null, edgeShare: 0 };
    return solidMoments(f, box);
  }
  const A = compile(job.a), B = compile(job.b);
  const size = (b) => Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
  const region = [0, 1, 2].map((i) => Math.min(A.box[i], B.box[i])).concat([3, 4, 5].map((i) => Math.max(A.box[i], B.box[i])));
  // The finest detail looked for: 1/1000 of the smaller part, at least 0.01 mm.
  const cell = Math.max(0.01, Math.min(size(A.box), size(B.box)) / 1000);
  return { ...nearestPoints(A.f, B.f, region, { cell }), cell };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The volume (mm3) of the solid f < 0 inside box, its centre of mass, and
// the share of the volume that came from boxes the surface passes through
// (where the answer is estimated rather than counted). Space is split level
// by level down to boxes about 1/cells of the part's longest side; if the
// next level would take more than maxEvals, the boxes reached so far are
// estimated as they are, so the answer always covers the whole part.
// A box the surface passes through is split into eight; each eighth counts
// by how far its centre is inside, 0.5 - f / edge (exact for a face square
// to an axis), clamped to 0..1.
export function solidMoments(f, box, { cells = 128, maxEvals = 1500000 } = {}) {
  const longest = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
  const cell = longest / cells;
  let volume = 0, edgeVolume = 0, evals = 0;
  let mx = 0, my = 0, mz = 0;
  let level = [box.slice()];
  while (level.length) {
    const next = [];
    const last = evals + level.length * 9 > maxEvals;
    for (const b of level) {
      const [cx, cy, cz, r, big, hx, hy, hz] = centre(b);
      const d = f(cx, cy, cz);
      evals++;
      if (d > r) continue;
      const v = 8 * hx * hy * hz;
      if (d < -r) {
        volume += v;
        mx += v * cx;
        my += v * cy;
        mz += v * cz;
        continue;
      }
      if (big * 2 > cell && !last) {
        split(b, next, hx, hy, hz, big);
        continue;
      }
      const edge = (hx + hy + hz) / 3; // an eighth's edge, on average
      for (let i = 0; i < 8; i++) {
        const x = cx + (i & 1 ? hx : -hx) / 2, y = cy + (i & 2 ? hy : -hy) / 2, z = cz + (i & 4 ? hz : -hz) / 2;
        const share = (v / 8) * clamp01(0.5 - f(x, y, z) / edge);
        volume += share;
        edgeVolume += share;
        mx += share * x;
        my += share * y;
        mz += share * z;
      }
      evals += 8;
    }
    level = next;
  }
  const com = volume > 0 ? [mx / volume, my / volume, mz / volume] : null;
  return { volume, centre: com, edgeShare: volume > 0 ? edgeVolume / volume : 0, evals };
}

// The direction f grows fastest at p, by central differences of step h.
function gradient(f, [x, y, z], h) {
  const g = [f(x + h, y, z) - f(x - h, y, z), f(x, y + h, z) - f(x, y - h, z), f(x, y, z + h) - f(x, y, z - h)];
  const n = Math.hypot(g[0], g[1], g[2]);
  return n > 0 ? g.map((v) => v / n) : null;
}
// The nearest point of the surface f = 0 to p, by a few Newton steps along
// the gradient. Returns null when it does not settle on the surface.
function onto(f, p, h, tol) {
  let q = p.slice();
  for (let k = 0; k < 12; k++) {
    const d = f(q[0], q[1], q[2]);
    if (Math.abs(d) <= tol) return q;
    const g = gradient(f, q, h);
    if (!g) return null;
    q = [q[0] - d * g[0], q[1] - d * g[1], q[2] - d * g[2]];
  }
  return Math.abs(f(q[0], q[1], q[2])) <= tol * 4 ? q : null;
}

// How close two solids come: { gap, a, b } with the nearest points on each,
// or { overlap, at } when they pass into each other (overlap: how deep, mm).
// region: a box holding both. cell: the finest detail searched for.
// The search (fit.js's deepest) finds the point where max(fa, fb) is lowest,
// which for true distances is midway between the nearest points. From there
// each surface is reached along its gradient, and then the two points are
// moved in turn to the nearest point of the other surface until they settle.
// The gap is the distance between two points on the two surfaces, so it can
// only be more than the true gap, never less, by the search's tolerance.
export function nearestPoints(fa, fb, region, { cell }) {
  const r = deepest(fa, fb, region, { cell, gap: true });
  if (!r.at) return null;
  if (r.m < 0) return { overlap: -2 * r.m, at: r.at };
  const h = cell / 8, tol = cell / 100;
  let a = onto(fa, r.at, h, tol), b = onto(fb, r.at, h, tol);
  if (!a || !b) return { gap: 2 * r.m, least: 2 * r.m, a: null, b: null, at: r.at };
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  let best = { gap: dist(a, b), a, b };
  for (let k = 0; k < 24; k++) {
    const b2 = onto(fb, a, h, tol);
    const a2 = b2 && onto(fa, b2, h, tol);
    if (!a2) break;
    const g = dist(a2, b2);
    if (g < best.gap - tol) best = { gap: g, a: a2, b: b2 };
    else {
      if (g < best.gap) best = { gap: g, a: a2, b: b2 };
      break;
    }
    a = a2;
  }
  // least: what the search found, which is never more than the true gap
  // (for shapes whose distances are true distances, it is the gap itself).
  return { ...best, least: 2 * r.m };
}
