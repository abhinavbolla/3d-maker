// Runs a model script: plain JavaScript that builds shapes with the functions
// below and declares named parts and adjustable values. The result is data
// (JSON shape trees per part), so it can be meshed in parallel and cached.
import { compile, isEmptyBox } from "./sdf.js";
import { makePoseApi, sampleMotion, defaultLoop } from "./motion.js";

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
const extrude = (pts, h) => new Shape({ t: "extrude", pts: points2(pts, "extrude"), h: num(h, "extrude height", { positive: true }) });
function revolve(pts) {
  const p = points2(pts, "revolve");
  p.forEach(([r], i) => r < 0 && fail(`revolve point ${i} has a negative radius ${r}; use [radius, z] with radius >= 0`));
  return new Shape({ t: "revolve", pts: p });
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
  return new Shape({ t: "union", c: segs, k: num(smooth, "tube smooth", { nonneg: true }) });
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
function intersect(...args) {
  const { nodes, k } = shapesAndSmooth(args, "intersect");
  if (nodes.length < 2) fail("intersect needs at least two shapes");
  return new Shape({ t: "intersect", c: nodes, k });
}

const API_NAMES = ["box", "sphere", "ellipsoid", "cylinder", "cone", "capsule", "torus", "extrude", "revolve", "tube", "union", "subtract", "intersect", "part", "param", "title", "print", "turn", "slide", "link", "still", "where", "joint", "loop"];
const DEG = Math.PI / 180;
// A joint may open by this much (mm) over the loop before it is reported.
export const JOINT_TOLERANCE_MM = 1;
// Globals a model script has no business touching inside the worker.
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
    parts.push({ name, color, motion, own, follow, node, hidden: opts.hidden === true });
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

  const api = { box, sphere, ellipsoid, cylinder, cone, capsule, torus, extrude, revolve, tube, union, subtract, intersect, part, param, title, print, turn: poses.turn, slide: poses.slide, link: poses.link, still: poses.still, where, joint, loop };
  try {
    const fn = new Function(...API_NAMES, ...BLOCKED, `"use strict";\n${source}\n//# sourceURL=model.js`);
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
  return { title: modelTitle, parts: out, params, prints, warnings, motion };
}

function niceStep(range) {
  const raw = range / 200;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw);
}
