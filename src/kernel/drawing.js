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
export function viewOutline(parts, view, { resolution = 3200, crease = 30, cut = null } = {}) {
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
    for (let e = 0; e < ne; e++) {
      const t0 = E[e * 6 + 2], t1 = E[e * 6 + 3];
      const f0 = front[t0], f1 = t1 < 0 ? 0 : front[t1];
      // An outline (only for the mesh's own edges), or a sharp edge on a face that shows.
      if (!((f0 !== f1 && e < real) || (sharp[e] && (f0 || f1)))) continue;
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
      let start = -1;
      for (let k = 0; k <= n; k++) {
        const t = ta + ((k + 0.5) / n) * (tb - ta);
        const x = xa + t * (xb - xa), y = ya + t * (yb - ya), z = za + t * (zb - za);
        const vis = k < n && ((f0 && !hidden(x + step[0], y + step[1], z + step[2])) || (f1 && !hidden(x + step[3], y + step[4], z + step[5])));
        if (vis && start < 0) start = k;
        else if (!vis && start >= 0) {
          const s0 = ta + (start / n) * (tb - ta), s1 = ta + (k / n) * (tb - ta);
          ka.push(start === 0 && ta === 0 ? a : -1);
          kb.push(k === n && tb === 1 ? b : -1);
          pts.push(U[a] + s0 * (U[b] - U[a]), V[a] + s0 * (V[b] - V[a]), U[a] + s1 * (U[b] - U[a]), V[a] + s1 * (V[b] - V[a]));
          start = -1;
        }
      }
    }
    const lines = chain(ka, kb, pts, U.length, 3 * px, 0.2 * px);
    if (lines.length) out.push({ name: part.name, lines });
  });
  return { view, box, pixel: px, parts: out };
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
const SHEET = { w: 420, h: 297, left: 20, top: 10, right: 410, bottom: 287 };
const TITLE = { w: 180, h: 30 };
// Line widths: ISO 128's 0.25 group, which keeps a crowded assembly readable.
const THICK = 0.25, THIN = 0.13;
const FONT = 'font-family="Helvetica, Arial, sans-serif"';
// Room kept around the views for dimensions, the cutting line's letters and the section's name.
const ROOM = { left: 24, top: 14, right: 12, bottom: 18, gapX: 28, gapY: 32 };
const DIM_OFF = 13; // from a view to its dimension line

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

// Places the four views at scale s, or returns null if they do not fit on
// the sheet clear of the title block.
function place(sizes, s, projection, sectionAt) {
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
  if (W > fw || H > fh) return null;
  const colX = [ROOM.left, ROOM.left + cols[0] + ROOM.gapX, ROOM.left + cols[0] + cols[1] + 2 * ROOM.gapX];
  const rowY = [ROOM.top, ROOM.top + rows[0] + ROOM.gapY];
  const title = [SHEET.right - TITLE.w - 6, SHEET.bottom - TITLE.h - 6];
  // Centred on the sheet; else centred above the title block; else at its left.
  for (const [ox, oy] of [
    [SHEET.left + (fw - W) / 2, SHEET.top + (fh - H) / 2],
    [SHEET.left + (fw - W) / 2, SHEET.top + (fh - TITLE.h - H) / 2],
    [SHEET.left + (fw - TITLE.w - W) / 2, SHEET.top + (fh - H) / 2],
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
    if (clear) return at;
  }
  return null;
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
const text = (x, y, size, str, attrs = "") => `<text x="${c2(x)}" y="${c2(y)}" font-size="${size}" ${attrs}>${xml(str)}</text>`;

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
  const attrs = `class="dimension" data-dimension="${kind}" text-anchor="middle" fill="#000" stroke="none"`;
  // Numbers sit above a horizontal line, and left of a vertical one, read from the right.
  out.push(horizontal ? text(mid[0], mid[1] - 1.2, 3.5, label, attrs) : text(mid[0] - 1.2, mid[1], 3.5, label, `${attrs} transform="rotate(-90 ${c2(mid[0] - 1.2)} ${c2(mid[1])})"`));
  return out.join("");
}

// The symbol that says which way the views are laid out: a cone seen from
// the side, and from its small end. First angle has the end view on the right.
function projectionSymbol(x, y, first) {
  const cx = first ? x + 12.5 : x + 3, fx = first ? x : x + 8;
  return (
    `<path d="M${c2(fx)} ${c2(y - 1.5)}L${c2(fx + 7)} ${c2(y - 3)}L${c2(fx + 7)} ${c2(y + 3)}L${c2(fx)} ${c2(y + 1.5)}Z"/>` +
    `<circle cx="${c2(cx)}" cy="${c2(y)}" r="1.5"/><circle cx="${c2(cx)}" cy="${c2(y)}" r="3"/>` +
    `<path stroke-width="${THIN}" stroke-dasharray="3 0.8 0.5 0.8" d="M${c2(fx - 1)} ${c2(y)}L${c2(fx + 8)} ${c2(y)}M${c2(cx - 4)} ${c2(y)}L${c2(cx + 4)} ${c2(y)}M${c2(cx)} ${c2(y - 4)}L${c2(cx)} ${c2(y + 4)}"/>`
  );
}

// The drawing sheet: A3 landscape, with a border, a title block, the front,
// top and side views, the section A-A with its cutting line on a view, and
// the overall width, depth and height.
//   bounds: the model's box. views: { front, top, side } from viewOutline
//   (side is "left" in first angle, "right" in third). section: from sectionView.
// Returns { svg, scale } where scale is e.g. "1:5".
export function sheetSVG({ title = "", date = "", bounds, views, section, projection = "first" }) {
  const first = projection !== "third";
  const sideName = first ? "left" : "right";
  const names = { front: "front", top: "top", side: sideName, section: section.view };
  const boxes = Object.fromEntries(Object.entries(names).map(([k, name]) => [k, viewBox(bounds, name)]));
  const sizes = Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, [b[2] - b[0], b[3] - b[1]]]));
  let at = null, scale = 0;
  for (const s of SCALES) {
    at = place(sizes, s, projection, "corner") ?? place(sizes, s, projection, "end");
    if (at) {
      scale = s;
      break;
    }
  }
  if (!at) throw new Error("The model is too large for a drawing sheet.");
  // Model millimetres in a view to paper millimetres (paper's y runs down).
  const map = (k) => ({ tx: (pu) => at[k].x + (pu - boxes[k][0]) * scale, ty: (pv) => at[k].y + (boxes[k][3] - pv) * scale });

  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET.w}mm" height="${SHEET.h}mm" viewBox="0 0 ${SHEET.w} ${SHEET.h}" data-scale="${scaleText(scale)}" data-projection="${first ? "first-angle" : "third-angle"}">\n`);
  out.push(`<title>${xml(title || "Drawing")}</title>\n<rect width="${SHEET.w}" height="${SHEET.h}" fill="#fff"/>\n`);
  out.push(`<g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round" ${FONT}>\n`);
  out.push(`<rect id="border" x="${SHEET.left}" y="${SHEET.top}" width="${SHEET.right - SHEET.left}" height="${SHEET.bottom - SHEET.top}" stroke-width="0.5"/>\n`);

  // The three views.
  for (const k of ["front", "top", "side"]) {
    const { tx, ty } = map(k);
    out.push(`<g id="view-${names[k]}" class="view" data-view="${names[k]}" stroke-width="${THICK}">\n`);
    for (const p of views[k].parts) out.push(`<path data-part="${xml(p.name)}" d="${pathOf(p.lines, tx, ty)}"/>\n`);
    out.push("</g>\n");
  }

  // The section: what lies beyond the cut, then the cut faces, hatched.
  {
    const { tx, ty } = map("section");
    out.push(`<g id="section-A" class="section" data-axis="${section.axis}" data-offset="${fmt(section.offset)}" data-area="${fmt(section.area)}">\n`);
    out.push(`<g class="beyond" stroke-width="${THICK}">\n`);
    for (const p of section.beyond ?? []) out.push(`<path data-part="${xml(p.name)}" d="${pathOf(p.lines, tx, ty)}"/>\n`);
    out.push("</g>\n");
    section.parts.forEach((p, i) => {
      const loops = p.loops.map((L) => Float64Array.from(L, (q, n) => (n % 2 ? ty(q) : tx(q))));
      // Neighbours in the list lean opposite ways; the spacing changes every two.
      let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (const L of loops) for (let n = 0; n < L.length; n++) (lo[n % 2] = min(lo[n % 2], L[n])), (hi[n % 2] = max(hi[n % 2], L[n]));
      const spacing = min([2.4, 3.2, 1.8, 4][(i >> 1) % 4], max(0.6, min(hi[0] - lo[0], hi[1] - lo[1]) / 3));
      out.push(`<g class="cut" data-part="${xml(p.name)}" data-area="${fmt(p.area)}">`);
      out.push(`<path class="hatch" stroke-width="${THIN}" d="${hatch(loops, i % 2 ? -45 : 45, spacing)}"/>`);
      out.push(`<path class="cut-outline" stroke-width="0.35" d="${loops.map((L) => `${pathOf([L], (q) => q, (q) => q)}Z`).join("")}"/></g>\n`);
    });
    const s = at.section;
    out.push(text(s.x + s.w / 2, s.y - 6, 5, "A–A", 'text-anchor="middle" fill="#000" stroke="none"'), "\n</g>\n");
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
    out.push(`<g id="cutting-line" data-view="${host}">\n`);
    out.push(`<path stroke-width="${THIN}" stroke-dasharray="8 1.5 0.5 1.5" d="M${c2(ends[0][0])} ${c2(ends[0][1])}L${c2(ends[1][0])} ${c2(ends[1][1])}"/>`);
    ends.forEach((e, i) => {
      out.push(`<path stroke-width="0.5" stroke-linecap="butt" d="M${c2(e[0])} ${c2(e[1])}L${c2(inner[i][0])} ${c2(inner[i][1])}"/>`);
      const tail = [e[0] - look[0] * 7, e[1] - look[1] * 7];
      out.push(`<path stroke-width="${THIN}" d="M${c2(tail[0])} ${c2(tail[1])}L${c2(e[0])} ${c2(e[1])}"/>`, arrow(e[0], e[1], look[0], look[1], 3.5, 0.7));
      // The letter, beyond the end of the line.
      const out2 = vertical ? [0, i ? 1 : -1] : [i ? 1 : -1, 0];
      out.push(text(tail[0] + look[0] * 2 + out2[0] * 3, tail[1] + look[1] * 2 + out2[1] * 3 + 1.4, 4, "A", 'text-anchor="middle" fill="#000" stroke="none"'));
    });
    out.push("\n</g>\n");
  }

  // Overall sizes: height on the front view, depth on the top view, and
  // width under whichever of the two is lower on the sheet.
  {
    const size = [0, 1, 2].map((a) => bounds[a + 3] - bounds[a]);
    const f = at.front, t = at.top, low = first ? t : f;
    out.push(`<g id="dimensions" stroke-width="${THIN}">\n`);
    out.push(dimension("height", f.y, f.y + f.h, f.x, -DIM_OFF, dimensionText(size[2])), "\n");
    out.push(dimension("depth", t.y, t.y + t.h, t.x, -DIM_OFF, dimensionText(size[1])), "\n");
    out.push(dimension("width", low.x, low.x + low.w, low.y + low.h, DIM_OFF - 2, dimensionText(size[0])), "\n");
    out.push("</g>\n");
  }

  // The title block, in the bottom right corner.
  {
    const x = SHEET.right - TITLE.w, y = SHEET.bottom - TITLE.h, mid = y + 18;
    const label = (px, py, str) => text(px + 1.5, py + 3.2, 1.8, str, 'fill="#000" stroke="none"');
    const value = (px, py, str, size = 3.5) => text(px + 1.5, py - 2.6, size, str, 'fill="#000" stroke="none"');
    const name = title || "Untitled";
    out.push(`<g id="title-block" stroke-width="${THICK}">\n`);
    out.push(`<rect x="${x}" y="${y}" width="${TITLE.w}" height="${TITLE.h}" fill="#fff" stroke-width="0.5"/>`);
    out.push(`<path d="M${x} ${mid}H${SHEET.right}M${x + 120} ${y}V${mid}M${x + 146} ${y}V${mid}M${x + 60} ${mid}V${SHEET.bottom}M${x + 100} ${mid}V${SHEET.bottom}M${x + 120} ${mid}V${SHEET.bottom}M${x + 146} ${mid}V${SHEET.bottom}"/>\n`);
    out.push(label(x, y, "Title"), `<text id="title" x="${c2(x + 1.5)}" y="${c2(mid - 4)}" font-size="${c2(min(5, 116 / (0.56 * name.length)))}" fill="#000" stroke="none">${xml(name)}</text>`);
    out.push(label(x + 120, y, "Scale"), `<text id="scale" x="${c2(x + 121.5)}" y="${c2(mid - 4)}" font-size="5" fill="#000" stroke="none">${scaleText(scale)}</text>`);
    out.push(label(x + 146, y, first ? "First-angle projection" : "Third-angle projection"), projectionSymbol(x + 155, y + 11, first));
    out.push(label(x, mid, "Made with"), value(x, SHEET.bottom, "3D Maker"));
    out.push(label(x + 60, mid, "Date"), `<text id="date" x="${c2(x + 61.5)}" y="${c2(SHEET.bottom - 2.6)}" font-size="3.5" fill="#000" stroke="none">${xml(date)}</text>`);
    out.push(label(x + 100, mid, "Units"), value(x + 100, SHEET.bottom, "mm"));
    out.push(label(x + 120, mid, "Size"), value(x + 120, SHEET.bottom, "A3"));
    out.push(label(x + 146, mid, "Sheet"), value(x + 146, SHEET.bottom, "1 / 1"));
    out.push("\n</g>\n");
  }
  out.push("</g>\n</svg>\n");
  return { svg: out.join(""), scale: scaleText(scale) };
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
// over its workers instead): { svg, scale, section: { axis, offset, area } }.
// section: { axis, offset }, both optional (see sectionPlane).
export function drawingSVG(parts, { title, date = today(), section, projection = "first", resolution, crease } = {}) {
  const bounds = modelBounds(parts);
  const plane = sectionPlane(bounds, section);
  const opts = { resolution, crease };
  const views = { front: viewOutline(parts, "front", opts), top: viewOutline(parts, "top", opts), side: viewOutline(parts, sideViewOf(projection), opts) };
  const cut = sectionView(parts, plane, opts);
  const sheet = sheetSVG({ title, date, bounds, views, section: cut, projection });
  return { ...sheet, section: { axis: cut.axis, offset: cut.offset, area: cut.area } };
}
