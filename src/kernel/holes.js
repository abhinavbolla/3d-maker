// Holes and turned parts for drawings: where they are, their axes and their
// diameters, so a sheet can draw centre lines and dimension holes. No
// dependencies.
//
// Two sources. First the script: a part's shape tree says "a cylinder of
// radius 4.5 along this axis, cut away", so the size is the script's own
// value, not a measurement. Each one found is checked against the part's
// distance function, which says whether it is really there (a hole filled
// again by a later union, a cylinder buried inside another, are dropped).
// Second, for round edges the tree does not explain (a hole in a loft, a
// revolved bore), circles are fitted to a view's closed lines, and their
// accuracy is the fit's largest error, which is reported.
import { compile, compile2, rotationMatrix } from "./sdf.js";
import { fitCircle } from "./dxf.js";
import { VIEWS, viewOutline, sectionPlane } from "./drawing.js";

const { abs, min, max, hypot, sqrt, round, cos, sin, PI } = Math;

// ---- affine transforms: [m00, m01, m02, m10, ..., m22, tx, ty, tz] ----
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const apply = (M, [x, y, z]) => [M[0] * x + M[1] * y + M[2] * z + M[9], M[3] * x + M[4] * y + M[5] * z + M[10], M[6] * x + M[7] * y + M[8] * z + M[11]];
const turn = (M, [x, y, z]) => [M[0] * x + M[1] * y + M[2] * z, M[3] * x + M[4] * y + M[5] * z, M[6] * x + M[7] * y + M[8] * z];
// M followed by a child transform C (C applied first).
const then = (M, C) => {
  const out = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i * 3 + j] = M[i * 3] * C[j] + M[i * 3 + 1] * C[3 + j] + M[i * 3 + 2] * C[6 + j];
    out[9 + i] = M[i * 3] * C[9] + M[i * 3 + 1] * C[10] + M[i * 3 + 2] * C[11] + M[9 + i];
  }
  return out;
};
const moveBy = ([x, y, z]) => [1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z];
const scaleOf = (M) => hypot(M[0], M[3], M[6]);
const unit = (v) => {
  const l = hypot(...v) || 1;
  return v.map((c) => c / l);
};

// Every cylinder-like piece of a shape tree, in world coordinates:
// { kind: "hole" | "solid", c: [x, y, z] (a point on the axis), a: unit
// axis, r, t: [t0, t1] (its length along a, from c), dim (whether its
// diameter is a plain drilled or turned size), label (how it is called out:
// "Ø9", "M8") }.
export function scriptFeatures(node) {
  const out = [];
  const add = (M, cut, r, z0, z1, extra = {}) => {
    const k = scaleOf(M);
    const c = apply(M, [0, 0, (z0 + z1) / 2]);
    const a = unit(turn(M, [0, 0, 1]));
    const h = ((z1 - z0) / 2) * k;
    out.push({ kind: cut ? "hole" : "solid", c, a, r: r * k, t: [-h, h], dim: true, ...extra, ...(extra.inner != null ? { inner: extra.inner * k } : {}) });
  };
  // Circles in an extruded profile: walked with their 2D place.
  const profile = (p, M, cut, h, place) => {
    if (!p) return;
    const [cx, cy, ca, ss] = place;
    if (p.t === "circle2") add(then(M, moveBy([cx, cy, 0])), cut, p.r * ss, -h / 2, h / 2);
    else if (p.t === "union2" || p.t === "intersect2") for (const q of p.c) profile(q, M, cut, h, place);
    else if (p.t === "subtract2") {
      profile(p.a, M, cut, h, place);
      for (const q of p.b) profile(q, M, !cut, h, place);
    } else if (p.t === "move2") {
      const [vx, vy] = p.v;
      profile(p.c, M, cut, h, [cx + ss * (cos(ca) * vx - sin(ca) * vy), cy + ss * (sin(ca) * vx + cos(ca) * vy), ca, ss]);
    } else if (p.t === "rotate2") profile(p.c, M, cut, h, [cx, cy, ca + (p.deg * PI) / 180, ss]);
    else if (p.t === "scale2" && abs(p.s[0] - p.s[1]) < 1e-9) profile(p.c, M, cut, h, [cx, cy, ca, ss * abs(p.s[0])]);
  };
  const walk = (n, M, cut, grow) => {
    if (!n || typeof n !== "object") return;
    switch (n.t) {
      case "cylinder":
        return add(M, cut, n.r + (cut ? -grow : grow), -n.h / 2, n.h / 2);
      case "thread": {
        // A tapped hole or a threaded rod: called out by its metric size.
        const d = round(2 * n.r);
        return add(M, cut, n.r, n.z0, n.z1, { label: abs(2 * n.r - d) < 0.25 ? `M${d}` : null, dim: cut, inner: n.r - 0.7 * n.p });
      }
      case "cone":
        return add(M, cut, max(n.r1, n.r2), -n.h / 2, n.h / 2, { dim: false });
      case "revolve":
        if ((n.angle ?? 360) < 360) return;
        {
          const pts = n.p ? null : n.pts;
          let r = 0, z0 = 0, z1 = 0;
          if (pts) for (const [x, z] of pts) (r = max(r, abs(x))), (z0 = min(z0, z)), (z1 = max(z1, z));
          else {
            try {
              const box = profileBox(n.p);
              (r = max(abs(box[0]), abs(box[2]))), (z0 = box[1]), (z1 = box[3]);
            } catch {
              return;
            }
          }
          // Sized by its largest radius, where the surface is checked to be round.
          if (r > 0) add(M, cut, r, z0, z1);
        }
        return;
      case "extrude":
        if (!n.draft) profile(n.p, M, cut, n.h, [0, 0, 0, 1]);
        return;
      case "union":
      case "intersect":
        for (const c of n.c) walk(c, M, cut, grow);
        return;
      case "subtract":
        walk(n.a, M, cut, grow);
        for (const c of n.b) walk(c, M, !cut, grow);
        return;
      case "move":
        return walk(n.c, then(M, moveBy(n.v)), cut, grow);
      case "rotate": {
        const R = rotationMatrix(n.deg);
        return walk(n.c, then(M, [...R, 0, 0, 0]), cut, grow);
      }
      case "scale":
        if (abs(n.s[0] - n.s[1]) < 1e-9 && abs(n.s[0] - n.s[2]) < 1e-9) walk(n.c, then(M, [n.s[0], 0, 0, 0, n.s[0], 0, 0, 0, n.s[0], 0, 0, 0]), cut, grow / n.s[0]);
        return;
      case "mirror": {
        const s = [1, 1, 1];
        s[n.axis] = -1;
        return walk(n.c, then(M, [s[0], 0, 0, 0, s[1], 0, 0, 0, s[2], 0, 0, 0]), cut, grow);
      }
      case "symmetric": {
        const s = [1, 1, 1];
        s[n.axis] = -1;
        walk(n.c, M, cut, grow);
        return walk(n.c, then(M, [s[0], 0, 0, 0, s[1], 0, 0, 0, s[2], 0, 0, 0]), cut, grow);
      }
      case "offset":
        return walk(n.c, M, cut, grow + n.d / scaleOf(M));
      case "shell":
        return walk(n.c, M, cut, grow);
      default:
    }
  };
  walk(node, IDENTITY, false, 0);
  return out;
}

const profileBox = (p) => compile2(p).box;

// Two unit vectors square to a and to each other.
function across(a) {
  const t = abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit([a[1] * t[2] - a[2] * t[1], a[2] * t[0] - a[0] * t[2], a[0] * t[1] - a[1] * t[0]]);
  const e2 = [a[1] * e1[2] - a[2] * e1[1], a[2] * e1[0] - a[0] * e1[2], a[0] * e1[1] - a[1] * e1[0]];
  return [e1, e2];
}

// Keeps the features a part's distance function f shows: at some height
// along the axis, inside the part's box, the surface is at radius r all the
// way round (at 10 of 12 angles): for a hole, empty just inside r and solid
// just outside; for a solid, the other way. Each kept feature's t is cut to
// where it shows.
export function checkFeatures(features, f, box) {
  const out = [];
  for (const F of features) {
    if (!(F.r > 0)) continue;
    // The axis's stretch inside the box.
    let t0 = F.t[0], t1 = F.t[1];
    for (let i = 0; i < 3; i++) {
      if (abs(F.a[i]) < 1e-9) {
        if (F.c[i] < box[i] - F.r || F.c[i] > box[i + 3] + F.r) t1 = -Infinity;
        continue;
      }
      const ta = (box[i] - F.c[i]) / F.a[i], tb = (box[i + 3] - F.c[i]) / F.a[i];
      t0 = max(t0, min(ta, tb));
      t1 = min(t1, max(ta, tb));
    }
    if (!(t1 > t0)) continue;
    const [e1, e2] = across(F.a);
    const d = max(F.r * 0.02, 1e-3);
    const shows = (t) => {
      const p = [0, 1, 2].map((i) => F.c[i] + F.a[i] * t);
      let n = 0;
      for (let k = 0; k < 12; k++) {
        const an = (k * PI) / 6 + 0.1;
        const e = [0, 1, 2].map((i) => e1[i] * cos(an) + e2[i] * sin(an));
        const ri = (F.inner ?? F.r) - d;
        const fin = f(p[0] + e[0] * ri, p[1] + e[1] * ri, p[2] + e[2] * ri);
        const fout = f(p[0] + e[0] * (F.r + d), p[1] + e[1] * (F.r + d), p[2] + e[2] * (F.r + d));
        if (F.kind === "hole" ? fin > 0 && fout < 0 : fin < 0 && fout > 0) n++;
      }
      return n >= 10;
    };
    const steps = 16;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k <= steps; k++) {
      const t = t0 + ((t1 - t0) * (k + 0.5 * (k === 0) - 0.5 * (k === steps))) / steps;
      if (shows(t)) (lo = min(lo, t)), (hi = max(hi, t));
    }
    if (!(hi >= lo)) continue;
    const kept = { ...F, t: [max(t0, lo - (t1 - t0) / steps), min(t1, hi + (t1 - t0) / steps)] };
    if (F.kind === "hole") {
      // Where the hole's wall ends, to a thousandth of its stretch: from a
      // sample that shows towards the next that does not.
      const edge = (inT, outT) => {
        for (let i = 0; i < 12; i++) {
          const m = (inT + outT) / 2;
          if (shows(m)) inT = m;
          else outT = m;
        }
        return inT;
      };
      const a = edge(lo, max(t0, lo - (t1 - t0) / steps)), b = edge(hi, min(t1, hi + (t1 - t0) / steps));
      // A blind hole has material on its axis just past one end.
      const solidAt = (t) => f(F.c[0] + F.a[0] * t, F.c[1] + F.a[1] * t, F.c[2] + F.a[2] * t) < 0;
      const past = max(d, (t1 - t0) * 0.01);
      const ends = [solidAt(a - past), solidAt(b + past)];
      if (ends[0] !== ends[1]) kept.depth = b - a;
      kept.wall = [a, b];
    }
    out.push(kept);
  }
  return out;
}

// The key a feature is known by, so one size is dimensioned once.
export const featureKey = (F) => `${F.part}|${F.kind}|${F.c.map((v) => round(v * 100)).join(",")}|${F.a.map((v) => round(v * 1000)).join(",")}|${round(F.r * 1000)}`;

// What the section shows of the features: those whose axis lies in the
// cutting plane, in the section view's millimetres:
// [{ key, kind, r, dim, label, depth, part, u0, v0, u1, v1 }] (the axis on paper, model mm).
export function sectionMarks(features, { axis, offset }, view) {
  const a = "xyz".indexOf(axis);
  const { u, v } = VIEWS[view];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const out = [];
  for (const F of features) {
    if (abs(F.a[a]) > 1e-6 || abs(F.c[a] - offset) > 1e-6 * (1 + abs(offset))) continue;
    const [t0, t1] = F.wall ?? F.t;
    const p0 = [0, 1, 2].map((i) => F.c[i] + F.a[i] * t0), p1 = [0, 1, 2].map((i) => F.c[i] + F.a[i] * t1);
    out.push({ key: featureKey(F), kind: F.kind, r: F.r, dim: F.dim, label: F.label ?? null, depth: F.depth ?? null, part: F.part, u0: dot(p0, u), v0: dot(p0, v), u1: dot(p1, u), v1: dot(p1, v) });
  }
  return out;
}

// Where to cut when nobody says, for a drawing of a few parts: through the
// axes of the most holes (then the biggest bore, then the plane that shows
// most of the model), so a section shows holes at their full size. A plane
// that is given close to a hole's axis (within its radius) is moved onto
// it. With no holes, turned parts count instead. Returns { axis, offset,
// note } (note: a sentence for the user, or ""), or null to keep the
// usual plane.
export function featurePlane(features, bounds, given = {}, sheetScale = () => 1) {
  const size = [0, 1, 2].map((i) => bounds[i + 3] - bounds[i]);
  const tol = 1e-6 * max(...size);
  const holes = features.filter((F) => F.kind === "hole" && F.dim);
  const pool = holes.length ? holes : features.filter((F) => F.kind === "solid" && F.dim);
  if (!pool.length) return null;
  const word = holes.length ? "hole" : "turned part";
  const what = (F) => (F.label ? F.label : `⌀${String(round(F.r * 20) / 10)}`);
  if (given.axis && given.offset != null) {
    const a = "xyz".indexOf(given.axis);
    const near = pool.filter((F) => abs(F.a[a]) < 1e-6 && abs(F.c[a] - given.offset) <= F.r && abs(F.c[a] - given.offset) > tol).sort((p, q) => abs(p.c[a] - given.offset) - abs(q.c[a] - given.offset));
    if (!near.length) return null;
    const F = near[0];
    return { axis: given.axis, offset: F.c[a], note: `The section was moved ${String(round(abs(F.c[a] - given.offset) * 100) / 100)} mm onto the axis of the ${what(F)} ${word}, at ${given.axis} = ${String(round(F.c[a] * 100) / 100)} mm.` };
  }
  let best = null;
  for (let a = 0; a < 3; a++) {
    if (given.axis && "xyz"[a] !== given.axis) continue;
    for (const F of pool) {
      if (abs(F.a[a]) > 1e-6) continue;
      const offset = F.c[a];
      if (offset <= bounds[a] || offset >= bounds[a + 3]) continue;
      const on = pool.filter((G) => abs(G.a[a]) < 1e-6 && abs(G.c[a] - offset) < max(tol, 1e-3));
      // Holes counted by axis and size: a bore stepped down is two holes.
      const centres = new Set(on.map((G) => `${G.c.map((v) => round(v * 100)).join(",")}|${round(G.r * 1000)}`));
      // Most holes; then the plane whose section lets the sheet keep the larger scale; then the biggest bore.
      const score = [centres.size, sheetScale("xyz"[a]), max(...on.map((G) => G.r)), size[(a + 1) % 3] * size[(a + 2) % 3], -abs(offset - (bounds[a] + bounds[a + 3]) / 2)];
      const i = best ? score.findIndex((s, k) => abs(s - best.score[k]) > 1e-9) : -1;
      if (!best || (i >= 0 && score[i] > best.score[i])) best = { score, axis: "xyz"[a], offset, on, F };
    }
  }
  if (!best) return null;
  const sizes = [...new Set(best.on.map(what))];
  const n = best.score[0];
  return { axis: best.axis, offset: best.offset, note: `Section A–A goes through ${n > 1 ? `${n} ${word}s` : `the ${word}`} on their axes (${sizes.join(", ")}), at ${best.axis} = ${String(round(best.offset * 100) / 100)} mm.` };
}

// Every part's checked features: [{ part, ...feature }]. parts: { name, node,
// f?, box? } (f and box are compiled when missing).
export function partFeatures(parts) {
  const out = [];
  for (const p of parts) {
    if (!p.node) continue;
    const { f, box } = p.f && p.box ? p : compile(p.node);
    const found = scriptFeatures(p.node);
    if (!found.length) continue;
    for (const F of checkFeatures(found, f, box)) out.push({ part: p.name, source: "script", ...F });
  }
  return out;
}

// ---- in a view ----
// Points of a view's lines, binned, to ask "is there a line near here?".
function lineIndex(lines, cell) {
  const bins = new Map();
  const key = (i, j) => i * 1e6 + j;
  for (const L of lines)
    for (let n = 2; n < L.length; n += 2) {
      const x0 = L[n - 2], y0 = L[n - 1], x1 = L[n], y1 = L[n + 1];
      const k = max(1, Math.ceil(hypot(x1 - x0, y1 - y0) / (cell / 2)));
      for (let s = 0; s <= k; s++) {
        const x = x0 + ((x1 - x0) * s) / k, y = y0 + ((y1 - y0) * s) / k;
        bins.set(key(Math.floor(x / cell), Math.floor(y / cell)), 1);
      }
    }
  return (x, y) => {
    const i = Math.floor(x / cell), j = Math.floor(y / cell);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (bins.has(key(i + di, j + dj))) return true;
    return false;
  };
}

// What a view shows of the features, in the view's millimetres:
//   circles: [{ u, v, r, kind, dim, label, part, source, error? }], features
//     whose axis points at the viewer and whose circle is drawn there;
//   axes: [{ u0, v0, u1, v1, r, kind, part }], features lying across the
//     view whose two sides are drawn there.
// view: from viewOutline (lines, and hidden if drawn). parts: the parts, for
// fitting circles the script does not explain (with f, to tell a hole from a boss).
export function featuresInView(features, view, parts = []) {
  const { u, v, w } = VIEWS[view.view];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  // Only what is seen: a hidden hole is neither centred nor dimensioned.
  const all = view.parts.flatMap((p) => p.lines);
  const size = max(view.box[2] - view.box[0], view.box[3] - view.box[1], 1e-9);
  const tol = max(view.pixel * 3, size * 2e-3);
  const near = lineIndex(all, tol);
  const circles = [], axes = [];
  for (const F of features) {
    const along = dot(F.a, w);
    const cu = dot(F.c, u), cv = dot(F.c, v);
    if (abs(abs(along) - 1) < 1e-6) {
      let hit = 0;
      for (let k = 0; k < 24; k++) if (near(cu + F.r * cos((k * PI) / 12), cv + F.r * sin((k * PI) / 12))) hit++;
      if (hit >= 18) circles.push({ u: cu, v: cv, r: F.r, kind: F.kind, dim: F.dim, label: F.label ?? null, part: F.part, source: F.source, key: featureKey(F), depth: F.depth ?? null });
    } else if (abs(along) < 1e-6) {
      // The axis on paper, and its two sides r either way.
      const au = dot(F.a, u), av = dot(F.a, v);
      const [p0, p1] = F.t.map((t) => [cu + au * t, cv + av * t]);
      const nu = -av, nv = au;
      let hit = 0;
      for (let k = 0; k <= 10; k++) {
        const s = k / 10;
        const pu = p0[0] + (p1[0] - p0[0]) * s, pv = p0[1] + (p1[1] - p0[1]) * s;
        if (near(pu + nu * F.r, pv + nv * F.r)) hit++;
        if (near(pu - nu * F.r, pv - nv * F.r)) hit++;
      }
      if (hit >= 14) axes.push({ u0: p0[0], v0: p0[1], u1: p1[0], v1: p1[1], r: F.r, kind: F.kind, part: F.part });
    }
  }
  // Circles the script does not explain. A view's circle often comes in
  // pieces (where other edges meet it, or something covers part of it), so
  // each piece that is an arc is fitted on its own, arcs of the same circle
  // are gathered, and a circle counts once its arcs go 300° round. It is
  // then fitted again to all their points, and its error is the furthest
  // any of them lies off it.
  const fitted = [];
  for (const p of view.parts) {
    const part = parts.find((q) => q.name === p.name);
    const arcs = [];
    for (const L of p.lines) {
      if (L.length < 10) continue;
      const a = fitCircle(L, (r) => max(tol, r * 0.01), { whole: false });
      if (!a || a.r < tol * 2 || a.r > size) continue;
      // A straight piece fits a huge circle: an arc must bend away from its chord.
      const n = L.length / 2, mx = L[(n >> 1) * 2], my = L[(n >> 1) * 2 + 1];
      const cx = L[L.length - 2] - L[0], cy = L[L.length - 1] - L[1], cl = hypot(cx, cy) || 1;
      if (cl > a.r && abs((mx - L[0]) * cy - (my - L[1]) * cx) / cl < tol) continue;
      const home = arcs.find((g) => hypot(g.cx - a.cx, g.cy - a.cy) < max(tol, 0.03 * a.r) && abs(g.r - a.r) < max(tol, 0.03 * a.r));
      if (home) home.lines.push(L);
      else arcs.push({ cx: a.cx, cy: a.cy, r: a.r, lines: [L] });
    }
    for (const g of arcs) {
      const pts = Float64Array.from(g.lines.flatMap((L) => Array.from(L)));
      const c = fitCircle(pts, (r) => max(tol, r * 0.01), { whole: false });
      if (!c) continue;
      const bins = new Uint8Array(72);
      for (let i = 0; i < pts.length; i += 2) bins[Math.floor(((Math.atan2(pts[i + 1] - c.cy, pts[i] - c.cx) + PI) / (2 * PI)) * 72) % 72] = 1;
      // Segments between points cover the bins they pass too.
      for (const L of g.lines)
        for (let i = 2; i < L.length; i += 2) {
          let a0 = Math.atan2(L[i - 1] - c.cy, L[i - 2] - c.cx), a1 = Math.atan2(L[i + 1] - c.cy, L[i] - c.cx);
          if (a1 - a0 > PI) a1 -= 2 * PI;
          if (a0 - a1 > PI) a1 += 2 * PI;
          for (let k = 0; k <= 8; k++) bins[Math.floor(((a0 + ((a1 - a0) * k) / 8 + 3 * PI) / (2 * PI)) * 72) % 72] = 1;
        }
      if (bins.reduce((s, b) => s + b, 0) < 60) continue;
      // A circle round the centre of one the script explains and close to its size is an edge of that feature (a chamfer, a fillet), not a hole of its own.
      if (circles.some((k) => k.source === "script" && hypot(k.u - c.cx, k.v - c.cy) < max(tol, 0.05 * k.r) && abs(k.r - c.r) < 0.15 * k.r)) continue;
      // A hole if, a little way in from the face, the middle is empty and
      // just outside the circle is solid.
      let kind = "solid";
      if (part?.f) {
        const f = part.f;
        const at = (pu, pv, depth) => [0, 1, 2].map((i) => u[i] * pu + v[i] * pv + w[i] * depth);
        // From the nearest point of the part towards the back, in 24 steps.
        const P = part.positions;
        let wmax = -Infinity, wmin = Infinity;
        for (let i = 0; i < P.length; i += 3) {
          const d = w[0] * P[i] + w[1] * P[i + 1] + w[2] * P[i + 2];
          (wmax = max(wmax, d)), (wmin = min(wmin, d));
        }
        for (let s = 1; s < 24; s++) {
          const depth = wmax - ((wmax - wmin) * s) / 24;
          const ring = [0, 1, 2, 3].every((k) => f(...at(c.cx + (c.r * 1.05 + tol) * cos((k * PI) / 2), c.cy + (c.r * 1.05 + tol) * sin((k * PI) / 2), depth)) < 0);
          if (ring) {
            kind = f(...at(c.cx, c.cy, depth)) > 0 ? "hole" : "solid";
            break;
          }
        }
      }
      fitted.push({ u: c.cx, v: c.cy, r: c.r, kind, dim: kind === "hole", label: null, part: p.name, source: "fitted", error: c.error });
    }
  }
  return { circles: [...circles, ...fitted], axes };
}

// A view with its marks: viewOutline, plus marks (featuresInView) for the
// parts' holes and turned pieces. parts: with node, and f and box.
export function markedView(parts, view, opts = {}) {
  const v = viewOutline(parts, view, opts);
  v.marks = featuresInView(partFeatures(parts), v, parts);
  return v;
}

// The section plane for a drawing: as given, or through holes on a drawing
// of a few parts (see featurePlane), or across the longest side; then, if it
// passes close to a hole's or turned part's axis, onto that axis.
// Returns { plane: { axis, offset }, note }.
export function choosePlane(features, bounds, section = {}, parts = 1, sheetScale) {
  const given = { axis: section.axis ?? undefined, offset: section.offset ?? undefined };
  let plane = null, note = "";
  if (given.offset == null && parts <= 3) {
    const p = featurePlane(features, bounds, given, sheetScale);
    if (p) (plane = { axis: p.axis, offset: p.offset }), (note = p.note);
  }
  if (!plane) {
    plane = sectionPlane(bounds, given);
    const snap = featurePlane(features, bounds, plane);
    if (snap) {
      plane = { axis: snap.axis, offset: snap.offset };
      // Moving the plane the app chose itself needs no word.
      if (given.offset != null) note = snap.note;
    }
  }
  return { plane, note };
}

// The model's box from its surfaces, not only its meshes: a mesh's
// outermost vertex may stand a little proud of the surface or short of it
// (a rounded corner meshed in cells), which would make a 100 mm plate read
// 100.1. For each side of each part, the surface is found exactly along
// that axis through its outermost vertices (the distance function changes
// sign there), and the furthest of them is the side. parts: { positions,
// f? or node }.
export function surfaceBounds(parts) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const P = p.positions, n = P.length / 3;
    if (!n) continue;
    const f = p.f ?? (p.node ? compile(p.node).f : null);
    for (let a = 0; a < 3; a++) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) (lo = min(lo, P[i * 3 + a])), (hi = max(hi, P[i * 3 + a]));
      const reach = max((hi - lo) * 0.01, 1e-3);
      for (const top of [false, true]) {
        const edge = top ? hi : lo;
        let side = edge;
        if (f) {
          let found = -Infinity;
          const s = top ? 1 : -1;
          for (let i = 0; i < n; i++) {
            const c = P[i * 3 + a];
            if (abs(c - edge) > reach) continue;
            const v = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
            const at = (t) => {
              v[a] = t;
              return f(v[0], v[1], v[2]);
            };
            // Inside a little way in, outside a little way out: bisect.
            let tin = c - s * reach, tout = c + s * reach;
            if (!(at(tin) < 0 && at(tout) > 0)) continue;
            for (let k = 0; k < 40; k++) {
              const m = (tin + tout) / 2;
              if (at(m) < 0) tin = m;
              else tout = m;
            }
            found = max(found, s * tin);
          }
          if (found > -Infinity) side = s * found;
        }
        if (top) b[a + 3] = max(b[a + 3], side);
        else b[a] = min(b[a], side);
      }
    }
  }
  return b;
}
