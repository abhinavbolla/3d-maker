// 2D drawings: line views with hidden lines removed, sections, overall
// dimensions, and a drawing sheet as SVG. No dependencies.
//
// A part here is { name, positions, indices, f?, box? }: its closed mesh (as
// exported) and, where there is one, its distance function f(x, y, z) and box.
//
// Views are drawn from the mesh: sharp edges and outlines, less what other
// surfaces hide. Sections are not: a cut is contoured straight from the
// distance functions on the cutting plane, so its outline is as exact as the
// function, whatever the mesh detail.
// Units are millimetres; on the sheet, millimetres of paper.

import { markedView } from "./holes.js";

const { abs, min, max, sqrt, hypot, floor, ceil, round, cos, sin, PI } = Math;

// ---- views ----
// u and v: the world directions that run right and up on paper. w: towards
// the viewer, so a larger w is nearer.
export const VIEWS = {
  front: { u: [1, 0, 0], v: [0, 0, 1], w: [0, -1, 0] },
  back: { u: [-1, 0, 0], v: [0, 0, 1], w: [0, 1, 0] },
  right: { u: [0, 1, 0], v: [0, 0, 1], w: [1, 0, 0] },
  left: { u: [0, -1, 0], v: [0, 0, 1], w: [-1, 0, 0] },
  top: { u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, 1] },
  bottom: { u: [1, 0, 0], v: [0, -1, 0], w: [0, 0, -1] },
  // Isometric, looking from the front, the right and above.
  iso: { u: [1 / sqrt(2), 1 / sqrt(2), 0], v: [-1 / sqrt(6), 1 / sqrt(6), 2 / sqrt(6)], w: [1 / sqrt(3), -1 / sqrt(3), 1 / sqrt(3)] },
};
const AXES = { x: 0, y: 1, z: 2 };
// A section across an axis is seen the way the matching view is: across X
// like the left view, across Y like the front, across Z like the top.
export const SECTION_VIEWS = { x: "left", y: "front", z: "top" };

const viewOf = (name) => {
  const v = VIEWS[name];
  if (!v) throw new Error(`Unknown view "${name}". Views: ${Object.keys(VIEWS).join(", ")}.`);
  return v;
};

// The box around every part's mesh: [minx, miny, minz, maxx, maxy, maxz].
export function modelBounds(parts) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const { positions: p } of parts)
    for (let n = 0; n < p.length; n += 3)
      for (let a = 0; a < 3; a++) {
        if (p[n + a] < b[a]) b[a] = p[n + a];
        if (p[n + a] > b[a + 3]) b[a + 3] = p[n + a];
      }
  if (!(b[3] >= b[0])) throw new Error("There is nothing to draw.");
  return b;
}

// A 3D box as a view shows it: [umin, vmin, umax, vmax].
export function viewBox(bounds, name) {
  const { u, v } = viewOf(name);
  const out = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? bounds[3] : bounds[0], i & 2 ? bounds[4] : bounds[1], i & 4 ? bounds[5] : bounds[2]];
    const pu = u[0] * p[0] + u[1] * p[1] + u[2] * p[2], pv = v[0] * p[0] + v[1] * p[1] + v[2] * p[2];
    out[0] = min(out[0], pu);
    out[1] = min(out[1], pv);
    out[2] = max(out[2], pu);
    out[3] = max(out[3], pv);
  }
  return out;
}

// ---- edges of a mesh, and which of them are sharp ----
// View-independent, so worked out once per mesh. An edge is sharp when its
// two faces meet at more than `crease` degrees. A coarse mesh of a round
// surface also has such edges (a bolt with ten flats), so where the part has
// a distance function the surface's own normals decide: they are taken from
// the function just inside each face, next to the edge. Across a real crease
// they differ by the crease's angle; on a round surface they nearly agree.
const prepared = new WeakMap();
function edgesOf(part, crease) {
  const hit = prepared.get(part.indices);
  if (hit && hit.crease === crease && hit.f === part.f) return hit;
  const P = part.positions, I = part.indices, f = part.f;
  const nt = I.length / 3, nv = P.length / 3;
  const N = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = hypot(nx, ny, nz) || 1;
    N[t * 3] = nx / l;
    N[t * 3 + 1] = ny / l;
    N[t * 3 + 2] = nz / l;
  }
  // Each edge: its two corners, its two faces (the second is -1 on an open
  // edge), and the faces' third corners.
  let E = new Int32Array(nt * 9 + 24), ne = 0;
  const push = (a, b, t0, t1, c0, c1) => {
    if (ne * 6 + 6 > E.length) {
      const bigger = new Int32Array(E.length * 2);
      bigger.set(E);
      E = bigger;
    }
    E.set([a, b, t0, t1, c0, c1], ne * 6);
    ne++;
  };
  const third = (t, a, b) => {
    for (let k = 0; k < 3; k++) if (I[t * 3 + k] !== a && I[t * 3 + k] !== b) return I[t * 3 + k];
    return a;
  };
  const first = new Map();
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
      const key = a < b ? a * nv + b : b * nv + a;
      const other = first.get(key);
      if (other === undefined) first.set(key, t);
      else {
        first.delete(key);
        push(a, b, other, t, third(other, a, b), third(t, a, b));
      }
    }
  for (const [key, t] of first) {
    const a = floor(key / nv), b = key % nv;
    push(a, b, t, -1, third(t, a, b), -1);
  }
  const real = ne;

  // The surface normal from the distance function, beside the middle of
  // the edge from a to b on the side corner c is on: a quarter of the edge's
  // length away, square to the edge, in the plane of the three points. That
  // is near enough that a round surface has barely turned, and further than
  // the mesh's edge strays from the real crease (about a tenth of a cell).
  // The distance is not taken from the triangle, which may be a sliver.
  const fieldNormal = (a, b, c, out) => {
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ex = P[b * 3] - ax, ey = P[b * 3 + 1] - ay, ez = P[b * 3 + 2] - az;
    const l2 = ex * ex + ey * ey + ez * ez;
    const k = l2 ? ((P[c * 3] - ax) * ex + (P[c * 3 + 1] - ay) * ey + (P[c * 3 + 2] - az) * ez) / l2 : 0;
    const dx = P[c * 3] - ax - k * ex, dy = P[c * 3 + 1] - ay - k * ey, dz = P[c * 3 + 2] - az - k * ez;
    const dl = hypot(dx, dy, dz), el = sqrt(l2);
    if (!(dl > 1e-12 * el) || !el) return false;
    const s = (0.25 * el) / dl;
    const x = ax + ex / 2 + dx * s, y = ay + ey / 2 + dy * s, z = az + ez / 2 + dz * s;
    const h = el * 0.01;
    const gx = f(x + h, y, z) - f(x - h, y, z), gy = f(x, y + h, z) - f(x, y - h, z), gz = f(x, y, z + h) - f(x, y, z - h);
    const l = hypot(gx, gy, gz);
    if (!(l > 1e-12)) return false;
    out[0] = gx / l;
    out[1] = gy / l;
    out[2] = gz / l;
    return true;
  };
  const cosCrease = cos((crease * PI) / 180);
  const na = [0, 0, 0], nb = [0, 0, 0];
  // Does the surface turn by more than the crease angle across the line
  // from a to b, between the sides that corners c0 and c1 are on?
  const turns = (a, b, c0, c1) => {
    if (!fieldNormal(a, b, c0, na) || !fieldNormal(a, b, c1, nb)) return null;
    return na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] < cosCrease;
  };
  let sharp = new Uint8Array(ne);
  // With a function to ask, any edge the mesh bends at by more than this is asked about.
  const cosAsk = f ? cos((min(crease, 18) * PI) / 180) : cosCrease;
  for (let e = 0; e < ne; e++) {
    const t0 = E[e * 6 + 2], t1 = E[e * 6 + 3];
    if (t1 < 0) continue;
    const d = N[t0 * 3] * N[t1 * 3] + N[t0 * 3 + 1] * N[t1 * 3 + 1] + N[t0 * 3 + 2] * N[t1 * 3 + 2];
    if (d >= cosAsk) continue;
    sharp[e] = ((f && turns(E[e * 6], E[e * 6 + 1], E[e * 6 + 4], E[e * 6 + 5])) ?? d < cosCrease) ? 1 : 0;
  }

  // Where a crease steps across the mesh's grid, the two triangles there
  // may be split the other way, and no edge lies along the crease: it stops
  // at one corner and starts again at the opposite one. Such a pair of loose
  // ends is joined by the diagonal the mesh did not take, if the surface
  // does turn across it.
  const ends = new Uint8Array(nv);
  for (let e = 0; e < real; e++) if (sharp[e]) for (const v of [E[e * 6], E[e * 6 + 1]]) if (ends[v] < 3) ends[v]++;
  const joined = [];
  for (let e = 0; e < real; e++) {
    const c0 = E[e * 6 + 4], c1 = E[e * 6 + 5];
    if (sharp[e] || c1 < 0 || ends[c0] !== 1 || ends[c1] !== 1) continue;
    const a = E[e * 6], b = E[e * 6 + 1];
    if (!f || turns(c0, c1, a, b)) joined.push(e);
  }
  for (const e of joined) push(E[e * 6 + 4], E[e * 6 + 5], E[e * 6 + 2], E[e * 6 + 3], E[e * 6], E[e * 6 + 1]);
  if (ne > real) {
    const all = new Uint8Array(ne).fill(1);
    all.set(sharp);
    sharp = all;
  }
  const out = { crease, f, N, E, ne, real, sharp };
  prepared.set(part.indices, out);
  return out;
}

// ---- a view as lines ----
// The visible sharp edges and outlines of every part, seen from `view`, as
// polylines in the view's own millimetres:
//   { view, box: [umin, vmin, umax, vmax], pixel, parts: [{ name, lines: [Float64Array [u, v, u, v, ...]] }] }
//
// Which edges: sharp ones (see edgesOf) on a face that looks at the viewer,
// and outline edges, where a face that looks at the viewer meets one that
// does not.
//
// Which way a face looks comes from its triangle, except within a few
// degrees of edge on, where the mesh is not that accurate (the triangles
// along a sharp edge lean a little): there the distance function is asked.
//
// What is hidden: every triangle of every part is drawn into a depth
// picture, `resolution` pixels along the view's longer side. An edge shows
// where a face beside it that looks at the viewer shows. So each edge is
// walked in half-pixel steps, and each step is tested a little way (up to
// 2 pixels) into such a face, at the face's own depth there: it is hidden
// when the picture holds a nearer surface at that pixel and at all eight
// around it. (One of the nine is always level with or downhill of the
// tested point on its own face, so a face never hides its own edge, however
// steep it is.) Depths within 0.3 of a pixel count as the same. So
// visibility is right to a few pixels: about 1/1000 of the view with the
// default, well under a line's width on paper. The cost grows with the
// triangles and the picture, not with the number of parts.
//
// cut: { depth, loops } draws only what lies beyond that depth (the far side
// of a cutting plane), with the loops (the cut faces) hiding what is behind them.
// hidden: also the hidden edges, as each part's `hidden` polylines (see hiddenLines).
export function viewOutline(parts, view, { resolution = 3200, crease = 30, cut = null, hidden: hiddenToo = false } = {}) {
  const { u, v, w } = viewOf(view);
  // Project every part's vertices.
  const proj = parts.map(({ positions: P }) => {
    const n = P.length / 3;
    const U = new Float64Array(n), V = new Float64Array(n), W = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      U[i] = u[0] * x + u[1] * y + u[2] * z;
      V[i] = v[0] * x + v[1] * y + v[2] * z;
      W[i] = w[0] * x + w[1] * y + w[2] * z;
    }
    return { U, V, W };
  });
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { U, V } of proj)
    for (let i = 0; i < U.length; i++) {
      if (U[i] < box[0]) box[0] = U[i];
      if (U[i] > box[2]) box[2] = U[i];
      if (V[i] < box[1]) box[1] = V[i];
      if (V[i] > box[3]) box[3] = V[i];
    }
  if (!(box[2] >= box[0])) return { view, box: [0, 0, 0, 0], pixel: 0, parts: [] };

  // ---- the depth picture ----
  const px = max(box[2] - box[0], box[3] - box[1], 1e-9) / resolution;
  const u0 = box[0] - 2 * px, v0 = box[1] - 2 * px;
  const nx = ceil((box[2] - box[0]) / px) + 4, ny = ceil((box[3] - box[1]) / px) + 4;
  const depth = new Float32Array(nx * ny).fill(-Infinity);
  // Depths are kept from the middle of the model, so single precision is plenty.
  let wlo = Infinity, whi = -Infinity;
  for (const { W } of proj) for (let i = 0; i < W.length; i++) (wlo = min(wlo, W[i])), (whi = max(whi, W[i]));
  const wmid = (wlo + whi) / 2;
  for (const { W } of proj) for (let i = 0; i < W.length; i++) W[i] -= wmid;
  const cutDepth = cut ? cut.depth - wmid : 0;
  const far = cut ? cutDepth : Infinity;
  parts.forEach(({ indices: I }, pi) => {
    const { U, V, W } = proj[pi];
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      const x0 = (U[a] - u0) / px, y0 = (V[a] - v0) / px, x1 = (U[b] - u0) / px, y1 = (V[b] - v0) / px, x2 = (U[c] - u0) / px, y2 = (V[c] - v0) / px;
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (abs(area) < 1e-12) continue;
      const i0 = max(0, ceil(min(x0, x1, x2) - 0.5)), i1 = min(nx - 1, floor(max(x0, x1, x2) - 0.5));
      const j0 = max(0, ceil(min(y0, y1, y2) - 0.5)), j1 = min(ny - 1, floor(max(y0, y1, y2) - 0.5));
      for (let j = j0; j <= j1; j++) {
        const y = j + 0.5;
        for (let i = i0; i <= i1; i++) {
          const x = i + 0.5;
          const b0 = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / area;
          const b1 = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / area;
          const b2 = 1 - b0 - b1;
          if (b0 < -1e-9 || b1 < -1e-9 || b2 < -1e-9) continue;
          const z = b0 * W[a] + b1 * W[b] + b2 * W[c];
          if (z > far) continue;
          if (z > depth[j * nx + i]) depth[j * nx + i] = z;
        }
      }
    }
  });
  // The cut faces, filled (even-odd, one pixel wider) a pixel in front of
  // the cutting plane, so they also hide edges that lie in the plane itself.
  if (cut?.loops?.length) {
    const cap = cutDepth + px;
    const rows = new Map();
    for (const L of cut.loops)
      for (let n = 0; n < L.length; n += 2) {
        const m = (n + 2) % L.length;
        const xa = (L[n] - u0) / px, ya = (L[n + 1] - v0) / px, xb = (L[m] - u0) / px, yb = (L[m + 1] - v0) / px;
        if (ya === yb) continue;
        const lo = min(ya, yb), hi = max(ya, yb);
        for (let j = max(0, ceil(lo - 0.5)); j <= min(ny - 1, ceil(hi - 0.5) - 1); j++) {
          const x = xa + ((j + 0.5 - ya) / (yb - ya)) * (xb - xa);
          if (!rows.has(j)) rows.set(j, []);
          rows.get(j).push(x);
        }
      }
    for (const [j, xs] of rows) {
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let i = max(0, ceil(xs[k] - 1.5)); i <= min(nx - 1, floor(xs[k + 1] + 0.5)); i++) depth[j * nx + i] = cap;
    }
  }
  const eps = 0.3 * px;
  const hidden = (x, y, z) => {
    const i = floor(x), j = floor(y);
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny || depth[jj * nx + ii] <= z + eps) return false;
      }
    return true;
  };

  // ---- edges, less what is hidden ----
  const out = [];
  parts.forEach((part, pi) => {
    const { U, V, W } = proj[pi];
    const { N, E, ne, real, sharp } = edgesOf(part, crease);
    const nt = part.indices.length / 3;
    const front = new Uint8Array(nt);
    const { f, positions: P, indices: I } = part;
    for (let t = 0; t < nt; t++) {
      const d = N[t * 3] * w[0] + N[t * 3 + 1] * w[1] + N[t * 3 + 2] * w[2];
      if (!f || abs(d) > 0.1) {
        front[t] = d > 0.05 ? 1 : 0;
        continue;
      }
      // Nearly edge on: how the function changes towards the viewer, at the triangle's middle.
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const x = (P[a] + P[b] + P[c]) / 3, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      const h = max(0.01 * hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]), 1e-6);
      front[t] = f(x + h * w[0], y + h * w[1], z + h * w[2]) - f(x - h * w[0], y - h * w[1], z - h * w[2]) > 0.01 * h ? 1 : 0;
    }
    // For an edge and a face beside it: the step into the face (pixels) and
    // the face's change of depth over that step.
    const step = [0, 0, 0, 0, 0, 0];
    const into = (a, b, c, o) => {
      const ex = U[b] - U[a], ey = V[b] - V[a], l2 = ex * ex + ey * ey;
      const k = ((U[c] - U[a]) * ex + (V[c] - V[a]) * ey) / l2;
      // From the foot of the third corner on the edge, to the corner.
      const hx = U[c] - U[a] - k * ex, hy = V[c] - V[a] - k * ey, hz = W[c] - W[a] - k * (W[b] - W[a]);
      const h = hypot(hx, hy) / px;
      const s = h > 1e-9 ? min(2, h / 2) / h : 0;
      step[o] = (s * hx) / px;
      step[o + 1] = (s * hy) / px;
      step[o + 2] = s * hz;
    };
    // Visible pieces: [node a, node b] with their points; a node is a mesh
    // vertex, or -1 where an edge was cut short.
    const ka = [], kb = [], pts = [];
    // Hidden pieces, the same way, where they are asked for.
    const hka = [], hkb = [], hpts = [];
    for (let e = 0; e < ne; e++) {
      const t0 = E[e * 6 + 2], t1 = E[e * 6 + 3];
      const f0 = front[t0], f1 = t1 < 0 ? 0 : front[t1];
      // An outline (only for the mesh's own edges), or a sharp edge on a face that shows.
      const outline = f0 !== f1 && e < real;
      const shows = outline || (sharp[e] && (f0 || f1));
      // Hidden: an outline or any sharp edge, where something nearer covers it.
      const mayHide = hiddenToo && (outline || sharp[e]);
      if (!shows && !mayHide) continue;
      const a = E[e * 6], b = E[e * 6 + 1];
      const xa = (U[a] - u0) / px, ya = (V[a] - v0) / px, xb = (U[b] - u0) / px, yb = (V[b] - v0) / px;
      const len = hypot(xb - xa, yb - ya);
      if (len < 1e-6) continue;
      const za = W[a], zb = W[b];
      // Keep the part of the edge beyond the cutting plane.
      let ta = 0, tb = 1;
      if (za > far && zb > far) continue;
      if (za > far) ta = (far - za) / (zb - za);
      else if (zb > far) tb = (far - za) / (zb - za);
      const n = max(1, ceil(((tb - ta) * len) / 0.5));
      if (f0) into(a, b, E[e * 6 + 4], 0);
      if (f1) into(a, b, E[e * 6 + 5], 3);
      let start = -1, hstart = -1;
      const piece = (K, KB, Q, s, k) => {
        const s0 = ta + (s / n) * (tb - ta), s1 = ta + (k / n) * (tb - ta);
        K.push(s === 0 && ta === 0 ? a : -1);
        KB.push(k === n && tb === 1 ? b : -1);
        Q.push(U[a] + s0 * (U[b] - U[a]), V[a] + s0 * (V[b] - V[a]), U[a] + s1 * (U[b] - U[a]), V[a] + s1 * (V[b] - V[a]));
      };
      for (let k = 0; k <= n; k++) {
        const t = ta + ((k + 0.5) / n) * (tb - ta);
        const x = xa + t * (xb - xa), y = ya + t * (yb - ya), z = za + t * (zb - za);
        const vis = shows && k < n && ((f0 && !hidden(x + step[0], y + step[1], z + step[2])) || (f1 && !hidden(x + step[3], y + step[4], z + step[5])));
        if (vis && start < 0) start = k;
        else if (!vis && start >= 0) {
          piece(ka, kb, pts, start, k);
          start = -1;
        }
        if (!mayHide) continue;
        // An edge that shows where it is not covered is hidden where it is;
        // one between two faces turned away is hidden where something is in front of it.
        const hid = k < n && !vis && (shows || hidden(x, y, z));
        if (hid && hstart < 0) hstart = k;
        else if (!hid && hstart >= 0) {
          piece(hka, hkb, hpts, hstart, k);
          hstart = -1;
        }
      }
    }
    const lines = chain(ka, kb, pts, U.length, 3 * px, 0.2 * px);
    if (lines.length || hka.length) out.push({ name: part.name, lines, raw: hiddenToo ? [hka, hkb, hpts, U.length] : null });
  });
  if (hiddenToo) hiddenLines(out, { u0, v0, px, nx, ny });
  for (const p of out) delete p.raw;
  return { view, box, pixel: px, parts: out.filter((p) => p.lines.length || p.hidden?.length) };
}

// Hidden lines are drawn only where no visible line is: an edge behind a
// visible one of the same shape (the back of a box, the far rim of a hole)
// would only thicken it. So the visible lines are marked on a picture of the
// view, a pixel either side, and each hidden piece keeps only its stretches
// off them. Sets parts[i].hidden to polylines, like lines.
function hiddenLines(parts, { u0, v0, px, nx, ny }) {
  const mask = new Uint8Array(nx * ny);
  for (const { lines } of parts)
    for (const L of lines)
      for (let n = 2; n < L.length; n += 2) {
        const xa = (L[n - 2] - u0) / px, ya = (L[n - 1] - v0) / px, xb = (L[n] - u0) / px, yb = (L[n + 1] - v0) / px;
        const k = max(1, ceil(hypot(xb - xa, yb - ya) / 0.5));
        for (let i = 0; i <= k; i++) {
          const x = floor(xa + ((xb - xa) * i) / k), y = floor(ya + ((yb - ya) * i) / k);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < nx && y + dy < ny) mask[(y + dy) * nx + x + dx] = 1;
        }
      }
  for (const p of parts) {
    if (!p.raw) continue;
    const [hka, hkb, hpts, nv] = p.raw;
    const ka = [], kb = [], pts = [];
    for (let s = 0; s < hka.length; s++) {
      const [ua, va, ub, vb] = hpts.slice(s * 4, s * 4 + 4);
      const xa = (ua - u0) / px, ya = (va - v0) / px, xb = (ub - u0) / px, yb = (vb - v0) / px;
      const n = max(1, ceil(hypot(xb - xa, yb - ya) / 0.5));
      let start = -1;
      for (let k = 0; k <= n; k++) {
        const t = (k + 0.5) / n;
        const x = floor(xa + t * (xb - xa)), y = floor(ya + t * (yb - ya));
        const free = k < n && !(x >= 0 && y >= 0 && x < nx && y < ny && mask[y * nx + x]);
        if (free && start < 0) start = k;
        else if (!free && start >= 0) {
          const s0 = start / n, s1 = k / n;
          ka.push(start === 0 ? hka[s] : -1);
          kb.push(k === n ? hkb[s] : -1);
          pts.push(ua + s0 * (ub - ua), va + s0 * (vb - va), ua + s1 * (ub - ua), va + s1 * (vb - va));
          start = -1;
        }
      }
    }
    p.hidden = chain(ka, kb, pts, nv, 4 * px, 0.2 * px);
  }
}

// Joins pieces end to end into polylines. Pieces shorter than minLen that
// join nothing are dropped (a hidden edge seen for a pixel behind another
// part's outline), and points that add less than tol are left out.
function chain(ka, kb, pts, nv, minLen, tol) {
  const ns = ka.length;
  if (!ns) return [];
  const nodeOf = new Int32Array(nv).fill(-1);
  const ends = new Int32Array(ns * 2);
  const nodeXY = [];
  const segsAt = [];
  const node = (key, x, y) => {
    let id = key >= 0 ? nodeOf[key] : -1;
    if (id < 0) {
      id = segsAt.length;
      segsAt.push([]);
      nodeXY.push(x, y);
      if (key >= 0) nodeOf[key] = id;
    }
    return id;
  };
  for (let s = 0; s < ns; s++) {
    ends[s * 2] = node(ka[s], pts[s * 4], pts[s * 4 + 1]);
    ends[s * 2 + 1] = node(kb[s], pts[s * 4 + 2], pts[s * 4 + 3]);
    segsAt[ends[s * 2]].push(s);
    segsAt[ends[s * 2 + 1]].push(s);
  }
  const used = new Uint8Array(ns);
  const lines = [];
  const walk = (from, s) => {
    const line = [nodeXY[from * 2], nodeXY[from * 2 + 1]];
    let at = from, length = 0;
    for (;;) {
      used[s] = 1;
      const next = ends[s * 2] === at ? ends[s * 2 + 1] : ends[s * 2];
      length += hypot(nodeXY[next * 2] - nodeXY[at * 2], nodeXY[next * 2 + 1] - nodeXY[at * 2 + 1]);
      line.push(nodeXY[next * 2], nodeXY[next * 2 + 1]);
      at = next;
      if (at === from || segsAt[at].length !== 2) break;
      const [p, q] = segsAt[at];
      s = used[p] ? q : p;
      if (used[s]) break;
    }
    const loose = at === from || (segsAt[from].length === 1 && segsAt[at].length === 1);
    if (!(loose && length < minLen)) lines.push(simplify(line, tol));
  };
  for (let n = 0; n < segsAt.length; n++) if (segsAt[n].length !== 2) for (const s of segsAt[n]) if (!used[s]) walk(n, s);
  for (let s = 0; s < ns; s++) if (!used[s]) walk(ends[s * 2], s);
  return lines;
}

// Douglas-Peucker: drops points that lie within tol of the line through
// their neighbours. line: [x, y, x, y, ...].
function simplify(line, tol) {
  const n = line.length / 2;
  if (n < 3) return Float64Array.from(line);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    const ax = line[a * 2], ay = line[a * 2 + 1], dx = line[b * 2] - ax, dy = line[b * 2 + 1] - ay;
    const l2 = dx * dx + dy * dy;
    let worst = -1, far = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const px = line[i * 2] - ax, py = line[i * 2 + 1] - ay;
      const t = l2 ? min(max((px * dx + py * dy) / l2, 0), 1) : 0;
      const d = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d > far) (far = d), (worst = i);
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push(a, worst, worst, b);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(line[i * 2], line[i * 2 + 1]);
  return Float64Array.from(out);
}

// ---- sections ----
// The outline of g(u, v) < 0 inside box [umin, vmin, umax, vmax], as closed
// loops [u, v, u, v, ...] with the solid on their left (so outer loops have
// positive area and holes negative).
//
// The plane is searched coarse to fine, as the mesher searches space: a
// square whose centre is further from the surface than its half diagonal
// holds none of it and is dropped; the rest are split, down to `cell`. The
// last squares are contoured by marching squares. Each crossing is then
// found on the function itself (not just interpolated between the corners),
// and where the outline turns a corner inside a square, the corner is put
// back where the two sides' tangents meet. So straight sides and sharp
// corners come out exact, and curves to well under a cell.
const SQUARES = [[], [[0, 3]], [[1, 0]], [[1, 3]], [[2, 1]], null, [[2, 0]], [[2, 3]], [[3, 2]], [[0, 2]], null, [[1, 2]], [[3, 1]], [[0, 1]], [[3, 0]], []];
export function contour(g, [bu0, bv0, bu1, bv1], cell) {
  const pad = cell * 1.5;
  const ou = bu0 - pad, ov = bv0 - pad;
  const nu = ceil((bu1 - bu0 + 2 * pad) / cell), nv = ceil((bv1 - bv0 + 2 * pad) / cell);
  let k = 0;
  while (max(nu, nv) >> k > 16) k++;
  let size = 1 << k;
  let cells = [];
  for (let i = 0; i < nu; i += size) for (let j = 0; j < nv; j += size) cells.push(i, j);
  for (; size > 1; size >>= 1) {
    const next = [], half = size / 2, reach = 0.75 * size * cell;
    for (let n = 0; n < cells.length; n += 2) {
      const i = cells[n], j = cells[n + 1];
      if (abs(g(ou + (i + half) * cell, ov + (j + half) * cell)) > reach) continue;
      next.push(i, j, i + half, j, i, j + half, i + half, j + half);
    }
    cells = next;
  }

  const stride = nv + (1 << k) + 2;
  const vals = new Map();
  const val = (i, j) => {
    const key = i * stride + j;
    let v = vals.get(key);
    if (v === undefined) vals.set(key, (v = g(ou + i * cell, ov + j * cell)));
    return v;
  };
  // Crossing points, one per grid edge the outline crosses.
  const X = [], Y = [], GX = [], GY = [];
  const crossings = new Map();
  const crossing = (i, j, dir) => {
    const key = (i * stride + j) * 2 + dir;
    let id = crossings.get(key);
    if (id !== undefined) return id;
    const ax = ou + i * cell, ay = ov + j * cell, dx = dir ? 0 : cell, dy = dir ? cell : 0;
    let lo = 0, hi = 1, flo = val(i, j), fhi = dir ? val(i, j + 1) : val(i + 1, j);
    let t = flo / (flo - fhi), side = 0;
    for (let it = 0; it < 6; it++) {
      const ft = g(ax + t * dx, ay + t * dy);
      if (abs(ft) < 1e-9 * cell) break;
      if (ft < 0 === flo < 0) {
        lo = t;
        flo = ft;
        if (side === 1) fhi /= 2;
        side = 1;
      } else {
        hi = t;
        fhi = ft;
        if (side === -1) flo /= 2;
        side = -1;
      }
      t = lo + ((hi - lo) * flo) / (flo - fhi);
    }
    id = X.length;
    X.push(ax + t * dx);
    Y.push(ay + t * dy);
    crossings.set(key, id);
    return id;
  };
  const grad = (id) => {
    if (GX[id] === undefined) {
      const h = cell * 1e-3;
      const gx = g(X[id] + h, Y[id]) - g(X[id] - h, Y[id]), gy = g(X[id], Y[id] + h) - g(X[id], Y[id] - h);
      const l = hypot(gx, gy) || 1;
      GX[id] = gx / l;
      GY[id] = gy / l;
    }
  };
  const next = [];
  const join = (a, b, i, j) => {
    // A corner inside this square: where the tangents at a and b meet.
    grad(a);
    grad(b);
    const det = GX[a] * GY[b] - GY[a] * GX[b];
    if (abs(det) > 0.26) {
      const ca = GX[a] * X[a] + GY[a] * Y[a], cb = GX[b] * X[b] + GY[b] * Y[b];
      const x = (ca * GY[b] - cb * GY[a]) / det, y = (GX[a] * cb - GX[b] * ca) / det;
      const x0 = ou + i * cell, y0 = ov + j * cell, slack = cell * 1e-6;
      if (x >= x0 - slack && x <= x0 + cell + slack && y >= y0 - slack && y <= y0 + cell + slack && abs(g(x, y)) < 0.2 * cell) {
        const c = X.length;
        X.push(x);
        Y.push(y);
        next[a] = c;
        next[c] = b;
        return;
      }
    }
    next[a] = b;
  };
  for (let n = 0; n < cells.length; n += 2) {
    const i = cells[n], j = cells[n + 1];
    const kind = (val(i, j) < 0 ? 1 : 0) | (val(i + 1, j) < 0 ? 2 : 0) | (val(i + 1, j + 1) < 0 ? 4 : 0) | (val(i, j + 1) < 0 ? 8 : 0);
    if (kind === 0 || kind === 15) continue;
    let segs = SQUARES[kind];
    if (!segs) {
      // Two opposite corners inside: the centre says whether they join.
      const inside = g(ou + (i + 0.5) * cell, ov + (j + 0.5) * cell) < 0;
      segs = kind === 5 ? (inside ? [[0, 1], [2, 3]] : [[0, 3], [2, 1]]) : inside ? [[3, 0], [1, 2]] : [[1, 0], [3, 2]];
    }
    const edge = (e) => (e === 0 ? crossing(i, j, 0) : e === 1 ? crossing(i + 1, j, 1) : e === 2 ? crossing(i, j + 1, 0) : crossing(i, j, 1));
    for (const [a, b] of segs) join(edge(a), edge(b), i, j);
  }

  // Follow the pieces round into loops.
  const seen = new Uint8Array(X.length);
  const hasPrev = new Uint8Array(X.length);
  for (let a = 0; a < X.length; a++) if (next[a] !== undefined) hasPrev[next[a]] = 1;
  const loops = [];
  const follow = (s) => {
    const line = [];
    for (let a = s; a !== undefined && !seen[a]; a = next[a]) {
      seen[a] = 1;
      line.push(X[a], Y[a]);
    }
    if (line.length >= 6) loops.push(simplifyLoop(line, cell * 0.02));
  };
  for (let a = 0; a < X.length; a++) if (!hasPrev[a] && next[a] !== undefined) follow(a);
  for (let a = 0; a < X.length; a++) if (!seen[a] && next[a] !== undefined) follow(a);
  return loops.filter((l) => l.length >= 6);
}

function simplifyLoop(line, tol) {
  // Split into two open lines at two points that are certainly corners: the
  // leftmost (lowest, of several) and the one furthest from it.
  const n = line.length / 2;
  let lead = 0;
  for (let i = 1; i < n; i++) if (line[i * 2] < line[lead * 2] || (line[i * 2] === line[lead * 2] && line[i * 2 + 1] < line[lead * 2 + 1])) lead = i;
  line = [...line.slice(lead * 2), ...line.slice(0, lead * 2)];
  let far = 0, at = 0;
  for (let i = 1; i < n; i++) {
    const d = (line[i * 2] - line[0]) ** 2 + (line[i * 2 + 1] - line[1]) ** 2;
    if (d > far) (far = d), (at = i);
  }
  const a = simplify(line.slice(0, at * 2 + 2), tol);
  const b = simplify([...line.slice(at * 2), line[0], line[1]], tol);
  const out = new Float64Array(a.length + b.length - 4);
  out.set(a.subarray(0, a.length - 2));
  out.set(b.subarray(0, b.length - 2), a.length - 2);
  return out;
}

// Area inside loops (outer loops count up, holes down), mm2.
export function loopsArea(loops) {
  let s = 0;
  for (const L of loops)
    for (let n = 0; n < L.length; n += 2) {
      const m = (n + 2) % L.length;
      s += L[n] * L[m + 1] - L[m] * L[n + 1];
    }
  return s / 2;
}

// Where to cut when nobody says: square across the model's longest axis, at its middle.
export function sectionPlane(bounds, { axis, offset } = {}) {
  const size = [0, 1, 2].map((a) => bounds[a + 3] - bounds[a]);
  if (axis == null) axis = "xyz"[size.indexOf(max(...size))];
  const a = AXES[axis];
  if (a === undefined) throw new Error(`The section axis is "x", "y" or "z", not ${JSON.stringify(axis)}.`);
  if (offset == null) offset = (bounds[a] + bounds[a + 3]) / 2;
  if (!Number.isFinite(offset)) throw new Error("The section offset must be a number of millimetres.");
  if (offset <= bounds[a] || offset >= bounds[a + 3]) throw new Error(`A section at ${axis} = ${fmt(offset)} mm misses the model, which runs from ${fmt(bounds[a])} to ${fmt(bounds[a + 3])} mm along ${axis}.`);
  return { axis, offset };
}

// Cuts every part with the plane `axis` = offset. Each part's cut face is
// contoured from its distance function, in the coordinates of the view the
// section is seen in (SECTION_VIEWS):
//   { axis, offset, view, area, parts: [{ name, loops, area }] }
// cell: the contouring cell (mm); by default 1/512 of the part or 1/4096 of
// the model, whichever is smaller.
export function sectionCut(parts, { axis, offset }, { cell } = {}) {
  const a = AXES[axis];
  const view = SECTION_VIEWS[axis];
  const { u, v } = VIEWS[view];
  const bounds = modelBounds(parts);
  const L = max(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]);
  const n = [0, 0, 0];
  n[a] = offset;
  const out = [];
  for (const part of parts) {
    if (!part.f) throw new Error(`Part "${part.name}" has no distance function to cut.`);
    const box = part.box && part.box.every(Number.isFinite) ? part.box : modelBounds([part]);
    if (!(box[3] >= box[0]) || offset < box[a] || offset > box[a + 3]) continue;
    const b2 = viewBox(box, view);
    const f = part.f;
    const g = (pu, pv) => f(u[0] * pu + v[0] * pv + n[0], u[1] * pu + v[1] * pv + n[1], u[2] * pu + v[2] * pv + n[2]);
    const c = cell ?? min(L / 4096, max(b2[2] - b2[0], b2[3] - b2[1]) / 512);
    if (!(c > 0)) continue;
    const loops = contour(g, b2, c);
    const area = loopsArea(loops);
    if (loops.length && area > 0) out.push({ name: part.name, loops, area });
  }
  return { axis, offset, view, area: out.reduce((s, p) => s + p.area, 0), parts: out };
}

// A section as it is drawn: the cut faces, and the visible edges of what
// lies beyond the cutting plane.
export function sectionView(parts, plane, opts = {}) {
  const cut = sectionCut(parts, plane, opts);
  const w = VIEWS[cut.view].w;
  const beyond = viewOutline(parts, cut.view, { ...opts, cut: { depth: w[AXES[plane.axis]] * plane.offset, loops: cut.parts.flatMap((p) => p.loops) } });
  return { ...cut, beyond: beyond.parts };
}

// ---- the sheet ----
const fmt = (v) => String(round(v * 10) / 10);
// A size as it is lettered: whole millimetres from a metre up, else to 0.1 mm.
export const dimensionText = (v) => String(v >= 1000 ? round(v) : round(v * 10) / 10);
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
// Paper coordinates to 0.01 mm.
const c2 = (v) => {
  const r = round(v * 100) / 100;
  return r === 0 ? "0" : String(r);
};

// Standard scales (ISO 5455), largest first; and on down for very big models.
export const SCALES = [50, 20, 10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000, 1 / 2000, 1 / 5000, 1 / 10000, 1 / 20000, 1 / 50000, 1 / 100000];
export const scaleText = (s) => (s >= 1 ? `${round(s)}:1` : `1:${round(1 / s)}`);

// A3 landscape (ISO 5457): a 20 mm filing edge on the left, 10 mm elsewhere.
// The grid reference border is the outer 5 mm of that margin next to the frame.
// The other sizes (ISO 5457 and ISO 216): A4 upright, A3 to A0 across, each
// with the same margins, so the frame and its grid of 50 mm fields grow
// with the sheet and the title block stays 180 mm wide in the corner.
export const SHEETS = { A4: [210, 297], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] };
const sheetOf = (name = "A3") => {
  const size = SHEETS[name];
  if (!size) throw new Error(`The sheet is one of ${Object.keys(SHEETS).join(", ")}, not ${JSON.stringify(name)}.`);
  const [w, h] = size;
  return { name, w, h, left: 20, top: 10, right: w - 10, bottom: h - 10, grid: 5 };
};
// The sheet being drawn: set by planSheet and sheetSVG from their size.
let SHEET = sheetOf("A3");
// The title block (ISO 7200): 180 mm wide, three 9 mm rows, at the bottom
// right against the frame, with a 9 mm strip above it for the projection,
// scale and units.
const TITLE = { w: 180, h: 36, row: 9 };
// Line widths of the title block, and of the frame and centring marks (0.7,
// ISO 5457). The views' widths come from a line group (see lineGroup).
const THIN = 0.25, FRAME = 0.7;
const FONT = 'font-family="Helvetica, Arial, sans-serif"';
const INK = 'fill="#000" stroke="none"';
// Room kept around the views for dimensions, the cutting line's letters and
// the section's name, clear of the centring marks.
const ROOM = { left: 28, top: 18, right: 12, bottom: 24, gapX: 28, gapY: 32 };
const DIM_OFF = 13; // from a view to its dimension line

// ---- lettering ----
// Helvetica's advance widths (Arial's are the same), in thousandths of the
// letter size, so text can be fitted to its cell without a font to measure.
const WIDTHS = {};
for (const [w, chars] of [
  [222, "ijl"],
  [278, "ftI .,:;/!|[]\\'"],
  [333, "r-()\"`{}"],
  [500, "cksvxyzJ"],
  [556, "abdeghnopqu0123456789L?_$#–"],
  [584, "+=<>~"],
  [611, "FTZ"],
  [667, "ABEKPSVXY&"],
  [722, "CDHNRUw"],
  [778, "GOQ"],
  [833, "mM"],
  [889, "%"],
  [944, "W"],
  [1000, "—…"],
])
  for (const c of chars) WIDTHS[c] = w;
export const textWidth = (s, size) => {
  let w = 0;
  for (const c of String(s)) w += WIDTHS[c] ?? (c.codePointAt(0) >= 0x2e80 ? 1000 : 600);
  return (w * size) / 1000;
};

// Text fitted to a cell `width` wide, never cut short: on one line at
// `size`, or smaller down to `one`; where `lines` is 2, then on two lines
// from `most` down to `least`, broken at the space that makes the longer
// line shortest, or between letters if no space will do. Returns
// { rows, size }, or null if it does not fit.
function fitText(s, width, size, { least = 2.5, lines = 1, one = least, most = size } = {}) {
  const w1 = textWidth(s, 1);
  const shrink = (w) => min(size, floor((width / w) * 20) / 20);
  if (w1 * one <= width) return { rows: [s], size: shrink(w1) };
  if (lines < 2) return w1 * least <= width ? { rows: [s], size: shrink(w1) } : null;
  const words = s.split(" ");
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const pair = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
    const w = max(textWidth(pair[0], 1), textWidth(pair[1], 1));
    if (!best || w < best.w) best = { pair, w };
  }
  if (best && best.w * least <= width) return { rows: best.pair, size: min(most, shrink(best.w)) };
  const chars = [...s];
  let k = chars.length;
  while (k > 1 && textWidth(chars.slice(0, k).join(""), least) > width) k--;
  const pair = [chars.slice(0, k).join(""), chars.slice(k).join("")];
  return textWidth(pair[1], least) <= width ? { rows: pair, size: least } : null;
}

// How many characters each field the user fills in may have: ISO 7200's
// recommended lengths (Tables 1 to 3: creator and approval person 20,
// identification number 16, revision index 2, supplementary title 2 x 25).
// It gives none for the legal owner, which gets two lines of 20 here, nor
// for general tolerances, which are not one of its fields. Text of these
// lengths fits its cell with letters at least 2.5 mm high even if every
// letter is as wide as the widest (a W, a dash, a CJK character), so
// nothing on a sheet is ever cut short.
export const LIMITS = { createdBy: 20, approvedBy: 20, owner: 40, number: 16, revision: 2, subtitle: 50, tolerances: 30 };

// The title cell, 67.6 mm wide with room for two lines, and the
// supplementary title's, 67.6 mm wide in one 9 mm row.
const TITLE_ROOM = 70 - 2.4;
const titleFit = (t, least) => fitText(t, TITLE_ROOM, 5, { least, lines: 2, one: 4 });
const SUBTITLE = { lines: 2, one: 3, most: 2.6 };
const subtitleFit = (t) => fitText(t, TITLE_ROOM, 3.5, SUBTITLE);

// Cuts text at a word, with "…", to the most that `fits` takes.
function shorten(s, fits) {
  const words = s.split(" ");
  for (let k = words.length - 1; k > 0; k--) {
    const t = `${words.slice(0, k).join(" ").replace(/[\s,;:–-]+$/, "")}…`;
    if (fits(t)) return t;
  }
  const chars = [...s];
  for (let k = chars.length - 1; k > 0; k--) if (fits(`${chars.slice(0, k).join("")}…`)) return `${chars.slice(0, k).join("")}…`;
  return "…";
}

// The model's title and the supplementary title as they go on the sheet.
// The title comes from the script, not from the user filling in the block,
// so it never stops a drawing: it is made to fit, and cut short with "…"
// only if it cannot. ISO 7200 recommends a short title (25 to 30
// characters) with the rest in the supplementary title, so:
// - With a supplementary title the user gave, theirs stays, and the title
//   has its own cell, in letters down to 2.5 mm.
// - Without one, a title that fits its cell in letters 3.5 mm or more stays
//   whole; a longer one is split at a space before the 30th character (or
//   at the 30th), and the rest goes in the supplementary title.
// Returns { title, subtitle, shortened }.
export function titleLines(title, subtitle) {
  title = String(title ?? "").trim() || "Untitled";
  subtitle = String(subtitle ?? "").trim();
  if (subtitle) {
    const fits = (t) => titleFit(t, 2.5);
    return fits(title) ? { title, subtitle, shortened: false } : { title: shorten(title, fits), subtitle, shortened: true };
  }
  if (titleFit(title, 3.5)) return { title, subtitle, shortened: false };
  const at = title.lastIndexOf(" ", 30);
  const head = at >= 12 ? title.slice(0, at).replace(/[\s,;:–-]+$/, "") : title.slice(0, 30);
  const rest = title.slice(at >= 12 ? at + 1 : 30).trim();
  return subtitleFit(rest) ? { title: head, subtitle: rest, shortened: false } : { title: head, subtitle: shorten(rest, subtitleFit), shortened: true };
}

export const documentType = (parts) => (parts > 1 ? "Assembly drawing" : "Part drawing");

// ---- layout ----
// Where each view goes. First angle (ISO): the top view under the front, the
// view from the left on its right. Third angle: the top view above the
// front, the view from the right on its right. The section goes in the
// free corner (under or over the side view), or failing that at the far right.
function arrange(projection, sectionAt) {
  const first = projection !== "third";
  return {
    front: [0, first ? 0 : 1],
    top: [0, first ? 1 : 0],
    side: [1, first ? 0 : 1],
    section: sectionAt === "corner" ? [1, first ? 1 : 0] : [2, first ? 0 : 1],
  };
}

// Every way the four views fit on the sheet at scale s clear of the title
// block, best first: centred on the sheet, centred above or beside the
// title block, then over to the left (which leaves room for an isometric view).
function layouts(sizes, s, projection, sectionAt) {
  const slots = arrange(projection, sectionAt);
  const cols = [0, 0, 0], rows = [0, 0];
  for (const k of Object.keys(slots)) {
    cols[slots[k][0]] = max(cols[slots[k][0]], sizes[k][0] * s);
    rows[slots[k][1]] = max(rows[slots[k][1]], sizes[k][1] * s);
  }
  const ncols = cols[2] > 0 ? 3 : 2;
  const W = ROOM.left + cols[0] + cols[1] + cols[2] + ROOM.gapX * (ncols - 1) + ROOM.right;
  const H = ROOM.top + rows[0] + ROOM.gapY + rows[1] + ROOM.bottom;
  const fw = SHEET.right - SHEET.left, fh = SHEET.bottom - SHEET.top;
  if (W > fw || H > fh) return [];
  const colX = [ROOM.left, ROOM.left + cols[0] + ROOM.gapX, ROOM.left + cols[0] + cols[1] + 2 * ROOM.gapX];
  const rowY = [ROOM.top, ROOM.top + rows[0] + ROOM.gapY];
  const title = [SHEET.right - TITLE.w - 6, SHEET.bottom - TITLE.h - 6];
  const cx = SHEET.left + (fw - W) / 2, cy = SHEET.top + (fh - H) / 2;
  const bx = SHEET.left + (fw - TITLE.w - W) / 2, by = SHEET.top + (fh - TITLE.h - H) / 2;
  const out = [];
  for (const [ox, oy] of [
    [cx, cy],
    [cx, by],
    [bx, cy],
    [bx, by],
    [SHEET.left, cy],
    [SHEET.left, by],
    [SHEET.left, SHEET.top],
  ]) {
    if (ox < SHEET.left || oy < SHEET.top) continue;
    const at = {};
    let clear = true;
    for (const k of Object.keys(slots)) {
      const [c, r] = slots[k];
      const w = sizes[k][0] * s, h = sizes[k][1] * s;
      // The upper row sits on the gap, the lower row hangs from it.
      const x = ox + colX[c], y = oy + rowY[r] + (r === 0 ? rows[0] - h : 0);
      at[k] = { x, y, w, h };
      // Room for what hangs off a view: dimensions on its left and under it.
      const padL = c === 0 ? ROOM.left : 10, padB = r === 1 ? ROOM.bottom : 10;
      if (x + w + 10 > title[0] && y + h + padB > title[1]) clear = false;
      if (x - padL < SHEET.left - 1e-9 || y + h + padB > SHEET.bottom + 1e-9) clear = false;
    }
    if (clear) out.push(at);
  }
  return out;
}

// The isometric view goes right of the other views and above the title
// block, at the sheet's scale or the largest standard one below it that
// fits. Left out (null) when that would be smaller than 40 mm across.
function isoPlace(at, size, scale) {
  let x0 = SHEET.left;
  for (const r of Object.values(at)) x0 = max(x0, r.x + r.w);
  // Clear of the cutting line's ends and letters.
  x0 += 18;
  const x1 = SHEET.right - 10, y0 = SHEET.top + ROOM.top, y1 = SHEET.bottom - TITLE.h - 14;
  for (const s of SCALES) {
    if (s > scale * (1 + 1e-9)) continue;
    const w = size[0] * s, h = size[1] * s;
    if (w > x1 - x0 || h > y1 - y0) continue;
    if (max(w, h) < 40) return null;
    return { s, x: x0 + (x1 - x0 - w) / 2, y: y0 + (y1 - y0 - h) / 2, w, h };
  }
  return null;
}

// The box a view of the parts fills: [umin, vmin, umax, vmax], the same as
// viewOutline's box, but only projecting the corners of the mesh, so it is
// cheap.
export function outlineBox(parts, view) {
  const { u, v } = viewOf(view);
  const out = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { positions: P } of parts)
    for (let i = 0; i < P.length; i += 3) {
      const pu = u[0] * P[i] + u[1] * P[i + 1] + u[2] * P[i + 2], pv = v[0] * P[i] + v[1] * P[i + 1] + v[2] * P[i + 2];
      if (pu < out[0]) out[0] = pu;
      if (pu > out[2]) out[2] = pu;
      if (pv < out[1]) out[1] = pv;
      if (pv > out[3]) out[3] = pv;
    }
  return out;
}

// Where everything goes, worked out from boxes alone, so the caller knows
// whether to draw the isometric view before drawing any view.
//   bounds: the model's box. axis: the section's axis. isoBox: the
//   isometric view's box (outlineBox), or null for none.
// Returns { scale, at: { front, top, side, section: { x, y, w, h } }, boxes,
// iso: { s, x, y, w, h } or null }.
export function planSheet({ bounds, axis, projection = "first", isoBox = null, size = "A3" }) {
  SHEET = sheetOf(size);
  const names = { front: "front", top: "top", side: sideViewOf(projection), section: SECTION_VIEWS[axis] };
  const boxes = Object.fromEntries(Object.entries(names).map(([k, name]) => [k, viewBox(bounds, name)]));
  const sizes = Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, [b[2] - b[0], b[3] - b[1]]]));
  let options = [], scale = 0;
  for (const s of SCALES) {
    options = layouts(sizes, s, projection, "corner");
    if (!options.length) options = layouts(sizes, s, projection, "end");
    if (options.length) {
      scale = s;
      break;
    }
  }
  if (!options.length) throw new Error("The model is too large for a drawing sheet.");
  // The isometric view is sized by its own outline, not the model's box,
  // which it would show much bigger than the model looks.
  let at = options[0], iso = null;
  if (isoBox) {
    const size = [isoBox[2] - isoBox[0], isoBox[3] - isoBox[1]];
    for (const o of options) {
      const p = isoPlace(o, size, scale);
      if (p && (!iso || p.s > iso.s * (1 + 1e-9))) (iso = p), (at = o);
    }
  }
  return { scale, at, boxes, names, iso };
}

// ISO 128-20 leaves the line group to the drawing's kind, size and scale:
// wide lines that suit a part at 1:1 run together in a crowded assembly at
// 1:50. So the lines are measured on paper, in 4 mm squares, and the group
// is chosen by how much line the more crowded squares hold (mm of line per
// mm2, the 90th percentile of squares that hold any). Lines s mm apart
// make about 1/s; a gap of at least twice a line's width keeps them apart,
// so the 0.5 group stops at about 0.7 and the 0.35 group at 1.
// Returns [wide, narrow] widths in mm.
const LINE_GROUPS = [
  [0.5, 0.25],
  [0.35, 0.18],
  [0.25, 0.13],
];
function lineGroup(drawn) {
  const cell = 4, bins = new Map();
  for (const { lines, tx, ty } of drawn)
    for (const L of lines)
      for (let n = 2; n < L.length; n += 2) {
        const x0 = tx(L[n - 2]), y0 = ty(L[n - 1]), x1 = tx(L[n]), y1 = ty(L[n + 1]);
        const len = hypot(x1 - x0, y1 - y0), k = max(1, ceil(len));
        for (let i = 0; i < k; i++) {
          const t = (i + 0.5) / k;
          const key = floor((x0 + t * (x1 - x0)) / cell) * 1000 + floor((y0 + t * (y1 - y0)) / cell);
          bins.set(key, (bins.get(key) ?? 0) + len / k);
        }
      }
  const v = [...bins.values()].sort((a, b) => a - b);
  const busy = v.length ? v[floor(v.length * 0.9)] / (cell * cell) : 0;
  return busy > 1 ? LINE_GROUPS[2] : busy > 0.7 ? LINE_GROUPS[1] : LINE_GROUPS[0];
}

const pathOf = (lines, tx, ty) => {
  const d = [];
  for (const L of lines) {
    d.push(`M${c2(tx(L[0]))} ${c2(ty(L[1]))}`);
    for (let n = 2; n < L.length; n += 2) d.push(`L${c2(tx(L[n]))} ${c2(ty(L[n + 1]))}`);
  }
  return d.join("");
};

// Hatching: lines `spacing` apart at `angle` degrees, kept inside the loops
// (even-odd). loops: [[x, y, ...]] on paper. Returns path data.
function hatch(loops, angle, spacing) {
  const c = cos((angle * PI) / 180), s = sin((angle * PI) / 180);
  const rows = new Map();
  for (const L of loops)
    for (let n = 0; n < L.length; n += 2) {
      const m = (n + 2) % L.length;
      const xa = c * L[n] + s * L[n + 1], ya = -s * L[n] + c * L[n + 1], xb = c * L[m] + s * L[m + 1], yb = -s * L[m] + c * L[m + 1];
      if (ya === yb) continue;
      for (let k = ceil(min(ya, yb) / spacing); k * spacing < max(ya, yb); k++) {
        if (!rows.has(k)) rows.set(k, []);
        rows.get(k).push(xa + ((k * spacing - ya) / (yb - ya)) * (xb - xa));
      }
    }
  const d = [];
  for (const [k, xs] of rows) {
    xs.sort((p, q) => p - q);
    const y = k * spacing;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] < 0.05) continue;
      d.push(`M${c2(c * xs[i] - s * y)} ${c2(s * xs[i] + c * y)}L${c2(c * xs[i + 1] - s * y)} ${c2(s * xs[i + 1] + c * y)}`);
    }
  }
  return d.join("");
}

// A filled arrowhead with its tip at (x, y), pointing along (dx, dy).
const arrow = (x, y, dx, dy, len = 3, half = 0.5) => {
  const l = hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  const bx = x - ux * len, by = y - uy * len;
  return `<path d="M${c2(x)} ${c2(y)}L${c2(bx - uy * half)} ${c2(by + ux * half)}L${c2(bx + uy * half)} ${c2(by - ux * half)}Z" fill="#000" stroke="none"/>`;
};
const text = (x, y, size, str, attrs = "") => `<text x="${c2(x)}" y="${c2(y)}" font-size="${c2(size)}" ${attrs}>${xml(str)}</text>`;

// A dimension between two points on a horizontal or vertical line, standing
// `off` away from the view: extension lines, the dimension line with arrows
// (outside the lines when it is short), and the number.
function dimension(kind, a, b, edge, off, label) {
  const out = [];
  const line = edge + off;
  const dir = Math.sign(off);
  const horizontal = kind === "width";
  const P = (along, across) => (horizontal ? [along, across] : [across, along]);
  const seg = (p, q) => `M${c2(p[0])} ${c2(p[1])}L${c2(q[0])} ${c2(q[1])}`;
  const d = [seg(P(a, edge + dir * 1.5), P(a, line + dir * 2)), seg(P(b, edge + dir * 1.5), P(b, line + dir * 2))];
  const short = abs(b - a) < 8;
  d.push(short ? seg(P(min(a, b) - 6, line), P(max(a, b) + 6, line)) : seg(P(a, line), P(b, line)));
  out.push(`<path d="${d.join("")}"/>`);
  const lo = P(min(a, b), line), hi = P(max(a, b), line);
  const along = horizontal ? [1, 0] : [0, 1];
  const s = short ? 1 : -1;
  out.push(arrow(lo[0], lo[1], s * along[0], s * along[1]), arrow(hi[0], hi[1], -s * along[0], -s * along[1]));
  const mid = P((a + b) / 2, line);
  const attrs = `class="dimension" data-dimension="${kind}" text-anchor="middle" ${INK}`;
  // Numbers sit above a horizontal line, and left of a vertical one, read from the right.
  out.push(horizontal ? text(mid[0], mid[1] - 1.2, 3.5, label, attrs) : text(mid[0] - 1.2, mid[1], 3.5, label, `${attrs} transform="rotate(-90 ${c2(mid[0] - 1.2)} ${c2(mid[1])})"`));
  return out.join("");
}

// The symbol that says which way the views are laid out (ISO 5456-2, sized
// for 3.5 mm lettering): a cone 7 mm long from 3.5 to 7 mm across, seen
// from the side and from its small end. First angle has the end view on
// the right. x: its left edge, y: its axis. It is 17.5 mm wide.
const SYMBOL = { small: 3.5, large: 7, length: 7, gap: 3.5, line: 0.35 };
function projectionSymbol(x, y, first) {
  const { small, large, length, gap, line } = SYMBOL;
  const fx = first ? x : x + large + gap, cx = first ? x + length + gap + large / 2 : x + large / 2;
  const ext = 0.75;
  return (
    `<g id="projection-symbol" stroke-width="${line}">` +
    `<path d="M${c2(fx)} ${c2(y - small / 2)}L${c2(fx + length)} ${c2(y - large / 2)}L${c2(fx + length)} ${c2(y + large / 2)}L${c2(fx)} ${c2(y + small / 2)}Z"/>` +
    `<circle cx="${c2(cx)}" cy="${c2(y)}" r="${c2(small / 2)}"/><circle cx="${c2(cx)}" cy="${c2(y)}" r="${c2(large / 2)}"/>` +
    `<path stroke-width="0.18" stroke-dasharray="3 0.8 0.5 0.8" d="M${c2(fx - ext)} ${c2(y)}L${c2(fx + length + ext)} ${c2(y)}M${c2(cx - large / 2 - ext)} ${c2(y)}L${c2(cx + large / 2 + ext)} ${c2(y)}M${c2(cx)} ${c2(y - large / 2 - ext)}L${c2(cx)} ${c2(y + large / 2 + ext)}"/>` +
    "</g>"
  );
}

// The frame, the grid reference border and the centring marks (ISO 5457).
// The grid's fields are 50 mm long, counted out from the middle of each
// side, with what is left over added to the corner fields: on A3, 8 along
// and 6 down. Numbers run left to right along the top and bottom, capital
// letters (no I or O) top down on both sides, 3.5 mm high.
const GRID_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
function fieldsAlong(lo, hi, mid) {
  const cuts = [lo];
  for (let b = mid - 50 * floor((mid - lo) / 50); b < hi - 25; b += 50) if (b > lo + 25) cuts.push(b);
  cuts.push(hi);
  return cuts;
}
function frame() {
  const { w, h, left: L, top: T, right: R, bottom: B, grid: g } = SHEET;
  const cx = w / 2, cy = h / 2;
  const xs = fieldsAlong(L, R, cx), ys = fieldsAlong(T, B, cy);
  const out = [`<rect id="border" x="${L}" y="${T}" width="${R - L}" height="${B - T}" stroke-width="${FRAME}"/>\n`];
  const d = [];
  for (const x of xs.slice(1, -1)) d.push(`M${c2(x)} ${T - g}V${T}M${c2(x)} ${B}V${B + g}`);
  for (const y of ys.slice(1, -1)) d.push(`M${L - g} ${c2(y)}H${L}M${R} ${c2(y)}H${R + g}`);
  out.push(`<g id="grid" stroke-width="0.35"><rect x="${L - g}" y="${T - g}" width="${R - L + 2 * g}" height="${B - T + 2 * g}"/><path d="${d.join("")}"/>`);
  const mark = (x, y, str) => text(x, y + 1.25, 3.5, str, `text-anchor="middle" ${INK}`);
  for (let i = 0; i + 1 < xs.length; i++) {
    const x = (xs[i] + xs[i + 1]) / 2;
    out.push(mark(x, T - g / 2, String(i + 1)), mark(x, B + g / 2, String(i + 1)));
  }
  for (let i = 0; i + 1 < ys.length; i++) {
    const y = (ys[i] + ys[i + 1]) / 2;
    out.push(mark(L - g / 2, y, GRID_LETTERS[i]), mark(R + g / 2, y, GRID_LETTERS[i]));
  }
  out.push("</g>\n");
  // Centring marks: from the grid border to 10 mm inside the frame, except
  // into the title block where it spans the middle (on A4).
  const under = cx > R - TITLE.w ? B : B - 10;
  out.push(`<path id="centring-marks" stroke-width="${FRAME}" stroke-linecap="butt" d="M${cx} ${T - g}V${T + 10}M${cx} ${B + g}V${under}M${L - g} ${cy}H${L + 10}M${R + g} ${cy}H${R - 10}"/>\n`);
  // The size, in the bottom border at the right corner (ISO 5457).
  out.push(text(R - 1, B + g / 2 + 1.25, 3.5, SHEET.name, `id="sheet-size" text-anchor="end" ${INK}`), "\n");
  return out.join("");
}

// The title block. f: the fields (see sheetSVG). Every mandatory field of
// ISO 7200 has its cell, filled or not: an empty cell is a line to sign or
// fill in by hand, which is better than a name nobody gave.
function titleBlock(f, scale, first) {
  const R = SHEET.right, B = SHEET.bottom, X = R - TITLE.w, row = TITLE.row;
  const top = B - 3 * row, strip = top - row;
  const out = [`<g id="title-block" data-layer="TITLE" stroke-width="${THIN}">\n`];
  const lines = [];
  // A cell: its label small at the top left, its value below, fitted to the
  // cell, on two lines where `two` allows. Text that cannot fit is an error
  // (see LIMITS): a sheet never shows a value cut short.
  const cell = (id, x, y, w, label, value, { size = 3.5, two = false } = {}) => {
    lines.push(`M${c2(x)} ${c2(y)}H${c2(x + w)}`, `M${c2(x)} ${c2(y)}V${c2(y + row)}`);
    out.push(text(x + 1.2, y + 2.4, 1.8, label, `class="label" ${INK}`));
    if (!value) return;
    const fit = fitText(value, w - 2.4, size, two ? SUBTITLE : {});
    if (!fit) throw new Error(`${label} "${value}" is too long for its cell on the sheet.`);
    if (fit.rows.length === 1) out.push(text(x + 1.2, y + row - 1.6, fit.size, fit.rows[0], `id="${id}" ${INK}`));
    else fit.rows.forEach((r, i) => out.push(text(x + 1.2, y + 5.4 + 2.8 * i, fit.size, r, `id="${i ? `${id}-2` : id}" ${INK}`)));
  };

  // The strip above the block: projection, scale, units, and general
  // tolerances only when they are given.
  const widths = f.tolerances ? [45, 30, 25, 80] : [70, 60, 50];
  let x = X;
  lines.push(`M${c2(x)} ${c2(strip)}V${c2(top)}`);
  out.push(projectionSymbol(x + 2, strip + row / 2, first), text(x + 23, strip + row / 2 + 1.25, 3.5, first ? "First angle" : "Third angle", `id="projection" ${INK}`));
  lines.push(`M${c2(x)} ${c2(strip)}H${c2(x + widths[0])}`);
  x += widths[0];
  cell("scale", x, strip, widths[1], "Scale", scale);
  x += widths[1];
  cell("units", x, strip, widths[2], "Units", "mm");
  x += widths[2];
  if (f.tolerances) cell("tolerances", x, strip, widths[3], "General tolerances", f.tolerances);
  lines.push(`M${c2(R)} ${c2(strip)}V${c2(top)}`);

  // The block: who made and approved it, and what it is; the title; the
  // owner, the number, the revision, the date of issue and the sheet.
  const [a, b, c] = [X, X + 55, X + 125];
  cell("created-by", a, top, 55, "Created by", f.createdBy);
  cell("approved-by", a, top + row, 55, "Approved by", f.approvedBy);
  cell("document-type", a, top + 2 * row, 55, "Document type", f.type);
  // The title, on one line or two (see titleLines).
  {
    lines.push(`M${b} ${c2(top)}V${c2(top + 2 * row)}`);
    out.push(text(b + 1.2, top + 2.4, 1.8, "Title", `class="label" ${INK}`));
    const fit = titleFit(f.title, 2.5);
    if (!fit) throw new Error(`The title "${f.title}" is too long for its cell on the sheet.`);
    const { rows, size } = fit;
    const ys = rows.length === 1 ? [top + 2 * row - 4.2] : [top + 2 * row - 8.2 - (size - 3.5) * 0.4, top + 2 * row - 2.2];
    rows.forEach((r, i) => out.push(text(b + 1.2, ys[i], size, r, `id="${i ? "title-2" : "title"}" ${INK}`)));
  }
  cell("subtitle", b, top + 2 * row, 70, "Supplementary title", f.subtitle, { two: true });
  cell("owner", c, top, 55, "Legal owner", f.owner, { two: true });
  cell("number", c, top + row, 55, "Identification number", f.number, { size: 5 });
  cell("revision", c, top + 2 * row, 12, "Rev.", f.revision);
  cell("date", c + 12, top + 2 * row, 25, "Date of issue", f.date);
  cell("sheet", c + 37, top + 2 * row, 18, "Sheet", "1/1");
  out.push(`<path d="${lines.join("")}"/>`);
  out.push(`<rect x="${X}" y="${c2(top)}" width="${TITLE.w}" height="${3 * row}" stroke-width="${FRAME}"/>`);
  out.push("\n</g>\n");
  return out.join("");
}

// The drawing sheet: A3 landscape, with a frame, grid and centring marks, a
// title block, the front, top and side views, the section A-A with its
// cutting line on a view, the overall width, depth and height, and an
// isometric view where there is room.
//   info: the title block's fields, all strings, any may be empty: title,
//   subtitle (supplementary title), number (identification number), revision,
//   date (of issue), createdBy, approvedBy, owner (legal owner), type
//   (document type), tolerances (general tolerances). See LIMITS.
//   bounds: the model's box. views: { front, top, side, iso? } from
//   viewOutline (side is "left" in first angle, "right" in third); iso only
//   where planSheet found room for it. section: from sectionView.
// Returns { svg, scale, iso, titles } where scale is e.g. "1:5", iso says
// whether the isometric view was drawn, and titles is what titleLines made.
export function sheetSVG({ info = {}, bounds, views, section, projection = "first", size = "A3", detail = null }) {
  const first = projection !== "third";
  const isoView = views.iso?.parts.length ? views.iso : null;
  const { scale, at, boxes, names, iso } = planSheet({ bounds, axis: section.axis, projection, isoBox: isoView?.box, size });
  // Model millimetres in a view to paper millimetres (paper's y runs down).
  const map = (k) => ({ tx: (pu) => at[k].x + (pu - boxes[k][0]) * scale, ty: (pv) => at[k].y + (boxes[k][3] - pv) * scale });
  // Wide lines for outlines and cut faces, narrow ones (half as wide) for
  // hatching, dimensions and the cutting line.
  const [wide, narrow] = lineGroup(["front", "top", "side"].flatMap((k) => views[k].parts.map((p) => ({ lines: p.lines, ...map(k) }))));

  const { title, subtitle, shortened } = titleLines(info.title, info.subtitle);
  const f = {
    title,
    subtitle,
    number: info.number ?? "",
    revision: info.revision ?? "",
    date: info.date ?? "",
    createdBy: info.createdBy ?? "",
    approvedBy: info.approvedBy ?? "",
    owner: info.owner ?? "",
    type: info.type ?? "",
    tolerances: info.tolerances ?? "",
  };

  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- Made with Draftsman -->\n<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET.w}mm" height="${SHEET.h}mm" viewBox="0 0 ${SHEET.w} ${SHEET.h}" data-scale="${scaleText(scale)}" data-projection="${first ? "first-angle" : "third-angle"}">\n`);
  out.push(`<title>${xml(f.title)}</title>\n`);
  // The title block's facts for programs that read SVG metadata (Dublin Core).
  const dc = [["title", [f.title, f.subtitle].filter(Boolean).join(" – ")], ["identifier", f.number], ["date", f.date], ["type", f.type], ["creator", f.createdBy], ["rights", f.owner]];
  out.push(`<metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Description rdf:about="">${dc.filter(([, v]) => v).map(([k, v]) => `<dc:${k}>${xml(v)}</dc:${k}>`).join("")}</rdf:Description></rdf:RDF></metadata>\n`);
  out.push(`<rect width="${SHEET.w}" height="${SHEET.h}" fill="#fff"/>\n`);
  out.push(`<g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round" ${FONT}>\n`);
  out.push(`<g data-layer="FRAME">\n${frame()}</g>\n`);

  // The three views, and the isometric one.
  for (const k of ["front", "top", "side"]) {
    const { tx, ty } = map(k);
    out.push(`<g id="view-${names[k]}" class="view" data-view="${names[k]}" data-layer="VISIBLE" stroke-width="${wide}">\n`);
    // Hidden edges, where asked for: narrow and dashed (ISO 128-20 type 02:
    // dashes 12 line widths long, gaps 3), under the visible ones.
    const hid = views[k].parts.filter((p) => p.hidden?.length);
    if (hid.length) {
      const d = max(narrow, 0.25);
      out.push(`<g class="hidden" data-layer="HIDDEN" stroke-width="${narrow}" stroke-dasharray="${c2(12 * d)} ${c2(3 * d)}" stroke-linecap="butt">\n`);
      for (const p of hid) out.push(`<path data-part="${xml(p.name)}" d="${pathOf(p.hidden, tx, ty)}"/>\n`);
      out.push("</g>\n");
    }
    for (const p of views[k].parts) if (p.lines.length) out.push(`<path data-part="${xml(p.name)}" d="${pathOf(p.lines, tx, ty)}"/>\n`);
    out.push("</g>\n");
  }
  if (iso) {
    const b = isoView.box;
    const tx = (pu) => iso.x + (pu - b[0]) * iso.s, ty = (pv) => iso.y + (b[3] - pv) * iso.s;
    // No scale is given: an isometric view foreshortens every axis, so
    // nothing on it is measured (it is a picture of the part).
    out.push(`<g id="view-iso" class="view" data-view="iso" data-layer="VISIBLE" stroke-width="${wide}">\n`);
    for (const p of isoView.parts) out.push(`<path data-part="${xml(p.name)}" d="${pathOf(p.lines, tx, ty)}"/>\n`);
    out.push("</g>\n");
  }

  // The section: what lies beyond the cut, then the cut faces, hatched.
  {
    const { tx, ty } = map("section");
    out.push(`<g id="section-A" class="section" data-axis="${section.axis}" data-offset="${fmt(section.offset)}" data-area="${fmt(section.area)}" data-layer="SECTION">\n`);
    out.push(`<g class="beyond" data-layer="VISIBLE" stroke-width="${wide}">\n`);
    for (const p of section.beyond ?? []) out.push(`<path data-part="${xml(p.name)}" d="${pathOf(p.lines, tx, ty)}"/>\n`);
    out.push("</g>\n");
    section.parts.forEach((p, i) => {
      const loops = p.loops.map((L) => Float64Array.from(L, (q, n) => (n % 2 ? ty(q) : tx(q))));
      // Neighbours in the list lean opposite ways; the spacing changes every two.
      let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (const L of loops) for (let n = 0; n < L.length; n++) (lo[n % 2] = min(lo[n % 2], L[n])), (hi[n % 2] = max(hi[n % 2], L[n]));
      const spacing = min([2.4, 3.2, 1.8, 4][(i >> 1) % 4], max(0.6, min(hi[0] - lo[0], hi[1] - lo[1]) / 3));
      out.push(`<g class="cut" data-part="${xml(p.name)}" data-area="${fmt(p.area)}">`);
      out.push(`<path class="hatch" stroke-width="${narrow}" data-layer="HATCH" d="${hatch(loops, i % 2 ? -45 : 45, spacing)}"/>`);
      out.push(`<path class="cut-outline" stroke-width="${wide}" d="${loops.map((L) => `${pathOf([L], (q) => q, (q) => q)}Z`).join("")}"/></g>\n`);
    });
    // The name goes just above what the section draws, which can be well
    // inside the model's box (a cut through a bracket's thin web).
    const s = at.section;
    let lo = Infinity, hi = -Infinity, up = Infinity;
    const take = (x, y) => ((lo = min(lo, x)), (hi = max(hi, x)), (up = min(up, y)));
    for (const p of section.parts) for (const L of p.loops) for (let n = 0; n < L.length; n += 2) take(tx(L[n]), ty(L[n + 1]));
    for (const p of section.beyond ?? []) for (const L of p.lines) for (let n = 0; n < L.length; n += 2) take(tx(L[n]), ty(L[n + 1]));
    if (!(hi >= lo)) (lo = s.x), (hi = s.x + s.w), (up = s.y);
    out.push(text((lo + hi) / 2, up - 4, 5, "A–A", `id="section-name" text-anchor="middle" ${INK}`), "\n</g>\n");
  }

  // The cutting line, on the view that sees the plane edge on, with arrows
  // that look the way the section is seen.
  {
    const host = section.axis === "y" ? "top" : "front";
    const { tx, ty } = map(host);
    const r = at[host];
    const vertical = section.axis === "x";
    const c = vertical ? tx(section.offset) : ty(section.offset);
    // The section looks towards +X, +Y or -Z: right, up or down on the host view.
    const look = section.axis === "x" ? [1, 0] : section.axis === "y" ? [0, -1] : [0, 1];
    const ends = vertical ? [[c, r.y - 6], [c, r.y + r.h + 6]] : [[r.x - 6, c], [r.x + r.w + 6, c]];
    const inner = vertical ? [[c, r.y], [c, r.y + r.h]] : [[r.x, c], [r.x + r.w, c]];
    out.push(`<g id="cutting-line" data-view="${host}" data-layer="SECTION">\n`);
    out.push(`<path stroke-width="${narrow}" stroke-dasharray="8 1.5 0.5 1.5" d="M${c2(ends[0][0])} ${c2(ends[0][1])}L${c2(ends[1][0])} ${c2(ends[1][1])}"/>`);
    ends.forEach((e, i) => {
      out.push(`<path stroke-width="${wide}" stroke-linecap="butt" d="M${c2(e[0])} ${c2(e[1])}L${c2(inner[i][0])} ${c2(inner[i][1])}"/>`);
      const tail = [e[0] - look[0] * 7, e[1] - look[1] * 7];
      out.push(`<path stroke-width="${narrow}" d="M${c2(tail[0])} ${c2(tail[1])}L${c2(e[0])} ${c2(e[1])}"/>`, arrow(e[0], e[1], look[0], look[1], 3.5, 0.7));
      // The letter, beyond the end of the line.
      const out2 = vertical ? [0, i ? 1 : -1] : [i ? 1 : -1, 0];
      out.push(text(tail[0] + look[0] * 2 + out2[0] * 3, tail[1] + look[1] * 2 + out2[1] * 3 + 1.4, 4, "A", `text-anchor="middle" ${INK}`));
    });
    out.push("\n</g>\n");
  }

  // Overall sizes: height on the front view, depth on the top view, and
  // width under whichever of the two is lower on the sheet.
  {
    const size = [0, 1, 2].map((a) => bounds[a + 3] - bounds[a]);
    const f = at.front, t = at.top, low = first ? t : f;
    out.push(`<g id="dimensions" data-layer="DIMENSIONS" stroke-width="${narrow}">\n`);
    out.push(dimension("height", f.y, f.y + f.h, f.x, -DIM_OFF, dimensionText(size[2])), "\n");
    out.push(dimension("depth", t.y, t.y + t.h, t.x, -DIM_OFF, dimensionText(size[1])), "\n");
    // In third angle a cut across X ends under the front view, so its letter
    // would sit on the width: the width stands further off.
    const under = !first && section.axis === "x" ? 6 : 0;
    out.push(dimension("width", low.x, low.x + low.w, low.y + low.h, DIM_OFF - 2 + under, dimensionText(size[0])), "\n");
    out.push("</g>\n");
  }

  // Centre lines, and the holes' diameters and positions, kept clear of
  // everything above.
  const taken = [];
  const pad = (r, d = 1) => [r.x - d, r.y - d, r.x + r.w + d, r.y + r.h + d];
  for (const k of ["front", "top", "side", "section"]) taken.push(pad(at[k]));
  if (iso) taken.push(pad(iso));
  {
    const f0 = at.front, t0 = at.top, low = first ? t0 : f0;
    taken.push([f0.x - DIM_OFF - 5, f0.y - 1, f0.x, f0.y + f0.h + 1], [t0.x - DIM_OFF - 5, t0.y - 1, t0.x, t0.y + t0.h + 1]);
    taken.push([low.x - 4, low.y + low.h, low.x + low.w + 4, low.y + low.h + DIM_OFF + 8]);
    const host = at[section.axis === "y" ? "top" : "front"];
    // The cutting line's ends, arrows and letters.
    const { tx: hx, ty: hy } = map(section.axis === "y" ? "top" : "front");
    if (section.axis === "x") {
      const c = hx(section.offset);
      taken.push([c - 13, host.y - 15, c + 2, host.y], [c - 13, host.y + host.h, c + 2, host.y + host.h + 15]);
    } else {
      const c = hy(section.offset), s = section.axis === "y" ? -1 : 1;
      const [y0, y1] = s < 0 ? [c - 12, c + 2] : [c - 2, c + 12];
      taken.push([host.x - 14, y0, host.x, y1], [host.x + host.w, y0, host.x + host.w + 14, y1]);
    }
    // The section's name.
    taken.push([at.section.x - 4, at.section.y - 12, at.section.x + at.section.w + 4, at.section.y]);
  }
  taken.push([SHEET.right - TITLE.w - 2, SHEET.bottom - TITLE.h - 2, SHEET.right, SHEET.bottom]);
  // The centring marks reach 10 mm into the frame.
  taken.push([SHEET.w / 2 - 1, SHEET.top, SHEET.w / 2 + 1, SHEET.top + 11], [SHEET.w / 2 - 1, SHEET.bottom - 11, SHEET.w / 2 + 1, SHEET.bottom]);
  taken.push([SHEET.left, SHEET.h / 2 - 1, SHEET.left + 11, SHEET.h / 2 + 1], [SHEET.right - 11, SHEET.h / 2 - 1, SHEET.right, SHEET.h / 2 + 1]);
  const shown = detail ? detailView({ views, at, map, names, scale, wide, narrow, taken, spec: detail }) : null;
  if (shown) out.push(shown.svg);
  const marked = annotate({ views, at, map, scale, narrow, taken, keys: ["front", "top", "side"] });
  if (shown?.left_out) marked.notes.left_out.push(shown.left_out);
  out.push(marked.svg);

  out.push(titleBlock(f, scaleText(scale), first));
  // Credit where it belongs: in the filing margin, outside the frame.
  out.push(text(10, SHEET.bottom, 1.8, "Made with Draftsman", `id="credit" data-layer="FRAME" fill="#777" stroke="none" transform="rotate(-90 10 ${SHEET.bottom})"`), "\n");
  out.push("</g>\n</svg>\n");
  return { svg: out.join(""), scale: scaleText(scale), iso: Boolean(iso), titles: { title, subtitle, shortened }, marks: marked.notes, detail: shown?.info ?? null };
}

// ---- centre lines and holes ----
// Rectangles on paper: [x0, y0, x1, y1].
const meets = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
// Does the segment from p to q pass through rectangle r?
function crosses(p, q, r) {
  let t0 = 0, t1 = 1;
  const d = [q[0] - p[0], q[1] - p[1]];
  for (let i = 0; i < 2; i++) {
    if (abs(d[i]) < 1e-12) {
      if (p[i] < r[i] || p[i] > r[i + 2]) return false;
      continue;
    }
    let a = (r[i] - p[i]) / d[i], b = (r[i + 2] - p[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = max(t0, a);
    t1 = min(t1, b);
    if (t0 > t1) return false;
  }
  return true;
}

// The long-dash-dot of centre lines and cutting lines (ISO 128-20 type 04).
const CHAIN = "8 1.5 0.5 1.5";
// A centre line beyond the outline it centres, on paper (ISO 129-1 suggests a few mm).
const CENTRE_OVER = 2.5;
// Diameters smaller than this on paper are not called out.
const SMALLEST_HOLE = 2;
// Holes at more places than this along a view's width or height get no
// position dimensions: they would crowd the sheet.
const MOST_POSITIONS = 6;
// Drawings of more parts than this get centre lines but no hole sizes.
const MOST_PARTS = 3;

// Centre lines of holes and turned pieces seen in the views, and for holes
// their diameters (grouped: "4× Ø9") and positions (from the view's left
// and bottom edges), each placed where nothing else is. taken: rectangles
// already used on paper; placed labels are added to it.
// Returns { svg, notes: { centre_lines, holes: [{ view, text, from }],
// positions, fitted: [{ diameter, within }], left_out: [] } }.
function annotate({ views, at, map, scale, narrow, taken, keys }) {
  const centre = [], dims = [];
  const notes = { centre_lines: 0, holes: [], positions: 0, fitted: [], left_out: [] };
  // Holes are sized and placed on a part drawing, or an assembly of a few
  // parts; a bigger assembly gets centre lines only (its parts' sizes
  // belong on their own drawings).
  const count = new Set(keys.flatMap((k) => views[k].parts.map((p) => p.name))).size;
  const sized = count <= MOST_PARTS;
  if (!sized && keys.some((k) => views[k].marks?.circles.some((c) => c.kind === "hole" && c.dim)))
    notes.left_out.push(`hole sizes and positions: an assembly of ${count} parts gets centre lines only (sizes belong on each part's own drawing)`);
  // Thin lines (dimension and extension lines): a label may not sit on one, a leader may cross it.
  const thin = [];
  const free = (r) => r[0] >= SHEET.left + 1 && r[1] >= SHEET.top + 1 && r[2] <= SHEET.right - 1 && r[3] <= SHEET.bottom - 1 && !taken.some((t) => meets(t, r)) && !thin.some((t) => meets(t, r));
  const seg = (x0, y0, x1, y1) => `M${c2(x0)} ${c2(y0)}L${c2(x1)} ${c2(y1)}`;
  for (const k of keys) {
    const marks = views[k].marks;
    if (!marks) continue;
    const { tx, ty } = map(k);
    const V = at[k];
    const own = [V.x - 1, V.y - 1, V.x + V.w + 1, V.y + V.h + 1];
    // ---- centre lines ----
    // One cross per centre, as big as its largest circle; an axis per turned piece or hole seen from the side.
    const crosses_ = [];
    for (const c of marks.circles) {
      const x = tx(c.u), y = ty(c.v), r = c.r * scale;
      if (r < 0.75) continue;
      const same = crosses_.find((q) => hypot(q.x - x, q.y - y) < 0.3);
      if (same) same.r = max(same.r, r);
      else crosses_.push({ x, y, r });
    }
    const d = [];
    for (const { x, y, r } of crosses_) {
      const L = r + CENTRE_OVER;
      // A short dash crosses at the centre; for a circle big enough, a gap
      // and a long dash out past the circle.
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (r < 3) d.push(seg(x, y, x + dx * L, y + dy * L));
        else {
          const a = min(1.5, r / 3);
          d.push(seg(x, y, x + dx * a, y + dy * a), seg(x + dx * (a + 1), y + dy * (a + 1), x + dx * L, y + dy * L));
        }
      }
    }
    if (d.length) centre.push(`<path data-view="${k}" d="${d.join("")}"/>`);
    notes.centre_lines += crosses_.length;
    const axes = [];
    for (const a of marks.axes) {
      if (a.r * scale < 0.75) continue;
      let p = [tx(a.u0), ty(a.v0)], q = [tx(a.u1), ty(a.v1)];
      const l = hypot(q[0] - p[0], q[1] - p[1]);
      if (l < 2) continue;
      const e = [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
      p = [p[0] - e[0] * CENTRE_OVER, p[1] - e[1] * CENTRE_OVER];
      q = [q[0] + e[0] * CENTRE_OVER, q[1] + e[1] * CENTRE_OVER];
      // The same axis twice (a bore in a boss): one line, the longer.
      const same = axes.find((o) => abs((o.p[0] - p[0]) * e[1] - (o.p[1] - p[1]) * e[0]) < 0.3 && abs(o.e[0] * e[1] - o.e[1] * e[0]) < 1e-3);
      if (same) {
        const t = (pt) => (pt[0] - same.p[0]) * same.e[0] + (pt[1] - same.p[1]) * same.e[1];
        const lo = min(0, t(p), t(q)), hi = max(same.len, t(p), t(q));
        same.p = [same.p[0] + same.e[0] * lo, same.p[1] + same.e[1] * lo];
        same.len = hi - lo;
      } else axes.push({ p, e, len: hypot(q[0] - p[0], q[1] - p[1]) });
    }
    if (axes.length) centre.push(`<path data-view="${k}" stroke-dasharray="${CHAIN}" d="${axes.map((a) => seg(a.p[0], a.p[1], a.p[0] + a.e[0] * a.len, a.p[1] + a.e[1] * a.len)).join("")}"/>`);
    notes.centre_lines += axes.length;

    const holes = sized ? marks.circles.filter((c) => c.kind === "hole" && c.dim && 2 * c.r * scale >= SMALLEST_HOLE) : [];
    // ---- positions ----
    // Per part, from the part's own left edge (over the view) and bottom
    // edge (right of it) as this view shows them.
    for (const name of new Set(holes.map((c) => c.part))) {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const L of views[k].parts.find((q) => q.name === name)?.lines ?? [])
      for (let n = 0; n < L.length; n += 2) (box[0] = min(box[0], L[n])), (box[1] = min(box[1], L[n + 1])), (box[2] = max(box[2], L[n])), (box[3] = max(box[3], L[n + 1]));
    if (!(box[2] > box[0])) continue;
    const centres = [];
    for (const c of holes) if (c.part === name && !centres.some((o) => hypot(o.u - c.u, o.v - c.v) < 1e-3 * (1 + abs(c.u)))) centres.push(c);
    // A bore in the middle of its part (a bush, a wheel) is placed by being in the middle.
    const mid = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    if (centres.length === 1 && hypot(centres[0].u - mid[0], centres[0].v - mid[1]) < 2e-3 * (box[2] - box[0] + box[3] - box[1])) continue;
    const distinct = (vals) => [...new Set(vals.map((v) => round(v * 100) / 100))].sort((a, b) => a - b);
    const us = distinct(centres.map((c) => c.u)).filter((u) => u - box[0] > 0.05);
    const vs = distinct(centres.map((c) => c.v)).filter((v) => v - box[1] > 0.05);
    if (!centres.length) continue;
    if (us.length > MOST_POSITIONS || vs.length > MOST_POSITIONS) {
      notes.left_out.push(`hole positions on the ${views[k].view} view (holes at ${max(us.length, vs.length)} places across; say which to dimension)`);
      continue;
    }
    // Running dimensions (ISO 129-1): one line each way from an origin on
    // the view's left or bottom edge, each value at its own arrow, so any
    // number of holes takes one line. Horizontal over the view, vertical right of it.
    const x0 = tx(box[0]), y0 = ty(box[1]);
    const running = (horizontal) => {
      const stops = (horizontal ? us : vs).map((q) => {
        const at = horizontal ? tx(q) : ty(q);
        const here = centres.filter((c) => abs((horizontal ? c.u : c.v) - q) < 0.01);
        // The extension line starts just past the hole's centre line.
        const from = horizontal ? min(...here.map((c) => ty(c.v) - c.r * scale - CENTRE_OVER - 1)) : max(...here.map((c) => tx(c.u) + c.r * scale + CENTRE_OVER + 1));
        const lbl = dimensionText(q - (horizontal ? box[0] : box[1]));
        return { at, from, lbl, w: textWidth(lbl, 3.5) };
      });
      if (!stops.length) return;
      for (let level = 0; level < 3; level++) {
        const line = horizontal ? V.y - 7 - 6 * level : V.x + V.w + 7 + 6 * level;
        // Values read along their extension lines: up the page over the view, across it on the right.
        const rects = stops.map((t) => (horizontal ? [t.at - 4.5, line - 1.5 - t.w - 1, t.at + 0.8, line - 1] : [line + 1, t.at - 4.5, line + 1.5 + t.w + 1, t.at + 0.8]));
        const far = horizontal ? max(...stops.map((t) => t.at)) : min(...stops.map((t) => t.at));
        const lineRect = horizontal ? [x0 - 1, line - 0.6, far + 0.5, line + 0.6] : [line - 0.6, far - 0.5, line + 0.6, y0 + 1];
        if (![...rects, lineRect].every(free)) continue;
        const d = [], o = [];
        const P = (along, acr) => (horizontal ? [along, acr] : [acr, along]);
        const segp = (p, q) => `M${c2(p[0])} ${c2(p[1])}L${c2(q[0])} ${c2(q[1])}`;
        const origin = horizontal ? x0 : y0, edge = horizontal ? V.y - 1.5 : V.x + V.w + 1.5, beyond = horizontal ? -2 : 2;
        d.push(segp(P(origin, edge), P(origin, line + beyond)), segp(P(origin, line), P(far, line)));
        o.push(`<circle cx="${c2(P(origin, line)[0])}" cy="${c2(P(origin, line)[1])}" r="0.75"/>`);
        for (const t of stops) {
          d.push(segp(P(t.at, t.from), P(t.at, line + beyond)));
          const tip = P(t.at, line);
          o.push(arrow(tip[0], tip[1], horizontal ? 1 : 0, horizontal ? 0 : -1));
          o.push(horizontal ? text(t.at - 1.2, line - 1.5, 3.5, t.lbl, `class="dimension" data-dimension="position" data-view="${views[k].view}" ${INK} transform="rotate(-90 ${c2(t.at - 1.2)} ${c2(line - 1.5)})"`) : text(line + 1.5, t.at - 1.2, 3.5, t.lbl, `class="dimension" data-dimension="position" data-view="${views[k].view}" ${INK}`));
        }
        dims.push(`<path d="${d.join("")}"/>${o.join("")}`);
        taken.push(...rects);
        thin.push(lineRect);
        for (const t of stops) thin.push(horizontal ? [t.at - 0.4, line, t.at + 0.4, t.from] : [t.from, t.at - 0.4, line, t.at + 0.4]);
        thin.push(horizontal ? [origin - 0.4, line, origin + 0.4, edge] : [edge, origin - 0.4, line, origin + 0.4]);
        notes.positions += stops.length;
        return;
      }
      notes.left_out.push(`the hole positions ${horizontal ? "across" : "up"} the ${views[k].view} view (no room)`);
    };
    running(true);
    running(false);
    }
  }
  // ---- diameters ----
  // After every position dimension, so labels go round them.
  for (const k of keys) {
    if (!sized) break;
    const marks = views[k].marks;
    if (!marks) continue;
    const { tx, ty } = map(k);
    const V = at[k];
    const own = [V.x - 1, V.y - 1, V.x + V.w + 1, V.y + V.h + 1];
    const seg = (x0, y0, x1, y1) => `M${c2(x0)} ${c2(y0)}L${c2(x1)} ${c2(y1)}`;
    const holes = marks.circles.filter((c) => c.kind === "hole" && c.dim && 2 * c.r * scale >= SMALLEST_HOLE);
    const groups = new Map();
    for (const c of holes) {
      const text = c.label ?? `⌀${dimensionText(2 * c.r)}`;
      const key = `${c.part}|${text}`;
      const g = groups.get(key) ?? { text, list: [], source: c.source, error: 0 };
      // Concentric copies of one hole count once.
      if (!g.list.some((o) => hypot(o.u - c.u, o.v - c.v) < 1e-3 * (1 + abs(c.u)))) g.list.push(c);
      g.error = max(g.error, c.error ?? 0);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const label = `${g.list.length > 1 ? `${g.list.length}× ` : ""}${g.text}`;
      const w = textWidth(label, 3.5);
      // Try places right of, above, left of and under the view, nearest first.
      let best = null;
      for (const c of g.list) {
        const cx = tx(c.u), cy = ty(c.v), r = c.r * scale;
        const tries = [];
        for (const off of [4, 9, 14])
          for (const dy of [0, -6, 6, -12, 12, -18, 18]) {
            tries.push({ x: V.x + V.w + off, y: cy + dy, side: 1 });
            tries.push({ x: V.x - off - w - 2, y: cy + dy, side: -1 });
          }
        for (const off of [5, 11, 17])
          for (const dx of [0, 8, -8, 16, -16, 24]) {
            tries.push({ x: cx + dx + 3, y: V.y - off, side: 1 });
            tries.push({ x: cx + dx + 3, y: V.y + V.h + off + 4, side: 1 });
          }
        for (const t of tries) {
          // The label sits on a shoulder; the leader runs from the circle to the shoulder's end.
          const sx = t.side > 0 ? t.x - 1 : t.x + w + 1, sy = t.y + 1;
          const rect = [t.x - 1.5, t.y - 4.5, t.x + w + 1.5, t.y + 2.5];
          const dirx = sx - cx, diry = sy - cy, dl = hypot(dirx, diry);
          if (dl < r + 3) continue;
          const px = cx + (dirx / dl) * r, py = cy + (diry / dl) * r;
          // A leader square to the paper runs along extension lines: avoided where there is another way.
          const slope = Math.atan2(abs(diry), abs(dirx)) * 180 / PI;
          const cost = slope < 20 || slope > 70 ? dl * 3 : dl;
          if (best && cost >= best.cost) continue;
          if (!free(rect)) continue;
          // The leader may cross its own view, but no other view or label.
          if (taken.some((q) => !(q[0] === own[0] && q[1] === own[1] && q[2] === own[2]) && crosses([px, py], [sx, sy], q))) continue;
          best = { cost, rect, t, sx, sy, px, py, w };
        }
      }
      if (!best) {
        notes.left_out.push(`the diameter ${label} on the ${views[k].view} view (no room)`);
        continue;
      }
      const { t, sx, sy, px, py, rect } = best;
      taken.push(rect);
      const ex = t.side > 0 ? t.x + best.w + 1 : t.x - 1;
      dims.push(`<path d="${seg(px, py, sx, sy)}${seg(sx, sy, ex, sy)}"/>`, arrow(px, py, px - sx, py - sy, 3, 0.5), text(t.x, t.y, 3.5, label, `class="dimension" data-dimension="diameter" data-view="${views[k].view}" ${INK}`));
      notes.holes.push({ view: views[k].view, text: label, from: g.source === "script" ? "the script" : "a circle fitted to the view" });
      if (g.source === "fitted") notes.fitted.push({ diameter: dimensionText(2 * g.list[0].r), within_mm: round(g.error * 1000) / 1000 });
    }

  }
  const svg = [];
  if (centre.length) svg.push(`<g id="centre-lines" data-layer="CENTRE" stroke-width="${narrow}" stroke-linecap="butt">\n${centre.join("\n")}\n</g>\n`);
  if (dims.length) svg.push(`<g id="hole-dimensions" data-layer="DIMENSIONS" stroke-width="${narrow}">\n${dims.join("\n")}\n</g>\n`);
  return { svg: svg.join(""), notes };
}

// A position dimension from a datum to a hole centre, on paper. Horizontal:
// a and b are x, their extension lines start at y fa and fb and run to the
// dimension line at y `line` (over the view). Vertical: a and b are y, the
// lines start at x fa and fb and run to x `line` (right of the view).
function positionDim(horizontal, a, fa, b, fb, line, label, view) {
  const P = (along, acr) => (horizontal ? [along, acr] : [acr, along]);
  const dir = horizontal ? -1 : 1;
  const seg = (p, q) => `M${c2(p[0])} ${c2(p[1])}L${c2(q[0])} ${c2(q[1])}`;
  const d = [seg(P(a, fa), P(a, line + dir * 2)), seg(P(b, fb), P(b, line + dir * 2)), seg(P(a, line), P(b, line))];
  const out = [`<path d="${d.join("")}"/>`];
  const along = horizontal ? [1, 0] : [0, 1];
  const s = Math.sign(b - a) || 1;
  const lo = P(a, line), hi = P(b, line);
  if (abs(b - a) >= 7) out.push(arrow(lo[0], lo[1], -s * along[0], -s * along[1]), arrow(hi[0], hi[1], s * along[0], s * along[1]));
  else out.push(arrow(hi[0], hi[1], s * along[0], s * along[1]));
  const mid = P((a + b) / 2, line);
  const attrs = `class="dimension" data-dimension="position" data-view="${view}" text-anchor="middle" ${INK}`;
  out.push(horizontal ? text(mid[0], mid[1] - 1.2, 3.5, label, attrs) : text(mid[0] - 1.2, mid[1], 3.5, label, `${attrs} transform="rotate(-90 ${c2(mid[0] - 1.2)} ${c2(mid[1])})"`));
  return out.join("");
}

// Today's date as it goes in the title block: 2026-01-31.
export function today() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// Which side view a projection uses.
export const sideViewOf = (projection) => (projection === "third" ? "right" : "left");

// The whole drawing in one go, on this thread (the app shares the views out
// over its workers instead): { svg, scale, iso, section: { axis, offset, area } }.
// title and date go in the title block, with the rest of info (see sheetSVG).
// section: { axis, offset }, both optional (see sectionPlane).
export function drawingSVG(parts, { title, date = today(), info = {}, section, projection = "first", resolution, crease, hidden = false, size = "A3", detail = null } = {}) {
  const bounds = modelBounds(parts);
  const plane = sectionPlane(bounds, section);
  const opts = { resolution, crease };
  const flat = { ...opts, hidden };
  const views = { front: markedView(parts, "front", flat), top: markedView(parts, "top", flat), side: markedView(parts, sideViewOf(projection), flat) };
  // The isometric view is drawn only where the sheet has room for it.
  if (planSheet({ bounds, axis: plane.axis, projection, isoBox: outlineBox(parts, "iso"), size }).iso) views.iso = viewOutline(parts, "iso", opts);
  const cut = sectionView(parts, plane, opts);
  const sheet = sheetSVG({ info: { title, date, type: documentType(parts.length), ...info }, bounds, views, section: cut, projection, size, detail });
  return { ...sheet, section: { axis: cut.axis, offset: cut.offset, area: cut.area } };
}

// ---- detail view ----
// Polylines on paper cut to the inside of a circle.
function clipToCircle(lines, cx, cy, r) {
  const out = [];
  for (const L of lines) {
    let cur = null;
    const inside = (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    for (let n = 2; n < L.length; n += 2) {
      const x0 = L[n - 2], y0 = L[n - 1], x1 = L[n], y1 = L[n + 1];
      // Where the segment crosses the circle: t in [0, 1].
      const dx = x1 - x0, dy = y1 - y0, fx = x0 - cx, fy = y0 - cy;
      const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r;
      const disc = b * b - 4 * a * c;
      let t0 = 0, t1 = 1;
      if (a < 1e-18) continue;
      if (disc <= 0) {
        if (!inside(x0, y0)) {
          cur = null;
          continue;
        }
      } else {
        const sq = sqrt(disc);
        t0 = max(0, (-b - sq) / (2 * a));
        t1 = min(1, (-b + sq) / (2 * a));
        if (t0 >= t1) {
          cur = null;
          continue;
        }
      }
      const ax = x0 + dx * t0, ay = y0 + dy * t0, bx = x0 + dx * t1, by = y0 + dy * t1;
      if (!cur || t0 > 0) {
        cur = [ax, ay];
        out.push(cur);
      }
      cur.push(bx, by);
      if (t1 < 1) cur = null;
    }
  }
  return out.filter((l) => l.length >= 4);
}

// A detail view: a crowded part of one view drawn again at a larger
// standard scale, in a free place on the sheet, with its circle and letter
// on the view it comes from (ISO 128-3). spec: true picks the most crowded
// place of the three views; or { view: "front", "top" or "side", at: [x, y,
// z] (mm, its middle), radius (mm) }. Returns { svg, info } or { left_out }.
function detailView({ views, at, map, names, scale, wide, narrow, taken, spec }) {
  const keys = ["front", "top", "side"];
  let k, cx, cy, R;
  if (spec === true || spec?.at === undefined) {
    // The most crowded place: line length per 4 mm square of paper.
    const cell = 4;
    let best = null;
    for (const key of spec?.view ? [spec.view === "left" || spec.view === "right" ? "side" : spec.view] : keys) {
      const { tx, ty } = map(key);
      const bins = new Map();
      for (const p of views[key].parts)
        for (const L of p.lines)
          for (let n = 2; n < L.length; n += 2) {
            const x0 = tx(L[n - 2]), y0 = ty(L[n - 1]), x1 = tx(L[n]), y1 = ty(L[n + 1]);
            const len = hypot(x1 - x0, y1 - y0), m = max(1, ceil(len));
            for (let i = 0; i < m; i++) {
              const t = (i + 0.5) / m, kx = floor((x0 + t * (x1 - x0)) / cell), ky = floor((y0 + t * (y1 - y0)) / cell);
              const b = bins.get(kx * 10000 + ky) ?? { kx, ky, len: 0 };
              b.len += len / m;
              bins.set(kx * 10000 + ky, b);
            }
          }
      for (const b of bins.values()) {
        // Smoothed over the square and its neighbours.
        let sum = 0;
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) sum += bins.get((b.kx + i) * 10000 + b.ky + j)?.len ?? 0;
        if (!best || sum > best.sum) best = { key, sum, kx: b.kx, ky: b.ky, bins };
      }
    }
    if (!best) return { left_out: "the detail view (nothing to show)" };
    k = best.key;
    // The crowded patch around it: squares at least half as full, joined to it.
    const peak = best.bins.get(best.kx * 10000 + best.ky).len;
    const seen = new Set([best.kx * 10000 + best.ky]), todo = [[best.kx, best.ky]];
    let x0 = best.kx, x1 = best.kx, y0 = best.ky, y1 = best.ky;
    while (todo.length) {
      const [i, j] = todo.pop();
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = (i + di) * 10000 + j + dj;
        if (seen.has(key) || (best.bins.get(key)?.len ?? 0) < peak / 2 || seen.size > 60) continue;
        seen.add(key);
        todo.push([i + di, j + dj]);
        (x0 = min(x0, i + di)), (x1 = max(x1, i + di)), (y0 = min(y0, j + dj)), (y1 = max(y1, j + dj));
      }
    }
    cx = ((x0 + x1 + 1) / 2) * cell;
    cy = ((y0 + y1 + 1) / 2) * cell;
    R = min(25, max(6, (hypot(x1 - x0 + 1, y1 - y0 + 1) * cell) / 2 + 1));
  } else {
    k = spec.view === "left" || spec.view === "right" ? "side" : spec.view ?? "front";
    if (!keys.includes(k)) throw new Error(`A detail view is of the front, top or side view, not ${JSON.stringify(spec.view)}.`);
    const { u, v } = VIEWS[names[k]];
    const { tx, ty } = map(k);
    const P = spec.at;
    if (!Array.isArray(P) || P.length !== 3 || !P.every(Number.isFinite)) throw new Error("A detail view's at is a point [x, y, z] in mm.");
    cx = tx(u[0] * P[0] + u[1] * P[1] + u[2] * P[2]);
    cy = ty(v[0] * P[0] + v[1] * P[1] + v[2] * P[2]);
    R = (spec.radius ?? 20 / scale) * scale;
    if (!(R > 0)) throw new Error("A detail view's radius must be a positive number of mm.");
  }
  // The largest standard scale, at least twice the sheet's, whose circle has room.
  const free = (r) => r[0] >= SHEET.left + 2 && r[1] >= SHEET.top + 2 && r[2] <= SHEET.right - 2 && r[3] <= SHEET.bottom - 2 && !taken.some((t) => meets(t, r));
  for (const s of SCALES) {
    if (s < scale * 2 * (1 - 1e-9)) break;
    // At most 90 mm across on the sheet: a bigger patch is cut down to its middle.
    const f = s / scale, Rk = min(R, 45 / f), D = Rk * f;
    if (Rk < R / 2) continue;
    // Places on a 5 mm grid, nearest the circle on the view first.
    let spot = null;
    for (let y = SHEET.top + 2 + D + 8; y + D + 10 <= SHEET.bottom - 2; y += 5)
      for (let x = SHEET.left + 2 + D; x + D <= SHEET.right - 2; x += 5) {
        const box = [x - D - 1, y - D - 8, x + D + 1, y + D + 9];
        if (!free(box)) continue;
        const d = hypot(x - cx, y - cy);
        if (!spot || d < spot.d) spot = { x, y, d, box };
      }
    if (!spot) continue;
    // The letter on the parent view, just outside its circle, where it is free.
    let letter = null;
    for (const an of [-45, -135, 45, 135, -90, 0, 180, 90]) {
      const a = (an * PI) / 180, lx = cx + cos(a) * (Rk + 4), ly = cy + sin(a) * (Rk + 4) + 1.8;
      const box = [lx - 3, ly - 5, lx + 3, ly + 1];
      // It may sit on its own view, but on nothing else.
      const own = at[k];
      if (free(box) || (box[0] >= SHEET.left + 2 && !taken.some((t) => meets(t, box) && !(t[0] === own.x - 1 && t[1] === own.y - 1)))) {
        letter = { lx, ly, box };
        break;
      }
    }
    if (!letter) continue;
    taken.push(spot.box, letter.box, [cx - Rk - 0.5, cy - Rk - 0.5, cx + Rk + 0.5, cy + Rk + 0.5]);
    const { tx, ty } = map(k);
    const T = (x, y) => [spot.x + (x - cx) * f, spot.y + (y - cy) * f];
    const out = [`<g id="detail-B" class="detail" data-view="${names[k]}" data-scale="${scaleText(s)}">\n`];
    out.push(`<g data-layer="DETAIL" stroke-width="${narrow}"><circle cx="${c2(cx)}" cy="${c2(cy)}" r="${c2(Rk)}"/><circle cx="${c2(spot.x)}" cy="${c2(spot.y)}" r="${c2(D)}"/></g>`);
    out.push(text(letter.lx, letter.ly, 5, "B", `data-layer="DETAIL" text-anchor="middle" ${INK}`));
    out.push(`<g data-layer="VISIBLE" stroke-width="${wide}">\n`);
    for (const p of views[k].parts) {
      const paper = p.lines.map((L) => Float64Array.from(L, (q, n) => (n % 2 ? ty(q) : tx(q))));
      const inner = clipToCircle(paper, cx, cy, Rk).map((L) => Float64Array.from(L, (q, n) => (n % 2 ? T(0, q)[1] : T(q, 0)[0])));
      if (inner.length) out.push(`<path data-part="${xml(p.name)}" d="${pathOf(inner, (q) => q, (q) => q)}"/>\n`);
    }
    out.push("</g>\n");
    out.push(text(spot.x, spot.y + D + 7, 5, `B (${scaleText(s)})`, `id="detail-name" data-layer="DETAIL" text-anchor="middle" ${INK}`));
    out.push("\n</g>\n");
    return { svg: out.join(""), info: { view: names[k], scale: scaleText(s), letter: "B" } };
  }
  return { left_out: "the detail view (no room on the sheet for it at twice the scale or more)" };
}
