// Profiles as exact outlines, for the STEP export: a 2D profile node becomes
// regions, each an outer loop and its holes, made of lines and arcs. Only
// profiles whose outline is known exactly come out (circles, rects, outlines
// and paths, moved, turned, scaled evenly or mirrored, holes cut wholly
// inside, and pieces that do not touch); anything else gives null.
//
// A loop is a list of pieces, each going from a to b with the region on its
// left: { a: [x, y], b: [x, y], arc: null | { c: [x, y], r, sw } }, sw being
// the arc's signed sweep in radians (> 0 counterclockwise). A full circle is
// one arc with a == b and sw = +-2 pi. Outer loops run counterclockwise,
// holes clockwise.

const TAU = 2 * Math.PI;
const { abs, hypot, atan2, cos, sin, min, max } = Math;

export function profileRegions(node) {
  try {
    return regionsOf(node);
  } catch {
    return null;
  }
}

function regionsOf(node) {
  switch (node.t) {
    case "circle2":
      return node.r > 0 ? [{ outer: circleLoop([0, 0], node.r), holes: [] }] : null;
    case "rect2":
      return rectRegion(node.w, node.h, node.r ?? 0);
    case "poly2":
      return polyRegion(node.pts, node.arcs);
    case "move2":
      return mapRegions(regionsOf(node.c), ([x, y]) => [x + node.v[0], y + node.v[1]], 1, false);
    case "rotate2": {
      const c = cos((node.deg * Math.PI) / 180), s = sin((node.deg * Math.PI) / 180);
      return mapRegions(regionsOf(node.c), ([x, y]) => [c * x - s * y, s * x + c * y], 1, false);
    }
    case "scale2": {
      const [sx, sy] = node.s;
      if (!(abs(abs(sx) - abs(sy)) <= 1e-12 * abs(sx)) || !sx) return null;
      return mapRegions(regionsOf(node.c), ([x, y]) => [x * sx, y * sy], abs(sx), sx * sy < 0);
    }
    case "union2":
      return unionRegions(node);
    case "subtract2":
      return subtractRegions(node);
    default:
      return null; // offsets, strokes, intersections, smooth joins: not exact here
  }
}

// ---- loops ----
export function circleLoop(c, r, ccw = true) {
  const a = [c[0] + r, c[1]];
  return [{ a, b: a, arc: { c, r, sw: ccw ? TAU : -TAU } }];
}

function rectRegion(w, h, r) {
  const x = w / 2, y = h / 2;
  if (!(w > 0 && h > 0)) return null;
  if (!r) {
    const p = [[-x, -y], [x, -y], [x, y], [-x, y]];
    return [{ outer: p.map((a, i) => ({ a, b: p[(i + 1) % 4], arc: null })), holes: [] }];
  }
  // Lines between the corner arcs (left out where the arcs meet).
  const loop = [];
  const corners = [[x - r, -y + r, -Math.PI / 2], [x - r, y - r, 0], [-x + r, y - r, Math.PI / 2], [-x + r, -y + r, Math.PI]];
  const at = (c, t) => [c[0] + r * cos(t), c[1] + r * sin(t)];
  corners.forEach((c, i) => {
    const a = at(c, c[2]), b = at(c, c[2] + Math.PI / 2);
    loop.push({ a, b, arc: { c: [c[0], c[1]], r, sw: Math.PI / 2 } });
    const n = corners[(i + 1) % 4], na = at(n, n[2]);
    if (hypot(na[0] - b[0], na[1] - b[1]) > 1e-12 * (w + h)) loop.push({ a: b, b: na, arc: null });
  });
  // Snap shared ends so each piece starts exactly where the last ended.
  for (let i = 0; i < loop.length; i++) loop[i].b = loop[(i + 1) % loop.length].a;
  return [{ outer: loop, holes: [] }];
}

// An outline of points, with the runs the script drew as arcs written as arcs.
function polyRegion(pts, arcs = []) {
  const n = pts.length;
  if (n < 3) return null;
  const size = pts.reduce((m, p) => max(m, abs(p[0]), abs(p[1])), 0) || 1;
  const runs = [...(arcs ?? [])].filter((a) => Array.isArray(a) && a.length === 6 && a[1] <= n).sort((a, b) => a[0] - b[0]);
  const loop = [];
  let i = 0, k = 0;
  while (i < n) {
    while (k < runs.length && runs[k][0] < i) k++;
    const run = k < runs.length && runs[k][0] === i ? runs[k] : null;
    const arc = run && arcPiece(pts, run, size);
    if (arc) {
      loop.push(arc);
      i = run[1];
      k++;
    } else {
      loop.push({ a: pts[i], b: pts[(i + 1) % n], arc: null });
      i++;
    }
  }
  // Drop pieces of no length; a run that ended past the first point is not allowed.
  const pieces = loop.filter((p) => p.arc || hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) > 1e-9 * size);
  if (pieces.length < (pieces.some((p) => p.arc) ? 1 : 3)) return null;
  if (!simple(pieces)) return null;
  return [{ outer: area(pieces) > 0 ? pieces : reverseLoop(pieces), holes: [] }];
}

// One run of points [first, last, cx, cy, r, sweep] as an arc, if every point
// of the run lies on that circle (else null, and the points stay lines).
function arcPiece(pts, [i0, i1, cx, cy, r, sw], size) {
  const n = pts.length;
  if (!(i1 > i0 && i1 <= n && r > 0 && abs(sw) <= TAU + 1e-9)) return null;
  const tol = 2e-5 + 1e-9 * size;
  for (let i = i0; i <= i1; i++) {
    const p = pts[i % n];
    if (abs(hypot(p[0] - cx, p[1] - cy) - r) > tol + 1e-6 * r) return null;
  }
  const a = pts[i0], b = pts[i1 % n];
  // The way round must be the way the points go.
  const m = pts[i0 + 1];
  const turn = (a[0] - cx) * (m[1] - cy) - (a[1] - cy) * (m[0] - cx);
  if (turn * sw <= 0) return null;
  if (i1 - i0 >= n && hypot(a[0] - b[0], a[1] - b[1]) < tol) return { a, b: a, arc: { c: [cx, cy], r: hypot(a[0] - cx, a[1] - cy), sw: Math.sign(sw) * TAU } };
  // The centre moved onto the line halfway between the ends, so both ends lie
  // exactly on the circle.
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], l = hypot(dx, dy);
  if (!(l > 0)) return null;
  const px = -dy / l, py = dx / l, t = (cx - mx) * px + (cy - my) * py;
  const c = [mx + px * t, my + py * t];
  const rr = hypot(a[0] - c[0], a[1] - c[1]);
  let s = atan2(b[1] - c[1], b[0] - c[0]) - atan2(a[1] - c[1], a[0] - c[0]);
  if (sw > 0) while (s <= 0) s += TAU;
  else while (s >= 0) s -= TAU;
  if (abs(s - sw) > 1e-3) return null;
  return { a, b, arc: { c, r: rr, sw: s } };
}

export function reverseLoop(loop) {
  return loop.map((p) => ({ a: p.b, b: p.a, arc: p.arc && { ...p.arc, sw: -p.arc.sw } })).reverse();
}

// Points along a loop, arcs in steps of at most `step` radians (closed: the
// first point is not repeated).
export function loopPoints(loop, step = Math.PI / 360) {
  const out = [];
  for (const p of loop) {
    out.push(p.a);
    if (!p.arc) continue;
    const { c, sw } = p.arc;
    const k = Math.max(2, Math.ceil(abs(sw) / step));
    const t0 = atan2(p.a[1] - c[1], p.a[0] - c[0]), r = hypot(p.a[0] - c[0], p.a[1] - c[1]);
    for (let j = 1; j < k; j++) out.push([c[0] + r * cos(t0 + (sw * j) / k), c[1] + r * sin(t0 + (sw * j) / k)]);
  }
  return out;
}

// Signed area (counterclockwise > 0), exact for lines and arcs.
export function area(loop) {
  let s = 0;
  for (const p of loop) {
    s += (p.a[0] * p.b[1] - p.b[0] * p.a[1]) / 2;
    if (p.arc) s += (p.arc.r * p.arc.r * (p.arc.sw - sin(p.arc.sw))) / 2;
  }
  return s;
}

function mapRegions(regions, f, scale, flip) {
  if (!regions) return null;
  const mapLoop = (loop) => {
    const out = loop.map((p) => ({ a: f(p.a), b: f(p.b), arc: p.arc && { c: f(p.arc.c), r: p.arc.r * scale, sw: flip ? -p.arc.sw : p.arc.sw } }));
    for (let i = 0; i < out.length; i++) out[i].b = out[(i + 1) % out.length].a;
    return flip ? reverseLoop(out) : out;
  };
  return regions.map((g) => ({ outer: mapLoop(g.outer), holes: g.holes.map(mapLoop) }));
}

// ---- how loops lie to each other ----
// Loops as polylines with their boxes; arcs in half-degree steps, so a
// polyline is within r * 4e-5 of its arc, and loops must stay farther apart
// than that (plus a little) to count as apart.
function poly(loop) {
  const p = loopPoints(loop);
  let box = [Infinity, Infinity, -Infinity, -Infinity], sag = 0;
  for (const [x, y] of p) box = [min(box[0], x), min(box[1], y), max(box[2], x), max(box[3], y)];
  for (const q of loop) if (q.arc) sag = max(sag, q.arc.r * (1 - cos(Math.PI / 720)));
  return { p, box, sag };
}
const boxesApart = (a, b, d) => a[0] > b[2] + d || b[0] > a[2] + d || a[1] > b[3] + d || b[1] > a[3] + d;

function segDist(ax, ay, bx, by, cx, cy, dx, dy) {
  // Crossing segments are 0 apart.
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx), d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  const pd = (px, py, qx, qy, rx, ry) => {
    const ex = rx - qx, ey = ry - qy, l = ex * ex + ey * ey;
    const t = l ? min(max(((px - qx) * ex + (py - qy) * ey) / l, 0), 1) : 0;
    return hypot(px - qx - ex * t, py - qy - ey * t);
  };
  return min(pd(ax, ay, cx, cy, dx, dy), pd(bx, by, cx, cy, dx, dy), pd(cx, cy, ax, ay, bx, by), pd(dx, dy, ax, ay, bx, by));
}

// Do two loops come closer than their margin anywhere?
function touch(A, B) {
  const d = A.sag + B.sag + 1e-7 * (1 + max(...A.box.map(abs), ...B.box.map(abs)));
  if (boxesApart(A.box, B.box, d)) return false;
  const near = (P, box) => {
    const out = [];
    for (let i = 0; i < P.p.length; i++) {
      const a = P.p[i], b = P.p[(i + 1) % P.p.length];
      if (!boxesApart([min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])], box, d)) out.push([a, b]);
    }
    return out;
  };
  const sa = near(A, B.box), sb = near(B, A.box);
  for (const [a, b] of sa) for (const [c, e] of sb) if (segDist(a[0], a[1], b[0], b[1], c[0], c[1], e[0], e[1]) <= d) return true;
  return false;
}

function inside(P, [x, y]) {
  let s = false;
  const p = P.p;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) s = !s;
  }
  return s;
}

// A loop that does not cross or touch itself.
function simple(loop) {
  const P = poly(loop), p = P.p, n = p.length;
  if (n > 4000) return false;
  const size = max(...P.box.map(abs)) || 1;
  const segs = p.map((a, i) => [a, p[(i + 1) % n], i]).sort((s, t) => min(s[0][0], s[1][0]) - min(t[0][0], t[1][0]));
  for (let i = 0; i < n; i++) {
    const [a, b, ia] = segs[i];
    const hi = max(a[0], b[0]);
    for (let j = i + 1; j < n && min(segs[j][0][0], segs[j][1][0]) <= hi + 1e-12 * size; j++) {
      const [c, e, ic] = segs[j];
      const gap = abs(ia - ic);
      if (gap === 1 || gap === n - 1) continue; // neighbours share an end
      if (segDist(a[0], a[1], b[0], b[1], c[0], c[1], e[0], e[1]) <= 1e-9 * size) return false;
    }
  }
  return true;
}

// ---- joins and cut-outs of whole profiles ----
function unionRegions({ c, k = 0 }) {
  const parts = c.map(regionsOf);
  if (parts.some((r) => !r)) return null;
  if (parts.length === 1) return parts[0];
  if (k) return null;
  const all = parts.flat();
  const outers = all.map((g) => poly(g.outer));
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      // Pieces that touch, overlap or lie one in the other are not handled.
      if (touch(outers[i], outers[j]) || inside(outers[i], outers[j].p[0]) || inside(outers[j], outers[i].p[0])) return null;
    }
  return all;
}

function subtractRegions({ a, b, k = 0 }) {
  const base = regionsOf(a);
  if (!base) return null;
  if (!b.length) return base;
  if (k) return null;
  const regions = base.map((g) => ({ outer: g.outer, holes: [...g.holes] }));
  for (const cut of b) {
    const cr = regionsOf(cut);
    if (!cr) return null;
    for (const g of cr) {
      if (g.holes.length) return null;
      const L = poly(g.outer);
      let into = null;
      for (const r of regions) {
        const O = poly(r.outer);
        if (touch(L, O)) return null;
        if (!inside(O, L.p[0])) {
          if (inside(L, O.p[0])) return null; // the cut swallows the whole region
          continue;
        }
        for (const h of r.holes) {
          const H = poly(h);
          if (touch(L, H) || inside(H, L.p[0]) || inside(L, H.p[0])) return null;
        }
        into = r;
      }
      // A cut wholly outside the profile changes nothing.
      if (into) into.holes.push(reverseLoop(g.outer));
    }
  }
  return regions;
}
