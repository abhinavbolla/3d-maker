// Exact boundary representations for the STEP export, built straight from a
// part's shape tree where the tree says exactly what the shape is: boxes,
// cylinders, cones, spheres, tori, capsules, extrusions and revolves of exact
// outlines (see outline2.js), under moves, turns, even scales and mirrors,
// and unions of such shapes that cannot touch (their boxes are apart).
// Anything with a cut, a smooth join, an overlap or a free-form shape gives
// null, and the part goes out as facets of its mesh instead (facets.js).
//
// A solid is { faces }, each face { surf, same, loops }: surf a plane,
// cylinder, cone, sphere or torus; same whether the face's outward normal is
// the surface's own normal; loops a list of loops (the outer one first), each
// a list of [edge, forward]. Seen from outside, a loop runs counterclockwise
// round the face it bounds (holes clockwise). An edge is { v0, v1, curve,
// via }: curve null for a straight line, else a circle { o, z, x, r }; via a
// point on the edge a quarter of the way along, which says which way round a
// circle the edge goes. A vertex is { p: [x, y, z] }. Surfaces are placed by
// o (origin), z (axis or normal) and x (reference direction).

import { compile, rotationMatrix } from "./sdf.js";
import { profileRegions, circleLoop } from "./outline2.js";

const TAU = 2 * Math.PI;
const { abs, hypot, cos, sin, sqrt, atan2, max } = Math;
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];

const vertex = (p) => ({ p });
const edge = (v0, v1, curve = null, via = null) => ({ v0, v1, curve, via });

// ---- extrusion of regions along Z, centred: z from -h/2 to h/2 ----
export function extrudeSolid(regions, h) {
  const z0 = -h / 2, z1 = h / 2;
  const solids = [];
  for (const g of regions) {
    const faces = [];
    const bottom = [], top = [];
    for (const loop of [g.outer, ...g.holes]) {
      const n = loop.length;
      const vb = loop.map((s) => vertex([s.a[0], s.a[1], z0])), vt = loop.map((s) => vertex([s.a[0], s.a[1], z1]));
      const up = loop.map((_, i) => edge(vb[i], vt[i]));
      const flat = (z, vs) => loop.map((s, i) => (s.arc ? edge(vs[i], vs[(i + 1) % n], { o: [s.arc.c[0], s.arc.c[1], z], z: Z, x: X, r: s.arc.r }, [...quarter(s), z]) : edge(vs[i], vs[(i + 1) % n])));
      const eb = flat(z0, vb), et = flat(z1, vt);
      loop.forEach((s, i) => {
        const j = (i + 1) % n;
        let surf, same = true;
        if (s.arc) {
          surf = { type: "cylinder", o: [s.arc.c[0], s.arc.c[1], 0], z: Z, x: X, r: s.arc.r };
          same = s.arc.sw > 0;
        } else {
          const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l = hypot(dx, dy);
          surf = { type: "plane", o: [s.a[0], s.a[1], z0], z: [dy / l, -dx / l, 0], x: [dx / l, dy / l, 0] };
        }
        faces.push({ surf, same, loops: [[[eb[i], true], [up[j], true], [et[i], false], [up[i], false]]] });
      });
      bottom.push(eb.map((e) => [e, false]).reverse());
      top.push(et.map((e) => [e, true]));
    }
    faces.push({ surf: { type: "plane", o: [0, 0, z0], z: [0, 0, -1], x: X }, same: true, loops: bottom });
    faces.push({ surf: { type: "plane", o: [0, 0, z1], z: Z, x: X }, same: true, loops: top });
    solids.push({ faces });
  }
  return solids;
}

// A point a quarter of the way along an arc piece (2D).
function quarter(s) {
  const { c, sw } = s.arc;
  const t = atan2(s.a[1] - c[1], s.a[0] - c[0]) + sw / 4, r = hypot(s.a[0] - c[0], s.a[1] - c[1]);
  return [c[0] + r * cos(t), c[1] + r * sin(t)];
}

// ---- revolve of regions in [radius, z] around Z, through `angle` radians
// counterclockwise from +X. Null where a surface would be degenerate.
export function revolveSolid(regions, angle = TAU) {
  const full = angle >= TAU - 1e-9;
  const size = regions.reduce((m, g) => [g.outer, ...g.holes].flat().reduce((q, s) => max(q, abs(s.a[0]), abs(s.a[1])), m), 0) || 1;
  const eps = 1e-9 * size;
  const at = (r, z, phi) => [r * cos(phi), r * sin(phi), z];
  const solids = [];
  for (const g of regions) {
    const loops = [g.outer, ...g.holes];
    // Nothing on the far side of the axis.
    for (const loop of loops)
      for (const s of loop) {
        if (s.a[0] < -eps) return null;
        if (s.arc && reaches(s, Math.PI) && s.arc.c[0] - s.arc.r < -eps) return null;
      }
    const faces = [];
    const ends0 = [], endsA = [];
    for (const loop of loops) {
      const n = loop.length;
      const r = loop.map((s) => (s.a[0] < eps ? 0 : s.a[0])), z = loop.map((s) => s.a[1]);
      const v0 = loop.map((_, i) => vertex(at(r[i], z[i], 0)));
      const vA = full ? v0 : loop.map((_, i) => (r[i] ? vertex(at(r[i], z[i], angle)) : v0[i]));
      // The circle (or arc) each point of the profile sweeps.
      const ring = loop.map((_, i) => (r[i] ? edge(v0[i], vA[i], { o: [0, 0, z[i]], z: Z, x: X, r: r[i] }, at(r[i], z[i], (full ? TAU : angle) / 4)) : null));
      // A piece of the profile at angle phi, as an edge.
      const meridian = (s, i, phi, vs) => {
        const j = (i + 1) % n;
        if (!s.arc) return edge(vs[i], vs[j]);
        const q = quarter(s), [cr, cz] = s.arc.c;
        return edge(vs[i], vs[j], { o: at(cr, cz, phi), z: [-sin(phi), cos(phi), 0], x: [cos(phi), sin(phi), 0], r: s.arc.r }, at(q[0], q[1], phi));
      };
      const m0 = [], mA = [];
      loop.forEach((s, i) => {
        const j = (i + 1) % n;
        const onAxis = !s.arc && !r[i] && !r[j];
        m0.push(meridian(s, i, 0, v0));
        mA.push(full || onAxis ? m0[i] : meridian(s, i, angle, vA));
        if (onAxis) return;
        const surf = surfaceOf(s, r[i], r[j], eps);
        if (!surf) throw new Degenerate();
        const { same } = surf;
        delete surf.same;
        if (surf.type === "plane") {
          if (full) {
            // A disc or a ring: one loop per circle, the larger one outside.
            const ls = [];
            if (r[i]) ls.push([r[i], [[ring[i], true]]]);
            if (r[j]) ls.push([r[j], [[ring[j], false]]]);
            faces.push({ surf, same, loops: ls.sort((p, q) => q[0] - p[0]).map((l) => l[1]) });
            return;
          }
        }
        const lp = full ? [[m0[i], true], r[j] && [ring[j], false], [m0[i], false], r[i] && [ring[i], true]] : [[m0[i], false], r[i] && [ring[i], true], [mA[i], true], r[j] && [ring[j], false]];
        faces.push({ surf, same, loops: [lp.filter(Boolean)] });
      });
      if (!full) {
        ends0.push(m0.map((e) => [e, true]));
        endsA.push(mA.map((e) => [e, false]).reverse());
      }
    }
    if (!full) {
      faces.push({ surf: { type: "plane", o: [0, 0, 0], z: [0, -1, 0], x: X }, same: true, loops: ends0 });
      faces.push({ surf: { type: "plane", o: [0, 0, 0], z: [-sin(angle), cos(angle), 0], x: [cos(angle), sin(angle), 0] }, same: true, loops: endsA });
    }
    solids.push({ faces });
  }
  return solids;
}
class Degenerate extends Error {}

// Does an arc piece pass through direction t (radians)?
function reaches(s, t) {
  const { c, sw } = s.arc;
  const a = atan2(s.a[1] - c[1], s.a[0] - c[0]);
  let d = sw > 0 ? t - a : a - t;
  d = ((d % TAU) + TAU) % TAU;
  return d <= abs(sw);
}

// The surface a profile piece sweeps round Z, with `same`: whether the
// solid's outward normal is the surface's own (away from the axis, or from
// the centre).
function surfaceOf(s, ra, rb, eps) {
  if (s.arc) {
    const [cr, cz] = s.arc.c, rho = s.arc.r, same = s.arc.sw > 0;
    if (abs(cr) <= eps) return { type: "sphere", o: [0, 0, cz], z: Z, x: X, r: rho, same };
    if (cr > rho + eps) return { type: "torus", o: [0, 0, cz], z: Z, x: X, R: cr, r: rho, same };
    return null; // a torus through its own axis
  }
  const za = s.a[1], zb = s.b[1], dr = rb - ra, dz = zb - za;
  if (abs(dz) <= eps) return { type: "plane", o: [0, 0, za], z: [0, 0, dr < 0 ? 1 : -1], x: X, same: true };
  if (abs(dr) <= eps) return { type: "cylinder", o: [0, 0, 0], z: Z, x: X, r: ra, same: dz > 0 };
  // Placed at the wider end, axis pointing away from the narrow end, so the
  // radius there is greater than 0 and the half angle is between 0 and 90.
  const [r1, z1, z0] = rb > ra ? [rb, zb, za] : [ra, za, zb];
  return { type: "cone", o: [0, 0, z1], z: [0, 0, z1 > z0 ? 1 : -1], x: X, r: r1, semi: atan2(abs(dr), abs(dz)), same: dz > 0 };
}

// ---- placing a solid: p -> A p + t, A a turn times an even scale (and
// maybe a mirror) ----
const mulMV = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
const unit = (v) => {
  const l = hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const det3 = (A) => A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);

export function placeSolid(solid, { A, t }) {
  const s = Math.cbrt(abs(det3(A))), flip = det3(A) < 0;
  const pt = (p) => {
    const q = mulMV(A, p);
    return [q[0] + t[0], q[1] + t[1], q[2] + t[2]];
  };
  const dir = (d) => unit(mulMV(A, d));
  const vs = new Map(), es = new Map();
  const V = (v) => vs.get(v) ?? (vs.set(v, vertex(pt(v.p))), vs.get(v));
  const E = (e) => {
    if (!es.has(e)) es.set(e, edge(V(e.v0), V(e.v1), e.curve && { o: pt(e.curve.o), z: dir(e.curve.z), x: dir(e.curve.x), r: e.curve.r * s }, e.via && pt(e.via)));
    return es.get(e);
  };
  const surf = (f) => {
    const out = { ...f, o: pt(f.o), z: dir(f.z), x: dir(f.x) };
    if (f.r !== undefined) out.r = f.r * s;
    if (f.R !== undefined) out.R = f.R * s;
    return out;
  };
  // A mirror turns every loop the other way round.
  const loop = (l) => (flip ? l.map(([e, fw]) => [E(e), !fw]).reverse() : l.map(([e, fw]) => [E(e), fw]));
  return { faces: solid.faces.map((f) => ({ surf: surf(f.surf), same: f.same, loops: f.loops.map(loop) })) };
}

// ---- shape trees ----
const IDENTITY = { A: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const compose = (M, A, t = [0, 0, 0]) => {
  // M after (p -> A p + t)
  const B = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) B.push(M.A[i * 3] * A[j] + M.A[i * 3 + 1] * A[3 + j] + M.A[i * 3 + 2] * A[6 + j]);
  const mt = mulMV(M.A, t);
  return { A: B, t: [mt[0] + M.t[0], mt[1] + M.t[1], mt[2] + M.t[2]] };
};

// The exact solids of a shape tree, placed in the world, or null.
export function exactSolids(node) {
  try {
    const out = solidsOf(node, IDENTITY);
    return out && out.length ? out : null;
  } catch (err) {
    if (err instanceof Degenerate) return null;
    throw err;
  }
}

function solidsOf(node, M) {
  const place = (list) => list && list.map((s) => placeSolid(s, M));
  switch (node.t) {
    case "box": {
      if (node.r) return null;
      const [sx, sy, sz] = node.s;
      return place(extrudeSolid(profileRegions({ t: "rect2", w: sx, h: sy }), sz));
    }
    case "cylinder": {
      const { r, h } = node, rr = node.round ?? 0;
      if (!rr) return place(revolveSolid([{ outer: lines([[0, -h / 2], [r, -h / 2], [r, h / 2], [0, h / 2]]), holes: [] }]));
      if (!(r - rr > rr * (1 + 1e-9)) || !(h / 2 - rr >= 0)) return null;
      const a = r - rr, b = h / 2 - rr;
      const loop = [
        { a: [0, -h / 2], b: [a, -h / 2], arc: null },
        { a: [a, -h / 2], b: [r, -b], arc: { c: [a, -b], r: rr, sw: Math.PI / 2 } },
        ...(b > 0 ? [{ a: [r, -b], b: [r, b], arc: null }] : []),
        { a: [r, b], b: [a, h / 2], arc: { c: [a, b], r: rr, sw: Math.PI / 2 } },
        { a: [a, h / 2], b: [0, h / 2], arc: null },
        { a: [0, h / 2], b: [0, -h / 2], arc: null },
      ];
      return place(revolveSolid([{ outer: loop, holes: [] }]));
    }
    case "cone": {
      const { r1, r2, h } = node;
      // A point end (radius 0) is left out: the profile is then a triangle.
      const p = [[0, -h / 2], ...(r1 ? [[r1, -h / 2]] : []), ...(r2 ? [[r2, h / 2]] : []), [0, h / 2]];
      return place(revolveSolid([{ outer: lines(p), holes: [] }]));
    }
    case "sphere":
      return place(revolveSolid([sphereProfile(node.r)]));
    case "ellipsoid": {
      const [a, b, c] = node.r;
      if (abs(a - b) > 1e-12 * a || abs(a - c) > 1e-12 * a) return null;
      return place(revolveSolid([sphereProfile(a)]));
    }
    case "torus":
      if (!(node.R > node.r)) return null;
      return place(revolveSolid([{ outer: circleLoop([node.R, 0], node.r), holes: [] }]));
    case "capsule":
      return capsuleSolids(node, M);
    case "extrude": {
      if (node.draft) return null;
      const regions = profileRegions(node.p ?? { t: "poly2", pts: node.pts });
      return regions && place(extrudeSolid(regions, node.h));
    }
    case "revolve": {
      const regions = profileRegions(node.p ?? { t: "poly2", pts: node.pts });
      if (!regions) return null;
      const angle = ((node.angle ?? 360) * Math.PI) / 180;
      return place(revolveSolid(regions, angle >= TAU - 1e-9 ? TAU : angle));
    }
    case "move":
      return solidsOf(node.c, compose(M, IDENTITY.A, node.v));
    case "rotate": {
      // rotationMatrix is row-major and takes child points into the world.
      return solidsOf(node.c, compose(M, rotationMatrix(node.deg)));
    }
    case "scale": {
      const [sx, sy, sz] = node.s;
      if (!sx || abs(abs(sx) - abs(sy)) > 1e-12 * abs(sx) || abs(abs(sx) - abs(sz)) > 1e-12 * abs(sx)) return null;
      return solidsOf(node.c, compose(M, [sx, 0, 0, 0, sy, 0, 0, 0, sz]));
    }
    case "mirror":
      return solidsOf(node.c, compose(M, mirrorA(node.axis)));
    case "symmetric": {
      // The shape and its mirror image, where the shape lies wholly on the
      // kept side of the plane (else the field cuts it there).
      const b = compile(node.c).box, size = max(...b.map(abs));
      if (!(b[node.axis] > 1e-9 * size)) return null;
      const one = solidsOf(node.c, M), two = solidsOf(node.c, compose(M, mirrorA(node.axis)));
      return one && two && [...one, ...two];
    }
    case "union": {
      const kids = node.c.filter((c) => !isEmptyBox(compile(c).box));
      if (kids.length === 1) return solidsOf(kids[0], M);
      if (node.k) return null;
      const boxes = kids.map((c) => compile(c).box);
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (!apart(boxes[i], boxes[j])) return null;
      const out = [];
      for (const c of kids) {
        const s = solidsOf(c, M);
        if (!s) return null;
        out.push(...s);
      }
      return out;
    }
    default:
      return null;
  }
}

const mirrorA = (axis) => [axis === 0 ? -1 : 1, 0, 0, 0, axis === 1 ? -1 : 1, 0, 0, 0, axis === 2 ? -1 : 1];
const isEmptyBox = (b) => !(b[0] <= b[3] && b[1] <= b[4] && b[2] <= b[5]);
// Boxes with a gap between them on some axis.
const apart = (a, b) => {
  const g = 1e-9 * max(...a.map(abs), ...b.map(abs), 1);
  return a[0] > b[3] + g || b[0] > a[3] + g || a[1] > b[4] + g || b[1] > a[4] + g || a[2] > b[5] + g || b[2] > a[5] + g;
};
const lines = (p) => p.map((a, i) => ({ a, b: p[(i + 1) % p.length], arc: null }));
const sphereProfile = (r) => ({ outer: [{ a: [0, -r], b: [0, r], arc: { c: [0, 0], r, sw: Math.PI } }, { a: [0, r], b: [0, -r], arc: null }], holes: [] });

// A capsule: two spheres joined by the cone that touches both, turned round
// the line between their centres.
function capsuleSolids({ a, b, r1, r2 = r1 }, M) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = hypot(...d);
  if (L ** 2 - (r1 - r2) ** 2 <= 1e-12) {
    const [c, r] = r1 >= r2 ? [a, r1] : [b, r2];
    return revolveSolid([sphereProfile(r)]).map((s) => placeSolid(s, compose(M, IDENTITY.A, c)));
  }
  const w = unit(d);
  const u = unit(abs(w[0]) < 0.9 ? cross(w, X) : cross(w, Y)), v = cross(w, u);
  // Columns u, v, w: the profile's Z along a -> b.
  const A = [u[0], v[0], w[0], u[1], v[1], w[1], u[2], v[2], w[2]];
  const sa = (r1 - r2) / L, ca = sqrt(1 - sa * sa), al = Math.asin(sa);
  const ta = [r1 * ca, r1 * sa], tb = [r2 * ca, L + r2 * sa];
  const loop = [
    { a: [0, -r1], b: ta, arc: { c: [0, 0], r: r1, sw: Math.PI / 2 + al } },
    { a: ta, b: tb, arc: null },
    { a: tb, b: [0, L + r2], arc: { c: [0, L], r: r2, sw: Math.PI / 2 - al } },
    { a: [0, L + r2], b: [0, -r1], arc: null },
  ];
  return revolveSolid([{ outer: loop, holes: [] }]).map((s) => placeSolid(s, compose(M, A, a)));
}
const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
