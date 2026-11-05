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

// ---- compile ----
// Returns { f, box } for a node.
export function compile(node) {
  const c = COMPILERS[node.t];
  if (!c) throw new Error(`Unknown shape "${node.t}"`);
  return c(node);
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
  extrude({ pts, h }) {
    const d2 = polygon2D(pts);
    const b = boxOf(pts.map(([x, y]) => [x, y, 0]));
    const hh = h / 2;
    return {
      box: [b[0], b[1], -hh, b[3], b[4], hh],
      f: (x, y, z) => {
        const wx = d2(x, y), wz = abs(z) - hh;
        return min(max(wx, wz), 0) + hypot(max(wx, 0), max(wz, 0));
      },
    };
  },
  revolve({ pts }) {
    const d2 = polygon2D(pts);
    const R = max(...pts.map((p) => abs(p[0])));
    const zs = pts.map((p) => p[1]);
    return { box: [-R, -R, min(...zs), R, R, max(...zs)], f: (x, y, z) => d2(sqrt(x * x + y * y), z) };
  },

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
