// Turns a distance function into a closed triangle mesh.
//
// 1. Coarse-to-fine search: a cell can only touch the surface if |f(centre)|
//    is at most its half diagonal, so empty space is skipped level by level
//    until the next level would exceed the cell budget.
// 2. Dual contouring on the finest cells: one vertex per surface patch in a
//    cell, placed where the surface tangent planes meet, so sharp edges and
//    corners stay sharp. Ambiguous cell faces are resolved the same way from
//    both sides, and each patch gets its own vertex, which keeps the mesh
//    closed. The search follows the surface from cell to cell, so no part of
//    it can be dropped at the edge of the search area.

const OFF = 32768;
const K = 65536;
const key3 = (i, j, k) => ((i + OFF) * K + (j + OFF)) * K + (k + OFF);
const K2 = 131072;
const OFF2 = 65536;
const key3x2 = (i, j, k) => ((i + OFF2) * K2 + (j + OFF2)) * K2 + (k + OFF2);

const HALF_DIAG = Math.sqrt(3) / 2;
const THIN_CAP = 6;
// Walls thinner than a cell hidden in more than this share of the cells:
// refine. A few (a thin lip in one spot) stay as they were.
const WALLS = 0.01;
// Hidden in more than this share, a wall would go missing over much of the
// part: refine on if cells fine enough for it fit in WALL_CAP times the
// budget (and in maxCells), or else draw it thicker (see meshGrid).
const LOST = 0.05;
const WALL_CAP = 16;

// Fraction of cells with detail thinner than the cell that the mesh would
// miss: the centre is on the other side of the surface from all eight
// corners, or a wall passes between the two ends of a cell edge without
// changing its sign. The second is found from the distances themselves: an
// edge is clear when the empty balls around its ends (radius |f|) cover it;
// where they do not, it is split and its middle tested, a few times over.
// A plate thinner than a cell and lying between grid planes is found this
// way even when every corner and centre is outside it. An edge that only
// grazes a curved surface also dips inside it; that is not a wall, and the
// two are told apart by which way the surface faces at the two ends: away
// from each other across a wall, the same way (or at most square, at a
// corner) across a graze.
const GAP_DEPTH = 4;
const WALL_COS = -0.8;
const HIT = new Float64Array(4); // the point inside a hidden wall, and f there
function hiddenCrossing(f, x0, y0, z0, x1, y1, z1, f0, f1, depth) {
  const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  if (Math.abs(f0) + Math.abs(f1) >= len) return false;
  const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2, zm = (z0 + z1) / 2;
  const fm = f(xm, ym, zm);
  if (fm < 0 !== f0 < 0) {
    (HIT[0] = xm), (HIT[1] = ym), (HIT[2] = zm), (HIT[3] = fm);
    return true;
  }
  if (!depth) return false;
  return hiddenCrossing(f, x0, y0, z0, xm, ym, zm, f0, fm, depth - 1) || hiddenCrossing(f, xm, ym, zm, x1, y1, z1, fm, f1, depth - 1);
}
function gradientAt(f, x, y, z, e, out) {
  const a = f(x + e, y - e, z - e), b = f(x - e, y - e, z + e), d = f(x - e, y + e, z - e), g = f(x + e, y + e, z + e);
  const nx = a - b - d + g, ny = -a - b + d + g, nz = -a + b - d + g;
  const l = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / l;
  out[1] = ny / l;
  out[2] = nz / l;
}
const G0 = new Float64Array(3), G1 = new Float64Array(3);
function wallInEdge(f, x0, y0, z0, x1, y1, z1, f0, f1, c) {
  if (!hiddenCrossing(f, x0, y0, z0, x1, y1, z1, f0, f1, GAP_DEPTH)) return false;
  gradientAt(f, x0, y0, z0, c * 0.01, G0);
  gradientAt(f, x1, y1, z1, c * 0.01, G1);
  return G0[0] * G1[0] + G0[1] * G1[1] + G0[2] * G1[2] < WALL_COS;
}
// How thick the wall is through the point HIT inside it: its depth there,
// plus how far it is to the other side, found by stepping against the
// surface normal by the distance each time.
function wallThickness(f, c) {
  const [x, y, z, d] = HIT;
  gradientAt(f, x, y, z, c * 0.001, G0);
  let s = 0;
  for (let it = 0; it < 16; it++) {
    const v = f(x - G0[0] * s, y - G0[1] * s, z - G0[2] * s);
    if (v >= -c * 0.01) break;
    s += -v;
  }
  return -d + s;
}
function missedDetail(f, O, c, kept, centres, withWalls = true, vals = new Map()) {
  const at = (i, j, k) => {
    const key = key3(i, j, k);
    let v = vals.get(key);
    if (v === undefined) vals.set(key, (v = f(O[0] + i * c, O[1] + j * c, O[2] + k * c)));
    return v;
  };
  const gaps = new Map(); // edge key -> a wall hides inside it
  const cv = new Float64Array(8);
  const thick = []; // a sample of the hidden walls' thicknesses
  let slivers = 0, walls = 0;
  for (let n = 0, m = 0; n < kept.length; n += 3, m++) {
    const i = kept[n], j = kept[n + 1], k = kept[n + 2];
    const inside = centres[m] < 0;
    let all = true;
    for (let q = 0; q < 8; q++) {
      cv[q] = at(i + (q & 1), j + ((q >> 1) & 1), k + ((q >> 2) & 1));
      if (cv[q] < 0 === inside) all = false;
    }
    if (all) {
      slivers++;
      // Solid at the centre, outside at every corner: a wall too.
      if (inside && withWalls) {
        walls++;
        if (thick.length < 64) {
          const [i0, j0, k0] = [i + 0.5, j + 0.5, k + 0.5];
          (HIT[0] = O[0] + i0 * c), (HIT[1] = O[1] + j0 * c), (HIT[2] = O[2] + k0 * c), (HIT[3] = centres[m]);
          thick.push(wallThickness(f, c));
        }
      }
      continue;
    }
    if (!withWalls) continue;
    // Only solid walls between two outside corners: a slot thinner than a
    // cell fills in, which loses no material.
    for (let e = 0; e < 12; e++) {
      const [c0, c1] = EDGE_CORNERS[e];
      const f0 = cv[c0], f1 = cv[c1];
      if (f0 < 0 || f1 < 0 || f0 + f1 >= c) continue;
      const a = e >> 2;
      const ci = i + (c0 & 1), cj = j + ((c0 >> 1) & 1), ck = k + ((c0 >> 2) & 1);
      const ekey = key3(ci, cj, ck) * 3 + a;
      let g = gaps.get(ekey);
      if (g === undefined) {
        const x0 = O[0] + ci * c, y0 = O[1] + cj * c, z0 = O[2] + ck * c;
        const dx = a === 0 ? c : 0, dy = a === 1 ? c : 0, dz = a === 2 ? c : 0;
        // First, cheaply: a wall between the ends has the distance falling
        // from both ends into the edge, so rising away from it on both sides
        // (told by the grid corners beyond, which are mostly known already).
        // Most edges near a surface run along it, where it does not.
        const s = 0.02;
        const ai = a === 0 ? 1 : 0, aj = a === 1 ? 1 : 0, ak = a === 2 ? 1 : 0;
        g =
          at(ci - ai, cj - aj, ck - ak) > f0 + 0.3 * c &&
          at(ci + 2 * ai, cj + 2 * aj, ck + 2 * ak) > f1 + 0.3 * c &&
          f(x0 + dx * s, y0 + dy * s, z0 + dz * s) < f0 - 0.3 * s * c &&
          f(x0 + dx * (1 - s), y0 + dy * (1 - s), z0 + dz * (1 - s)) < f1 - 0.3 * s * c &&
          wallInEdge(f, x0, y0, z0, x0 + dx, y0 + dy, z0 + dz, f0, f1, c);
        gaps.set(ekey, g);
        if (g && thick.length < 64) thick.push(wallThickness(f, c));
      }
      if (g) {
        walls++;
        break;
      }
    }
  }
  thick.sort((a, b) => a - b);
  // The thinner walls count: a quarter of the way up the sample.
  return { slivers: slivers / centres.length, walls: walls / centres.length, thickness: thick.length ? thick[thick.length >> 2] : 0 };
}

// Local cell edges: e = axis * 4 + ub + 2 * vb, with u = (axis + 1) % 3, v = (axis + 2) % 3.
const EDGE_CORNERS = []; // [c0, c1] local corner indices (bit0 x, bit1 y, bit2 z)
for (let a = 0; a < 3; a++) {
  const u = (a + 1) % 3, v = (a + 2) % 3;
  for (let vb = 0; vb < 2; vb++)
    for (let ub = 0; ub < 2; ub++) {
      const base = (ub << u) | (vb << v);
      EDGE_CORNERS[a * 4 + ub + 2 * vb] = [base, base | (1 << a)];
    }
}
// Faces: for axis a and side s, corners C00, C10, C11, C01 and edges E0..E3 in cyclic order.
const FACES = [];
for (let a = 0; a < 3; a++) {
  const u = (a + 1) % 3, v = (a + 2) % 3;
  for (let s = 0; s < 2; s++) {
    const corner = (cu, cv) => (s << a) | (cu << u) | (cv << v);
    FACES.push({
      a, s, u, v,
      corners: [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)],
      edges: [u * 4 + 0 + 2 * s, v * 4 + s + 2, u * 4 + 1 + 2 * s, v * 4 + s],
    });
  }
}

const EMPTY_MESH = () => ({ positions: new Float32Array(0), indices: new Uint32Array(0), normals: new Float32Array(0), cellSize: 0 });

// budget: about how many surface cells to aim for. maxCell: refine, even past
// the budget, until cells are about this small (mm; cells halve each level,
// so they end up at most 1.41x maxCell), so the big parts of a model are as
// detailed as the small ones. maxCells: hard cap.
// A flat part (a blade, a wing, a plate) is thin along one axis only. Cells
// fine enough for its thickness everywhere would cost far too many, and cells
// sized by its area leave its thin edges thinner than a cell, where they come
// out bitten. So such a part is meshed stretched along its thin axis, up to
// 8x, and the mesh squeezed back: its cells are that much finer through the
// thickness while its broad faces, which are most of its surface, need few
// more of them. (A blade's box is also deepened by its twist, so the stretch
// is up to twice how flat its box is.)
const MAX_STRETCH = 8;
export function stretchFor(box) {
  const ext = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
  const order = [0, 1, 2].sort((a, b) => ext[a] - ext[b]);
  const thin = ext[order[0]], mid = ext[order[1]];
  if (!(thin > 0) || mid / thin < 3) return null;
  const s = [1, 1, 1];
  s[order[0]] = Math.min(MAX_STRETCH, (2 * mid) / thin);
  return s;
}

// Only parts whose plain mesh misses thin slivers (blades and wings, which
// taper to an edge) or whole walls (a plate thinner than the cells) are
// meshed again stretched; a thicker plate's square edges come out sharp
// either way, and stretched it would spend cells on its sides.
const SLIVERS = 0.001;
export function meshSDF(f, box, opts = {}) {
  const s = stretchFor(box);
  if (!s) return meshGrid(f, box, opts);
  // The search alone (no surface yet) says the cell size and what it misses.
  const probe = meshGrid(f, box, opts, null, true);
  if (!(probe.slivers > SLIVERS || probe.walls > LOST)) return meshGrid(f, box, opts);
  // Never coarser along the broad faces than the plain mesh would be.
  const stretched = meshGrid(f, box, { ...opts, maxCell: Math.min(opts.maxCell ?? Infinity, probe.cellSize) }, s);
  return stretched.incomplete || stretched.cellSize > probe.cellSize * 1.01 ? meshGrid(f, box, opts) : stretched;
}

function meshGrid(fw, boxw, { budget = 40000, maxCells = 3_000_000, normals = false, minCell = 0, maxCell = Infinity } = {}, stretch = null, probe = false) {
  // Stretched (see stretchFor): the grid works on the shape stretched by S.
  // Distances are measured before the stretch, so they never exceed the
  // stretched ones: still a safe underestimate for the search.
  const S = stretch ?? [1, 1, 1];
  let f = stretch ? (x, y, z) => fw(x / S[0], y / S[1], z / S[2]) : fw;
  const box = stretch ? [boxw[0] * S[0], boxw[1] * S[1], boxw[2] * S[2], boxw[3] * S[0], boxw[4] * S[1], boxw[5] * S[2]] : boxw;
  const ext = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
  const L = Math.max(...ext);
  if (!(L > 0) || !Number.isFinite(L)) return EMPTY_MESH();

  // ---- 1. coarse-to-fine search ----
  const pad = L * 0.01 + 1e-6;
  const O = [box[0] - pad, box[1] - pad, box[2] - pad];
  let c = (L + 2 * pad) / 8;
  const n0 = ext.map((e) => Math.max(1, Math.ceil((e + 2 * pad) / c)));
  let cells = [];
  for (let i = 0; i < n0[0]; i++) for (let j = 0; j < n0[1]; j++) for (let k = 0; k < n0[2]; k++) cells.push(i, j, k);

  // Lipschitz margin: smooth blends and scaled shapes are slight underestimates, never over.
  const LIP = 1.5;
  let kept, centres;
  let capped = false; // stopped by the cell cap
  let lost = null; // what was missed where cells stopped too coarse for walls
  // f at this level's grid corners: looking for missed detail fills it, and
  // dual contouring goes on from it at the last level.
  let levelVals = new Map();
  for (let level = 0; ; level++) {
    levelVals = new Map();
    kept = [];
    centres = [];
    const lim = LIP * c * HALF_DIAG;
    for (let n = 0; n < cells.length; n += 3) {
      const i = cells[n], j = cells[n + 1], k = cells[n + 2];
      const d = f(O[0] + (i + 0.5) * c, O[1] + (j + 0.5) * c, O[2] + (k + 0.5) * c);
      if (Math.abs(d) <= lim) kept.push(i, j, k), centres.push(d);
    }
    const count = kept.length / 3;
    if (!count) return EMPTY_MESH();
    if (c / 2 < minCell || level >= 14) break;
    // A finer level has about 4x the cells, and closing the surface visits
    // some neighbours too; stop while that still fits in maxCells.
    if (count * 4 * 1.5 > maxCells) {
      capped = true;
      break;
    }
    if (count * 4 > budget && c <= maxCell * Math.SQRT2) {
      // Over budget, but keep going (up to a cap) while thin walls or blades
      // still slip between the grid corners.
      const over = count * 4 > budget * THIN_CAP;
      if (over && probe) break;
      // Walls are only looked for when slivers alone would not refine (the
      // probe looks for slivers only: walls are what stretching is for).
      let md = missedDetail(f, O, c, kept, centres, over, levelVals);
      if (!over) {
        if (md.slivers <= 0.002 && (probe || (md = missedDetail(f, O, c, kept, centres, true, levelVals)).walls <= WALLS)) break;
      } else {
        // Past the cap, only for walls going missing over much of the part,
        // and only if cells fine enough for them fit under WALL_CAP.
        if (md.walls <= LOST) break;
        const need = count * (c / (0.9 * md.thickness)) ** 2;
        if (!(md.thickness > 0) || need > budget * WALL_CAP || need * 1.5 > maxCells) {
          lost = md;
          break;
        }
      }
    }
    cells = [];
    for (let n = 0; n < kept.length; n += 3) {
      const i = kept[n] * 2, j = kept[n + 1] * 2, k = kept[n + 2] * 2;
      for (let q = 0; q < 8; q++) cells.push(i + (q & 1), j + ((q >> 1) & 1), k + ((q >> 2) & 1));
    }
    c /= 2;
  }

  if (probe) {
    const md = missedDetail(f, O, c, kept, centres, true, levelVals);
    return { slivers: md.slivers, walls: md.walls, cellSize: c };
  }

  // Cells too coarse for a wall thinner than them (a thin tube, a tilted
  // sheet, a shell, at a small budget) would leave it in shreds or leave it
  // out. Then the surface is moved out just enough for the wall to be a bit
  // more than a cell thick, so it comes out whole: thicker than it is, but
  // there.
  if (capped) {
    const md = missedDetail(f, O, c, kept, centres, true, levelVals);
    if (md.walls > LOST) lost = md;
  }
  let thickened = 0;
  if (lost) {
    const fs = f;
    thickened = Math.max(0.05 * c, (1.1 * c - (lost.thickness || 0)) / 2);
    f = (x, y, z) => fs(x, y, z) - thickened;
  }

  // ---- 2. dual contouring at cell size c ----
  const cornerVals = lost ? new Map() : levelVals;
  const corner = (i, j, k) => {
    const key = key3(i, j, k);
    let v = cornerVals.get(key);
    if (v === undefined) {
      v = f(O[0] + i * c, O[1] + j * c, O[2] + k * c);
      cornerVals.set(key, v);
    }
    return v;
  };
  const faceVals = new Map();
  const faceCentre = (I, J, Kk) => {
    const key = key3x2(I, J, Kk);
    let v = faceVals.get(key);
    if (v === undefined) {
      v = f(O[0] + (I / 2) * c, O[1] + (J / 2) * c, O[2] + (Kk / 2) * c);
      faceVals.set(key, v);
    }
    return v;
  };

  const seen = new Set();
  const queue = [];
  const push = (i, j, k) => {
    const key = key3(i, j, k);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(i, j, k);
  };
  for (let n = 0; n < kept.length; n += 3) push(kept[n], kept[n + 1], kept[n + 2]);

  const active = new Map(); // cell key -> { i, j, k, vals, vtx }
  const edges = new Map(); // global edge key -> [i, j, k, axis, insideAtStart]
  const vals = new Float64Array(8);
  let incomplete = false;

  for (let q = 0; q < queue.length; q += 3) {
    if (seen.size > maxCells) {
      incomplete = true;
      break;
    }
    const i = queue[q], j = queue[q + 1], k = queue[q + 2];
    let mask = 0;
    for (let ci = 0; ci < 8; ci++) {
      vals[ci] = corner(i + (ci & 1), j + ((ci >> 1) & 1), k + ((ci >> 2) & 1));
      if (vals[ci] < 0) mask |= 1 << ci;
    }
    if (mask === 0 || mask === 255) continue;
    active.set(key3(i, j, k), { i, j, k, vals: Float64Array.from(vals), mask, vtx: new Int32Array(12).fill(-1) });
    for (let e = 0; e < 12; e++) {
      const [c0, c1] = EDGE_CORNERS[e];
      if (((mask >> c0) & 1) === ((mask >> c1) & 1)) continue;
      const a = e >> 2;
      const ci = i + (c0 & 1), cj = j + ((c0 >> 1) & 1), ck = k + ((c0 >> 2) & 1);
      const ekey = key3(ci, cj, ck) * 3 + a;
      if (edges.has(ekey)) continue;
      edges.set(ekey, [ci, cj, ck, a, (mask >> c0) & 1]);
      // The four cells around this edge all touch the surface.
      const u = (a + 1) % 3, v = (a + 2) % 3;
      const p = [ci, cj, ck];
      for (const [du, dv] of [[0, 0], [-1, 0], [-1, -1], [0, -1]]) {
        const cell = [...p];
        cell[u] += du;
        cell[v] += dv;
        push(cell[0], cell[1], cell[2]);
      }
    }
  }

  // Crossing point and surface normal on each sign-changing edge. Normals
  // come from the shape before the stretch (stretched, it changes faster
  // across than along, so samples near an edge would mix the two faces), and
  // are turned into the stretched space for placing vertices.
  const eps = (c * 0.002) / Math.max(...S);
  const worldNormal = (x, y, z, out, o) => {
    (x /= S[0]), (y /= S[1]), (z /= S[2]);
    const a = fw(x + eps, y - eps, z - eps), b = fw(x - eps, y - eps, z + eps), d = fw(x - eps, y + eps, z - eps), g = fw(x + eps, y + eps, z + eps);
    const nx = a - b - d + g, ny = -a - b + d + g, nz = -a + b - d + g;
    const len = Math.hypot(nx, ny, nz) || 1;
    out[o] = nx / len;
    out[o + 1] = ny / len;
    out[o + 2] = nz / len;
  };
  const grad = (x, y, z, out, o) => {
    worldNormal(x, y, z, out, o);
    if (!stretch) return;
    const nx = out[o] / S[0], ny = out[o + 1] / S[1], nz = out[o + 2] / S[2], len = Math.hypot(nx, ny, nz) || 1;
    out[o] = nx / len;
    out[o + 1] = ny / len;
    out[o + 2] = nz / len;
  };
  const hits = new Map(); // edge key -> Float64Array [px, py, pz, nx, ny, nz]
  const hit = (ekey) => {
    let h = hits.get(ekey);
    if (h) return h;
    const [i, j, k, a] = edges.get(ekey);
    const p0 = [O[0] + i * c, O[1] + j * c, O[2] + k * c];
    const at = (t) => {
      const p = [...p0];
      p[a] += t * c;
      return p;
    };
    const end = [i, j, k];
    end[a] += 1;
    // Regula falsi, Illinois variant: when one end keeps its place, its
    // value is halved, so it converges even where the distances on the two
    // sides grow at very different rates (thin walls, stretched meshes).
    let ta = 0, fa = corner(i, j, k), tb = 1, fb = corner(end[0], end[1], end[2]);
    let t = fa / (fa - fb), side = 0;
    for (let it = 0; it < 12; it++) {
      const ft = f(...at(t));
      if (Math.abs(ft) < c * 1e-6) break;
      if (ft < 0 === fa < 0) {
        (ta = t), (fa = ft);
        if (side === -1) fb /= 2;
        side = -1;
      } else {
        (tb = t), (fb = ft);
        if (side === 1) fa /= 2;
        side = 1;
      }
      if (tb - ta < 1e-5 || Math.abs(fa - fb) < 1e-12) break;
      t = ta + ((tb - ta) * fa) / (fa - fb);
    }
    h = new Float64Array(6);
    const p = at(t);
    h[0] = p[0];
    h[1] = p[1];
    h[2] = p[2];
    grad(p[0], p[1], p[2], h, 3);
    hits.set(ekey, h);
    return h;
  };

  // One vertex per surface patch in each active cell.
  const pos = [];
  const parent = new Int8Array(12);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const join = (x, y) => {
    x = find(x);
    y = find(y);
    if (x !== y) parent[x] = y;
  };
  const edgeKeyOf = (cell, e) => {
    const c0 = EDGE_CORNERS[e][0];
    return key3(cell.i + (c0 & 1), cell.j + ((c0 >> 1) & 1), cell.k + ((c0 >> 2) & 1)) * 3 + (e >> 2);
  };
  const crosses = (mask, e) => {
    const [c0, c1] = EDGE_CORNERS[e];
    return ((mask >> c0) & 1) !== ((mask >> c1) & 1);
  };

  for (const cell of active.values()) {
    const { mask } = cell;
    for (let e = 0; e < 12; e++) parent[e] = e;
    for (const face of FACES) {
      const ex = face.edges.filter((e) => crosses(mask, e));
      if (ex.length === 2) join(ex[0], ex[1]);
      else if (ex.length === 4) {
        const idx = [cell.i, cell.j, cell.k];
        const I = idx.map((x) => x * 2);
        I[face.a] += face.s * 2;
        I[face.u] += 1;
        I[face.v] += 1;
        const centreInside = faceCentre(I[0], I[1], I[2]) < 0;
        const c00Inside = ((mask >> face.corners[0]) & 1) === 1;
        const [E0, E1, E2, E3] = face.edges;
        if (centreInside === c00Inside) join(E0, E1), join(E2, E3);
        else join(E3, E0), join(E1, E2);
      }
    }
    const groups = new Map();
    for (let e = 0; e < 12; e++) {
      if (!crosses(mask, e)) continue;
      const r = find(e);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(e);
    }
    const lo = [O[0] + cell.i * c, O[1] + cell.j * c, O[2] + cell.k * c];
    let prev = null;
    for (const list of groups.values()) {
      const hs = list.map((e) => hit(edgeKeyOf(cell, e)));
      const v = solveVertex(hs, lo, c);
      // Two patches in one cell must not share a point.
      if (prev && Math.hypot(v[0] - prev[0], v[1] - prev[1], v[2] - prev[2]) < 0.01 * c) for (let a = 0; a < 3; a++) v[a] += (hs[0][a] - v[a]) * 0.1;
      prev = v;
      const index = pos.length / 3;
      pos.push(v[0], v[1], v[2]);
      for (const e of list) cell.vtx[e] = index;
    }
  }

  // One quad per sign-changing edge, joining the four cells around it.
  const idx = [];
  let missing = 0;
  const P = pos;
  const d2 = (a, b) => (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2;
  const OFFS = [[0, 0, 0], [1, 0, 1], [1, 1, 3], [0, 1, 2]]; // [du, dv, local ub + 2 vb] for cells (0,0) (-1,0) (-1,-1) (0,-1)
  for (const [i, j, k, a, insideAtStart] of edges.values()) {
    const u = (a + 1) % 3, v = (a + 2) % 3;
    const quad = [];
    for (const [du, dv, local] of OFFS) {
      const cc = [i, j, k];
      cc[u] -= du;
      cc[v] -= dv;
      const cell = active.get(key3(cc[0], cc[1], cc[2]));
      const vi = cell ? cell.vtx[a * 4 + local] : -1;
      if (vi < 0) break;
      quad.push(vi);
    }
    if (quad.length < 4) {
      missing++;
      continue;
    }
    if (!insideAtStart) quad.reverse();
    const [q0, q1, q2, q3] = quad;
    if (d2(q0, q2) <= d2(q1, q3)) idx.push(q0, q1, q2, q0, q2, q3);
    else idx.push(q1, q2, q3, q1, q3, q0);
  }

  splitPinches(pos, idx);
  const positions = Float32Array.from(pos);
  const out = { positions, indices: Uint32Array.from(idx), cellSize: c, incomplete: incomplete || missing > 0 };
  if (thickened) out.thickened = thickened / Math.max(...S);
  if (normals) {
    const nrm = new Float32Array(positions.length);
    for (let n = 0; n < pos.length; n += 3) worldNormal(pos[n], pos[n + 1], pos[n + 2], nrm, n);
    out.normals = nrm;
  }
  if (stretch) for (let n = 0; n < positions.length; n += 3) (positions[n] /= S[0]), (positions[n + 1] /= S[1]), (positions[n + 2] /= S[2]);
  return out;
}

// Over a fold steeper than the crease angle, the surface counts as smooth
// when no one of three steps turns its normal by more than this share of the
// whole turn (half of it, on an evenly curved surface).
const SMOOTH_STEP = 0.75;
// A copy of a mesh for drawing, with normals that keep sharp edges sharp.
// Around each vertex, neighbouring triangles that meet at less than the
// crease angle are one smooth patch; each patch gets its own copy of the
// vertex and its own normal.
// With the distance function f, a steeper fold between two triangles is
// tested on the surface itself: a small fillet turns its normal smoothly
// from one triangle to the next, a sharp edge all at once. So a fillet only
// a cell or two across is shaded round instead of in facets, and a sharp
// edge stays crisp. The normals come from f too: on a smooth patch the
// surface normal at the vertex; on a patch that ends at an edge, the normal
// a little way into that patch, which is its face's own normal.
// Without f, the true normals passed in are used where they agree with the
// triangles, and the patch's average elsewhere.
export function displayMesh({ positions: P, indices: I, normals: G }, creaseDeg = 40, f = null) {
  const nv = P.length / 3;
  const nt = I.length / 3;
  const fn = new Float64Array(nt * 3); // area-weighted face normals
  const un = new Float64Array(nt * 3); // unit face normals
  let size = 0; // mean edge length, for sampling f
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1;
    fn[t * 3] = x; fn[t * 3 + 1] = y; fn[t * 3 + 2] = z;
    un[t * 3] = x / l; un[t * 3 + 1] = y / l; un[t * 3 + 2] = z / l;
    if (t < 256) size += Math.hypot(ux, uy, uz);
  }
  size /= Math.min(nt, 256) || 1;
  // Triangles around each vertex (CSR).
  const start = new Uint32Array(nv + 1);
  for (let n = 0; n < I.length; n++) start[I[n] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const around = new Uint32Array(I.length);
  for (let n = 0; n < I.length; n++) around[fill[I[n]]++] = n; // corner index (t * 3 + r)

  // The surface normal near a point, from f: one step onto the surface, then
  // the gradient there.
  const e = size * 1e-3;
  const g4 = new Float64Array(4);
  const grad = (x, y, z, out) => {
    const a = f(x + e, y - e, z - e), b = f(x - e, y - e, z + e), d = f(x - e, y + e, z - e), g = f(x + e, y + e, z + e);
    let nx = a - b - d + g, ny = -a - b + d + g, nz = -a + b - d + g;
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l; out[3] = (a + b + d + g) / 4;
  };
  const surfaceNormal = (x, y, z, out) => {
    grad(x, y, z, g4);
    const s = g4[3];
    grad(x - g4[0] * s, y - g4[1] * s, z - g4[2] * s, out);
  };
  const centroid = (t, out) => {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) out[k] = (P[a + k] + P[b + k] + P[c + k]) / 3;
  };
  const triNormal = new Map(); // triangle -> normal of f at its centre
  const cpos = new Float64Array(3);
  const normalOfTri = (t) => {
    let n = triNormal.get(t);
    if (!n) {
      centroid(t, cpos);
      n = new Float64Array(4);
      surfaceNormal(cpos[0], cpos[1], cpos[2], n);
      triNormal.set(t, n);
    }
    return n;
  };
  // Is the surface smooth across the edge (v, o) between triangles t and s?
  // f's normal is followed from t's centre, past the edge's middle, to s's
  // centre, in three steps: over a fillet it turns in all of them, over a
  // sharp edge all in the middle one.
  const smoothCache = new Map();
  const q = new Float64Array(4), r0 = new Float64Array(3), r1 = new Float64Array(3);
  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  const smoothAcross = (v, o, t, s) => {
    const key = v < o ? v * nv + o : o * nv + v;
    let ok = smoothCache.get(key);
    if (ok !== undefined) return ok;
    centroid(t, r0);
    centroid(s, r1);
    const mx = (P[v * 3] + P[o * 3]) / 2, my = (P[v * 3 + 1] + P[o * 3 + 1]) / 2, mz = (P[v * 3 + 2] + P[o * 3 + 2]) / 2;
    // Not on the edge itself: on a sharp edge, f's normal there is a blend
    // of the two faces', which would look like a smooth turn.
    const pts = [
      [(r0[0] + mx) / 2, (r0[1] + my) / 2, (r0[2] + mz) / 2],
      [(r1[0] + mx) / 2, (r1[1] + my) / 2, (r1[2] + mz) / 2],
    ];
    let prev = normalOfTri(t), total = 0, most = 0;
    for (const [x, y, z] of pts) {
      const n = new Float64Array(4);
      surfaceNormal(x, y, z, n);
      const a = angle(prev, n);
      total += a;
      most = Math.max(most, a);
      prev = n;
    }
    const a = angle(prev, normalOfTri(s));
    total += a;
    most = Math.max(most, a);
    ok = most < SMOOTH_STEP * total;
    smoothCache.set(key, ok);
    return ok;
  };

  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
  const cosAgree = Math.cos((20 * Math.PI) / 180);
  const cosTrust = Math.cos((60 * Math.PI) / 180);
  const pos = [];
  const nrm = [];
  const corner = new Uint32Array(I.length); // new vertex index per corner
  const parent = [];
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const dot = (t, s) => un[t * 3] * un[s * 3] + un[t * 3 + 1] * un[s * 3 + 1] + un[t * 3 + 2] * un[s * 3 + 2];
  const into = new Float64Array(4);
  for (let v = 0; v < nv; v++) {
    const s0 = start[v], s1 = start[v + 1];
    const k = s1 - s0;
    if (!k) continue;
    parent.length = k;
    for (let i = 0; i < k; i++) parent[i] = i;
    // Triangles sharing an edge (v, x) are neighbours; join them if smooth.
    const byOther = new Map();
    for (let i = 0; i < k; i++) {
      const cn = around[s0 + i];
      const t = (cn / 3) | 0;
      const r = cn - t * 3;
      for (const o of [I[t * 3 + ((r + 1) % 3)], I[t * 3 + ((r + 2) % 3)]]) {
        const j = byOther.get(o);
        if (j === undefined) byOther.set(o, i);
        else {
          const s = (around[s0 + j] / 3) | 0;
          if (dot(t, s) >= cosCrease || (f && smoothAcross(v, o, t, s))) parent[find(i)] = find(j);
        }
      }
    }
    const groups = new Map();
    for (let i = 0; i < k; i++) {
      const g = find(i);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(i);
    }
    const whole = groups.size === 1;
    for (const list of groups.values()) {
      let x = 0, y = 0, z = 0;
      for (const i of list) {
        const t = (around[s0 + i] / 3) | 0;
        x += fn[t * 3]; y += fn[t * 3 + 1]; z += fn[t * 3 + 2];
      }
      const l = Math.hypot(x, y, z) || 1;
      (x /= l), (y /= l), (z /= l);
      if (f && !whole) {
        // A patch that ends at an edge: f's normal a little way into it.
        let cx = 0, cy = 0, cz = 0;
        for (const i of list) {
          centroid((around[s0 + i] / 3) | 0, cpos);
          cx += cpos[0]; cy += cpos[1]; cz += cpos[2];
        }
        const w = 0.5 / list.length;
        surfaceNormal(P[v * 3] * 0.5 + cx * w, P[v * 3 + 1] * 0.5 + cy * w, P[v * 3 + 2] * 0.5 + cz * w, into);
        if (into[0] * x + into[1] * y + into[2] * z >= cosTrust) (x = into[0]), (y = into[1]), (z = into[2]);
      } else if (G) {
        const d = G[v * 3] * x + G[v * 3 + 1] * y + G[v * 3 + 2] * z;
        if (d >= (f ? cosTrust : cosAgree)) (x = G[v * 3]), (y = G[v * 3 + 1]), (z = G[v * 3 + 2]);
      } else if (f) {
        surfaceNormal(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], into);
        if (into[0] * x + into[1] * y + into[2] * z >= cosTrust) (x = into[0]), (y = into[1]), (z = into[2]);
      }
      const id = pos.length / 3;
      pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      nrm.push(x, y, z);
      for (const i of list) corner[around[s0 + i]] = id;
    }
  }
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), indices: corner };
}

// A lighter copy of a drawing mesh, for where its detail cannot be seen: the
// shadow it casts and its reflection in the floor. All vertices in one cell
// of a grid move to their average, and triangles that collapse are dropped,
// so the surface stays joined wherever it was joined, sharp edges included,
// and no vertex moves by more than a cell's diagonal. Within a cell, vertices
// that face different ways (along different ones of the six axis directions)
// stay separate vertices with their own normals. That keeps both skins of a
// plate thinner than a cell, as two sheets back to back, so a thin blade
// still casts a shadow and is shaded on both sides.
export function lightMesh({ positions: P, normals: N, indices: I }, cell) {
  const nv = P.length / 3;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let v = 0; v < nv; v++) {
    x0 = Math.min(x0, P[v * 3]);
    y0 = Math.min(y0, P[v * 3 + 1]);
    y1 = Math.max(y1, P[v * 3 + 1]);
    z0 = Math.min(z0, P[v * 3 + 2]);
    z1 = Math.max(z1, P[v * 3 + 2]);
  }
  const ny = Math.floor((y1 - y0) / cell) + 1, nz = Math.floor((z1 - z0) / cell) + 1;
  const ids = new Map(); // grid cell and direction -> new vertex
  const places = new Map(); // grid cell -> its place
  const to = new Uint32Array(nv); // old vertex -> new vertex
  const placeOf = []; // new vertex -> its cell's place
  const facing = []; // per new vertex: its normals, summed
  const at = []; // per place: its positions and their count, summed
  for (let v = 0; v < nv; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    const a = N[v * 3], b = N[v * 3 + 1], c = N[v * 3 + 2];
    const ax = Math.abs(a), ay = Math.abs(b), az = Math.abs(c);
    const way = ax >= ay && ax >= az ? (a < 0 ? 0 : 1) : ay >= az ? (b < 0 ? 2 : 3) : c < 0 ? 4 : 5;
    const where = (Math.floor((x - x0) / cell) * ny + Math.floor((y - y0) / cell)) * nz + Math.floor((z - z0) / cell);
    let place = places.get(where);
    if (place === undefined) {
      place = at.length / 4;
      places.set(where, place);
      at.push(0, 0, 0, 0);
    }
    at[place * 4] += x;
    at[place * 4 + 1] += y;
    at[place * 4 + 2] += z;
    at[place * 4 + 3]++;
    let id = ids.get(where * 6 + way);
    if (id === undefined) {
      id = placeOf.length;
      ids.set(where * 6 + way, id);
      placeOf.push(place);
      facing.push(0, 0, 0);
    }
    to[v] = id;
    facing[id * 3] += a;
    facing[id * 3 + 1] += b;
    facing[id * 3 + 2] += c;
  }
  const n = placeOf.length;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = placeOf[i] * 4, k = at[o + 3];
    positions[i * 3] = at[o] / k;
    positions[i * 3 + 1] = at[o + 1] / k;
    positions[i * 3 + 2] = at[o + 2] / k;
    const l = Math.hypot(facing[i * 3], facing[i * 3 + 1], facing[i * 3 + 2]) || 1;
    normals[i * 3] = facing[i * 3] / l;
    normals[i * 3 + 1] = facing[i * 3 + 1] / l;
    normals[i * 3 + 2] = facing[i * 3 + 2] / l;
  }
  const kept = new Uint32Array(I.length);
  let m = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = to[I[t]], b = to[I[t + 1]], c = to[I[t + 2]];
    // Collapsed: two of its corners are in one cell.
    if (placeOf[a] === placeOf[b] || placeOf[b] === placeOf[c] || placeOf[a] === placeOf[c]) continue;
    kept[m++] = a;
    kept[m++] = b;
    kept[m++] = c;
  }
  return { positions, normals, indices: kept.slice(0, m) };
}

// Where the surface pinches inside a cell, one vertex ends up joined to a
// neighbour twice and their edge is shared by four triangles. The ring of
// neighbours around such a vertex then passes through a point twice; split
// the ring into simple loops and give each loop its own copy of the vertex,
// nudged slightly towards that loop so the copies stay apart. Every edge is
// then shared by exactly two triangles.
function splitPinches(pos, idx) {
  const count = new Map();
  const ek = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  for (let n = 0; n < idx.length; n += 3)
    for (let e = 0; e < 3; e++) {
      const k = ek(idx[n + e], idx[n + ((e + 1) % 3)]);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  const suspects = new Set();
  for (const [k, v] of count) if (v !== 2) suspects.add(Math.floor(k / 4294967296)), suspects.add(k % 4294967296);
  if (!suspects.size) return;
  const adj = new Map([...suspects].map((v) => [v, []]));
  for (let n = 0; n < idx.length; n += 3) for (let e = 0; e < 3; e++) adj.get(idx[n + e])?.push(n);

  for (const a of suspects) {
    // Directed ring: triangle (a, x, y) contributes x -> y.
    const out = new Map();
    for (const t of adj.get(a)) {
      const r = idx[t] === a ? 0 : idx[t + 1] === a ? 1 : 2;
      const x = idx[t + ((r + 1) % 3)];
      if (!out.has(x)) out.set(x, []);
      out.get(x).push(t);
    }
    if ([...out.values()].every((l) => l.length === 1)) continue;
    const next = (t) => {
      const r = idx[t] === a ? 0 : idx[t + 1] === a ? 1 : 2;
      return idx[t + ((r + 2) % 3)];
    };
    // Walk loops; whenever a walk returns to a point it already passed, cut that loop off.
    const loops = [];
    for (const start of out.keys()) {
      while (out.get(start).length) {
        const path = [start];
        const tris = [];
        let x = start;
        for (;;) {
          const t = out.get(x).pop();
          tris.push(t);
          x = next(t);
          const seenAt = path.indexOf(x);
          if (seenAt >= 0) {
            loops.push(tris.splice(seenAt));
            path.length = seenAt + 1;
            if (seenAt === 0 && !tris.length) break;
            if (!tris.length && x === start) break;
          } else path.push(x);
          if (!out.get(x)?.length && !tris.length) break;
        }
        if (tris.length) loops.push(tris);
      }
    }
    if (loops.length < 2) continue;
    const px = pos[a * 3], py = pos[a * 3 + 1], pz = pos[a * 3 + 2];
    loops.forEach((tris, li) => {
      let cx = 0, cy = 0, cz = 0;
      for (const t of tris) {
        const y = next(t);
        cx += pos[y * 3]; cy += pos[y * 3 + 1]; cz += pos[y * 3 + 2];
      }
      cx /= tris.length; cy /= tris.length; cz /= tris.length;
      const v = li === 0 ? a : pos.length / 3;
      const w = 0.05;
      const q = [px + (cx - px) * w, py + (cy - py) * w, pz + (cz - pz) * w];
      if (li === 0) [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]] = q;
      else pos.push(...q);
      for (const t of tris) for (let e = 0; e < 3; e++) if (idx[t + e] === a) idx[t + e] = v;
    });
  }
}

// Least-squares point closest to all tangent planes, pulled gently towards
// their average so flat patches stay well placed, then kept inside the cell.
function solveVertex(hitsList, lo, c) {
  const n = hitsList.length;
  let mx = 0, my = 0, mz = 0;
  for (const h of hitsList) (mx += h[0]), (my += h[1]), (mz += h[2]);
  mx /= n;
  my /= n;
  mz /= n;
  const L = 0.05;
  let a00 = L, a01 = 0, a02 = 0, a11 = L, a12 = 0, a22 = L, b0 = 0, b1 = 0, b2 = 0;
  for (const h of hitsList) {
    const nx = h[3], ny = h[4], nz = h[5];
    const d = nx * (h[0] - mx) + ny * (h[1] - my) + nz * (h[2] - mz);
    a00 += nx * nx; a01 += nx * ny; a02 += nx * nz;
    a11 += ny * ny; a12 += ny * nz; a22 += nz * nz;
    b0 += nx * d; b1 += ny * d; b2 += nz * d;
  }
  const det = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
  let x = mx, y = my, z = mz;
  if (Math.abs(det) > 1e-12) {
    const i00 = a11 * a22 - a12 * a12, i01 = a02 * a12 - a01 * a22, i02 = a01 * a12 - a02 * a11;
    const i11 = a00 * a22 - a02 * a02, i12 = a01 * a02 - a00 * a12, i22 = a00 * a11 - a01 * a01;
    x += (i00 * b0 + i01 * b1 + i02 * b2) / det;
    y += (i01 * b0 + i11 * b1 + i12 * b2) / det;
    z += (i02 * b0 + i12 * b1 + i22 * b2) / det;
  }
  // A solution far outside the cell means the planes barely meet (thin or
  // nearly flat detail); the average point is the safe choice there. Keeping
  // vertices a hair inside their cell stops neighbours from coinciding.
  const m = 0.02 * c;
  const near = (v, l) => v >= l - c / 2 && v <= l + c * 1.5;
  if (!(near(x, lo[0]) && near(y, lo[1]) && near(z, lo[2]))) (x = mx), (y = my), (z = mz);
  const clamp = (v, l) => Math.min(Math.max(v, l + m), l + c - m);
  return [clamp(x, lo[0]), clamp(y, lo[1]), clamp(z, lo[2])];
}

// ---- mesh helpers ----
// Surface area (mm2).
export function meshArea({ positions: p, indices: t }) {
  let s = 0;
  for (let n = 0; n < t.length; n += 3) {
    const a = t[n] * 3, b = t[n + 1] * 3, c = t[n + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return s / 2;
}

export function meshVolume({ positions: p, indices: t }) {
  let v = 0;
  for (let n = 0; n < t.length; n += 3) {
    const a = t[n] * 3, b = t[n + 1] * 3, c = t[n + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

export function meshBounds({ positions: p }) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let n = 0; n < p.length; n += 3)
    for (let a = 0; a < 3; a++) {
      if (p[n + a] < b[a]) b[a] = p[n + a];
      if (p[n + a] > b[a + 3]) b[a + 3] = p[n + a];
    }
  return b;
}

// Counts edges not shared by exactly two triangles (0 for a closed mesh).
export function openEdges({ indices: t }) {
  const count = new Map();
  for (let n = 0; n < t.length; n += 3)
    for (const [a, b] of [[t[n], t[n + 1]], [t[n + 1], t[n + 2]], [t[n + 2], t[n]]]) {
      const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  let bad = 0;
  for (const v of count.values()) if (v !== 2) bad++;
  return bad;
}

export function toSTL(meshes) {
  const tris = meshes.reduce((s, m) => s + m.indices.length / 3, 0);
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  const header = "Draftsman STL, millimetres";
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris, true);
  let o = 84;
  for (const { positions: p, indices: t } of meshes)
    for (let n = 0; n < t.length; n += 3) {
      const a = t[n] * 3, b = t[n + 1] * 3, c = t[n + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / len, true);
      dv.setFloat32(o + 4, ny / len, true);
      dv.setFloat32(o + 8, nz / len, true);
      o += 12;
      for (const q of [a, b, c]) {
        dv.setFloat32(o, p[q], true);
        dv.setFloat32(o + 4, p[q + 1], true);
        dv.setFloat32(o + 8, p[q + 2], true);
        o += 12;
      }
      o += 2;
    }
  return new Uint8Array(buf);
}
