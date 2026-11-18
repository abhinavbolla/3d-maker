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

// Tables keyed by whole numbers (the grid keys above, up to 2^53). The mesher
// looks up millions of them, and JavaScript's own Map is slow for numbers
// that do not fit in 31 bits. These are open-addressing tables over typed
// arrays, never more than half full.
function hashKey(key) {
  let h = (key >>> 0) ^ Math.imul((key / 4294967296) | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return h ^ (h >>> 13);
}
// key -> number. place(key) is where the key is or would go: it is there
// already when keys[place] === key, and put() fills an empty place.
class NumMap {
  constructor() {
    this.cap = 4096;
    this.keys = new Float64Array(this.cap).fill(-1);
    this.vals = new Float64Array(this.cap);
    this.size = 0;
  }
  place(key) {
    if (this.size * 2 >= this.cap) this.grow();
    const keys = this.keys, mask = this.cap - 1;
    let s = hashKey(key) & mask;
    while (keys[s] !== key && keys[s] !== -1) s = (s + 1) & mask;
    return s;
  }
  put(s, key, v) {
    this.keys[s] = key;
    this.vals[s] = v;
    this.size++;
  }
  grow() {
    const { keys, vals, cap } = this;
    this.cap = cap * 2;
    const k2 = (this.keys = new Float64Array(this.cap).fill(-1)), v2 = (this.vals = new Float64Array(this.cap));
    const mask = this.cap - 1;
    for (let n = 0; n < cap; n++) {
      if (keys[n] === -1) continue;
      let s = hashKey(keys[n]) & mask;
      while (k2[s] !== -1) s = (s + 1) & mask;
      k2[s] = keys[n];
      v2[s] = vals[n];
    }
  }
}
// key -> its place in the order the keys were added (0, 1, 2, ...).
class Index {
  constructor() {
    this.cap = 4096;
    this.keys = new Float64Array(this.cap).fill(-1);
    this.slots = new Int32Array(this.cap);
    this.size = 0;
  }
  // The key's place, or -1.
  find(key) {
    const keys = this.keys, mask = this.cap - 1;
    let s = hashKey(key) & mask;
    while (keys[s] !== key) {
      if (keys[s] === -1) return -1;
      s = (s + 1) & mask;
    }
    return this.slots[s];
  }
  // The key's place; a new key goes at the end, at what the size was.
  add(key) {
    if (this.size * 2 >= this.cap) this.grow();
    const keys = this.keys, mask = this.cap - 1;
    let s = hashKey(key) & mask;
    while (keys[s] !== key) {
      if (keys[s] === -1) {
        keys[s] = key;
        this.slots[s] = this.size;
        return this.size++;
      }
      s = (s + 1) & mask;
    }
    return this.slots[s];
  }
  // Room for n keys, so the table does not grow on the way there.
  reserve(n) {
    let to = this.cap;
    while (to < n * 2) to *= 2;
    if (to > this.cap) this.grow(to);
  }
  grow(to = this.cap * 2) {
    const { keys, slots, cap } = this;
    this.cap = to;
    const k2 = (this.keys = new Float64Array(this.cap).fill(-1)), s2 = (this.slots = new Int32Array(this.cap));
    const mask = this.cap - 1;
    for (let n = 0; n < cap; n++) {
      if (keys[n] === -1) continue;
      let s = hashKey(keys[n]) & mask;
      while (k2[s] !== -1) s = (s + 1) & mask;
      k2[s] = keys[n];
      s2[s] = slots[n];
    }
  }
}

// f at the corners of a grid (origin O, cell size c), worked out once each.
// The corners are kept in blocks of 8 x 8 x 8, found through a table of the
// blocks, so a cell's eight corners are mostly side by side in memory and the
// last block used is usually the one wanted next.
class Corners {
  constructor(f, O, c) {
    this.f = f;
    (this.x = O[0]), (this.y = O[1]), (this.z = O[2]), (this.c = c);
    this.blocks = new Index();
    this.vals = new Float64Array(0); // 512 per block; NaN where not worked out yet
    this.key = -1; // the block last used, and where it starts in vals
    this.base = 0;
  }
  at(i, j, k) {
    const key = key3(i >> 3, j >> 3, k >> 3);
    if (key !== this.key) {
      const b = this.blocks.add(key) * 512;
      if (b >= this.vals.length) {
        const more = new Float64Array(Math.max(8192, b * 2)).fill(NaN, b);
        more.set(this.vals);
        this.vals = more;
      }
      (this.key = key), (this.base = b);
    }
    const o = this.base + (i & 7) + ((j & 7) << 3) + ((k & 7) << 6);
    let v = this.vals[o];
    if (v !== v) this.vals[o] = v = this.f(this.x + i * this.c, this.y + j * this.c, this.z + k * this.c);
    return v;
  }
}

const HALF_DIAG = Math.sqrt(3) / 2;
const THIN_CAP = 6;
// Walls thinner than a cell hidden in more than this share of the cells:
// refine. A few (a thin lip in one spot) stay as they were.
const WALLS = 0.01;
// Hidden in more than this share, a wall would go missing over much of the
// part: refine on if cells fine enough for it fit in WALL_CAP times the
// budget (and in maxCells), or else grow the grid's shape (see meshGrid).
const LOST = 0.05;
const WALL_CAP = 16;
// Where the finished grid still misses thin detail (more than SLIVERS of
// its cells, below, or THIN_WALLS of them with a hidden wall), its signs come
// from the shape grown by INFLATE cells, its vertices from the true surface.
const THIN_WALLS = 0.002;
const INFLATE = 0.5;

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
function missedDetail(f, O, c, kept, centres, withWalls = true, vals = new Corners(f, O, c)) {
  const O0 = O[0], O1 = O[1], O2 = O[2];
  const at = (i, j, k) => vals.at(i, j, k);
  const gaps = new NumMap(); // edge key -> 1 where a wall hides inside it, else 0
  const cv = new Float64Array(8);
  const thick = []; // a sample of the hidden walls' thicknesses
  let slivers = 0, walls = 0;
  for (let n = 0, m = 0; n < kept.length; n += 3, m++) {
    const i = kept[n], j = kept[n + 1], k = kept[n + 2];
    const inside = centres[m] < 0;
    // Cells come in pairs side by side along x: the second one's low
    // corners are the first one's high corners.
    const beside = n > 0 && i === kept[n - 3] + 1 && j === kept[n - 2] && k === kept[n - 1];
    if (beside) (cv[0] = cv[1]), (cv[2] = cv[3]), (cv[4] = cv[5]), (cv[6] = cv[7]);
    let all = true;
    for (let q = 0; q < 8; q++) {
      if (!beside || q & 1) cv[q] = at(i + (q & 1), j + ((q >> 1) & 1), k + ((q >> 2) & 1));
      if (cv[q] < 0 === inside) all = false;
    }
    if (all) {
      slivers++;
      // Solid at the centre, outside at every corner: a wall too.
      if (inside && withWalls) {
        walls++;
        if (thick.length < 64) {
          (HIT[0] = O0 + (i + 0.5) * c), (HIT[1] = O1 + (j + 0.5) * c), (HIT[2] = O2 + (k + 0.5) * c), (HIT[3] = centres[m]);
          thick.push(wallThickness(f, c));
        }
      }
      continue;
    }
    if (!withWalls) continue;
    // Only solid walls between two outside corners: a slot thinner than a
    // cell fills in, which loses no material.
    for (let e = 0; e < 12; e++) {
      const c0 = EC0[e];
      const f0 = cv[c0], f1 = cv[EC1[e]];
      if (f0 < 0 || f1 < 0 || f0 + f1 >= c) continue;
      const a = e >> 2;
      const ci = i + (c0 & 1), cj = j + ((c0 >> 1) & 1), ck = k + ((c0 >> 2) & 1);
      const ekey = key3(ci, cj, ck) * 3 + a;
      const gs = gaps.place(ekey);
      let g;
      if (gaps.keys[gs] === ekey) g = gaps.vals[gs] === 1;
      else {
        const x0 = O0 + ci * c, y0 = O1 + cj * c, z0 = O2 + ck * c;
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
        gaps.put(gs, ekey, g ? 1 : 0);
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
const EC0 = Int8Array.from(EDGE_CORNERS, (p) => p[0]), EC1 = Int8Array.from(EDGE_CORNERS, (p) => p[1]);
// For each pattern of inside corners, the edges the surface crosses (bit e).
const CROSS = new Uint16Array(256);
for (let mask = 0; mask < 256; mask++) for (let e = 0; e < 12; e++) if (((mask >> EC0[e]) & 1) !== ((mask >> EC1[e]) & 1)) CROSS[mask] |= 1 << e;
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
      // The face's centre, in half cells from the cell's low corner.
      off: [0, 1, 2].map((x) => (x === a ? s * 2 : 1)),
    });
  }
}

const EMPTY_MESH = () => ({ positions: new Float32Array(0), indices: new Uint32Array(0), normals: new Float32Array(0), cellSize: 0 });

// budget: about how many surface cells to aim for. maxCell: refine, even past
// the budget, until cells are about this small (mm; cells halve each level,
// so they end up at most 1.41x maxCell), so the big parts of a model are as
// detailed as the small ones. maxCells: hard cap. grid: a whole number that
// shifts the grid a little (none for 0): parts exported into one file with
// different numbers never share a vertex, even where they touch on the same
// surface with the same box (a hull and the deck on it), which would weld
// them together, edges with four triangles, in a slicer.
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

function meshGrid(fw, boxw, { budget = 40000, maxCells = 3_000_000, normals = false, minCell = 0, maxCell = Infinity, grid = 0 } = {}, stretch = null, probe = false) {
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
  const shift = grid ? L * 0.004 * ((grid * 0.6180339887498949) % 1) : 0;
  const O = [box[0] - pad - shift, box[1] - pad - shift, box[2] - pad - shift];
  let c = (L + 2 * pad) / 8;
  const n0 = ext.map((e) => Math.max(1, Math.ceil((e + 2 * pad + shift) / c)));
  let cells = [];
  for (let i = 0; i < n0[0]; i++) for (let j = 0; j < n0[1]; j++) for (let k = 0; k < n0[2]; k++) cells.push(i, j, k);

  // Lipschitz margin: smooth blends and scaled shapes are slight underestimates, never over.
  const LIP = 1.5;
  let kept, centres;
  let capped = false; // stopped by the cell cap
  let lost = null; // what was missed where cells stopped too coarse for walls
  // f at this level's grid corners: looking for missed detail fills it, and
  // dual contouring goes on from it at the last level.
  let levelVals;
  let found = null; // what the last level was found to miss, walls included
  for (let level = 0; ; level++) {
    levelVals = new Corners(f, O, c);
    found = null;
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
        if (md.slivers <= 0.002 && (probe || (md = missedDetail(f, O, c, kept, centres, true, levelVals)).walls <= WALLS)) {
          if (!probe) found = md;
          break;
        }
      } else {
        found = md;
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

  if (capped) {
    const md = (found = missedDetail(f, O, c, kept, centres, true, levelVals));
    if (md.walls > LOST) lost = md;
  }
  // Detail thinner than the cells: a blade's or a sail's edge tapering to
  // nothing, a rim, a sheet or a tube wall thinner than a cell. The grid
  // corners fall on either side of it, so plain dual contouring bites it
  // away wherever no corner happens to land inside: a sawtooth edge, or a
  // wall in shreds. Then the grid's signs come from the shape grown by half a
  // cell (or enough to make the thinnest wall a cell thick), which every
  // such edge and wall is thick enough to show in whole, and each place the
  // grown surface crosses a grid edge is taken back to the true surface
  // along its normal: with an exact distance, f's gradient there points
  // straight at the nearest true point, f away. So the vertices sit on the
  // true surface, sharp edges included, and a tapering edge ends where it
  // really ends. A stretched grid leaves such parts to the plain one.
  let inflate = 0;
  if (lost) {
    if (stretch) return { ...EMPTY_MESH(), incomplete: true };
    inflate = Math.max(INFLATE * c, (1.1 * c - (lost.thickness || 0)) / 2);
  } else if (!stretch) {
    const md = found ?? missedDetail(f, O, c, kept, centres, true, levelVals);
    if (md.slivers > SLIVERS || md.walls > THIN_WALLS) inflate = INFLATE * c;
  }
  const ft = f; // the true surface
  if (inflate) f = (x, y, z) => ft(x, y, z) - inflate;

  // ---- 2. dual contouring at cell size c ----
  const O0 = O[0], O1 = O[1], O2 = O[2];
  const cornerVals = levelVals;
  // Grown, a corner counts as inside only if the true surface really is
  // near: f is often a loose distance (smooth unions, lofts), with dips that
  // never reach the surface, which growing would turn into bumps. Followed
  // down f's gradient, the surface must turn up within 1.5 times the growth.
  const near = new NumMap();
  const nearSurface = (x, y, z, d) => {
    let walked = 0;
    const tol = 0.1 * c;
    for (let it = 0; it < 3; it++) {
      if (d <= tol) return true;
      if (walked + d > 1.5 * inflate) return false;
      gradientAt(ft, x, y, z, c * 0.01, G1);
      (x -= G1[0] * d), (y -= G1[1] * d), (z -= G1[2] * d);
      walked += d;
      d = ft(x, y, z);
    }
    return d <= tol;
  };
  // A vertex the tangent planes left well off the surface (where f is a
  // loose distance, its planes are loose too) is stepped onto it, if that
  // brings it closer and moves it less than a cell.
  const P3 = new Float64Array(3);
  const polish = (V) => {
    const d0 = ft(V[0], V[1], V[2]);
    if (Math.abs(d0) <= 0.1 * c) return;
    let d = d0;
    (P3[0] = V[0]), (P3[1] = V[1]), (P3[2] = V[2]);
    for (let it = 0; it < 4 && Math.abs(d) > 0.02 * c; it++) {
      gradientAt(ft, P3[0], P3[1], P3[2], c * 0.01, G1);
      for (let a = 0; a < 3; a++) P3[a] -= G1[a] * d;
      d = ft(P3[0], P3[1], P3[2]);
    }
    if (Math.abs(d) < Math.abs(d0) && Math.hypot(P3[0] - V[0], P3[1] - V[1], P3[2] - V[2]) < c) (V[0] = P3[0]), (V[1] = P3[1]), (V[2] = P3[2]);
  };
  const corner = !inflate
    ? (i, j, k) => cornerVals.at(i, j, k)
    : (i, j, k) => {
        const v = cornerVals.at(i, j, k);
        if (v < 0 || v >= inflate) return v - inflate;
        const key = key3(i, j, k);
        const s = near.place(key);
        if (near.keys[s] === key) return near.vals[s];
        const w = nearSurface(O[0] + i * c, O[1] + j * c, O[2] + k * c, v) ? v - inflate : v;
        near.put(s, key, w);
        return w;
      };
  const faceVals = new NumMap();
  const faceCentre = (I, J, Kk) => {
    const key = key3x2(I, J, Kk);
    const s = faceVals.place(key);
    if (faceVals.keys[s] === key) return faceVals.vals[s];
    const v = f(O0 + (I / 2) * c, O1 + (J / 2) * c, O2 + (Kk / 2) * c);
    faceVals.put(s, key, v);
    return v;
  };

  // The cells the surface passes through, followed from the ones the search
  // kept.
  const seen = new Index();
  seen.reserve(centres.length * 1.25);
  const queue = [];
  const push = (i, j, k) => {
    const n = seen.size;
    if (seen.add(key3(i, j, k)) === n) queue.push(i, j, k);
  };
  for (let n = 0; n < kept.length; n += 3) push(kept[n], kept[n + 1], kept[n + 2]);

  // The cells the surface crosses, and the grid edges it crosses, each in
  // the order they are found.
  const cellAt = []; // per cell: i, j, k, which corners are inside, and where its edges start in cellEdges
  const cellEdges = []; // per cell: the edges it is crossed on, in order of e
  const edges = new Index(); // edge key -> its place in edgeAt and edgeEnds
  edges.reserve(centres.length);
  const edgeAt = []; // per edge: i, j, k, axis and whether its start is inside
  const edgeEnds = []; // per edge: f at its two ends
  const cv = new Float64Array(8);
  let incomplete = false;

  for (let q = 0; q < queue.length; q += 3) {
    if (seen.size > maxCells) {
      incomplete = true;
      break;
    }
    const i = queue[q], j = queue[q + 1], k = queue[q + 2];
    // A cell beside the last one along x has its high corners for low ones.
    const beside = q > 0 && i === queue[q - 3] + 1 && j === queue[q - 2] && k === queue[q - 1];
    if (beside) (cv[0] = cv[1]), (cv[2] = cv[3]), (cv[4] = cv[5]), (cv[6] = cv[7]);
    let mask = 0;
    for (let ci = 0; ci < 8; ci++) {
      if (!beside || ci & 1) cv[ci] = corner(i + (ci & 1), j + ((ci >> 1) & 1), k + ((ci >> 2) & 1));
      if (cv[ci] < 0) mask |= 1 << ci;
    }
    if (mask === 0 || mask === 255) continue;
    cellAt.push(i, j, k, mask, cellEdges.length);
    const cross = CROSS[mask];
    for (let e = 0; e < 12; e++) {
      if (!((cross >> e) & 1)) continue;
      const c0 = EC0[e];
      const a = e >> 2;
      const ci = i + (c0 & 1), cj = j + ((c0 >> 1) & 1), ck = k + ((c0 >> 2) & 1);
      const n = edges.size;
      const edge = edges.add(key3(ci, cj, ck) * 3 + a);
      cellEdges.push(edge);
      if (edge !== n) continue;
      edgeAt.push(ci, cj, ck, a, (mask >> c0) & 1);
      edgeEnds.push(cv[c0], cv[EC1[e]]);
      // The four cells around this edge all touch the surface.
      if (a === 0) push(ci, cj, ck), push(ci, cj - 1, ck), push(ci, cj - 1, ck - 1), push(ci, cj, ck - 1);
      else if (a === 1) push(ci, cj, ck), push(ci, cj, ck - 1), push(ci - 1, cj, ck - 1), push(ci - 1, cj, ck);
      else push(ci, cj, ck), push(ci - 1, cj, ck), push(ci - 1, cj - 1, ck), push(ci, cj - 1, ck);
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
    return len / (4 * eps); // how fast f changes there
  };
  const grad = (x, y, z, out, o) => {
    const slope = worldNormal(x, y, z, out, o);
    if (!stretch) return slope;
    const nx = out[o] / S[0], ny = out[o + 1] / S[1], nz = out[o + 2] / S[2], len = Math.hypot(nx, ny, nz) || 1;
    out[o] = nx / len;
    out[o + 1] = ny / len;
    out[o + 2] = nz / len;
  };
  const nEdges = edges.size;
  const H = new Float64Array(nEdges * 6); // per edge: px, py, pz, nx, ny, nz
  const hitDone = new Uint8Array(nEdges);
  const hit = (n) => {
    if (hitDone[n]) return;
    hitDone[n] = 1;
    const i = edgeAt[n * 5], j = edgeAt[n * 5 + 1], k = edgeAt[n * 5 + 2], a = edgeAt[n * 5 + 3];
    const x0 = O0 + i * c, y0 = O1 + j * c, z0 = O2 + k * c;
    // Regula falsi, Illinois variant: when one end keeps its place, its
    // value is halved, so it converges even where the distances on the two
    // sides grow at very different rates (thin walls, stretched meshes).
    let ta = 0, fa = edgeEnds[n * 2], tb = 1, fb = edgeEnds[n * 2 + 1];
    let t = fa / (fa - fb), side = 0;
    for (let it = 0; it < 12; it++) {
      const ft = f(a === 0 ? x0 + t * c : x0, a === 1 ? y0 + t * c : y0, a === 2 ? z0 + t * c : z0);
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
    const x = a === 0 ? x0 + t * c : x0, y = a === 1 ? y0 + t * c : y0, z = a === 2 ? z0 + t * c : z0;
    H[n * 6] = x;
    H[n * 6 + 1] = y;
    H[n * 6 + 2] = z;
    const slope = grad(x, y, z, H, n * 6 + 3);
    if (inflate) {
      // Back onto the true surface along the normal: f there is inflate, so
      // it is inflate / slope away (slope 1 for an exact distance). Where f
      // is not exact (outside the sharp edge of an intersection, f's grown
      // surface stays sharp where the true one is round), that point can be
      // off the surface: then it steps down f's own gradient there, which
      // finds the edge. The normal stays the grown surface's, the face that
      // this crossing belongs to.
      const nx = H[n * 6 + 3], ny = H[n * 6 + 4], nz = H[n * 6 + 5];
      const k = 1 / Math.min(2, Math.max(0.5, slope));
      let qx = x - nx * inflate * k, qy = y - ny * inflate * k, qz = z - nz * inflate * k;
      for (let it = 0; it < 3; it++) {
        const d = ft(qx, qy, qz);
        if (Math.abs(d) < 0.005 * c) break;
        gradientAt(ft, qx, qy, qz, c * 0.01, G1);
        (qx -= G1[0] * d), (qy -= G1[1] * d), (qz -= G1[2] * d);
      }
      H[n * 6] = qx;
      H[n * 6 + 1] = qy;
      H[n * 6 + 2] = qz;
    }
  };

  // One vertex per surface patch in each active cell.
  const pos = [];
  const nCells = cellAt.length / 5;
  // Per edge, the vertices of the four cells around it: (0,0) (-1,0) (-1,-1)
  // (0,-1) across the edge. A cell holds the edge at local place ub + 2 vb,
  // which is 0, 1, 3, 2 for those four.
  const around = new Int32Array(nEdges * 4).fill(-1);
  const PLACE = [0, 1, 3, 2];
  const edgeOf = new Int32Array(12); // this cell's crossed edges, by e
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
  const roots = new Int8Array(12), group = new Int8Array(12), patchEdges = new Int8Array(12);
  const hitAt = new Int32Array(12); // where in H each of a patch's edges is
  const V = new Float64Array(3);
  for (let n = 0; n < nCells; n++) {
    const ci = cellAt[n * 5], cj = cellAt[n * 5 + 1], ck = cellAt[n * 5 + 2], mask = cellAt[n * 5 + 3];
    const cross = CROSS[mask];
    for (let e = 0, p = cellAt[n * 5 + 4]; e < 12; e++) {
      parent[e] = e;
      if ((cross >> e) & 1) edgeOf[e] = cellEdges[p++];
    }
    for (const face of FACES) {
      const fe = face.edges;
      let count = 0, e0 = 0, e1 = 0;
      for (let q = 0; q < 4; q++) {
        if (!((cross >> fe[q]) & 1)) continue;
        if (count === 0) e0 = fe[q];
        else if (count === 1) e1 = fe[q];
        count++;
      }
      if (count === 2) join(e0, e1);
      else if (count === 4) {
        const centreInside = faceCentre(ci * 2 + face.off[0], cj * 2 + face.off[1], ck * 2 + face.off[2]) < 0;
        const c00Inside = ((mask >> face.corners[0]) & 1) === 1;
        if (centreInside === c00Inside) join(fe[0], fe[1]), join(fe[2], fe[3]);
        else join(fe[3], fe[0]), join(fe[1], fe[2]);
      }
    }
    // The patches, in the order of their first edges.
    let patches = 0;
    for (let e = 0; e < 12; e++) {
      if (!((cross >> e) & 1)) continue;
      const r = find(e);
      let g = 0;
      while (g < patches && roots[g] !== r) g++;
      if (g === patches) roots[patches++] = r;
      group[e] = g;
    }
    const lx = O0 + ci * c, ly = O1 + cj * c, lz = O2 + ck * c;
    let px = 0, py = 0, pz = 0;
    for (let g = 0; g < patches; g++) {
      let m = 0;
      for (let e = 0; e < 12; e++) {
        if (!((cross >> e) & 1) || group[e] !== g) continue;
        hit(edgeOf[e]);
        hitAt[m] = edgeOf[e] * 6;
        patchEdges[m++] = e;
      }
      solveVertex(H, hitAt, m, lx, ly, lz, c, V, inflate);
      if (inflate) polish(V);
      // Two patches in one cell must not share a point.
      if (g && Math.hypot(V[0] - px, V[1] - py, V[2] - pz) < 0.01 * c) for (let a = 0; a < 3; a++) V[a] += (H[hitAt[0] + a] - V[a]) * 0.1;
      (px = V[0]), (py = V[1]), (pz = V[2]);
      const index = pos.length / 3;
      pos.push(V[0], V[1], V[2]);
      for (let q = 0; q < m; q++) around[edgeOf[patchEdges[q]] * 4 + PLACE[patchEdges[q] & 3]] = index;
    }
  }

  // One quad per sign-changing edge, joining the four cells around it.
  const idx = [];
  let missing = 0;
  const P = pos;
  const d2 = (a, b) => (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2;
  for (let n = 0; n < nEdges; n++) {
    const v0 = around[n * 4], v1 = around[n * 4 + 1], v2 = around[n * 4 + 2], v3 = around[n * 4 + 3];
    // A cell that was never reached (the cell cap) leaves its place empty.
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) {
      missing++;
      continue;
    }
    const inside = edgeAt[n * 5 + 4];
    const q0 = inside ? v0 : v3, q1 = inside ? v1 : v2, q2 = inside ? v2 : v1, q3 = inside ? v3 : v0;
    if (d2(q0, q2) <= d2(q1, q3)) idx.push(q0, q1, q2, q0, q2, q3);
    else idx.push(q1, q2, q3, q1, q3, q0);
  }

  splitPinches(pos, idx);
  const positions = Float32Array.from(pos);
  const out = { positions, indices: Uint32Array.from(idx), cellSize: c, incomplete: incomplete || missing > 0 };
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
  // Around one vertex: the other ends of its edges, each with the first
  // triangle seen on it, and its triangles' patches. Short lists, searched
  // as they are.
  let other = new Int32Array(64), first = new Int32Array(64), patch = new Int32Array(32), roots = new Int32Array(32);
  for (let v = 0; v < nv; v++) {
    const s0 = start[v], s1 = start[v + 1];
    const k = s1 - s0;
    if (!k) continue;
    if (k > patch.length) (other = new Int32Array(k * 4)), (first = new Int32Array(k * 4)), (patch = new Int32Array(k * 2)), (roots = new Int32Array(k * 2));
    parent.length = k;
    for (let i = 0; i < k; i++) parent[i] = i;
    // Triangles sharing an edge (v, x) are neighbours; join them if smooth.
    let others = 0;
    for (let i = 0; i < k; i++) {
      const cn = around[s0 + i];
      const t = (cn / 3) | 0;
      const r = cn - t * 3;
      for (let w = 1; w <= 2; w++) {
        const o = I[t * 3 + ((r + w) % 3)];
        let m = 0;
        while (m < others && other[m] !== o) m++;
        if (m === others) (other[others] = o), (first[others++] = i);
        else {
          const j = first[m];
          const s = (around[s0 + j] / 3) | 0;
          if (dot(t, s) >= cosCrease || (f && smoothAcross(v, o, t, s))) parent[find(i)] = find(j);
        }
      }
    }
    // The patches, in the order of their first triangles.
    let patches = 0;
    for (let i = 0; i < k; i++) {
      const r = find(i);
      let g = 0;
      while (g < patches && roots[g] !== r) g++;
      if (g === patches) roots[patches++] = r;
      patch[i] = g;
    }
    const whole = patches === 1;
    for (let g = 0; g < patches; g++) {
      let x = 0, y = 0, z = 0, count = 0;
      for (let i = 0; i < k; i++) {
        if (patch[i] !== g) continue;
        const t = (around[s0 + i] / 3) | 0;
        x += fn[t * 3]; y += fn[t * 3 + 1]; z += fn[t * 3 + 2];
        count++;
      }
      const l = Math.hypot(x, y, z) || 1;
      (x /= l), (y /= l), (z /= l);
      if (f && !whole) {
        // A patch that ends at an edge: f's normal a little way into it.
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < k; i++) {
          if (patch[i] !== g) continue;
          centroid((around[s0 + i] / 3) | 0, cpos);
          cx += cpos[0]; cy += cpos[1]; cz += cpos[2];
        }
        const w = 0.5 / count;
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
      for (let i = 0; i < k; i++) if (patch[i] === g) corner[around[s0 + i]] = id;
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
  // Edges not shared by exactly two triangles. Each edge is filed under its
  // lower vertex, and each vertex's few edges are sorted and counted: no
  // table of every edge is needed.
  const nv = pos.length / 3;
  const start = new Uint32Array(nv + 1);
  for (let n = 0; n < idx.length; n += 3)
    for (let e = 0; e < 3; e++) {
      const a = idx[n + e], b = idx[n + ((e + 1) % 3)];
      start[(a < b ? a : b) + 1]++;
    }
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const far = new Uint32Array(idx.length); // the higher vertex of each edge, by lower vertex
  for (let n = 0; n < idx.length; n += 3)
    for (let e = 0; e < 3; e++) {
      const a = idx[n + e], b = idx[n + ((e + 1) % 3)];
      if (a < b) far[fill[a]++] = b;
      else far[fill[b]++] = a;
    }
  const ek = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  const bad = new Set();
  for (let v = 0; v < nv; v++) {
    const s0 = start[v], s1 = start[v + 1];
    for (let n = s0 + 1; n < s1; n++) {
      const x = far[n];
      let m = n - 1;
      for (; m >= s0 && far[m] > x; m--) far[m + 1] = far[m];
      far[m + 1] = x;
    }
    for (let n = s0, m; n < s1; n = m) {
      for (m = n + 1; m < s1 && far[m] === far[n]; m++);
      if (m - n !== 2) bad.add(v * 4294967296 + far[n]);
    }
  }
  if (!bad.size) return;
  // Their ends, in the order the edges first come up in the triangles.
  const suspects = new Set();
  for (let n = 0; n < idx.length; n += 3)
    for (let e = 0; e < 3; e++) {
      const k = ek(idx[n + e], idx[n + ((e + 1) % 3)]);
      if (bad.has(k)) suspects.add(Math.floor(k / 4294967296)), suspects.add(k % 4294967296);
    }
  const adj = new Map([...suspects].map((v) => [v, []]));
  const suspect = new Uint8Array(nv);
  for (const v of suspects) suspect[v] = 1;
  for (let n = 0; n < idx.length; n += 3) for (let e = 0; e < 3; e++) if (suspect[idx[n + e]]) adj.get(idx[n + e]).push(n);

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
// their average so flat patches stay well placed, then kept inside the cell
// (grown by grow on every side: on a grown grid the true surface can lie up
// to that far outside the cells its grown surface crosses).
// H holds the crossings (point, then normal); at[0..n) are the places in it
// of this patch's; the cell's low corner is (lx, ly, lz); the point goes to out.
function solveVertex(H, at, n, lx, ly, lz, c, out, grow = 0) {
  let mx = 0, my = 0, mz = 0;
  for (let q = 0; q < n; q++) {
    const o = at[q];
    (mx += H[o]), (my += H[o + 1]), (mz += H[o + 2]);
  }
  mx /= n;
  my /= n;
  mz /= n;
  const L = 0.05;
  let a00 = L, a01 = 0, a02 = 0, a11 = L, a12 = 0, a22 = L, b0 = 0, b1 = 0, b2 = 0;
  for (let q = 0; q < n; q++) {
    const o = at[q];
    const nx = H[o + 3], ny = H[o + 4], nz = H[o + 5];
    const d = nx * (H[o] - mx) + ny * (H[o + 1] - my) + nz * (H[o + 2] - mz);
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
  const m = 0.02 * c - grow, w = c / 2 + grow;
  if (!(x >= lx - w && x <= lx + c + w && y >= ly - w && y <= ly + c + w && z >= lz - w && z <= lz + c + w)) (x = mx), (y = my), (z = mz);
  out[0] = Math.min(Math.max(x, lx + m), lx + c - m);
  out[1] = Math.min(Math.max(y, ly + m), ly + c - m);
  out[2] = Math.min(Math.max(z, lz + m), lz + c - m);
  if (grow) {
    // Outside its own cell, a vertex leans a little towards it, so the
    // cells around a corner never all put theirs on the corner itself.
    const k = 0.02 * c, lean = 0.005;
    out[0] += (Math.min(Math.max(out[0], lx + k), lx + c - k) - out[0]) * lean;
    out[1] += (Math.min(Math.max(out[1], ly + k), ly + c - k) - out[1]) * lean;
    out[2] += (Math.min(Math.max(out[2], lz + k), lz + c - k) - out[2]) * lean;
  }
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
