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

// Fraction of cells whose centre is on the other side of the surface from
// all eight corners: detail thinner than the cell that the mesh would miss.
function missedDetail(f, O, c, kept, centres) {
  const vals = new Map();
  const at = (i, j, k) => {
    const key = key3(i, j, k);
    let v = vals.get(key);
    if (v === undefined) vals.set(key, (v = f(O[0] + i * c, O[1] + j * c, O[2] + k * c)));
    return v;
  };
  let missed = 0;
  for (let n = 0, m = 0; n < kept.length; n += 3, m++) {
    const i = kept[n], j = kept[n + 1], k = kept[n + 2];
    const inside = centres[m] < 0;
    let all = true;
    for (let q = 0; q < 8 && all; q++) all = at(i + (q & 1), j + ((q >> 1) & 1), k + ((q >> 2) & 1)) < 0 !== inside;
    if (all) missed++;
  }
  return missed / centres.length;
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

export function meshSDF(f, box, { budget = 40000, maxCells = 3_000_000, normals = false, minCell = 0 } = {}) {
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
  let kept;
  for (let level = 0; ; level++) {
    kept = [];
    const centres = [];
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
    if (count * 4 * 1.5 > maxCells) break;
    if (count * 4 > budget) {
      // Over budget, but keep going (up to a cap) while thin walls or blades
      // still slip between the grid corners.
      if (count * 4 > budget * THIN_CAP || missedDetail(f, O, c, kept, centres) <= 0.002) break;
    }
    cells = [];
    for (let n = 0; n < kept.length; n += 3) {
      const i = kept[n] * 2, j = kept[n + 1] * 2, k = kept[n + 2] * 2;
      for (let q = 0; q < 8; q++) cells.push(i + (q & 1), j + ((q >> 1) & 1), k + ((q >> 2) & 1));
    }
    c /= 2;
  }

  // ---- 2. dual contouring at cell size c ----
  const cornerVals = new Map();
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

  // Crossing point and surface normal on each sign-changing edge.
  const eps = c * 0.02;
  const grad = (x, y, z, out, o) => {
    const a = f(x + eps, y - eps, z - eps), b = f(x - eps, y - eps, z + eps), d = f(x - eps, y + eps, z - eps), g = f(x + eps, y + eps, z + eps);
    let nx = a - b - d + g, ny = -a - b + d + g, nz = -a + b - d + g;
    const len = Math.hypot(nx, ny, nz) || 1;
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
    let ta = 0, fa = corner(i, j, k), tb = 1, fb = corner(end[0], end[1], end[2]);
    let t = fa / (fa - fb);
    for (let it = 0; it < 3; it++) {
      const ft = f(...at(t));
      if (ft < 0 === fa < 0) (ta = t), (fa = ft);
      else (tb = t), (fb = ft);
      if (Math.abs(fa - fb) < 1e-12) break;
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
  if (normals) {
    const nrm = new Float32Array(positions.length);
    for (let n = 0; n < pos.length; n += 3) grad(pos[n], pos[n + 1], pos[n + 2], nrm, n);
    out.normals = nrm;
  }
  return out;
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
  const header = "3D Maker STL, millimetres";
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
