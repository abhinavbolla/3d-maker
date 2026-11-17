// Buildings in a model script: outer walls round a footprint, inner walls
// (partitions) that join them, doors and windows cut into named walls, rooms
// named by a point inside them, a floor slab and a roof.
//
// The script only records what it is given; everything is worked out when
// the script has run (finish), so the order of the calls does not matter.
// Each piece becomes an ordinary part (shape tree, name, colour, material),
// so the view, the exports, fit checks and measurements treat a house like
// any other model. What a floor plan needs to know besides the solids (which
// wall is which, where each opening is and which way a door opens, the
// rooms and their areas) goes back with the result as plain data.
//
// Units are millimetres, as everywhere. Plans are in the XY plane, +Z up;
// north is +Y unless house({ north }) turns it.
import { compile2 } from "./sdf.js";
import { contour, loopsArea } from "./drawing.js";

const { abs, min, max, sqrt, hypot, atan2, cos, sin, tan, PI, round, ceil } = Math;
const DEG = PI / 180;
const R5 = (v) => round(v * 1e5) / 1e5;
const R1 = (v) => round(v * 10) / 10;

// The script functions this adds, in the order they are passed to scripts.
export const BUILDING_NAMES = ["house", "outerWalls", "wall", "door", "window", "room", "roof", "stair"];

// Defaults, in mm: wall height (floor to the top of the walls), outer and
// inner wall thickness, floor slab thickness, and the plan's cut height
// above the floor.
const DEFAULTS = { height: 2700, wall: 300, partition: 100, slab: 200, cut: 1200, north: 0 };
const DOOR = { width: 900, height: 2100 };
const WINDOW = { width: 1200, height: 1200, sill: 900 };
// Door lining: jambs and head this wide; the leaf this thick.
const LINING = 50, LEAF = 40;
// Window frame: this wide and deep, the glazing unit this thick, the frame's
// middle this far into the wall from its outer face (a share of the wall).
const FRAME_W = 60, FRAME_D = 70, GLASS = 24, SET_IN = 0.35;

const COLORS = {
  slab: ["#a7a39b", "plastic"],
  outer: ["#ebe5d8", "paint"],
  inner: ["#f4f1ea", "paint"],
  frame: ["#f5f4f0", "paint"],
  leaf: ["#efebe2", "paint"],
  frontLeaf: ["#2f4d5c", "paint"],
  windowFrame: ["#3d4247", "paint"],
  glass: ["#9fc2d4", "glass"],
  roof: ["#8a4a3a", "plastic"],
  stair: ["#b89870", "plastic"],
};

// ---- plain 2D geometry ----
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => hypot(a[0], a[1]);
const unit = (a) => mul(a, 1 / (len(a) || 1));
const left = (d) => [-d[1], d[0]];
export function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += cross(pts[i], pts[(i + 1) % pts.length]);
  return s / 2;
}
// Where the lines p + t r and q + u s meet, or null if they are parallel.
function meet(p, r, q, s) {
  const d = cross(r, s);
  if (abs(d) < 1e-12) return null;
  return add(p, mul(r, cross(sub(q, p), s) / d));
}
// The polygon (counter-clockwise) with every edge moved d to its left
// (inwards), corners mitred.
function insetPolygon(P, d) {
  const n = P.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n];
    const r = unit(sub(b, a)), s = unit(sub(c, b));
    const p = add(a, mul(left(r), d)), q = add(b, mul(left(s), d));
    out.push(meet(p, r, q, s) ?? add(b, mul(left(s), d)));
  }
  return out;
}
function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign(cross(sub(q, p), sub(r, p)));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function pointInLoop(x, y, L) {
  let inside = false;
  for (let n = 0, m = L.length - 2; n < L.length; m = n, n += 2) {
    const xi = L[n], yi = L[n + 1], xj = L[m], yj = L[m + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const pointInPolygon = (p, P) => pointInLoop(p[0], p[1], P.flat());
// Distance from p to the segment ab, and how far along it (0..1) the nearest point is.
function toSegment(p, a, b) {
  const e = sub(b, a), l2 = dot(e, e) || 1;
  const t = min(max(dot(sub(p, a), e) / l2, 0), 1);
  return { d: len(sub(p, add(a, mul(e, t)))), t };
}

// The part of segment ab inside polygon Q: [from, to] or null (the first
// and last points inside; walls cross a room once).
function clipToPolygon(a, b, Q) {
  const ts = [0, 1], e = sub(b, a);
  for (let i = 0; i < Q.length; i++) {
    const q = Q[i], r = sub(Q[(i + 1) % Q.length], q), d = cross(e, r);
    if (abs(d) < 1e-12) continue;
    const t = cross(sub(q, a), r) / d, u = cross(sub(q, a), e) / d;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  let lo = null, hi = null;
  for (let i = 1; i < ts.length; i++) {
    const m = (ts[i - 1] + ts[i]) / 2;
    if (ts[i] - ts[i - 1] > 1e-9 && pointInPolygon(add(a, mul(e, m)), Q)) (lo ??= ts[i - 1]), (hi = ts[i]);
  }
  return lo === null ? null : [add(a, mul(e, lo)), add(a, mul(e, hi))];
}

// A contoured outline (from marching squares, corners cut by up to a cell)
// made exact again for outlines of straight walls: short edges at corners
// are dropped and the long edges on either side extended to meet.
// L: [x, y, ...]; returns [[x, y], ...].
export function squareLoop(L, cell) {
  const pts = [];
  for (let n = 0; n < L.length; n += 2) pts.push([L[n], L[n + 1]]);
  // Points that sit on a straight run between their neighbours go first.
  const simple = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
    const e = sub(c, a), l = len(e);
    if (l > 0 && abs(cross(e, sub(b, a))) / l < cell * 0.05 && dot(sub(b, a), e) > 0 && dot(sub(c, b), e) > 0) continue;
    simple.push(b);
  }
  // Long edges, each a line fitted through its two ends.
  const n = simple.length, edges = [];
  for (let i = 0; i < n; i++) {
    const a = simple[i], b = simple[(i + 1) % n];
    if (len(sub(b, a)) > cell * 2.5) edges.push({ a, b });
  }
  if (edges.length < 3) return simple;
  // Merge neighbouring long edges that run on in the same line.
  const merged = [];
  for (const e of edges) {
    const last = merged.at(-1);
    if (last && abs(cross(unit(sub(last.b, last.a)), sub(e.b, last.a))) < cell * 0.6 && dot(unit(sub(last.b, last.a)), unit(sub(e.b, e.a))) > 0.999) last.b = e.b;
    else merged.push({ ...e });
  }
  if (merged.length > 2) {
    const f = merged[0], l = merged.at(-1);
    if (abs(cross(unit(sub(l.b, l.a)), sub(f.b, l.a))) < cell * 0.6 && dot(unit(sub(l.b, l.a)), unit(sub(f.b, f.a))) > 0.999) {
      f.a = l.a;
      merged.pop();
    }
  }
  const out = [];
  for (let i = 0; i < merged.length; i++) {
    const p = merged[(i - 1 + merged.length) % merged.length], q = merged[i];
    const m = meet(p.a, sub(p.b, p.a), q.a, sub(q.b, q.a));
    // Parallel neighbours (a short jog between them): keep both ends.
    if (!m || len(sub(m, q.a)) > cell * 4) out.push(p.b, q.a);
    else out.push(m);
  }
  return out.map(([x, y]) => [R5(x), R5(y)]);
}

// What Claude is told about a building after each change: each wall with
// where it runs (an opening's "at" is measured along it), the rooms with
// their areas and inside sizes, and the doors and windows.
export function buildingSummary(B) {
  return {
    floor_z: B.floor_z,
    wall_top_z: B.top_z,
    walls: B.walls.map((w) => (w.kind === "outer" ? { name: w.name, outer: true, from: w.from, to: w.to, length: w.length, thickness: w.thickness } : { name: w.name, points: w.points, length_inside: w.length, thickness: w.thickness })),
    rooms: B.rooms.map((r) => ({ name: r.name, area_m2: r.area_m2, size: [R1(r.box[2] - r.box[0]), R1(r.box[3] - r.box[1])], ...(r.shared ? { same_space_as: r.shared } : {}) })),
    openings: B.openings.map((o) => ({ name: o.name, kind: o.kind, wall: o.wall, at: o.at, width: o.width, height: o.height, ...(o.kind === "window" ? { sill: o.sill } : {}) })),
    ...(B.roof ? { roof: B.roof } : {}),
  };
}

// ---- shape tree helpers (plain data, as the kernel takes it) ----
const poly = (pts) => ({ t: "poly2", pts: pts.map(([x, y]) => [R5(x), R5(y)]) });
// A profile pushed up from z0 to z1.
const prism = (p, z0, z1) => ({ t: "move", v: [0, 0, R5((z0 + z1) / 2)], c: { t: "extrude", p, h: R5(z1 - z0) } });
// A box size [along, across, up] centred at c, turned so "along" runs at
// angle `deg` in plan.
const turnedBox = (c, s, deg) => ({ t: "move", v: c.map(R5), c: deg ? { t: "rotate", deg: [0, 0, R5(deg)], c: { t: "box", s: s.map(R5), r: 0 } } : { t: "box", s: s.map(R5), r: 0 } });
const unionOf = (c) => (c.length === 1 ? c[0] : { t: "union", c, k: 0 });

// Makes the building functions for one run of a script. part: the script's
// part(); fail: its error; num: its number check.
export function makeBuilding({ part, fail, num }) {
  let settings = null, outline = null;
  const partitions = [], openings = [], rooms = [], stairs = [];
  let roofSpec = null;
  let info = null;
  const openingInfo = [];

  const opts = (o, where, keys) => {
    if (o === undefined) return {};
    if (typeof o !== "object" || o === null || Array.isArray(o)) fail(`${where} options must be an object like { ${keys.join(", ")} }`);
    for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${where}: unknown option "${k}"; the options are ${keys.join(", ")}`);
    return o;
  };
  const pts2 = (p, where, least) => {
    if (!Array.isArray(p) || p.length < least) fail(`${where} needs at least ${least} points [[x, y], ...]`);
    return p.map((q, i) => {
      if (!Array.isArray(q) || q.length !== 2) fail(`${where} point ${i} must be [x, y]`);
      return [num(q[0], `${where} point ${i} x`), num(q[1], `${where} point ${i} y`)];
    });
  };
  const nameOf = (n, where) => {
    if (typeof n !== "string" || !n.trim()) fail(`${where} needs a name first, like "Kitchen"`);
    return n.trim();
  };

  // house({ height, wall, partition, slab, cut, north })
  function house(o) {
    if (settings) fail("house() is called twice; give all its settings in one call");
    o = opts(o, "house", Object.keys(DEFAULTS));
    settings = {};
    for (const k of Object.keys(DEFAULTS)) if (o[k] !== undefined) settings[k] = num(o[k], `house ${k}`, k === "north" ? {} : k === "slab" ? { nonneg: true } : { positive: true });
  }

  // outerWalls(points, { thickness, names }): the outside corners, in order.
  function outerWalls(points, o) {
    if (outline) fail("outerWalls() is called twice; a model holds one building, drawn as one outline");
    o = opts(o, "outerWalls", ["thickness", "names"]);
    let P = pts2(points, "outerWalls", 3);
    if (hypot(...sub(P[0], P.at(-1))) < 1e-6) P = P.slice(0, -1);
    if (P.length < 3) fail("outerWalls needs at least 3 different corners");
    const area = polygonArea(P);
    if (abs(area) < 1) fail("outerWalls: the corners are all in a line");
    let names = o.names;
    if (names !== undefined && (!Array.isArray(names) || names.length !== P.length || names.some((s) => typeof s !== "string" || !s.trim()))) fail(`outerWalls names must be a list of ${P.length} names, one per side, starting with the side from the first point to the second`);
    // Counter-clockwise, so each side runs left to right seen from outside.
    if (area < 0) {
      P = P.reverse();
      // Side j now runs from old point n-1-j to n-2-j: old side n-2-j, turned round.
      if (names) names = names.map((_, j) => names[(2 * names.length - 2 - j) % names.length]);
    }
    for (let i = 0; i < P.length; i++)
      for (let j = i + 2; j < P.length; j++) if ((j + 1) % P.length !== i && segmentsCross(P[i], P[(i + 1) % P.length], P[j], P[(j + 1) % P.length])) fail("outerWalls: the outline crosses itself");
    outline = { P, thickness: o.thickness === undefined ? null : num(o.thickness, "outerWalls thickness", { positive: true }), names: names?.map((s) => s.trim()) ?? null };
  }

  // wall(name, points, { thickness }): an inner wall along its centre line.
  function wall(name, points, o) {
    name = nameOf(name, "wall");
    o = opts(o, `wall "${name}"`, ["thickness"]);
    const P = pts2(points, `wall "${name}"`, 2);
    for (let i = 1; i < P.length; i++) if (len(sub(P[i], P[i - 1])) < 1) fail(`wall "${name}" has two points in the same place`);
    if (partitions.some((w) => w.name === name)) fail(`There are two walls named "${name}"`);
    partitions.push({ name, P, thickness: o.thickness === undefined ? null : num(o.thickness, `wall "${name}" thickness`, { positive: true }) });
  }

  const KEYS = { door: ["width", "height", "hinge", "opens", "name"], window: ["width", "height", "sill", "name"] };
  function opening(kind, wallName, at, o) {
    if (typeof wallName !== "string" || !wallName.trim()) fail(`${kind} needs the name of the wall it is in first, like "South wall"`);
    num(at, `${kind} position along "${wallName}"`);
    o = opts(o, kind, KEYS[kind]);
    const d = kind === "door" ? DOOR : WINDOW;
    const width = num(o.width ?? d.width, `${kind} width`, { positive: true });
    const height = num(o.height ?? d.height, `${kind} height`, { positive: true });
    const sill = kind === "door" ? 0 : num(o.sill ?? d.sill, "window sill", { nonneg: true });
    const n = openings.filter((q) => q.kind === kind).length + 1;
    const name = o.name === undefined ? `${kind === "door" ? "Door" : "Window"} ${n}` : nameOf(o.name, `${kind} name`);
    if (openings.some((q) => q.name === name)) fail(`There are two doors or windows named "${name}"`);
    const hinge = o.hinge ?? "start";
    if (kind === "door" && hinge !== "start" && hinge !== "end") fail(`door hinge must be "start" or "end" (the end of the opening nearer the wall's start, or its far end), got ${JSON.stringify(hinge)}`);
    if (kind === "door" && o.opens !== undefined && (typeof o.opens !== "string" || !o.opens.trim())) fail('door opens must be "in", "out", "left", "right" or a room name');
    openings.push({ kind, wall: wallName.trim(), at, width, height, sill, name, hinge, opens: kind === "door" ? o.opens?.trim() ?? null : null });
  }
  const door = (w, at, o) => opening("door", w, at, o);
  const window_ = (w, at, o) => opening("window", w, at, o);

  function room(name, point) {
    name = nameOf(name, "room");
    if (!Array.isArray(point) || point.length !== 2) fail(`room "${name}" needs a point inside it, [x, y]`);
    if (rooms.some((r) => r.name === name)) fail(`There are two rooms named "${name}"`);
    rooms.push({ name, point: [num(point[0], `room "${name}" x`), num(point[1], `room "${name}" y`)] });
  }

  function roof(o) {
    if (roofSpec) fail("roof() is called twice");
    o = opts(o, "roof", ["type", "pitch", "overhang", "ridge", "thickness", "hidden", "color", "name"]);
    const type = o.type ?? "gable";
    if (type !== "gable" && type !== "flat") fail(`roof type must be "gable" or "flat", got ${JSON.stringify(type)}`);
    const pitch = num(o.pitch ?? 35, "roof pitch", { positive: true });
    if (type === "gable" && (pitch < 5 || pitch > 60)) fail(`roof pitch must be between 5 and 60 degrees, got ${pitch}`);
    if (o.ridge !== undefined && o.ridge !== "x" && o.ridge !== "y") fail('roof ridge must be "x" or "y" (the direction the ridge runs)');
    roofSpec = { type, pitch, overhang: num(o.overhang ?? (type === "flat" ? 150 : 400), "roof overhang", { nonneg: true }), ridge: o.ridge ?? null, thickness: num(o.thickness ?? (type === "flat" ? 250 : 200), "roof thickness", { positive: true }), hidden: o.hidden === true, color: o.color ?? null, name: o.name === undefined ? "Roof" : nameOf(o.name, "roof name") };
  }

  // stair(name, [x, y], { direction, width, rise, steps, going }): a straight
  // flight from the floor, its first step's front edge centred on the point.
  function stair(name, at, o) {
    name = nameOf(name, "stair");
    if (!Array.isArray(at) || at.length !== 2) fail(`stair "${name}" needs the point where its first step starts, [x, y]`);
    o = opts(o, `stair "${name}"`, ["direction", "width", "rise", "steps", "going"]);
    const dir = o.direction ?? "y";
    if (!["x", "-x", "y", "-y"].includes(dir)) fail('stair direction must be "x", "-x", "y" or "-y" (the way it climbs)');
    stairs.push({ name, at: [num(at[0], "stair x"), num(at[1], "stair y")], dir, width: num(o.width ?? 900, "stair width", { positive: true }), rise: o.rise === undefined ? null : num(o.rise, "stair rise", { positive: true }), steps: o.steps === undefined ? null : Math.round(num(o.steps, "stair steps", { positive: true })), going: num(o.going ?? 250, "stair going", { positive: true }) });
  }

  // ---- once the script has run ----
  function finish() {
    const any = outline || partitions.length || openings.length || rooms.length || roofSpec || stairs.length;
    if (!any) return;
    if (!outline) fail("outerWalls([...]) comes first: inner walls, doors, windows, rooms and the roof all belong to the outer walls round the house");
    const S = { ...DEFAULTS, ...settings };
    const T = outline.thickness ?? S.wall;
    const floorZ = S.slab, topZ = S.slab + S.height;
    const P = outline.P;
    const Q = insetPolygon(P, T);
    if (!(polygonArea(Q) > 0) || Q.some((q, i) => dot(sub(Q[(i + 1) % Q.length], q), sub(P[(i + 1) % P.length], P[i])) <= 0)) fail(`outerWalls: the walls (${T} thick) are too thick for the outline; some sides are shorter than the walls are thick`);

    // The outer walls' sides, named by the way they face.
    const north = [-sin(S.north * DEG), cos(S.north * DEG)], east = [cos(S.north * DEG), sin(S.north * DEG)];
    const COMPASS = ["North", "North-east", "East", "South-east", "South", "South-west", "West", "North-west"];
    const sides = P.map((a, i) => {
      const b = P[(i + 1) % P.length], dir = unit(sub(b, a)), out = [dir[1], -dir[0]];
      const bearing = ((atan2(dot(out, east), dot(out, north)) / DEG) % 360 + 360) % 360;
      return { a, b, dir, out, length: len(sub(b, a)), facing: COMPASS[round(bearing / 45) % 8], inner: [Q[i], Q[(i + 1) % Q.length]] };
    });
    const count = {};
    for (const s of sides) count[s.facing] = (count[s.facing] ?? 0) + 1;
    const seen = {};
    sides.forEach((s, i) => {
      seen[s.facing] = (seen[s.facing] ?? 0) + 1;
      s.name = outline.names?.[i] ?? `${s.facing} wall${count[s.facing] > 1 ? ` ${seen[s.facing]}` : ""}`;
    });
    const walls = sides.map((s) => ({ name: s.name, kind: "outer", thickness: T, side: s }));
    for (const w of partitions) {
      if (walls.some((v) => v.name === w.name)) fail(`wall "${w.name}" has the same name as one of the outer walls; name it differently`);
      walls.push({ name: w.name, kind: "inner", thickness: w.thickness ?? S.partition, P: w.P });
    }

    // Inner walls: each run a rectangle along its centre line. An end that
    // meets another wall is carried on to that wall's far face, so corners
    // and T-junctions close; the whole is clipped to the inside of the
    // outer walls, so nothing pokes into or through them.
    const inner = walls.filter((w) => w.kind === "inner");
    const runs = inner.flatMap((w) => w.P.slice(1).map((b, i) => ({ wall: w, a: w.P[i], b, i, t: w.thickness })));
    const insideQ = (p) => pointInPolygon(p, Q);
    const reach = (run, end) => {
      const p = end ? run.b : run.a, dir = unit(end ? sub(run.b, run.a) : sub(run.a, run.b));
      if (!insideQ(p) || Q.some((q, i) => toSegment(p, q, Q[(i + 1) % Q.length]).d < 1)) return 2 * T + run.t;
      let best = null;
      for (const o of runs) {
        if (o === run) continue;
        const { d, t } = toSegment(p, o.a, o.b);
        if (d > o.t / 2 + 1) continue;
        // Joined to the next run of the same wall at a bend, or to another wall.
        const n = left(unit(sub(o.b, o.a))), c = dot(dir, n);
        let e;
        if (abs(c) < 0.05) {
          // Running on in the same line: only a shared end point joins.
          if (!(t <= 1e-6 || t >= 1 - 1e-6)) continue;
          e = 0;
        } else {
          const d0 = dot(sub(p, o.a), n);
          e = (o.t / 2 - Math.sign(c) * d0) / abs(c);
        }
        best = max(best ?? 0, e);
      }
      return best ?? 0;
    };
    const rects = runs.map((r) => {
      const dir = unit(sub(r.b, r.a)), n = left(dir), h = r.t / 2;
      const a = sub(r.a, mul(dir, reach(r, false))), b = add(r.b, mul(dir, reach(r, true)));
      r.ext = clipToPolygon(a, b, Q) ?? [a, a];
      return poly([add(a, mul(n, -h)), add(b, mul(n, -h)), add(b, mul(n, h)), add(a, mul(n, h))]);
    });
    const outerProfile = { t: "subtract2", a: poly(P), b: [poly(Q)], k: 0 };
    const innerProfile = rects.length ? { t: "intersect2", c: [{ t: "union2", c: rects, k: 0 }, poly(Q)], k: 0 } : null;

    // Rooms: the open floor inside the outer walls and outside the inner
    // walls (doors closed), contoured, then made exact again.
    const qf = compile2(poly(Q)).f, pf = innerProfile ? compile2(innerProfile).f : () => Infinity;
    const free = (x, y) => max(qf(x, y), -pf(x, y));
    const qb = Q.reduce((b, [x, y]) => [min(b[0], x), min(b[1], y), max(b[2], x), max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
    const cell = max(5, max(qb[2] - qb[0], qb[3] - qb[1]) / 2000);
    const spaces = contour(free, qb, cell).map((L) => ({ L, area: loopsArea([L]) }));
    const outers = spaces.filter((s) => s.area > 0), holes = spaces.filter((s) => s.area < 0);
    const roomInfo = [];
    const warnings = [];
    const spaceOf = new Map();
    for (const r of rooms) {
      const [x, y] = r.point;
      if (free(x, y) >= 0) fail(`room "${r.name}" at [${x}, ${y}] is ${insideQ(r.point) ? "inside a wall" : "outside the house"}; give a point inside the room`);
      const s = outers.filter((o) => pointInLoop(x, y, o.L)).sort((a, b) => a.area - b.area)[0];
      if (!s) fail(`room "${r.name}" at [${x}, ${y}] is not inside the house's walls`);
      const own = holes.filter((h) => pointInLoop(h.L[0], h.L[1], s.L) && !outers.some((o) => o !== s && o.area < s.area && pointInLoop(h.L[0], h.L[1], o.L)));
      const outlineR = squareLoop(s.L, cell);
      const holeR = own.map((h) => squareLoop(h.L, cell));
      const area = polygonArea(outlineR) + holeR.reduce((a, h) => a + polygonArea(h), 0);
      if (spaceOf.has(s)) warnings.push(`rooms "${spaceOf.get(s)}" and "${r.name}" are in the same space (no wall between them), so they share one area of ${(area / 1e6).toFixed(2)} m2. Add a wall between them, or make them one room ("Kitchen / living")`);
      else spaceOf.set(s, r.name);
      const xs = outlineR.map((p) => p[0]), ys = outlineR.map((p) => p[1]);
      roomInfo.push({ name: r.name, point: r.point, outline: outlineR, holes: holeR, area_mm2: R1(area), area_m2: round(area / 1e4) / 100, box: [min(...xs), min(...ys), max(...xs), max(...ys)].map(R1), shared: spaceOf.get(s) !== r.name ? spaceOf.get(s) : null });
    }

    // Openings: where each one is along its wall, and its cut.
    const cuts = { outer: [], inner: [] };
    const placed = [];
    const parts = [];
    const extra = { outer: [] };
    for (const o of openings) {
      const w = walls.find((v) => v.name === o.wall);
      if (!w) fail(`${o.kind} "${o.name}" is in wall "${o.wall}", but there is no wall with that name. Walls: ${walls.map((v) => v.name).join(", ")}`);
      let a, dir, faceOut, t = w.thickness, segLen, from;
      if (w.kind === "outer") {
        const s = w.side;
        a = s.a;
        dir = s.dir;
        faceOut = s.out;
        segLen = s.length;
        from = 0;
        // Clear of the walls round the corners at each end.
        const lo = T + o.width / 2, hi = s.length - T - o.width / 2;
        if (o.at < lo - 1e-6 || o.at > hi + 1e-6) fail(`${o.kind} "${o.name}" (${o.width} wide) at ${o.at} along "${w.name}" runs into a corner: that wall is ${R1(s.length)} long outside, so its centre must be between ${R1(lo)} and ${R1(hi)} from the wall's left end, seen from outside`);
      } else {
        // Along the centre line from the wall's first point, on one run.
        let s0 = 0, k = -1;
        for (let i = 1; i < w.P.length; i++) {
          const l = len(sub(w.P[i], w.P[i - 1]));
          if (o.at <= s0 + l + 1e-6 || i === w.P.length - 1) {
            k = i - 1;
            break;
          }
          s0 += l;
        }
        a = w.P[k];
        dir = unit(sub(w.P[k + 1], w.P[k]));
        faceOut = left(dir);
        segLen = len(sub(w.P[k + 1], w.P[k]));
        from = s0;
        const at = o.at - s0;
        if (at - o.width / 2 < -1e-6 || at + o.width / 2 > segLen + 1e-6) fail(`${o.kind} "${o.name}" (${o.width} wide) at ${o.at} along "${w.name}" does not fit on one straight run of it: that run goes from ${R1(s0)} to ${R1(s0 + segLen)} along the wall`);
      }
      const at = o.at - from;
      for (const q of placed) if (q.wall === o.wall && abs(q.at - o.at) < (q.width + o.width) / 2 + 1e-6) fail(`${o.kind} "${o.name}" overlaps "${q.name}" in "${o.wall}"`);
      if (o.sill + o.height > S.height + 1e-6) fail(`${o.kind} "${o.name}" is ${o.sill + o.height} high (sill ${o.sill} plus ${o.height}), more than the walls (${S.height})`);
      // The opening's centre on the wall's middle line; across: from outside
      // (or the left side, for an inner wall) to the other face.
      const mid = w.kind === "outer" ? add(add(a, mul(dir, at)), mul(faceOut, -t / 2)) : add(a, mul(dir, at));
      const deg = atan2(dir[1], dir[0]) / DEG;
      const z0 = floorZ + o.sill, z1 = z0 + o.height;
      cuts[w.kind].push(turnedBox([mid[0], mid[1], (z0 + z1) / 2], [o.width, t + 40, o.height], deg));
      const facts = { kind: o.kind, name: o.name, wall: o.wall, wall_kind: w.kind, at: o.at, width: o.width, height: o.height, sill: o.sill, center: [R1(mid[0]), R1(mid[1])], dir: [R5(dir[0]), R5(dir[1])], across: [R5(-faceOut[0]), R5(-faceOut[1])], thickness: t };
      // across: from the outer (or left) face to the other one.
      const pt = (along, acr, z, s) => turnedBox([mid[0] + dir[0] * along + facts.across[0] * acr, mid[1] + dir[1] * along + facts.across[1] * acr, z], s, deg);
      if (o.kind === "door") {
        // Which side it opens to: +1 the "across" side (inside, or the
        // right side of an inner wall), -1 the other.
        let side;
        const op = o.opens ?? (w.kind === "outer" ? "in" : "left");
        if (op === "in" || op === "out") {
          if (w.kind !== "outer") fail(`door "${o.name}" is in an inner wall, so it opens "left" or "right" (seen walking along the wall from its first point) or into a named room, not "${op}"`);
          side = op === "in" ? 1 : -1;
        } else if (op === "left" || op === "right") side = op === "left" ? -1 : 1;
        else {
          const r = roomInfo.find((q) => q.name === op);
          if (!r) fail(`door "${o.name}" opens into "${op}", but there is no room with that name${roomInfo.length ? `. Rooms: ${roomInfo.map((q) => q.name).join(", ")}` : ""}`);
          const probe = add(mid, mul(facts.across, t / 2 + 50));
          const inR = (p) => pointInPolygon(p, r.outline);
          if (inR(probe)) side = 1;
          else if (inR(add(mid, mul(facts.across, -(t / 2 + 50))))) side = -1;
          else fail(`door "${o.name}" in "${o.wall}" does not open into "${op}": that room is not on either side of it`);
        }
        facts.opens = side;
        facts.hinge = o.hinge;
        facts.swing_side = op;
        const ext = w.kind === "outer";
        const [lc, lm] = ext ? COLORS.frontLeaf : COLORS.leaf;
        // Lining: two jambs and a head, as deep as the wall.
        const jw = LINING, cw = o.width - 2 * jw, ch = o.height - jw;
        const frame = [pt(-(o.width - jw) / 2, 0, (z0 + z1 - jw) / 2, [jw, t, o.height - jw]), pt((o.width - jw) / 2, 0, (z0 + z1 - jw) / 2, [jw, t, o.height - jw]), pt(0, 0, z1 - jw / 2, [o.width, t, jw])];
        // The leaf, shut, flush with the lining on the side it opens to,
        // 3 mm clear of the lining and 10 mm off the floor.
        const lw = cw - 6, lh = ch - 13, off = side * (t / 2 - LEAF / 2);
        const hingeSign = o.hinge === "start" ? -1 : 1;
        // A lever handle each side, at the latch edge, pointing to the hinge.
        const latch = -hingeSign * (lw / 2 - 70);
        const lever = (s) => [pt(latch, off + s * (LEAF / 2 + 22.5), floorZ + 1000, [22, 45, 22]), pt(latch + hingeSign * 50, off + s * (LEAF / 2 + 54), floorZ + 1000, [130, 18, 18])];
        const leaf = [pt(0, off, z0 + 10 + lh / 2, [lw, LEAF, lh]), ...lever(1), ...lever(-1)];
        facts.leaf = { width: lw, thickness: LEAF, offset: off, clear: cw };
        parts.push([`${o.name} frame`, unionOf(frame), ...COLORS.frame], [o.name, unionOf(leaf), lc, lm]);
        facts.parts = [o.name, `${o.name} frame`];
      } else {
        // Frame set into the wall from the outside (or the left face), with
        // a mullion every 1200 mm or so, glazing units in between, and a
        // sill outside.
        const depthAt = w.kind === "outer" ? -t / 2 + t * SET_IN + FRAME_D / 2 : 0;
        const panes = max(1, ceil((o.width - 2 * FRAME_W) / 1200 - 0.05));
        const fw = FRAME_W, cwid = (o.width - 2 * fw - (panes - 1) * fw) / panes, chgt = o.height - 2 * fw;
        if (cwid < 100 || chgt < 100) fail(`window "${o.name}" is too small for its frame (at least ${2 * fw + 100} mm each way)`);
        const zc = (z0 + z1) / 2;
        const frame = [pt(-(o.width - fw) / 2, depthAt, zc, [fw, FRAME_D, o.height]), pt((o.width - fw) / 2, depthAt, zc, [fw, FRAME_D, o.height]), pt(0, depthAt, z1 - fw / 2, [o.width - 2 * fw, FRAME_D, fw]), pt(0, depthAt, z0 + fw / 2, [o.width - 2 * fw, FRAME_D, fw])];
        const glass = [];
        for (let i = 0; i < panes; i++) {
          const x = -o.width / 2 + fw + cwid / 2 + i * (cwid + fw);
          glass.push(pt(x, depthAt, zc, [cwid, GLASS, chgt]));
          if (i) frame.push(pt(x - cwid / 2 - fw / 2, depthAt, zc, [fw, FRAME_D, chgt]));
        }
        if (w.kind === "outer") {
          // Sill: from the frame out past the wall's face, 30 thick, on the opening's bottom.
          const inner = depthAt - FRAME_D / 2, outer = -t / 2 - 40;
          frame.push(pt(0, (inner + outer) / 2, z0 + 15, [o.width, inner - outer, 30]));
        }
        facts.frame = { depth: R1(depthAt), frameDepth: FRAME_D, glass: GLASS, panes, frameWidth: fw };
        parts.push([`${o.name} frame`, unionOf(frame), ...COLORS.windowFrame], [`${o.name} glass`, unionOf(glass), ...COLORS.glass]);
        facts.parts = [`${o.name} frame`, `${o.name} glass`];
      }
      placed.push(o);
      facts.wall_start = [R1(a[0]), R1(a[1])];
      facts.offset_along = from;
      facts.wall_length = R1(segLen);
      openingInfo.push(facts);
    }

    // The roof, and the gable ends of the outer walls under it.
    let roofNode = null;
    if (roofSpec) {
      const R = roofSpec;
      if (R.type === "flat") {
        const ring = insetPolygon(P, -R.overhang);
        roofNode = prism(poly(ring), topZ, topZ + R.thickness);
      } else {
        // A gable roof needs a rectangle: four corners, square.
        const rect = P.length === 4 && sides.every((s, i) => abs(dot(s.dir, sides[(i + 1) % 4].dir)) < 1e-6);
        if (!rect) fail("a gable roof needs a rectangular footprint (four corners, square); for other outlines use roof({ type: \"flat\" })");
        const [s0, s1] = [sides[0], sides[1]];
        // The ridge runs along the longer side, or the axis asked for.
        let along = s0.length >= s1.length ? s0 : s1;
        if (R.ridge) along = abs(s0.dir[R.ridge === "x" ? 0 : 1]) > 0.7 ? s0 : s1;
        const across = along === s0 ? s1 : s0;
        const L = along.length, W = across.length, tp = tan(R.pitch * DEG), ov = R.overhang, th = R.thickness / cos(R.pitch * DEG);
        const c = mul(add(P[0], P[2]), 0.5);
        // Across the ridge: x from -W/2 to W/2; up: z. The underside meets
        // the outer face of the eaves walls at the top of the walls.
        const zr = topZ + (W / 2) * tp;
        const section = [[-W / 2 - ov, topZ - ov * tp], [0, zr], [W / 2 + ov, topZ - ov * tp], [W / 2 + ov, topZ - ov * tp + th], [0, zr + th], [-W / 2 - ov, topZ - ov * tp + th]];
        // Extrude along Z, then lay it down: profile y up, the extrusion along the ridge.
        const ang = atan2(along.dir[1], along.dir[0]) / DEG;
        // After rotateX(90) the extrusion runs along -Y and profile x along +X;
        // turning by ang - 90 puts the extrusion along the ridge, and profile
        // x along across.dir only if that is the ridge turned a quarter
        // clockwise; otherwise mirror the section (it is symmetric anyway).
        const lay = (p, h, shift) => ({ t: "move", v: [R5(c[0] + along.dir[0] * shift), R5(c[1] + along.dir[1] * shift), 0], c: { t: "rotate", deg: [90, 0, R5(ang - 90)], c: { t: "extrude", p, h: R5(h) } } });
        roofNode = lay(poly(section), L + 2 * ov, 0);
        const gable = poly([[-W / 2, topZ], [W / 2, topZ], [0, zr]]);
        extra.outer.push(lay(gable, T, L / 2 - T / 2), lay(gable, T, -(L / 2 - T / 2)));
        R.facts = { ridge_z: R1(zr + th), eaves_z: R1(topZ - ov * tp), ridge_dir: along.dir.map(R5), span: R1(W), length: R1(L) };
      }
    }

    // The parts, in the order a builder puts them up.
    if (S.slab > 0) part("Floor slab", { t: "move", v: [0, 0, 0], c: prism(poly(P), 0, S.slab) }, { color: COLORS.slab[0], material: COLORS.slab[1] });
    const outerSolid = unionOf([prism(outerProfile, floorZ, topZ), ...extra.outer]);
    part("Outer walls", cuts.outer.length ? { t: "subtract", a: outerSolid, b: cuts.outer, k: 0 } : outerSolid, { color: COLORS.outer[0], material: COLORS.outer[1] });
    if (innerProfile) {
      const solid = prism(innerProfile, floorZ, topZ);
      part("Inner walls", cuts.inner.length ? { t: "subtract", a: solid, b: cuts.inner, k: 0 } : solid, { color: COLORS.inner[0], material: COLORS.inner[1] });
    }
    for (const [name, node, color, material] of parts) part(name, node, { color, material });
    if (roofNode) part(roofSpec.name, roofNode, { color: roofSpec.color ?? COLORS.roof[0], material: COLORS.roof[1], hidden: roofSpec.hidden });

    // Stairs: a solid flight of steps, as cast or built up under the treads.
    const stairInfo = [];
    for (const s of stairs) {
      const rise = s.rise ?? S.height;
      const steps = s.steps ?? max(2, ceil(rise / 180));
      const r = rise / steps, g = s.going;
      const prof = [[0, 0]];
      for (let i = 0; i < steps; i++) prof.push([i * g, (i + 1) * r], [(i + 1) * g, (i + 1) * r]);
      prof.push([steps * g, max(0, steps * r - 250)], [g, 0]);
      const run = steps * g;
      const d = { x: [1, 0], "-x": [-1, 0], y: [0, 1], "-y": [0, -1] }[s.dir];
      const ang = atan2(d[1], d[0]) / DEG;
      // The profile in (along, up), extruded across: lay it down like the roof.
      const node = { t: "move", v: [R5(s.at[0]), R5(s.at[1]), R5(floorZ)], c: { t: "rotate", deg: [90, 0, R5(ang)], c: { t: "extrude", p: poly(prof), h: R5(s.width) } } };
      part(s.name, node, { color: COLORS.stair[0], material: COLORS.stair[1] });
      stairInfo.push({ name: s.name, at: s.at, dir: d, width: s.width, steps, rise: R1(r), going: g, run });
    }

    info = {
      floor_z: floorZ,
      top_z: topZ,
      height: S.height,
      cut_z: floorZ + S.cut,
      north: S.north,
      outline: P.map((p) => p.map(R1)),
      inside: Q.map((p) => p.map(R5)),
      walls: walls.map((w) =>
        w.kind === "outer"
          ? { name: w.name, kind: "outer", thickness: w.thickness, from: w.side.a.map(R1), to: w.side.b.map(R1), length: R1(w.side.length), inner_length: R1(len(sub(w.side.inner[1], w.side.inner[0]))), facing: w.side.facing, out: w.side.out.map(R5) }
          : { name: w.name, kind: "inner", thickness: w.thickness, points: w.P, length: R1(runs.filter((r) => r.wall === w).reduce((s, r) => s + len(sub(r.ext[1], r.ext[0])), 0)), runs: runs.filter((r) => r.wall === w).map((r) => ({ from: r.ext[0].map(R1), to: r.ext[1].map(R1) })) },
      ),
      openings: openingInfo,
      rooms: roomInfo,
      stairs: stairInfo,
      roof: roofSpec ? { type: roofSpec.type, pitch: roofSpec.pitch, overhang: roofSpec.overhang, ...(roofSpec.facts ?? {}) } : null,
      warnings,
    };
  }
  return {
    api: { house, outerWalls, wall, door, window: window_, room, roof, stair },
    finish,
    // The building's facts for the plan and for Claude, or null.
    info: () => info,
  };
}
