// Signed distance field kernel. A shape is a plain JSON tree (so it can be
// hashed, cached and sent between workers); compile() turns it into a fast
// function f(x, y, z) that is negative inside, positive outside, and never
// changes faster than distance (|grad f| <= 1), plus a bounding box.
// Units are millimetres, +Z is up, angles are degrees.

const DEG = Math.PI / 180;
const { abs, min, max, sqrt, hypot, sign, cos, sin } = Math;

// ---- bounding boxes: [minx, miny, minz, maxx, maxy, maxz] ----
const EMPTY = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
const isEmpty = (b) => !(b[0] <= b[3] && b[1] <= b[4] && b[2] <= b[5]);
const grow = (b, d) => (isEmpty(b) ? b : [b[0] - d, b[1] - d, b[2] - d, b[3] + d, b[4] + d, b[5] + d]);
const unionBox = (a, b) => [min(a[0], b[0]), min(a[1], b[1]), min(a[2], b[2]), max(a[3], b[3]), max(a[4], b[4]), max(a[5], b[5])];
const interBox = (a, b) => [max(a[0], b[0]), max(a[1], b[1]), max(a[2], b[2]), min(a[3], b[3]), min(a[4], b[4]), min(a[5], b[5])];
const corners = (b) => {
  const out = [];
  for (let i = 0; i < 8; i++) out.push([i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]]);
  return out;
};
const boxOf = (pts) => pts.reduce((b, [x, y, z]) => [min(b[0], x), min(b[1], y), min(b[2], z), max(b[3], x), max(b[4], y), max(b[5], z)], EMPTY);

// Distance from a point to a box (0 inside): a lower bound on the distance to anything in it.
const boxDist = (b, x, y, z) => {
  const dx = max(b[0] - x, x - b[3], 0);
  const dy = max(b[1] - y, y - b[4], 0);
  const dz = max(b[2] - z, z - b[5], 0);
  return sqrt(dx * dx + dy * dy + dz * dz);
};

// Polynomial smooth min/max: exact min when |a-b| >= k, otherwise blends by at most k/4.
const smin = (a, b, k) => {
  if (k <= 0) return min(a, b);
  const h = max(k - abs(a - b), 0) / k;
  return min(a, b) - h * h * k * 0.25;
};
const smax = (a, b, k) => -smin(-a, -b, k);

// Rotation matrix for [rx, ry, rz] degrees: about world X, then Y, then Z.
export function rotationMatrix([rx = 0, ry = 0, rz = 0]) {
  const [a, b, c] = [rx * DEG, ry * DEG, rz * DEG];
  const [ca, sa, cb, sb, cc, sc] = [cos(a), sin(a), cos(b), sin(b), cos(c), sin(c)];
  // R = Rz * Ry * Rx, row-major
  return [
    cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa,
    sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa,
    -sb, cb * sa, cb * ca,
  ];
}

// ---- 2D polygon distance (exact), points [[x, y], ...] ----
function polygon2D(pts) {
  const n = pts.length;
  const xs = Float64Array.from(pts, (p) => p[0]);
  const ys = Float64Array.from(pts, (p) => p[1]);
  return (px, py) => {
    let d = (px - xs[0]) ** 2 + (py - ys[0]) ** 2;
    let s = 1;
    for (let i = 0, j = n - 1; i < n; j = i, i++) {
      const ex = xs[j] - xs[i], ey = ys[j] - ys[i];
      const wx = px - xs[i], wy = py - ys[i];
      const t = min(max((wx * ex + wy * ey) / (ex * ex + ey * ey || 1), 0), 1);
      const bx = wx - ex * t, by = wy - ey * t;
      d = min(d, bx * bx + by * by);
      const c1 = py >= ys[i], c2 = py < ys[j], c3 = ex * wy > ey * wx;
      if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
    }
    return s * sqrt(d);
  };
}

// ---- bounding volume trees over line segments, for long outlines and paths ----
// Segments are given as flat arrays of start and end points (dim 2 or 3).
// Leaves hold up to 4 segments; inner nodes have two children.
function buildTree(ax, bx, dim) {
  const n = ax.length / dim;
  const order = Int32Array.from({ length: n }, (_, i) => i);
  const lo = [], hi = [], kids = [], start = [], count = [];
  const cen = (i, d) => (ax[i * dim + d] + bx[i * dim + d]) / 2;
  const make = (s, e) => {
    const id = start.length;
    const l = new Array(dim).fill(Infinity), h = new Array(dim).fill(-Infinity);
    for (let k = s; k < e; k++) {
      const i = order[k];
      for (let d = 0; d < dim; d++) {
        l[d] = min(l[d], ax[i * dim + d], bx[i * dim + d]);
        h[d] = max(h[d], ax[i * dim + d], bx[i * dim + d]);
      }
    }
    lo.push(...l);
    hi.push(...h);
    kids.push(-1, -1);
    start.push(s);
    count.push(e - s);
    if (e - s > 4) {
      let axis = 0;
      for (let d = 1; d < dim; d++) if (h[d] - l[d] > h[axis] - l[axis]) axis = d;
      const part = Array.from(order.subarray(s, e)).sort((i, j) => cen(i, axis) - cen(j, axis));
      order.set(part, s);
      const m = (s + e) >> 1;
      kids[id * 2] = make(s, m);
      kids[id * 2 + 1] = make(m, e);
      count[id] = 0;
    }
    return id;
  };
  make(0, n);
  return { lo: Float64Array.from(lo), hi: Float64Array.from(hi), kids: Int32Array.from(kids), start: Int32Array.from(start), count: Int32Array.from(count), order };
}

// Exact signed distance to a closed outline [[x, y], ...] (even-odd inside).
function outline2D(pts) {
  const n = pts.length;
  if (n <= 24) return polygon2D(pts);
  const ax = new Float64Array(n * 2), bx = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    ax[i * 2] = pts[i][0];
    ax[i * 2 + 1] = pts[i][1];
    bx[i * 2] = pts[j][0];
    bx[i * 2 + 1] = pts[j][1];
  }
  const { lo, hi, kids, start, count, order } = buildTree(ax, bx, 2);
  const stack = new Int32Array(256);
  return (px, py) => {
    let best = Infinity;
    let inside = false;
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const node = stack[--sp];
      const dx = max(lo[node * 2] - px, px - hi[node * 2], 0);
      const dy = max(lo[node * 2 + 1] - py, py - hi[node * 2 + 1], 0);
      // Visit for distance if it could hold a nearer segment; for inside/out
      // if a ray from the point towards +x could cross one of its segments.
      if (dx * dx + dy * dy >= best && !(lo[node * 2 + 1] <= py && hi[node * 2 + 1] > py && hi[node * 2] >= px)) continue;
      if (kids[node * 2] < 0) {
        for (let k = start[node], e = k + count[node]; k < e; k++) {
          const i = order[k];
          const x0 = ax[i * 2], y0 = ax[i * 2 + 1], x1 = bx[i * 2], y1 = bx[i * 2 + 1];
          const ex = x1 - x0, ey = y1 - y0, wx = px - x0, wy = py - y0;
          const t = min(max((wx * ex + wy * ey) / (ex * ex + ey * ey || 1), 0), 1);
          const qx = wx - ex * t, qy = wy - ey * t;
          best = min(best, qx * qx + qy * qy);
          if (y0 > py !== y1 > py && px < x0 + ((py - y0) * ex) / ey) inside = !inside;
        }
      } else {
        stack[sp++] = kids[node * 2];
        stack[sp++] = kids[node * 2 + 1];
      }
    }
    return (inside ? -1 : 1) * sqrt(best);
  };
}

// ---- 2D profiles: { f(x, y), box: [minx, miny, maxx, maxy] } ----
// Used by extrude, revolve, sweep and loft. Same rules as 3D: negative inside,
// never changing faster than distance.
const EMPTY2 = [Infinity, Infinity, -Infinity, -Infinity];
const isEmpty2 = (b) => !(b[0] <= b[2] && b[1] <= b[3]);
export function compile2(node) {
  const c = COMPILERS2[node.t];
  if (!c) throw new Error(`Unknown profile "${node.t}"`);
  return c(node);
}
const COMPILERS2 = {
  circle2: ({ r }) => ({ box: [-r, -r, r, r], f: (x, y) => sqrt(x * x + y * y) - r }),
  rect2({ w, h, r = 0 }) {
    const bx = w / 2 - r, by = h / 2 - r;
    return {
      box: [-w / 2, -h / 2, w / 2, h / 2],
      f: (x, y) => {
        const qx = abs(x) - bx, qy = abs(y) - by;
        return hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r;
      },
    };
  },
  poly2({ pts }) {
    const b = pts.reduce((q, [x, y]) => [min(q[0], x), min(q[1], y), max(q[2], x), max(q[3], y)], EMPTY2);
    return { box: b, f: outline2D(pts) };
  },
  union2({ c, k = 0 }) {
    const kids = c.map(compile2).filter((q) => !isEmpty2(q.box));
    if (!kids.length) return { box: EMPTY2, f: () => Infinity };
    const box = kids.reduce((b, q) => [min(b[0], q.box[0]), min(b[1], q.box[1]), max(b[2], q.box[2]), max(b[3], q.box[3])], EMPTY2);
    const fs = kids.map((q) => q.f);
    return { box, f: (x, y) => fs.reduce((d, f) => smin(d, f(x, y), k), Infinity) };
  },
  subtract2({ a, b, k = 0 }) {
    const A = compile2(a);
    const fs = b.map(compile2).map((q) => q.f);
    return { box: A.box, f: (x, y) => fs.reduce((d, f) => smax(d, -f(x, y), k), A.f(x, y)) };
  },
  intersect2({ c, k = 0 }) {
    const kids = c.map(compile2);
    const box = kids.reduce((b, q) => [max(b[0], q.box[0]), max(b[1], q.box[1]), min(b[2], q.box[2]), min(b[3], q.box[3])], [-Infinity, -Infinity, Infinity, Infinity]);
    const fs = kids.map((q) => q.f);
    return { box: isEmpty2(box) ? EMPTY2 : box, f: (x, y) => fs.reduce((d, f) => smax(d, f(x, y), k), -Infinity) };
  },
  move2({ v: [vx, vy], c }) {
    const C = compile2(c);
    const b = C.box;
    return { box: [b[0] + vx, b[1] + vy, b[2] + vx, b[3] + vy], f: (x, y) => C.f(x - vx, y - vy) };
  },
  rotate2({ deg, c }) {
    const C = compile2(c);
    const ca = cos(deg * DEG), sa = sin(deg * DEG);
    const b = C.box;
    const cs = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(([x, y]) => [ca * x - sa * y, sa * x + ca * y]);
    const box = cs.reduce((q, [x, y]) => [min(q[0], x), min(q[1], y), max(q[2], x), max(q[3], y)], EMPTY2);
    return { box: isEmpty2(b) ? EMPTY2 : box, f: (x, y) => C.f(ca * x + sa * y, -sa * x + ca * y) };
  },
  scale2({ s: [sx, sy], c }) {
    const C = compile2(c);
    const b = C.box;
    const xs = [b[0] * sx, b[2] * sx], ys = [b[1] * sy, b[3] * sy];
    const m = min(abs(sx), abs(sy));
    return { box: [min(...xs), min(...ys), max(...xs), max(...ys)], f: (x, y) => C.f(x / sx, y / sy) * m };
  },
  offset2({ d, c }) {
    const C = compile2(c);
    const b = C.box;
    return { box: [b[0] - max(d, 0), b[1] - max(d, 0), b[2] + max(d, 0), b[3] + max(d, 0)], f: (x, y) => C.f(x, y) - d };
  },
};
// The old point-list form of extrude and revolve.
const profileOf = (node) => compile2(node.p ?? { t: "poly2", pts: node.pts });
// Distance for a 2D distance d2 extended by a slab distance dz (negative inside).
const slab = (d2, dz) => min(max(d2, dz), 0) + hypot(max(d2, 0), max(dz, 0));

// ---- sweep: a profile carried along a path of 3D points ----
// The profile's y axis starts pointing towards `up` (default +Z, or +Y when
// the path starts vertical), x = y cross the path direction. Frames are
// carried along the path without twisting (rotation minimising), plus `twist`
// degrees spread over the length. Each point is measured in the frame of the
// nearest path segment; at a corner, the bisecting (mitre) plane decides.
function sweep3({ p, path, closed = false, twist = 0, up }) {
  const P = compile2(p);
  const n = path.length;
  const m = closed ? n : n - 1;
  const A = new Float64Array(m * 3), B = new Float64Array(m * 3);
  const T = [], len = [], S = [0];
  for (let i = 0; i < m; i++) {
    const a = path[i], b = path[(i + 1) % n];
    for (let d = 0; d < 3; d++) (A[i * 3 + d] = a[d]), (B[i * 3 + d] = b[d]);
    const v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = hypot(...v) || 1e-12;
    T.push(v.map((x) => x / l));
    len.push(l);
    S.push(S[i] + l);
  }
  const L = S[m];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a) => { const l = hypot(...a) || 1; return a.map((x) => x / l); };
  // Minimal rotation taking direction a to direction b, applied to v.
  const carry = (v, a, b) => {
    const k = cross(a, b), s = hypot(...k), c = dot(a, b);
    if (s < 1e-12) return c > 0 ? v : v.map((x) => -x);
    const u = k.map((x) => x / s), ang = Math.atan2(s, c);
    const ca = cos(ang), sa = sin(ang), uv = cross(u, v), ud = dot(u, v);
    return [0, 1, 2].map((i) => v[i] * ca + uv[i] * sa + u[i] * ud * (1 - ca));
  };
  let upv = up ?? [0, 0, 1];
  if (abs(dot(unit(upv), T[0])) > 0.999) upv = [0, 1, 0];
  let Y = unit(upv.map((x, i) => x - dot(upv, T[0]) * T[0][i]));
  const X = [], Yv = [];
  for (let i = 0; i < m; i++) {
    if (i) Y = unit(carry(Y, T[i - 1], T[i]));
    Yv.push(Y);
    X.push(cross(Y, T[i]));
  }
  // A closed path's frame comes back turned; spread the correction over it.
  let turnRad = twist * DEG;
  if (closed && m > 1) {
    const back = carry(Yv[m - 1], T[m - 1], T[0]);
    turnRad -= Math.atan2(dot(cross(Yv[0], back), T[0]), dot(Yv[0], back));
  }
  const { lo, hi, kids, start, count, order } = buildTree(A, B, 3);
  const R = max(...[[P.box[0], P.box[1]], [P.box[2], P.box[1]], [P.box[2], P.box[3]], [P.box[0], P.box[3]]].map(([x, y]) => hypot(x, y)));
  // Twisting stretches distances far from the path; scale back to stay safe.
  const lip = sqrt(1 + (R * abs(turnRad / (L || 1))) ** 2);
  const stack = new Int32Array(256);
  const box = grow(boxOf(path), R);
  return {
    box,
    f: (x, y, z) => {
      let best = Infinity, seg = 0, bt = 0;
      let sp = 0;
      stack[sp++] = 0;
      while (sp) {
        const node = stack[--sp];
        const dx = max(lo[node * 3] - x, x - hi[node * 3], 0);
        const dy = max(lo[node * 3 + 1] - y, y - hi[node * 3 + 1], 0);
        const dz = max(lo[node * 3 + 2] - z, z - hi[node * 3 + 2], 0);
        if (dx * dx + dy * dy + dz * dz >= best) continue;
        if (kids[node * 2] < 0) {
          for (let k = start[node], e = k + count[node]; k < e; k++) {
            const i = order[k];
            const ex = B[i * 3] - A[i * 3], ey = B[i * 3 + 1] - A[i * 3 + 1], ez = B[i * 3 + 2] - A[i * 3 + 2];
            const wx = x - A[i * 3], wy = y - A[i * 3 + 1], wz = z - A[i * 3 + 2];
            const t = min(max((wx * ex + wy * ey + wz * ez) / (ex * ex + ey * ey + ez * ez || 1), 0), 1);
            const qx = wx - ex * t, qy = wy - ey * t, qz = wz - ez * t;
            const d = qx * qx + qy * qy + qz * qz;
            if (d < best) (best = d), (seg = i), (bt = t);
          }
        } else {
          stack[sp++] = kids[node * 2];
          stack[sp++] = kids[node * 2 + 1];
        }
      }
      // At a corner, the mitre plane decides which segment's frame to use.
      if (bt === 0 && (closed || seg > 0)) {
        const pr = (seg - 1 + m) % m;
        const q = [x - A[seg * 3], y - A[seg * 3 + 1], z - A[seg * 3 + 2]];
        if (dot(q, [T[pr][0] + T[seg][0], T[pr][1] + T[seg][1], T[pr][2] + T[seg][2]]) < 0) (seg = pr), (bt = 1);
      } else if (bt === 1 && (closed || seg < m - 1)) {
        const nx = (seg + 1) % m;
        const q = [x - B[seg * 3], y - B[seg * 3 + 1], z - B[seg * 3 + 2]];
        if (dot(q, [T[seg][0] + T[nx][0], T[seg][1] + T[nx][1], T[seg][2] + T[nx][2]]) >= 0) (seg = nx), (bt = 0);
      }
      const o = bt === 1 ? B : A;
      const q = [x - o[seg * 3], y - o[seg * 3 + 1], z - o[seg * 3 + 2]];
      // The point on the path (corners use the corner itself).
      if (bt > 0 && bt < 1) for (let d = 0; d < 3; d++) q[d] = [x, y, z][d] - (A[seg * 3 + d] + (B[seg * 3 + d] - A[seg * 3 + d]) * bt);
      const ang = turnRad * ((S[seg] + bt * len[seg]) / (L || 1));
      const ca = cos(ang), sa = sin(ang);
      const Xs = X[seg], Ys = Yv[seg];
      const u0 = dot(q, Xs), v0 = dot(q, Ys);
      const u = ca * u0 + sa * v0, v = -sa * u0 + ca * v0;
      const d2 = P.f(u, v) / lip;
      if (!closed) {
        const w = dot(q, T[seg]);
        if (seg === 0 && bt === 0 && w < 0) return slab(d2, -w);
        if (seg === m - 1 && bt === 1 && w > 0) return slab(d2, w);
      }
      return d2;
    },
  };
}

// ---- loft: a solid through profiles stacked along Z ----
// Each section's box (centre and size) is interpolated with height, and every
// section is stretched onto that box before their distances are blended, so a
// wing's chord, thickness and sweep change smoothly from root to tip instead
// of the middle shrinking. Smooth lofts use monotone cubics, which never
// overshoot their neighbours. The blend is scaled back by how fast it changes
// with height, so it stays a safe distance.
function loft3({ s, smooth = true }) {
  const secs = s.map(({ z, p }) => ({ z, ...compile2(p) }));
  const n = secs.length;
  const zs = secs.map((q) => q.z);
  const z0 = zs[0], z1 = zs[n - 1];
  const cubic = smooth && n > 2;
  const P = [0, 1, 2, 3].map((i) =>
    secs.map(({ box: b }) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, max(b[2] - b[0], 1e-6), max(b[3] - b[1], 1e-6)][i]),
  );
  // Fritsch-Carlson slope at section i for values v (a function of section index).
  const slopeAt = (v, i) => {
    if (i === 0) return (v(1) - v(0)) / (zs[1] - zs[0]);
    if (i === n - 1) return (v(n - 1) - v(n - 2)) / (zs[n - 1] - zs[n - 2]);
    const h0 = zs[i] - zs[i - 1], h1 = zs[i + 1] - zs[i];
    const d0 = (v(i) - v(i - 1)) / h0, d1 = (v(i + 1) - v(i)) / h1;
    if (d0 * d1 <= 0) return 0;
    const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
    return (w1 + w2) / (w1 / d0 + w2 / d1);
  };
  const slopes = P.map((vals) => zs.map((_, i) => slopeAt((j) => vals[j], i)));
  const herm = (a, b, m0, m1, t, h) => {
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * b + (t3 - t2) * h * m1;
  };
  const b2 = secs.reduce((b, q) => [min(b[0], q.box[0]), min(b[1], q.box[1]), max(b[2], q.box[2]), max(b[3], q.box[3])], EMPTY2);
  const cache = new Map();
  // Blended distance at height z (within the loft).
  const at = (x, y, z) => {
    let k = 0;
    while (k < n - 2 && z > zs[k + 1]) k++;
    const h = zs[k + 1] - zs[k];
    const t = (z - zs[k]) / h;
    const box = P.map((vals, i) => (cubic ? herm(vals[k], vals[k + 1], slopes[i][k], slopes[i][k + 1], t, h) : vals[k] + (vals[k + 1] - vals[k]) * t));
    cache.clear();
    const d = (j) => {
      let v = cache.get(j);
      if (v === undefined) {
        const sx = P[2][j] / box[2], sy = P[3][j] / box[3];
        v = secs[j].f(P[0][j] + (x - box[0]) * sx, P[1][j] + (y - box[1]) * sy) / max(sx, sy);
        cache.set(j, v);
      }
      return v;
    };
    if (!cubic) return d(k) + (d(k + 1) - d(k)) * t;
    return herm(d(k), d(k + 1), slopeAt(d, k), slopeAt(d, k + 1), t, h);
  };
  const dz = (z1 - z0) * 1e-4;
  return {
    box: [b2[0], b2[1], z0, b2[2], b2[3], z1],
    f: (x, y, z) => {
      const zc = min(max(z, z0), z1);
      const v = at(x, y, zc);
      let d2 = v;
      if (z === zc) {
        const za = max(z - dz, z0), zb = min(z + dz, z1);
        const g = (at(x, y, zb) - at(x, y, za)) / (zb - za);
        d2 = v / sqrt(1 + g * g);
      }
      return slab(d2, max(z0 - z, z - z1));
    },
  };
}

// ---- screw threads (ISO metric basic profile, 60° flanks) ----
// A threaded rod of major radius r and pitch p along Z, from z0 to z1. The
// thread's phase is fixed in the node's own frame (a crest passes through
// +X at z = 0), so pieces built in one frame mate. Right-handed unless left.
// The profile per turn, as radius against axial position u (crest at u = 0):
// flat crest p/8 wide at r, flanks at 30° to the radial plane, flat root p/4
// wide at r - 5H/8, H = 0.866p. chamfer: 45° ends from the root, [bottom, top].
// plain: drawn as a smooth rod (threads too small to see), but fits as a thread.
const THREAD_H = Math.sqrt(3) / 2;
export const threadRoot = (r, p) => r - (5 / 8) * THREAD_H * p;
export const threadPitchRadius = (r, p) => r - (3 / 8) * THREAD_H * p;
let fitMode = false;
function thread3({ r, p, z0, z1, left = false, chamfer = [false, false], plain = false }) {
  const r1 = threadRoot(r, p);
  const box = [-r, -r, z0, r, r, z1];
  // Chamfered ends: a 45° cone that meets the root radius at the end.
  const ends = (rr, z) => {
    let d = max(z0 - z, z - z1);
    if (chamfer[0]) d = max(d, (rr + z0 - z - r1) * Math.SQRT1_2);
    if (chamfer[1]) d = max(d, (rr + z - z1 - r1) * Math.SQRT1_2);
    return d;
  };
  // Checking fits: threads mate on the pitch diameter, so a bolt and its
  // nut touch there whatever their phase.
  if (fitMode) {
    const r2 = threadPitchRadius(r, p);
    return { box, f: (x, y, z) => { const rr = sqrt(x * x + y * y); return max(rr - r2, ends(rr, z)); } };
  }
  if (plain) return { box, f: (x, y, z) => { const rr = sqrt(x * x + y * y); return max(rr - r, ends(rr, z)); } };
  // One period of the profile as a polyline (u, radius), u in [-p/2, p/2].
  const us = [-p / 2, (-3 * p) / 8, -p / 16, p / 16, (3 * p) / 8, p / 2];
  const rs = [r1, r1, r, r, r1, r1];
  const turn = (left ? -p : p) / (2 * Math.PI);
  // The helix tilts the profile slightly; scale back to stay a safe distance.
  const lip = sqrt(1 + (p / (Math.PI * r1)) ** 2);
  return {
    box,
    f: (x, y, z) => {
      const rr = sqrt(x * x + y * y);
      let d;
      {
        let u = z - turn * Math.atan2(y, x);
        u -= p * Math.round(u / p);
        let best = Infinity;
        let inside = false;
        for (let k = -1; k <= 1; k++) {
          const uu = u - k * p;
          for (let i = 0; i < 5; i++) {
            const ex = us[i + 1] - us[i], ey = rs[i + 1] - rs[i];
            const wx = uu - us[i], wy = rr - rs[i];
            const t = min(max((wx * ex + wy * ey) / (ex * ex + ey * ey), 0), 1);
            best = min(best, (wx - ex * t) ** 2 + (wy - ey * t) ** 2);
            if (k === 0 && uu >= us[i] && uu <= us[i + 1]) inside = rr < rs[i] + (ey * wx) / ex;
          }
        }
        d = ((inside ? -1 : 1) * sqrt(best)) / lip;
        // Near the axis the helix turns fast; fade to the plain core there.
        if (rr < r1 / 2) {
          const w = rr / (r1 / 2);
          d = w * d + (1 - w) * (rr - r1);
        }
      }
      return max(d, ends(rr, z));
    },
  };
}

// ---- compile ----
// Returns { f, box } for a node.
export function compile(node) {
  const c = COMPILERS[node.t];
  if (!c) throw new Error(`Unknown shape "${node.t}"`);
  return c(node);
}
// The same, for checking how parts fit: threads become their pitch cylinders.
export function compileForFit(node) {
  fitMode = true;
  try {
    return compile(node);
  } finally {
    fitMode = false;
  }
}

const COMPILERS = {
  box({ s: [sx, sy, sz], r = 0 }) {
    const bx = sx / 2 - r, by = sy / 2 - r, bz = sz / 2 - r;
    return {
      box: [-sx / 2, -sy / 2, -sz / 2, sx / 2, sy / 2, sz / 2],
      f: (x, y, z) => {
        const qx = abs(x) - bx, qy = abs(y) - by, qz = abs(z) - bz;
        const ox = max(qx, 0), oy = max(qy, 0), oz = max(qz, 0);
        return sqrt(ox * ox + oy * oy + oz * oz) + min(max(qx, qy, qz), 0) - r;
      },
    };
  },
  sphere({ r }) {
    return { box: [-r, -r, -r, r, r, r], f: (x, y, z) => sqrt(x * x + y * y + z * z) - r };
  },
  ellipsoid({ r: [a, b, c] }) {
    // Distance bound by Inigo Quilez, scaled by min radius / max radius to stay a safe underestimate.
    const m = min(a, b, c);
    return {
      box: [-a, -b, -c, a, b, c],
      f: (x, y, z) => {
        const k0 = sqrt((x / a) ** 2 + (y / b) ** 2 + (z / c) ** 2);
        if (k0 < 1e-9) return -m;
        const k1 = sqrt((x / (a * a)) ** 2 + (y / (b * b)) ** 2 + (z / (c * c)) ** 2);
        return (k0 * (k0 - 1)) / k1;
      },
    };
  },
  cylinder({ r, h, round = 0 }) {
    const rr = round;
    return {
      box: [-r, -r, -h / 2, r, r, h / 2],
      f: (x, y, z) => {
        const dx = sqrt(x * x + y * y) - r + rr, dz = abs(z) - h / 2 + rr;
        return min(max(dx, dz), 0) + hypot(max(dx, 0), max(dz, 0)) - rr;
      },
    };
  },
  cone({ r1, r2, h }) {
    // Capped cone along Z, centred; r1 at the bottom, r2 at the top (exact, after Inigo Quilez).
    const hh = h / 2, R = max(r1, r2);
    const k2x = r2 - r1, k2y = 2 * hh, k2d = k2x * k2x + k2y * k2y;
    return {
      box: [-R, -R, -hh, R, R, hh],
      f: (x, y, z) => {
        const qx = sqrt(x * x + y * y), qy = z;
        const cax = qx - min(qx, qy < 0 ? r1 : r2), cay = abs(qy) - hh;
        const t = min(max(((r2 - qx) * k2x + (hh - qy) * k2y) / k2d, 0), 1);
        const cbx = qx - r2 + k2x * t, cby = qy - hh + k2y * t;
        const s = cbx < 0 && cay < 0 ? -1 : 1;
        return s * sqrt(min(cax * cax + cay * cay, cbx * cbx + cby * cby));
      },
    };
  },
  capsule({ a, b, r1, r2 = r1 }) {
    // Round cone between two points (exact, after Inigo Quilez).
    const [ax, ay, az] = a;
    const bax = b[0] - ax, bay = b[1] - ay, baz = b[2] - az;
    const l2 = bax * bax + bay * bay + baz * baz;
    const rr = r1 - r2;
    const a2 = l2 - rr * rr;
    const R = max(r1, r2);
    const box = grow(boxOf([a, b]), R);
    if (a2 <= 1e-12) {
      // One end sphere swallows the other.
      const [cx, cy, cz] = r1 >= r2 ? a : b;
      return { box, f: (x, y, z) => sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) - R };
    }
    const il2 = 1 / l2;
    const sr = sign(rr);
    return {
      box,
      f: (x, y, z) => {
        const px = x - ax, py = y - ay, pz = z - az;
        const yy = px * bax + py * bay + pz * baz;
        const zz = yy - l2;
        const wx = px * l2 - bax * yy, wy = py * l2 - bay * yy, wz = pz * l2 - baz * yy;
        const x2 = wx * wx + wy * wy + wz * wz;
        const y2 = yy * yy * l2;
        const z2 = zz * zz * l2;
        const k = sr * rr * rr * x2;
        if (sign(zz) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
        if (sign(yy) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
        return (sqrt((x2 * a2) * il2) + yy * rr) * il2 - r1;
      },
    };
  },
  torus({ R, r }) {
    const o = R + r;
    return { box: [-o, -o, -r, o, o, r], f: (x, y, z) => hypot(sqrt(x * x + y * y) - R, z) - r };
  },
  // draft: degrees the sides lean in going up (out if negative), as on a
  // moulded or cast part; the bottom face keeps the profile.
  extrude(node) {
    const P = profileOf(node);
    const b = P.box, hh = node.h / 2;
    if (!node.draft) return { box: [b[0], b[1], -hh, b[2], b[3], hh], f: (x, y, z) => slab(P.f(x, y), abs(z) - hh) };
    const t = Math.tan(node.draft * DEG), s = sqrt(1 + t * t);
    const g = max(-t * node.h, 0);
    return {
      box: [b[0] - g, b[1] - g, -hh, b[2] + g, b[3] + g, hh],
      f: (x, y, z) => slab((P.f(x, y) + (min(max(z, -hh), hh) + hh) * t) / s, abs(z) - hh),
    };
  },
  thread: (node) => thread3(node),
  // A profile of [radius, height] spun around Z, all the way or through
  // `angle` degrees counterclockwise from +X.
  revolve(node) {
    const P = profileOf(node);
    const R = max(abs(P.box[0]), abs(P.box[2]));
    const box = [-R, -R, P.box[1], R, R, P.box[3]];
    const A = (node.angle ?? 360) * DEG;
    if (A >= 2 * Math.PI - 1e-9) return { box, f: (x, y, z) => P.f(sqrt(x * x + y * y), z) };
    const ends = [0, A].map((a) => [cos(a), sin(a)]);
    return {
      box,
      f: (x, y, z) => {
        let phi = Math.atan2(y, x);
        if (phi < 0) phi += 2 * Math.PI;
        let best = Infinity, edge = Infinity;
        for (const [c, s] of ends) {
          const r = x * c + y * s, perp = -x * s + y * c;
          best = min(best, hypot(max(P.f(r, z), 0), perp));
          edge = min(edge, r >= 0 ? abs(perp) : hypot(x, y));
        }
        // Inside the wedge: the full revolve, cut by the two end planes.
        if (phi <= A) return max(P.f(sqrt(x * x + y * y), z), -edge);
        return best;
      },
    };
  },
  sweep: (node) => sweep3(node),
  loft: (node) => loft3(node),

  union({ c, k = 0 }) {
    const kids = c.map(compile).filter((k) => !isEmpty(k.box));
    if (!kids.length) return emptyShape();
    if (kids.length === 1 && !k) return kids[0];
    const fs = kids.map((q) => q.f), bs = kids.map((q) => q.box);
    const n = fs.length;
    return {
      box: grow(kids.reduce((b, q) => unionBox(b, q.box), EMPTY), k / 4),
      f: (x, y, z) => {
        let d = Infinity;
        for (let i = 0; i < n; i++) {
          // Skip children that are too far away to change the result. Only
          // outside a child's box: inside it, its own value is needed.
          const bd = boxDist(bs[i], x, y, z);
          if (bd > 0 && bd >= d + k) continue;
          d = smin(d, fs[i](x, y, z), k);
        }
        return d;
      },
    };
  },
  subtract({ a, b, k = 0 }) {
    const A = compile(a);
    const cut = b.map(compile).filter((q) => !isEmpty(q.box));
    if (!cut.length || isEmpty(A.box)) return A;
    const fs = cut.map((q) => q.f), bs = cut.map((q) => q.box);
    return {
      box: A.box,
      f: (x, y, z) => {
        let d = A.f(x, y, z);
        for (let i = 0; i < fs.length; i++) {
          const bd = boxDist(bs[i], x, y, z);
          if (bd > 0 && -bd <= d - k) continue;
          d = smax(d, -fs[i](x, y, z), k);
        }
        return d;
      },
    };
  },
  intersect({ c, k = 0 }) {
    const kids = c.map(compile);
    const box = kids.reduce((b, q) => interBox(b, q.box), [-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity]);
    if (isEmpty(box)) return emptyShape();
    const fs = kids.map((q) => q.f);
    return {
      box,
      f: (x, y, z) => {
        let d = -Infinity;
        for (let i = 0; i < fs.length; i++) d = smax(d, fs[i](x, y, z), k);
        return d;
      },
    };
  },
  move({ v: [vx, vy, vz], c }) {
    const C = compile(c);
    if (isEmpty(C.box)) return C;
    const b = C.box;
    return { box: [b[0] + vx, b[1] + vy, b[2] + vz, b[3] + vx, b[4] + vy, b[5] + vz], f: (x, y, z) => C.f(x - vx, y - vy, z - vz) };
  },
  rotate({ deg, c }) {
    const C = compile(c);
    if (isEmpty(C.box)) return C;
    const m = rotationMatrix(deg);
    const box = boxOf(corners(C.box).map(([x, y, z]) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z]));
    // Inverse rotation (transpose) takes world points into the child's frame.
    return { box, f: (x, y, z) => C.f(m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z) };
  },
  scale({ s: [sx, sy, sz], c }) {
    const C = compile(c);
    if (isEmpty(C.box)) return C;
    const b = C.box;
    const lo = [b[0] * sx, b[1] * sy, b[2] * sz], hi = [b[3] * sx, b[4] * sy, b[5] * sz];
    const m = min(abs(sx), abs(sy), abs(sz)); // keeps the result a safe underestimate
    return {
      box: [min(lo[0], hi[0]), min(lo[1], hi[1]), min(lo[2], hi[2]), max(lo[0], hi[0]), max(lo[1], hi[1]), max(lo[2], hi[2])],
      f: (x, y, z) => C.f(x / sx, y / sy, z / sz) * m,
    };
  },
  offset({ d, c }) {
    const C = compile(c);
    return { box: grow(C.box, max(d, 0)), f: (x, y, z) => C.f(x, y, z) - d };
  },
  shell({ th, c }) {
    const C = compile(c);
    return { box: C.box, f: (x, y, z) => { const d = C.f(x, y, z); return max(d, -d - th); } };
  },
  mirror({ axis, c }) {
    const C = compile(c);
    if (isEmpty(C.box)) return C;
    const b = [...C.box];
    [b[axis], b[axis + 3]] = [-b[axis + 3], -b[axis]];
    const f = C.f;
    return { box: b, f: axis === 0 ? (x, y, z) => f(-x, y, z) : axis === 1 ? (x, y, z) => f(x, -y, z) : (x, y, z) => f(x, y, -z) };
  },
  symmetric({ axis, c }) {
    const C = compile(c);
    if (isEmpty(C.box)) return C;
    const b = [...C.box];
    const e = max(abs(b[axis]), abs(b[axis + 3]));
    b[axis] = -e;
    b[axis + 3] = e;
    const f = C.f;
    return { box: b, f: axis === 0 ? (x, y, z) => f(abs(x), y, z) : axis === 1 ? (x, y, z) => f(x, abs(y), z) : (x, y, z) => f(x, y, abs(z)) };
  },
  empty: () => emptyShape(),
};

function emptyShape() {
  return { box: EMPTY, f: () => Infinity };
}

export { isEmpty as isEmptyBox };
