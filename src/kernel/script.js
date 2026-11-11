// Runs a model script: plain JavaScript that builds shapes with the functions
// below and declares named parts and adjustable values. The result is data
// (JSON shape trees per part), so it can be meshed in parallel and cached.
import { compile, compile2, isEmptyBox, threadRoot, threadPitchRadius, hullDirections } from "./sdf.js";
import { meshSDF } from "./mesh.js";
import { convexHullPlanes } from "./hull.js";
import { makePoseApi, sampleMotion, defaultLoop } from "./motion.js";
import { layoutText } from "./font.js";

export const PALETTE = ["#9aa3ad", "#c9cdd2", "#5b6670", "#b8483e", "#d9a441", "#4f7cac", "#6b8f5e", "#2f3338"];
const AXES = { x: 0, y: 1, z: 2 };

class ScriptError extends Error {}
class MotionError extends Error {}
const fail = (msg) => {
  throw new ScriptError(msg);
};

const what = (v) => (v === undefined ? "nothing" : v === null ? "null" : Array.isArray(v) ? `an array of ${v.length}` : typeof v === "object" ? "an object" : JSON.stringify(v));
const num = (v, where, { positive = false, nonneg = false } = {}) => {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${where} must be a number, got ${what(v)}`);
  if (positive && !(v > 0)) fail(`${where} must be greater than 0, got ${v}`);
  if (nonneg && v < 0) fail(`${where} must not be negative, got ${v}`);
  return v;
};
const vec = (v, where) => {
  if (!Array.isArray(v) || v.length !== 3) fail(`${where} must be [x, y, z], got ${what(v)}`);
  return v.map((x, i) => num(x, `${where}[${i}]`));
};
// Accepts f(x, y, z) or f([x, y, z]).
const vecArgs = (args, where, fill = 0) => (Array.isArray(args[0]) ? vec(args[0], where) : [0, 1, 2].map((i) => num(args[i] ?? fill, where)));
const axisOf = (a, where) => {
  if (typeof a === "string" && a.toLowerCase() in AXES) return AXES[a.toLowerCase()];
  fail(`${where} must be "x", "y" or "z", got ${what(a)}`);
};
const points2 = (pts, where, min = 3) => {
  if (!Array.isArray(pts) || pts.length < min) fail(`${where} needs at least ${min} points [[x, y], ...]`);
  return pts.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2) fail(`${where} point ${i} must be [x, y], got ${what(p)}`);
    return [num(p[0], `${where} point ${i}`), num(p[1], `${where} point ${i}`)];
  });
};

class Shape {
  constructor(node) {
    this.node = node;
  }
  move(...a) {
    const v = vecArgs(a, "move");
    return new Shape({ t: "move", v, c: this.node });
  }
  at(...a) {
    return this.move(...a);
  }
  rotate(...a) {
    return new Shape({ t: "rotate", deg: vecArgs(a, "rotate"), c: this.node });
  }
  rotateX(d) {
    return this.rotate(num(d, "rotateX"), 0, 0);
  }
  rotateY(d) {
    return this.rotate(0, num(d, "rotateY"), 0);
  }
  rotateZ(d) {
    return this.rotate(0, 0, num(d, "rotateZ"));
  }
  scale(...a) {
    const s = a.length === 1 && typeof a[0] === "number" ? [a[0], a[0], a[0]] : vecArgs(a, "scale", 1);
    s.forEach((x) => x === 0 && fail("scale cannot be 0"));
    return new Shape({ t: "scale", s, c: this.node });
  }
  add(...a) {
    return union(this, ...a);
  }
  cut(...a) {
    return subtract(this, ...a);
  }
  common(...a) {
    return intersect(this, ...a);
  }
  offset(d) {
    return new Shape({ t: "offset", d: num(d, "offset"), c: this.node });
  }
  shell(t) {
    return new Shape({ t: "shell", th: num(t, "shell thickness", { positive: true }), c: this.node });
  }
  mirror(axis) {
    return new Shape({ t: "mirror", axis: axisOf(axis, "mirror axis"), c: this.node });
  }
  symmetric(axis) {
    return new Shape({ t: "symmetric", axis: axisOf(axis, "symmetric axis"), c: this.node });
  }
  // Turns it about Z, from 0 at its bottom to deg degrees at its top.
  twist(deg) {
    return new Shape({ t: "twist", deg: num(deg, "twist angle"), c: this.node });
  }
  // Scales it across X and Y (about the Z axis) from 1 at its bottom to s
  // (or sx, sy) at its top.
  taper(sx, sy = sx) {
    num(sx, "taper scale", { positive: true });
    num(sy, "taper scale", { positive: true });
    return new Shape({ t: "taper", s: [sx, sy], c: this.node });
  }
  // Bends its X axis onto a circle of radius |r| through the origin, in the
  // XZ plane: r > 0 curls the ends up, r < 0 down. A length L bends through
  // L / r radians.
  bend(r) {
    num(r, "bend radius");
    if (!r) fail("bend radius cannot be 0");
    const b = compile(this.node).box;
    if (isEmptyBox(b)) return this;
    const A = Math.abs(r);
    if (Math.max(Math.abs(b[0]), Math.abs(b[3])) > Math.PI * A * 0.98) fail(`bend radius ${A} is too small: the shape (x from ${R5(b[0])} to ${R5(b[3])}) would bend more than half a turn each way. Use a radius of at least ${Math.ceil(Math.max(Math.abs(b[0]), Math.abs(b[3])) / Math.PI)}`);
    const inner = r > 0 ? A - b[5] : A + b[2];
    if (inner <= 0) fail(`bend radius ${A} is smaller than the shape is thick on the inside of the bend (z from ${R5(b[2])} to ${R5(b[5])})`);
    return new Shape({ t: "bend", r, c: this.node });
  }
  // Fills it with a lattice: "gyroid", "diamond", "grid" or "honeycomb",
  // repeating every cell mm, walls or struts wall mm thick. skin: keep a
  // solid outer wall of that thickness.
  lattice(kind, cell, wall, opts = {}) {
    if (!["gyroid", "diamond", "grid", "honeycomb"].includes(kind)) fail(`lattice kind must be "gyroid", "diamond", "grid" or "honeycomb", got ${what(kind)}`);
    num(cell, "lattice cell", { positive: true });
    num(wall, "lattice wall", { positive: true });
    const most = kind === "gyroid" || kind === "diamond" ? 0.3 : 0.6;
    if (wall > cell * most) fail(`lattice wall ${wall} is too thick for a ${cell} mm ${kind} cell (at most ${R5(cell * most)})`);
    if (typeof opts !== "object" || opts === null) fail("lattice options must be { skin }");
    const node = { t: "lattice", kind, cell, wall, c: this.node };
    if (!opts.skin) return new Shape(node);
    return new Shape({ t: "union", c: [{ t: "shell", th: num(opts.skin, "lattice skin", { positive: true }), c: this.node }, node] });
  }
  radial(n, axis = "z") {
    n = Math.round(num(n, "radial count", { positive: true }));
    const ax = axisOf(axis, "radial axis");
    const copies = [];
    for (let i = 0; i < n; i++) {
      const deg = [0, 0, 0];
      deg[ax] = (360 * i) / n;
      copies.push(i ? { t: "rotate", deg, c: this.node } : this.node);
    }
    return new Shape({ t: "union", c: copies });
  }
  array(n, ...a) {
    n = Math.round(num(n, "array count", { positive: true }));
    const d = vecArgs(a, "array step");
    const copies = [];
    for (let i = 0; i < n; i++) copies.push(i ? { t: "move", v: d.map((x) => x * i), c: this.node } : this.node);
    return new Shape({ t: "union", c: copies });
  }
}

const shapeNode = (s, where) => {
  if (s instanceof Shape) return s.node;
  fail(`${where} expects shapes, got ${what(s)}`);
};
// (...shapes, smooth?) where any argument may also be an array of shapes.
const shapesAndSmooth = (args, where) => {
  const list = args.flat(Infinity);
  let k = 0;
  if (typeof list.at(-1) === "number") k = num(list.pop(), `${where} smooth`, { nonneg: true });
  return { nodes: list.map((s) => shapeNode(s, where)), k };
};

// ---- primitives (all centred on the origin unless noted) ----
function box(...a) {
  const round = Array.isArray(a[0]) ? a[1] ?? 0 : a[3] ?? 0;
  const s = Array.isArray(a[0]) ? vec(a[0], "box size") : [num(a[0], "box width", { positive: true }), num(a[1] ?? a[0], "box depth", { positive: true }), num(a[2] ?? a[0], "box height", { positive: true })];
  s.forEach((x) => x > 0 || fail("box sizes must be greater than 0"));
  const r = num(round, "box round", { nonneg: true });
  if (r * 2 > Math.min(...s)) fail(`box round ${r} is more than half the smallest side (${Math.min(...s)})`);
  return new Shape({ t: "box", s, r });
}
const sphere = (r) => new Shape({ t: "sphere", r: num(r, "sphere radius", { positive: true }) });
const ellipsoid = (...a) => {
  const r = vecArgs(a, "ellipsoid radii");
  r.forEach((x) => x > 0 || fail("ellipsoid radii must be greater than 0"));
  return new Shape({ t: "ellipsoid", r });
};
function cylinder(r, h, round = 0) {
  num(r, "cylinder radius", { positive: true });
  num(h, "cylinder height", { positive: true });
  num(round, "cylinder round", { nonneg: true });
  if (round > Math.min(r, h / 2)) fail(`cylinder round ${round} is larger than the radius or half the height`);
  return new Shape({ t: "cylinder", r, h, round });
}
function cone(r1, r2, h) {
  num(r1, "cone bottom radius", { nonneg: true });
  num(r2, "cone top radius", { nonneg: true });
  num(h, "cone height", { positive: true });
  if (r1 === 0 && r2 === 0) fail("cone needs a radius greater than 0");
  return new Shape({ t: "cone", r1, r2, h });
}
function capsule(a, b, r1, r2 = r1) {
  return new Shape({ t: "capsule", a: vec(a, "capsule start"), b: vec(b, "capsule end"), r1: num(r1, "capsule radius", { positive: true }), r2: num(r2, "capsule end radius", { positive: true }) });
}
const torus = (R, r) => {
  num(R, "torus major radius", { positive: true });
  num(r, "torus minor radius", { positive: true });
  return new Shape({ t: "torus", R, r });
};
// ---- profiles: flat outlines in their own XY plane ----
// Used by extrude, revolve, sweep and loft. Curves are turned into fine
// point lists here, so the shape tree stays plain data.
const R5 = (v) => Math.round(v * 1e5) / 1e5;
class Profile {
  constructor(node) {
    this.node = node;
  }
  move(...a) {
    const [x, y] = Array.isArray(a[0]) ? pt2(a[0], "profile move") : [num(a[0] ?? 0, "profile move x"), num(a[1] ?? 0, "profile move y")];
    return new Profile({ t: "move2", v: [x, y], c: this.node });
  }
  at(...a) {
    return this.move(...a);
  }
  rotate(deg) {
    return new Profile({ t: "rotate2", deg: num(deg, "profile rotate"), c: this.node });
  }
  scale(sx, sy = sx) {
    num(sx, "profile scale");
    num(sy, "profile scale");
    if (!sx || !sy) fail("profile scale cannot be 0");
    return new Profile({ t: "scale2", s: [sx, sy], c: this.node });
  }
  mirror(axis) {
    if (axis !== "x" && axis !== "y") fail(`profile mirror axis must be "x" or "y", got ${what(axis)}`);
    return new Profile({ t: "scale2", s: axis === "x" ? [-1, 1] : [1, -1], c: this.node });
  }
  offset(d) {
    return new Profile({ t: "offset2", d: num(d, "profile offset"), c: this.node });
  }
  add(...a) {
    const { nodes, k } = profilesAndSmooth([this, ...a], "add");
    return new Profile({ t: "union2", c: nodes, k });
  }
  cut(...a) {
    const { nodes, k } = profilesAndSmooth([this, ...a], "cut");
    if (nodes.length < 2) fail("cut needs at least one profile to cut away");
    return new Profile({ t: "subtract2", a: nodes[0], b: nodes.slice(1), k });
  }
  common(...a) {
    const { nodes, k } = profilesAndSmooth([this, ...a], "common");
    if (nodes.length < 2) fail("common needs at least two profiles");
    return new Profile({ t: "intersect2", c: nodes, k });
  }
}
const pt2 = (p, where) => {
  if (!Array.isArray(p) || p.length !== 2) fail(`${where} must be [x, y], got ${what(p)}`);
  return [num(p[0], where), num(p[1], where)];
};
const profileNode = (p, where) => {
  if (p instanceof Profile) return p.node;
  if (p instanceof Path) fail(`${where}: this path is not closed. End it with .close() to make a profile`);
  fail(`${where} expects a profile (circle, rect, polygon, path(...).close(), airfoil), got ${p instanceof Shape ? "a 3D shape" : what(p)}`);
};
const profilesAndSmooth = (args, where) => {
  const list = args.flat(Infinity);
  let k = 0;
  if (typeof list.at(-1) === "number") k = num(list.pop(), `${where} smooth`, { nonneg: true });
  return { nodes: list.map((p) => profileNode(p, where)), k };
};
const outline = (pts) => new Profile({ t: "poly2", pts: pts.map(([x, y]) => [R5(x), R5(y)]) });

const circle = (r) => new Profile({ t: "circle2", r: num(r, "circle radius", { positive: true }) });
function rect(w, h = w, round = 0) {
  num(w, "rect width", { positive: true });
  num(h, "rect height", { positive: true });
  num(round, "rect round", { nonneg: true });
  if (round * 2 > Math.min(w, h)) fail(`rect round ${round} is more than half the smallest side (${Math.min(w, h)})`);
  return new Profile({ t: "rect2", w, h, r: round });
}
// Corners rounded with arcs of radius r (each limited to fit its edges).
function roundCorners(pts, r) {
  if (!r) return pts;
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const ua = [a[0] - p[0], a[1] - p[1]], ub = [b[0] - p[0], b[1] - p[1]];
    const la = Math.hypot(...ua), lb = Math.hypot(...ub);
    if (!la || !lb) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (ua[0] * ub[0] + ua[1] * ub[1]) / (la * lb))));
    if (ang > Math.PI - 1e-3) {
      out.push(p);
      continue;
    }
    // Distance from the corner to where the arc meets each edge.
    let t = r / Math.tan(ang / 2);
    const lim = Math.min(la, lb) / 2;
    const rr = t > lim ? lim * Math.tan(ang / 2) : r;
    t = Math.min(t, lim);
    const p1 = [p[0] + (ua[0] / la) * t, p[1] + (ua[1] / la) * t], p2 = [p[0] + (ub[0] / lb) * t, p[1] + (ub[1] / lb) * t];
    const bis = [ua[0] / la + ub[0] / lb, ua[1] / la + ub[1] / lb], bl = Math.hypot(...bis);
    const dc = rr / Math.sin(ang / 2);
    const c = [p[0] + (bis[0] / bl) * dc, p[1] + (bis[1] / bl) * dc];
    let s0 = Math.atan2(p1[1] - c[1], p1[0] - c[0]), s1 = Math.atan2(p2[1] - c[1], p2[0] - c[0]);
    let sw = s1 - s0;
    while (sw > Math.PI) sw -= 2 * Math.PI;
    while (sw < -Math.PI) sw += 2 * Math.PI;
    const k = Math.max(2, Math.ceil(Math.abs(sw) / (3 * DEG)));
    for (let j = 0; j <= k; j++) out.push([c[0] + rr * Math.cos(s0 + (sw * j) / k), c[1] + rr * Math.sin(s0 + (sw * j) / k)]);
  }
  return out;
}
function polygon(pts, round = 0) {
  return outline(roundCorners(points2(pts, "polygon"), num(round, "polygon round", { nonneg: true })));
}

// A NACA 4-digit airfoil ("2412": 2% camber at 40% chord, 12% thick), leading
// edge at the origin, chord along +x, upper surface towards +y.
function airfoil(code, chord) {
  const c = String(code);
  if (!/^\d{4}$/.test(c)) fail(`airfoil code must be 4 digits like "2412" or "0012", got ${what(code)}`);
  num(chord, "airfoil chord", { positive: true });
  const m = +c[0] / 100, pp = +c[1] / 10, th = +c.slice(2) / 100;
  if (!th) fail("airfoil thickness (last two digits) must be more than 0");
  const N = 60, up = [], lo = [];
  for (let i = 0; i <= N; i++) {
    const x = (1 - Math.cos((Math.PI * i) / N)) / 2;
    const yt = 5 * th * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    let yc = 0, dy = 0;
    if (m && pp) {
      if (x < pp) (yc = (m / pp ** 2) * (2 * pp * x - x * x)), (dy = ((2 * m) / pp ** 2) * (pp - x));
      else (yc = (m / (1 - pp) ** 2) * (1 - 2 * pp + 2 * pp * x - x * x)), (dy = ((2 * m) / (1 - pp) ** 2) * (pp - x));
    }
    const a = Math.atan(dy);
    up.push([(x - yt * Math.sin(a)) * chord, (yc + yt * Math.cos(a)) * chord]);
    lo.push([(x + yt * Math.sin(a)) * chord, (yc - yt * Math.cos(a)) * chord]);
  }
  // Trailing edge to leading edge along the top, back along the bottom.
  return outline([...up.reverse(), ...lo.slice(1, -1)]);
}

// Smooth curve through points (centripetal Catmull-Rom), k points per span.
function catmull(pts, closed, perSpan) {
  const n = pts.length, dim = pts[0].length, out = [];
  const get = (i) => (closed ? pts[(i + n) % n] : pts[Math.min(Math.max(i, 0), n - 1)]);
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const d = (a, b) => Math.max(Math.sqrt(Math.hypot(...a.map((v, j) => v - b[j]))), 1e-6);
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    const k = typeof perSpan === "function" ? perSpan(p1, p2) : perSpan;
    for (let j = 0; j < k; j++) {
      const t = t1 + ((t2 - t1) * j) / k;
      const lerp = (a, b, ta, tb) => a.map((v, q) => ((tb - t) * v + (t - ta) * b[q]) / (tb - ta || 1));
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2).slice(0, dim));
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

// path([x, y]).line(...).arc(...)... : an outline drawn piece by piece.
// .close() makes it a profile; an open path can be a sweep path (in XY).
class Path {
  constructor(p) {
    this.pts = [pt2(p, "path start")];
  }
  get last() {
    return this.pts[this.pts.length - 1];
  }
  xy(a, where) {
    return Array.isArray(a[0]) ? pt2(a[0], where) : [num(a[0], where), num(a[1], where)];
  }
  line(...a) {
    this.pts.push(this.xy(a, "line"));
    return this;
  }
  lineBy(...a) {
    const [dx, dy] = this.xy(a, "lineBy");
    this.pts.push([this.last[0] + dx, this.last[1] + dy]);
    return this;
  }
  // Arc from the current point through `via` to `to`.
  arc(via, to) {
    const [a, b, c] = [this.last, pt2(via, "arc through point"), pt2(to, "arc end")];
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-9) return this.line(to);
    const sq = (p) => p[0] * p[0] + p[1] * p[1];
    const cx = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
    const cy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
    const ang = (p) => Math.atan2(p[1] - cy, p[0] - cx);
    const s0 = ang(a), sb = ang(b), s1 = ang(c);
    const ccw = d > 0;
    const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const sweep = ccw ? norm(s1 - s0) : -norm(s0 - s1);
    return this.arcPoints(cx, cy, Math.hypot(a[0] - cx, a[1] - cy), s0, sweep, c);
  }
  // Arc of radius r to (x, y): r > 0 bends left (counterclockwise), r < 0 right.
  radiusArc(x, y, r) {
    const to = [num(x, "radiusArc x"), num(y, "radiusArc y")], a = this.last;
    num(r, "radiusArc radius");
    const dx = to[0] - a[0], dy = to[1] - a[1], ch = Math.hypot(dx, dy);
    if (!ch) return this;
    if (Math.abs(r) < ch / 2) fail(`radiusArc radius ${Math.abs(r)} is too small to reach a point ${R5(ch)} away (needs at least ${R5(ch / 2)})`);
    const h = Math.sqrt(r * r - (ch / 2) ** 2) * Math.sign(r);
    const cx = (a[0] + to[0]) / 2 - (dy / ch) * h, cy = (a[1] + to[1]) / 2 + (dx / ch) * h;
    const s0 = Math.atan2(a[1] - cy, a[0] - cx), s1 = Math.atan2(to[1] - cy, to[0] - cx);
    let sw = s1 - s0;
    if (r > 0) while (sw < 0) sw += 2 * Math.PI;
    else while (sw > 0) sw -= 2 * Math.PI;
    return this.arcPoints(cx, cy, Math.abs(r), s0, sw, to);
  }
  // Arc to (x, y) that continues smoothly from the last piece.
  tangentArc(...a) {
    const to = this.xy(a, "tangentArc"), p = this.last;
    if (this.pts.length < 2) fail("tangentArc needs a piece before it to continue from");
    const q = this.pts[this.pts.length - 2];
    const t = [p[0] - q[0], p[1] - q[1]], tl = Math.hypot(...t);
    const c = [to[0] - p[0], to[1] - p[1]];
    const cr = t[0] * c[1] - t[1] * c[0];
    if (Math.abs(cr) < 1e-9 * tl * Math.hypot(...c)) return this.line(to);
    // Centre on the normal at p, equally far from p and the end point.
    const nrm = [-t[1] / tl, t[0] / tl];
    const r = (c[0] * c[0] + c[1] * c[1]) / (2 * (c[0] * nrm[0] + c[1] * nrm[1]));
    const cx = p[0] + nrm[0] * r, cy = p[1] + nrm[1] * r;
    const s0 = Math.atan2(p[1] - cy, p[0] - cx), s1 = Math.atan2(to[1] - cy, to[0] - cx);
    let sw = s1 - s0;
    if (cr > 0) while (sw < 0) sw += 2 * Math.PI;
    else while (sw > 0) sw -= 2 * Math.PI;
    return this.arcPoints(cx, cy, Math.abs(r), s0, sw, to);
  }
  arcPoints(cx, cy, r, s0, sw, to) {
    const k = Math.max(2, Math.ceil(Math.abs(sw) / (2 * DEG)));
    for (let j = 1; j < k; j++) this.pts.push([cx + r * Math.cos(s0 + (sw * j) / k), cy + r * Math.sin(s0 + (sw * j) / k)]);
    this.pts.push(to);
    return this;
  }
  // Bezier curve: one control point (quadratic) or two (cubic), then the end.
  curve(...a) {
    const ps = a.map((p, i) => pt2(p, `curve point ${i + 1}`));
    if (ps.length < 2 || ps.length > 3) fail("curve takes one or two control points, then the end point: curve([cx, cy], [x, y]) or curve([c1x, c1y], [c2x, c2y], [x, y])");
    const ctl = [this.last, ...ps];
    const k = 32;
    for (let j = 1; j <= k; j++) {
      let q = ctl.map((p) => [...p]);
      const t = j / k;
      while (q.length > 1) q = q.slice(1).map((p, i) => [q[i][0] + (p[0] - q[i][0]) * t, q[i][1] + (p[1] - q[i][1]) * t]);
      this.pts.push(q[0]);
    }
    return this;
  }
  // Smooth curve through these points.
  spline(pts) {
    const ps = points2(pts, "spline", 1);
    this.pts.push(...catmull([this.last, ...ps], false, 16).slice(1));
    return this;
  }
  // The path drawn with a round pen of width w: a profile for a slot, a
  // groove, a wire or a raised line.
  stroke(w) {
    num(w, "stroke width", { positive: true });
    return new Profile({ t: "strokes2", lines: [this.pts.map(([x, y]) => [R5(x), R5(y)])], w });
  }
  close(round = 0) {
    let p = this.pts.filter((q, i, all) => i === 0 || Math.hypot(q[0] - all[i - 1][0], q[1] - all[i - 1][1]) > 1e-9);
    if (p.length > 1 && Math.hypot(p[0][0] - p.at(-1)[0], p[0][1] - p.at(-1)[1]) < 1e-9) p = p.slice(0, -1);
    if (p.length < 3) fail("a closed path needs at least 3 points");
    return outline(roundCorners(p, num(round, "close round", { nonneg: true })));
  }
}
const path = (...a) => new Path(Array.isArray(a[0]) ? a[0] : [a[0], a[1]]);

// Text as a profile, in our own single-stroke font: size is the capital
// height (mm). Centred on the origin unless align is "left" or "right" (then
// the first line's baseline starts or ends at the origin). pen: stroke width
// (default 12% of size); spacing: letter spacing factor; lines split at "\n".
function text(str, size, opts = {}) {
  if (typeof str !== "string" && typeof str !== "number") fail(`text needs a string first, got ${what(str)}`);
  str = String(str);
  if (!str.trim()) fail("text is empty");
  num(size, "text size", { positive: true });
  if (typeof opts !== "object" || opts === null) fail("text options must be { align, pen, spacing, lineHeight }");
  const align = opts.align ?? "center";
  if (!["left", "center", "right"].includes(align)) fail(`text align must be "left", "center" or "right", got ${what(align)}`);
  const pen = num(opts.pen ?? size * 0.12, "text pen", { positive: true });
  const spacing = num(opts.spacing ?? 1, "text spacing", { positive: true });
  const lineHeight = num(opts.lineHeight ?? 1.6, "text lineHeight", { positive: true });
  let layout;
  try {
    layout = layoutText(str, size, { pen, align, spacing, lineHeight });
  } catch (err) {
    fail(err.message);
  }
  // Centred: the block from the first line's capitals to the last baseline.
  const lines = str.split("\n").length;
  const dy = align === "center" ? -(size - (lines - 1) * size * lineHeight) / 2 : 0;
  return new Profile({ t: "strokes2", lines: layout.strokes.map((l) => l.map(([x, y]) => [R5(x), R5(y + dy)])), w: R5(pen) });
}

// A helix around Z: radius r, rising `pitch` per turn, starting at (r, 0, 0).
function helix(r, pitch, turns) {
  num(r, "helix radius", { positive: true });
  num(pitch, "helix pitch");
  num(turns, "helix turns", { positive: true });
  if (turns > 500) fail("helix turns must be at most 500");
  const n = Math.max(8, Math.ceil(turns * 72));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (2 * Math.PI * turns * i) / n;
    return [R5(r * Math.cos(a)), R5(r * Math.sin(a)), R5((pitch * turns * i) / n)];
  });
}

function extrude(p, h, opts = {}) {
  num(h, "extrude height", { positive: true });
  if (typeof opts !== "object" || opts === null) fail("extrude options must be { draft }");
  const node = Array.isArray(p) ? { t: "extrude", pts: points2(p, "extrude"), h } : { t: "extrude", p: profileNode(p, "extrude"), h };
  if (opts.draft) {
    const d = num(opts.draft, "extrude draft");
    if (Math.abs(d) >= 45) fail(`extrude draft must be between -45 and 45 degrees, got ${d}`);
    node.draft = d;
  }
  return new Shape(node);
}

// ---- threads, holes and fasteners (ISO metric) ----
// Size data per thread: pitch, clearance hole (ISO 273 normal), hex head
// across flats and height (ISO 4017), socket head diameter, height and key
// (ISO 4762), flat (countersunk) head diameter and key (ISO 10642), nut height
// (ISO 4032), washer inner, outer and thickness (ISO 7089), counterbore
// diameter (DIN 974).
const METRIC = {
  M2: [0.4, 2.4, 4, 1.4, 3.8, 2, 1.5, 4, 1.3, 1.6, 2.2, 5, 0.3, 4.3],
  "M2.5": [0.45, 2.9, 5, 1.7, 4.5, 2.5, 2, 5, 1.5, 2, 2.7, 6, 0.5, 5],
  M3: [0.5, 3.4, 5.5, 2, 5.5, 3, 2.5, 6.72, 2, 2.4, 3.2, 7, 0.5, 6.5],
  M4: [0.7, 4.5, 7, 2.8, 7, 4, 3, 8.96, 2.5, 3.2, 4.3, 9, 0.8, 8],
  M5: [0.8, 5.5, 8, 3.5, 8.5, 5, 4, 11.2, 3, 4.7, 5.3, 10, 1, 10],
  M6: [1, 6.6, 10, 4, 10, 6, 5, 13.44, 4, 5.2, 6.4, 12, 1.6, 11],
  M8: [1.25, 9, 13, 5.3, 13, 8, 6, 17.92, 5, 6.8, 8.4, 16, 1.6, 15],
  M10: [1.5, 11, 16, 6.4, 16, 10, 8, 22.4, 6, 8.4, 10.5, 20, 2, 18],
  M12: [1.75, 13.5, 18, 7.5, 18, 12, 10, 26.88, 8, 10.8, 13, 24, 2.5, 20],
  M14: [2, 15.5, 21, 8.8, 21, 14, 12, 30.8, 10, 12.8, 15, 28, 2.5, 24],
  M16: [2, 17.5, 24, 10, 24, 16, 14, 33.6, 10, 14.8, 17, 30, 3, 26],
  M20: [2.5, 22, 30, 12.5, 30, 20, 17, 40.32, 12, 18, 21, 37, 3, 33],
  M24: [3, 26, 36, 15, 36, 24, 19, 48, 14, 21.5, 25, 44, 4, 40],
  M30: [3.5, 33, 46, 18.7, 45, 30, 22, 60, 17, 25.6, 31, 56, 4, 48],
  M36: [4, 39, 55, 22.5, 54, 36, 27, 72, 19, 31, 37, 66, 5, 57],
};
function metric(size) {
  const key = typeof size === "string" ? size.trim().toUpperCase() : size;
  const row = METRIC[key];
  if (!row) fail(`unknown thread size ${what(size)}; use one of ${Object.keys(METRIC).join(", ")}`);
  const [pitch, clearance, s, k, sd, sk, key2, fd, fkey, m, wd, wD, wh, cb] = row;
  const d = Number(key.slice(1));
  const r = d / 2;
  return {
    size: key, d, pitch, clearance, tapDrill: R5(d - pitch),
    minor: R5(2 * threadRoot(r, pitch)), pitchDiameter: R5(2 * threadPitchRadius(r, pitch)),
    hex: { s, k }, socket: { d: sd, k: sk, key: key2 }, flat: { d: fd, k: R5((fd - d) / 2), key: fkey },
    nut: { s, m }, washer: { d: wd, D: wD, h: wh }, cbore: { d: cb, depth: sk },
  };
}
// A size given as "M6" (metric data) or a plain diameter (number).
const sizeOf = (size, where) => {
  if (typeof size === "string") return metric(size);
  num(size, `${where} size`, { positive: true });
  return null;
};
// Node helpers, all along Z between z0 and z1.
const zmove = (z, c) => ({ t: "move", v: [0, 0, R5(z)], c });
const cylZ = (r, z0, z1) => zmove((z0 + z1) / 2, { t: "cylinder", r: R5(r), h: R5(z1 - z0) });
const coneZ = (ra, rb, z0, z1) => zmove((z0 + z1) / 2, { t: "cone", r1: R5(ra), r2: R5(rb), h: R5(z1 - z0) });
const hexPts = (s) => Array.from({ length: 6 }, (_, i) => [R5((s / Math.sqrt(3)) * Math.cos((i * Math.PI) / 3)), R5((s / Math.sqrt(3)) * Math.sin((i * Math.PI) / 3))]);
const hexZ = (s, z0, z1) => zmove((z0 + z1) / 2, { t: "extrude", p: { t: "poly2", pts: hexPts(s) }, h: R5(z1 - z0) });
// A hex prism with its corners chamfered at 30°, at the top or both ends.
function chamferedHex(s, z0, z1, both) {
  const h = z1 - z0, out = s / 2 + h * Math.sqrt(3);
  const c = [hexZ(s, z0, z1), coneZ(out, s / 2, z0, z1)];
  if (both) c.push(coneZ(s / 2, out, z0, z1));
  return { t: "intersect", c };
}
const threadNode = (r, p, z0, z1, opts = {}) => ({ t: "thread", r: R5(r), p, z0: R5(z0), z1: R5(z1), ...opts });

// A threaded rod centred on the origin along Z, like cylinder: thread("M10", 40)
// or thread(10, 40, { pitch: 1.5 }). Options: pitch, left, chamfer (default true).
function thread(size, length, opts = {}) {
  const m = sizeOf(size, "thread");
  num(length, "thread length", { positive: true });
  const d = m ? m.d : size;
  const pitch = num(opts.pitch ?? m?.pitch ?? fail("thread with a plain diameter needs { pitch }, or use a size like \"M10\""), "thread pitch", { positive: true });
  if (pitch > d / 3) fail(`thread pitch ${pitch} is too coarse for diameter ${d}`);
  const ch = opts.chamfer ?? true;
  return new Shape(threadNode(d / 2, pitch, -length / 2, length / 2, { left: Boolean(opts.left), chamfer: [ch, ch] }));
}

// A hole to cut away, going down from z = 0 (put it at the surface, then cut).
// hole("M6", 12): clearance hole for an M6 bolt. hole(5, 12): 5 mm drill.
// Options: tapped (threaded, for a metric size), cbore (true for a socket head,
// or [diameter, depth]), csink (true for a flat head, or a diameter; 90°),
// tip (a 118° drill point at the bottom; default on for tapped holes).
function hole(size, depth, opts = {}) {
  const m = sizeOf(size, "hole");
  num(depth, "hole depth", { positive: true });
  if (typeof opts !== "object" || opts === null) fail("hole options must be { tapped, cbore, csink, tip }");
  if ((opts.tapped || opts.cbore === true || opts.csink === true) && !m) fail("hole tapped, cbore: true and csink: true need a metric size like \"M6\"; give cbore: [diameter, depth] or csink: diameter for a plain hole");
  const c = [];
  const above = Math.max(1, (m ? m.d : size) / 2);
  let r;
  if (opts.tapped) {
    r = threadRoot(m.d / 2, m.pitch);
    c.push(threadNode(m.d / 2 + 0.02 * m.pitch, m.pitch, -depth, above));
  } else {
    r = (m ? m.clearance : size) / 2;
    c.push(cylZ(r, -depth, above));
  }
  if (opts.tip ?? opts.tapped) c.push(coneZ(0, r, -depth - r / Math.tan(59 * DEG), -depth));
  if (opts.cbore) {
    const [D, dd] = opts.cbore === true ? [m.cbore.d, m.cbore.depth] : Array.isArray(opts.cbore) && opts.cbore.length === 2 ? opts.cbore.map((v) => num(v, "hole cbore", { positive: true })) : fail("hole cbore must be true or [diameter, depth]");
    if (D / 2 <= r) fail(`hole cbore diameter ${D} must be larger than the hole (${R5(r * 2)})`);
    c.push(cylZ(D / 2, -dd, above));
  }
  if (opts.csink) {
    const D = opts.csink === true ? m.flat.d : num(opts.csink, "hole csink", { positive: true });
    if (D / 2 <= r) fail(`hole csink diameter ${D} must be larger than the hole (${R5(r * 2)})`);
    c.push(coneZ(r, D / 2, -(D / 2 - r), 0), cylZ(D / 2, 0, above));
  }
  return new Shape({ t: "union", c });
}

// A bolt standing on z = 0 with its shank going down: hex head (default),
// socket head or flat (countersunk) head. The head sits on z = 0, except a flat
// head, whose top is at z = 0 (flush in a csink hole). length is the shank
// (the whole bolt for a flat head). thread: false draws the shank smooth.
function bolt(size, length, opts = {}) {
  const m = metric(size);
  num(length, "bolt length", { positive: true });
  if (typeof opts !== "object" || opts === null) fail("bolt options must be { head, thread }");
  const head = opts.head ?? "hex";
  const R = m.d / 2;
  const c = [];
  let top = 0; // where the shank starts
  if (head === "hex") c.push(chamferedHex(m.hex.s, 0, m.hex.k, false));
  else if (head === "socket") {
    const key = { t: "move", v: [0, 0, R5(m.socket.k)], c: { t: "extrude", p: { t: "poly2", pts: hexPts(m.socket.key) }, h: R5(m.socket.k * 1.2) } };
    c.push({ t: "subtract", a: zmove(m.socket.k / 2, { t: "cylinder", r: m.socket.d / 2, h: m.socket.k, round: R5(m.socket.k * 0.08) }), b: [key] });
  } else if (head === "flat") {
    top = -m.flat.k;
    if (length <= m.flat.k) fail(`bolt length ${length} is shorter than its flat head (${m.flat.k})`);
    const key = { t: "move", v: [0, 0, 0], c: { t: "extrude", p: { t: "poly2", pts: hexPts(m.flat.key) }, h: R5(m.flat.k * 1.2) } };
    c.push({ t: "subtract", a: coneZ(R, m.flat.d / 2, top, 0), b: [key] });
  } else fail(`bolt head must be "hex", "socket" or "flat", got ${what(head)}`);
  // Threaded all the way to the head, as screws for tapped holes are.
  c.push(threadNode(R, m.pitch, -length, top + 0.01, { chamfer: [true, false], ...(opts.thread === false ? { plain: true } : {}) }));
  return new Shape({ t: "union", c });
}
// A hex nut standing on z = 0, threaded through. Under a part, turn it over: .rotateX(180).
function nut(size) {
  const m = metric(size);
  return new Shape({ t: "subtract", a: chamferedHex(m.nut.s, 0, m.nut.m, true), b: [threadNode(m.d / 2 + 0.02 * m.pitch, m.pitch, -1, m.nut.m + 1)] });
}
// A flat washer standing on z = 0.
function washer(size) {
  const m = metric(size);
  return new Shape({ t: "subtract", a: cylZ(m.washer.D / 2, 0, m.washer.h), b: [cylZ(m.washer.d / 2, -1, m.washer.h + 1)] });
}
function revolve(p, angle = 360) {
  num(angle, "revolve angle", { positive: true });
  if (angle > 360) fail(`revolve angle must be at most 360, got ${angle}`);
  if (Array.isArray(p)) {
    const pts = points2(p, "revolve");
    pts.forEach(([r], i) => r < 0 && fail(`revolve point ${i} has a negative radius ${r}; use [radius, z] with radius >= 0`));
    return new Shape(angle < 360 ? { t: "revolve", pts, angle } : { t: "revolve", pts });
  }
  const node = profileNode(p, "revolve");
  return new Shape(angle < 360 ? { t: "revolve", p: node, angle } : { t: "revolve", p: node });
}

// sweep(profile, path, { smooth, closed, twist, up })
// path: [[x, y, z], ...] (smoothed through the points unless smooth: false),
// helix(...), an open path(...) in the XY plane, or a closed one (a profile
// made with path(...).close() or polygon) for a ring.
function sweep(profile, through, opts = {}) {
  const p = profileNode(profile, "sweep profile");
  if (typeof opts !== "object" || opts === null) fail("sweep options must be { smooth, closed, twist, up }");
  let pts, closed = Boolean(opts.closed), dense = false;
  if (through instanceof Path) (pts = through.pts.map(([x, y]) => [x, y, 0])), (dense = true);
  else if (through instanceof Profile && through.node.t === "poly2") (pts = through.node.pts.map(([x, y]) => [x, y, 0])), (closed = true), (dense = true);
  else if (Array.isArray(through)) {
    if (through.length < 2) fail("sweep path needs at least 2 points [[x, y, z], ...]");
    pts = through.map((q, i) => vec(q, `sweep path point ${i}`));
  } else fail(`sweep path must be points [[x, y, z], ...], helix(...) or path(...), got ${what(through)}`);
  pts = pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1], q[2] - pts[i - 1][2]) > 1e-9);
  if (closed && pts.length > 2 && Math.hypot(...pts[0].map((v, i) => v - pts.at(-1)[i])) < 1e-9) pts.pop();
  if (pts.length < 2) fail("sweep path points must not all be the same");
  const smooth = opts.smooth ?? !dense;
  if (smooth && pts.length > 2) {
    // Enough points per span to follow the curve closely.
    pts = catmull(pts, closed, (a, b) => Math.min(24, Math.max(2, Math.ceil(Math.hypot(...a.map((v, i) => v - b[i])) / 2))));
  }
  if (pts.length > 40000) fail("sweep path is too long or too finely divided (over 40000 points)");
  const node = { t: "sweep", p, path: pts.map((q) => q.map(R5)), closed };
  if (opts.twist !== undefined) node.twist = num(opts.twist, "sweep twist");
  if (opts.up !== undefined) node.up = vec(opts.up, "sweep up");
  return new Shape(node);
}

// loft([[z, profile], ...], { smooth }): a solid through profiles at heights z.
function loft(sections, opts = {}) {
  if (!Array.isArray(sections) || sections.length < 2) fail("loft needs at least 2 sections: loft([[z, profile], [z, profile], ...])");
  const s = sections.map((q, i) => {
    if (!Array.isArray(q) || q.length !== 2) fail(`loft section ${i} must be [z, profile], got ${what(q)}`);
    return { z: num(q[0], `loft section ${i} height`), p: profileNode(q[1], `loft section ${i}`) };
  });
  for (let i = 1; i < s.length; i++) if (!(s[i].z > s[i - 1].z)) fail(`loft section heights must increase: section ${i} is at ${s[i].z}, after ${s[i - 1].z}`);
  return new Shape({ t: "loft", s, smooth: opts.smooth ?? true });
}

// A smooth tube through points [[x, y, z, radius], ...]: round cones joined end to end.
function tube(pts, smooth = 0) {
  if (!Array.isArray(pts) || pts.length < 2) fail("tube needs at least 2 points [[x, y, z, radius], ...]");
  const p = pts.map((q, i) => {
    if (!Array.isArray(q) || q.length !== 4) fail(`tube point ${i} must be [x, y, z, radius], got ${what(q)}`);
    return [num(q[0], "tube x"), num(q[1], "tube y"), num(q[2], "tube z"), num(q[3], "tube radius", { positive: true })];
  });
  const segs = [];
  for (let i = 1; i < p.length; i++) segs.push({ t: "capsule", a: p[i - 1].slice(0, 3), b: p[i].slice(0, 3), r1: p[i - 1][3], r2: p[i][3] });
  // smooth is a blend radius; true/false (as sweep and loft take it) mean a
  // gentle blend of half the thinnest radius, or none.
  const k = smooth === true ? Math.min(...p.map((q) => q[3])) / 2 : smooth === false ? 0 : num(smooth, "tube smooth", { nonneg: true });
  return new Shape({ t: "union", c: segs, k });
}

// The convex hull of shapes: the smallest convex solid around them all, like
// a skin stretched over them. Found from a fine mesh of the shapes: the
// points that reach furthest in 2000 directions. Recent hulls are kept, so
// re-running a script is quick.
const HULL_DIRS = 2000;
const hullCache = new Map();

// The vertices of P (packed x, y, z) that can be furthest in some
// direction. Most of a mesh's vertices lie inside, or on the surface of, the
// hull of its furthest vertices in 96 directions, and those never are.
function candidates(P) {
  const rough = new Set();
  for (const [x, y, z] of hullDirections(96)) {
    let best = -Infinity, at = 0;
    for (let i = 0; i < P.length; i += 3) {
      const v = x * P[i] + y * P[i + 1] + z * P[i + 2];
      if (v > best) (best = v), (at = i);
    }
    rough.add(at);
  }
  let planes;
  try {
    planes = convexHullPlanes([...rough].map((i) => [P[i], P[i + 1], P[i + 2]]));
  } catch {
    return P; // flat or tiny: keep every vertex
  }
  let size = 1;
  for (let i = 0; i < P.length; i++) size = Math.max(size, Math.abs(P[i]));
  const tol = 1e-6 * size;
  const out = [];
  for (const i of rough) out.push(P[i], P[i + 1], P[i + 2]);
  for (let i = 0; i < P.length; i += 3) {
    if (rough.has(i)) continue;
    for (const n of planes)
      if (n[0] * P[i] + n[1] * P[i + 1] + n[2] * P[i + 2] - n[3] > tol) {
        out.push(P[i], P[i + 1], P[i + 2]);
        break;
      }
  }
  return Float64Array.from(out);
}

function hull(...args) {
  const { nodes } = shapesAndSmooth(args, "hull");
  if (!nodes.length) fail("hull needs at least one shape");
  const key = JSON.stringify(nodes);
  let pts = hullCache.get(key);
  if (!pts) {
    const { f, box } = compile(nodes.length === 1 ? nodes[0] : { t: "union", c: nodes });
    if (isEmptyBox(box)) fail("hull of nothing: the shapes are empty");
    const P = meshSDF(f, box, { budget: 30000 }).positions;
    if (!P.length) fail("hull of nothing: the shapes are empty");
    const picked = new Set();
    const C = candidates(P);
    for (const [x, y, z] of hullDirections(HULL_DIRS)) {
      let best = -Infinity, at = 0;
      for (let i = 0; i < C.length; i += 3) {
        const v = x * C[i] + y * C[i + 1] + z * C[i + 2];
        if (v > best) (best = v), (at = i);
      }
      picked.add(at);
    }
    pts = [...picked].map((i) => [R5(C[i]), R5(C[i + 1]), R5(C[i + 2])]);
    hullCache.set(key, pts);
    if (hullCache.size > 50) hullCache.delete(hullCache.keys().next().value);
  }
  try {
    compile({ t: "hull", pts });
  } catch (err) {
    fail(err.message);
  }
  return new Shape({ t: "hull", pts });
}

// The box around a shape or profile: { min, max, size }, in mm. For
// placing things (how long is this text, how tall is this part). It can be
// a little larger than the shape after rotations and smooth blends.
function bounds(x) {
  if (x instanceof Profile) {
    const b = compile2(x.node).box;
    return { min: [R5(b[0]), R5(b[1])], max: [R5(b[2]), R5(b[3])], size: [R5(b[2] - b[0]), R5(b[3] - b[1])] };
  }
  const b = compile(shapeNode(x, "bounds")).box;
  if (isEmptyBox(b)) fail("bounds of an empty shape");
  return { min: b.slice(0, 3).map(R5), max: b.slice(3).map(R5), size: [0, 1, 2].map((i) => R5(b[i + 3] - b[i])) };
}

function union(...args) {
  const { nodes, k } = shapesAndSmooth(args, "union");
  if (!nodes.length) fail("union needs at least one shape");
  return new Shape({ t: "union", c: nodes, k });
}
function subtract(...args) {
  const { nodes, k } = shapesAndSmooth(args, "subtract");
  if (nodes.length < 2) fail("subtract needs a shape and at least one shape to cut away");
  return new Shape({ t: "subtract", a: nodes[0], b: nodes.slice(1), k });
}
// A solid from its outlines in up to three views, the way a body is drawn on
// paper: side (the outline's x is world X, its y is world Z), top (x is X,
// y is Y) and front (x is Y, y is Z). Each outline is pushed
// straight through the others and the solid is what all of them share; any
// two views are enough. smooth rounds the edges where the views meet.
function views(v, smooth) {
  if (typeof v !== "object" || v === null || Array.isArray(v) || v instanceof Shape || v instanceof Profile)
    fail("views expects outlines by view, like views({ side: path(...).close(), top: ..., front: ... })");
  const known = ["side", "top", "front"], shaping = ["round", "belly", "tumble", "stations"];
  for (const k of Object.keys(v)) if (!known.includes(k) && !shaping.includes(k)) fail(`views: unknown option "${k}"; the views are side, top and front, and round, belly, tumble and stations shape a rounded body`);
  if (shaping.some((k) => v[k] !== undefined)) {
    if (v.round === undefined) fail("views: belly, tumble and stations go with round");
    return roundViews(v); // already round: smooth has nothing to round
  }
  const given = known.filter((k) => v[k] !== undefined);
  if (given.length < 2) fail("views needs at least two of side, top and front");
  let L = 1;
  for (const k of given) {
    const b = compile2(profileNode(v[k], `views ${k}`)).box;
    if (!(b[2] > b[0] && b[3] > b[1])) fail(`views: the ${k} outline is empty`);
    L = Math.max(L, ...b.map(Math.abs));
  }
  const H = 4 * L;
  const slabs = [];
  if (v.side) slabs.push(extrude(v.side, H).rotateX(90));
  if (v.top) slabs.push(extrude(v.top, H));
  if (v.front) slabs.push(extrude(v.front, H).rotateX(90).rotateZ(90));
  return smooth === undefined ? intersect(...slabs) : intersect(...slabs, num(smooth, "views smooth", { nonneg: true }));
}

// views({ side, top, round }): a body along X from its side outline (x, z)
// and top outline (x, y), with rounded cross-sections instead of the
// box-like ones the plain views() gives: at each
// station the section is a superellipse as tall as the side outline and as
// wide as the top outline there. round sets its shape (2 an oval, 3 a soft
// box, 5 or more nearly square), belly the lower half's (default round), and
// tumble how much the upper half narrows towards the top (0 to 0.4, as a
// cabin's sides lean in). Each can be one number or a table [[x, value], ...]
// so a cabin can flow into an oval tail cone and a round boom.
const BODY_POINTS = 64;
function roundViews(v) {
  if (v.front) fail("views with round uses the side and top outlines only; leave out front (round sets the cross-section instead)");
  if (!v.side || !v.top) fail("views with round needs both a side outline (x, z) and a top outline (x, y)");
  const side = compile2(profileNode(v.side, "views side")), top = compile2(profileNode(v.top, "views top"));
  const x0 = Math.max(side.box[0], top.box[0]), x1 = Math.min(side.box[2], top.box[2]);
  if (!(x1 > x0)) fail("views: the side and top outlines do not overlap along X");
  const L = x1 - x0;
  const table = (val, name, dflt) => {
    if (val === undefined) return () => dflt;
    if (typeof val === "number") {
      num(val, `views ${name}`);
      return () => val;
    }
    if (!Array.isArray(val) || val.length < 1) fail(`views ${name} must be a number or a table [[x, value], ...]`);
    const t = val.map((q, i) => {
      if (!Array.isArray(q) || q.length !== 2) fail(`views ${name} entry ${i} must be [x, value], got ${what(q)}`);
      return [num(q[0], `views ${name} x`), num(q[1], `views ${name} value`)];
    }).sort((a, b) => a[0] - b[0]);
    return (x) => {
      if (x <= t[0][0]) return t[0][1];
      for (let i = 1; i < t.length; i++) if (x <= t[i][0]) return t[i - 1][1] + ((t[i][1] - t[i - 1][1]) * (x - t[i - 1][0])) / (t[i][0] - t[i - 1][0]);
      return t[t.length - 1][1];
    };
  };
  const round = table(v.round, "round", 3), belly = table(v.belly, "belly", undefined), tumble = table(v.tumble, "tumble", 0);
  const stations = Math.round(num(v.stations ?? 40, "views stations", { positive: true }));
  if (stations < 4 || stations > 200) fail("views stations must be between 4 and 200");
  // The outline's extent across a vertical line at x: [low, high] or null.
  const span = (o, x) => {
    const lo0 = o.box[1], hi0 = o.box[3], N = 256;
    let first = -1, last = -1;
    for (let i = 0; i <= N; i++) {
      if (o.f(x, lo0 + ((hi0 - lo0) * i) / N) < 0) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first < 0) return null;
    const edge = (inside, outside) => {
      let a = inside, b = outside;
      for (let k = 0; k < 30; k++) {
        const m = (a + b) / 2;
        if (o.f(x, m) < 0) a = m;
        else b = m;
      }
      return a;
    };
    const at = (i) => lo0 + ((hi0 - lo0) * i) / N;
    return [first > 0 ? edge(at(first), at(first - 1)) : at(0), last < N ? edge(at(last), at(last + 1)) : at(N)];
  };
  const minSize = L * 0.002;
  const secs = [];
  for (let i = 0; i <= stations; i++) {
    // Closer together near the ends, where the shape changes fastest.
    const x = x0 + L * (0.002 + 0.996 * (1 - Math.cos((Math.PI * i) / stations)) / 2);
    const s = span(side, x), w = span(top, x);
    if (!s || !w) continue;
    const zc = (s[0] + s[1]) / 2, b = Math.max((s[1] - s[0]) / 2, minSize), yc = (w[0] + w[1]) / 2, a = Math.max((w[1] - w[0]) / 2, minSize);
    const nUp = Math.max(1.2, round(x)), nLo = Math.max(1.2, belly(x) ?? nUp), th = Math.min(Math.max(tumble(x), 0), 0.9);
    const pts = [];
    for (let k = 0; k < BODY_POINTS; k++) {
      const t = (k / BODY_POINTS) * 2 * Math.PI, c = Math.cos(t), sn = Math.sin(t), n = sn >= 0 ? nUp : nLo;
      const zz = b * Math.sign(sn) * Math.abs(sn) ** (2 / n);
      let yy = a * Math.sign(c) * Math.abs(c) ** (2 / n);
      if (zz > 0) yy *= 1 - th * (zz / b) ** 2;
      pts.push([yc + yy, zc + zz]);
    }
    secs.push([x, outline(pts)]);
  }
  if (secs.length < 2) fail("views: the side and top outlines share too little length to make a body");
  return loft(secs).rotateY(90).rotateX(90);
}

function intersect(...args) {
  const { nodes, k } = shapesAndSmooth(args, "intersect");
  if (nodes.length < 2) fail("intersect needs at least two shapes");
  return new Shape({ t: "intersect", c: nodes, k });
}

const API_NAMES = ["box", "sphere", "ellipsoid", "cylinder", "cone", "capsule", "torus", "extrude", "revolve", "tube", "circle", "rect", "polygon", "path", "airfoil", "text", "helix", "sweep", "loft", "views", "hull", "bounds", "thread", "hole", "bolt", "nut", "washer", "metric", "union", "subtract", "intersect", "part", "param", "title", "print", "turn", "slide", "link", "still", "where", "joint", "loop"];
const DEG = Math.PI / 180;
// A joint may open by this much (mm) over the loop before it is reported.
export const JOINT_TOLERANCE_MM = 1;
// Globals a model script has no business touching inside the worker.
// How a part's surface is drawn. Without one the view picks from the colour.
const MATERIALS = ["metal", "paint", "plastic", "rubber", "glass"];
const BLOCKED = ["self", "globalThis", "window", "fetch", "importScripts", "XMLHttpRequest", "WebSocket", "postMessage", "close", "indexedDB", "caches", "Worker", "Function"];

let lineOffset = null;
function scriptLine(err) {
  if (lineOffset === null) {
    try {
      new Function(`throw new Error("probe")\n//# sourceURL=model.js`)();
    } catch (e) {
      lineOffset = (rawLine(e) ?? 1) - 1;
    }
  }
  const l = rawLine(err);
  return l == null ? null : l - lineOffset;
}
function rawLine(err) {
  const m = String(err?.stack ?? "").match(/model\.js:(\d+)/);
  if (m) return Number(m[1]);
  return typeof err?.line === "number" ? err.line : null;
}

// values: { label: number } overrides from the sliders.
export function runScript(source, values = {}) {
  const parts = [];
  const params = [];
  const prints = [];
  const joints = [];
  let modelTitle = "";
  let loopSeconds = null;
  let sampler = null; // set once the script has run, so where() works inside motion
  let movingPart = null; // whose motion function is running
  const stretch = new Map(); // part -> largest link stretch, mm
  let usesWhere = false;
  const poses = makePoseApi({
    num,
    vec,
    fail,
    what,
    onLink(d) {
      if (movingPart) stretch.set(movingPart, Math.max(stretch.get(movingPart) ?? 0, d));
    },
  });

  function part(name, shape, opts = {}) {
    if (typeof name !== "string" || !name.trim()) fail(`part needs a name as its first argument, got ${what(name)}`);
    if (parts.some((p) => p.name === name)) fail(`There are two parts named "${name}"; part names must be unique`);
    const node = shapeNode(shape, `part "${name}"`);
    if (opts === null || typeof opts !== "object") fail(`part "${name}" options must be an object`);
    let color = opts.color ?? PALETTE[parts.length % PALETTE.length];
    if (typeof color !== "string" || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) fail(`part "${name}" color must look like "#7a8590", got ${what(color)}`);
    const material = opts.material ?? null;
    if (material !== null && !MATERIALS.includes(material)) fail(`part "${name}" material must be one of ${MATERIALS.join(", ")}, got ${what(material)}`);
    const motion = []; // a description, for get_model
    const own = []; // t -> pose matrix, applied in order
    if (opts.spin) {
      const s = opts.spin;
      const m = { type: "spin", axis: poses.axisVec(s.axis ?? "z", `part "${name}" spin axis`), center: vec(s.center ?? [0, 0, 0], `part "${name}" spin center`), rpm: num(s.rpm ?? 60, `part "${name}" spin rpm`) };
      motion.push(m);
      own.push((t) => poses.turn(m.rpm * 6 * t, m.axis, m.center).m);
    }
    if (opts.swing) {
      const s = opts.swing;
      const m = { type: "swing", axis: poses.axisVec(s.axis ?? "z", `part "${name}" swing axis`), center: vec(s.center ?? [0, 0, 0], `part "${name}" swing center`), angle: num(s.angle ?? 30, `part "${name}" swing angle`), seconds: num(s.seconds ?? 2, `part "${name}" swing seconds`, { positive: true }) };
      motion.push(m);
      own.push((t) => poses.turn(m.angle * Math.sin((2 * Math.PI * t) / m.seconds), m.axis, m.center).m);
    }
    if (opts.motion !== undefined) {
      if (typeof opts.motion !== "function") fail(`part "${name}" motion must be a function of time, like t => turn(t * 90, "z"), got ${what(opts.motion)}`);
      const f = opts.motion;
      motion.push({ type: "custom" });
      own.push((t) => {
        const was = movingPart;
        movingPart = name;
        try {
          return poses.isPose(f(t), `part "${name}" motion`);
        } finally {
          movingPart = was;
        }
      });
    }
    let follow = null;
    if (opts.follow !== undefined) {
      if (typeof opts.follow !== "string" || !opts.follow) fail(`part "${name}" follow must be the name of another part, got ${what(opts.follow)}`);
      if (opts.follow === name) fail(`part "${name}" cannot follow itself`);
      follow = opts.follow;
      motion.push({ type: "follow", part: follow });
    }
    parts.push({ name, color, material, motion, own, follow, node, hidden: opts.hidden === true });
  }

  function param(label, value, opts = {}) {
    if (typeof label !== "string" || !label.trim()) fail("param needs a label as its first argument");
    num(value, `param "${label}" default`);
    const min = num(opts.min ?? (value > 0 ? 0 : value * 2 || -100), `param "${label}" min`);
    const max = num(opts.max ?? (value > 0 ? value * 2 : value === 0 ? 100 : 0), `param "${label}" max`);
    if (!(min < max)) fail(`param "${label}" needs min < max`);
    const step = num(opts.step ?? niceStep(max - min), `param "${label}" step`, { positive: true });
    const partName = opts.part == null ? null : String(opts.part);
    if (params.some((p) => p.label === label && p.part === partName)) fail(`param "${label}" is declared twice`);
    const key = partName ? `${partName} / ${label}` : label;
    const raw = typeof values[key] === "number" ? values[key] : value;
    const v = Math.min(Math.max(raw, min), max);
    params.push({ key, label, part: partName, value: v, default: value, min, max, step });
    return v;
  }

  const title = (t) => (modelTitle = String(t));
  // Where a point, given at rest on a part, is at time t (inside motion functions).
  function where(partName, point, t) {
    usesWhere = true;
    if (!sampler) fail("where() works inside a part's motion function, like motion: t => link(a, b, where(\"Arm\", a, t), b)");
    if (typeof partName !== "string") fail(`where() needs a part name first, got ${what(partName)}`);
    const p = vec(point, "where point");
    const m = sampler.world(partName, num(t, "where time"));
    return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
  }
  // Declares that a point (at rest) belongs to both parts; the app checks it
  // stays together over the whole loop.
  function joint(a, b, point) {
    if (typeof a !== "string" || typeof b !== "string") fail("joint needs two part names and a point: joint(\"Link\", \"Horn\", [x, y, z])");
    joints.push({ a, b, point: vec(point, `joint "${a}"-"${b}" point`) });
  }
  const loop = (seconds) => (loopSeconds = num(seconds, "loop seconds", { positive: true }));
  const print = (...a) => prints.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));

  const api = { box, sphere, ellipsoid, cylinder, cone, capsule, torus, extrude, revolve, tube, circle, rect, polygon, path, airfoil, text, helix, sweep, loft, views, hull, bounds, thread, hole, bolt, nut, washer, metric, union, subtract, intersect, part, param, title, print, turn: poses.turn, slide: poses.slide, link: poses.link, still: poses.still, where, joint, loop };
  try {
    // In its own block, so the script may reuse a built-in name (const hole = ...).
    const fn = new Function(...API_NAMES, ...BLOCKED, `"use strict"; {\n${source}\n}\n//# sourceURL=model.js`);
    fn(...API_NAMES.map((n) => api[n]), ...BLOCKED.map(() => undefined));
  } catch (err) {
    const line = scriptLine(err);
    // "use strict" adds one line before the script.
    const where = line != null ? `Line ${line - 1}: ` : "";
    return { error: `${where}${err?.message ?? err}`, params, prints };
  }
  if (!parts.length) return { error: 'The script made no parts. Call part("Name", shape) for each visible piece.', params, prints };

  // ---- motion: sample every moving part over the loop, check joints ----
  for (const j of joints) for (const n of [j.a, j.b]) if (!parts.some((p) => p.name === n)) return { error: `joint names part "${n}", but there is no part with that name`, params, prints };
  const loopLen = loopSeconds ?? defaultLoop(parts.flatMap((p) => p.motion.filter((m) => m.type === "spin" || m.type === "swing")));
  let sampled;
  try {
    sampled = sampleMotion(parts, {
      loop: loopLen,
      joints,
      bind: (world) => (sampler = { world }),
      onError(fn, partName) {
        try {
          return fn();
        } catch (err) {
          if (err instanceof MotionError) throw err;
          const line = scriptLine(err);
          throw new MotionError(`${line != null ? `Line ${line - 1}: ` : ""}in the motion of part "${partName}": ${err?.message ?? err}`);
        }
      },
    });
  } catch (err) {
    return { error: String(err?.message ?? err), params, prints };
  }
  const jointReport = joints.map((j, k) => ({ a: j.a, b: j.b, point: j.point, max_gap_mm: Math.round(sampled.gaps[k] * 100) / 100 }));

  const warnings = [];
  const unknownPart = params.filter((p) => p.part && !parts.some((q) => q.name === p.part));
  for (const p of unknownPart) warnings.push(`param "${p.label}" belongs to part "${p.part}", but there is no part with that name`);
  for (const p of parts) {
    try {
      p.box = compile(p.node).box;
    } catch (err) {
      return { error: `part "${p.name}": ${err.message}`, params, prints };
    }
    if (isEmptyBox(p.box)) warnings.push(`part "${p.name}" is empty (everything was cut away or intersected to nothing)`);
    p.hash = JSON.stringify(p.node);
  }
  const links = [...stretch].map(([part, d]) => ({ part, max_stretch_mm: Math.round(d * 100) / 100 }));
  for (const l of links) {
    if (l.max_stretch_mm > JOINT_TOLERANCE_MM) warnings.push(`part "${l.part}" is a link() whose ends move up to ${l.max_stretch_mm} mm further apart or closer than its length, so it comes off one end during the motion; work the motions out so both ends stay its length apart`);
  }
  if ((links.length || usesWhere) && !joints.length) warnings.push("parts are linked with link() or where(), but no joint() is declared. Declare a joint at every pin, ball joint and rod end so the app can check the mechanism stays together.");
  for (const j of jointReport) {
    if (j.max_gap_mm > JOINT_TOLERANCE_MM) warnings.push(`joint between "${j.a}" and "${j.b}" at [${j.point.join(", ")}] comes apart by up to ${j.max_gap_mm} mm during the motion; make the parts' motions agree (link() and where() keep linked parts together)`);
  }
  const out = parts.map(({ own, ...p }) => ({ ...p, frames: sampled.frames.get(p.name) ?? null }));
  const motion = sampled.count ? { loop: loopLen, frames: sampled.count, joints: jointReport, links } : null;
  // joints also go on their own, so the fit check leaves their overlap out in a model that does not move.
  return { title: modelTitle, parts: out, params, prints, warnings, motion, joints: jointReport };
}

function niceStep(range) {
  const raw = range / 200;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw);
}
