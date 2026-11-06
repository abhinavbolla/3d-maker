// Motion for model scripts: rigid poses as functions of time, parts that
// follow other parts, rigid links between moving points, and joints that are
// checked over the whole animation loop.
//
// Every part is modelled in its rest position, in world coordinates. A pose
// moves it from rest. A part that follows another is first moved by its own
// pose, then by everything its parent does: world(t) = parent(t) · own(t).
//
// Poses are 3x4 affine matrices, row-major: [r00 r01 r02 tx, r10 ... ty, r20 ... tz].

const DEG = Math.PI / 180;
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function mul(a, b) {
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
      if (c === 3) v += a[r * 4 + 3];
      o[r * 4 + c] = v;
    }
  }
  return o;
}
export const apply = (m, [x, y, z]) => [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];

function rotation(axis, rad) {
  const len = Math.hypot(...axis);
  const [x, y, z] = axis.map((v) => v / len);
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0, t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0, t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0];
}
const translation = ([x, y, z]) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
const about = (m, c) => mul(translation(c), mul(m, translation(c.map((v) => -v))));

// A pose that the script builds with turn(), slide() and link(), and chains
// with .turn(), .slide() and .then(): each step moves the result of the last.
export class Pose {
  constructor(m = ID) {
    this.m = m;
  }
  then(p) {
    if (!(p instanceof Pose)) throw new TypeError(".then() needs a pose made with turn(), slide() or link()");
    return new Pose(mul(p.m, this.m));
  }
}

// onLink(stretch) is told, for every link(), how far the rod would have to
// stretch (or shrink) to reach both ends.
export function makePoseApi({ num, vec, fail, what, onLink }) {
  const AXIS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const axisVec = (a, where) => {
    if (typeof a === "string" && AXIS[a.toLowerCase()]) return AXIS[a.toLowerCase()];
    const v = vec(a, where);
    if (!Math.hypot(...v)) fail(`${where} must not be [0, 0, 0]`);
    return v;
  };
  const turnFn = (deg, axis = "z", center = [0, 0, 0]) => new Pose(about(rotation(axisVec(axis, "turn axis"), num(deg, "turn angle") * DEG), vec(center, "turn center")));
  const slideFn = (...a) => new Pose(translation(Array.isArray(a[0]) ? vec(a[0], "slide") : [0, 1, 2].map((i) => num(a[i] ?? 0, "slide"))));
  // Moves a rigid rod whose ends rest at a0 and b0 so its ends are at a and b
  // (the rod keeps its length; if a and b are further apart, b is not reached).
  function linkFn(a0, b0, a, b) {
    [a0, b0, a, b] = [a0, b0, a, b].map((p, i) => vec(p, `link point ${i + 1}`));
    const u0 = b0.map((v, i) => v - a0[i]);
    const u = b.map((v, i) => v - a[i]);
    const l0 = Math.hypot(...u0);
    const l = Math.hypot(...u);
    if (!l0 || !l) fail("link needs two different points at rest and two different points now");
    onLink?.(Math.abs(l - l0));
    const n0 = u0.map((v) => v / l0);
    const n = u.map((v) => v / l);
    const cross = [n0[1] * n[2] - n0[2] * n[1], n0[2] * n[0] - n0[0] * n[2], n0[0] * n[1] - n0[1] * n[0]];
    const sin = Math.hypot(...cross);
    const cos = n0[0] * n[0] + n0[1] * n[1] + n0[2] * n[2];
    let r = ID;
    if (sin > 1e-12) r = rotation(cross, Math.atan2(sin, cos));
    else if (cos < 0) r = rotation(Math.abs(n0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], Math.PI);
    return new Pose(mul(translation(a), mul(r, translation(a0.map((v) => -v)))));
  }
  const still = () => new Pose();
  // Chaining: pose.turn(...) and pose.slide(...) move the result further.
  Pose.prototype.turn = function (...a) {
    return this.then(turnFn(...a));
  };
  Pose.prototype.slide = function (...a) {
    return this.then(slideFn(...a));
  };
  const isPose = (p, where) => {
    if (p === undefined || p === null) return ID;
    if (p instanceof Pose) return p.m;
    fail(`${where} must return a pose made with turn(), slide() or link(), got ${what(p)}`);
  };
  return { turn: turnFn, slide: slideFn, link: linkFn, still, isPose, axisVec };
}

// Samples every moving part's world pose over the loop and checks joints.
// parts: [{ name, own: [t => matrix], follow }]. Returns per-part frames
// (Float32Array of frameCount x 12, or null for parts that never move) and
// each joint's largest gap.
export function sampleMotion(parts, { loop, joints, onError, bind }) {
  const byName = new Map(parts.map((p) => [p.name, p]));
  for (const p of parts) {
    if (p.follow != null && !byName.has(p.follow)) throw new Error(`part "${p.name}" follows "${p.follow}", but there is no part with that name`);
  }
  for (const p of parts) {
    const chain = [p.name];
    for (let q = p; q.follow != null; ) {
      q = byName.get(q.follow);
      if (chain.includes(q.name)) throw new Error(`parts follow each other in a circle: ${[...chain, q.name].join(" → ")}`);
      chain.push(q.name);
    }
  }
  const moves = new Map();
  const movesOf = (p, seen = new Set()) => {
    if (moves.has(p.name)) return moves.get(p.name);
    if (seen.has(p.name)) throw new Error(`part "${p.name}" follows itself (${[...seen, p.name].join(" → ")})`);
    seen.add(p.name);
    const m = p.own.length > 0 || (p.follow != null && movesOf(byName.get(p.follow), seen));
    moves.set(p.name, m);
    return m;
  };
  parts.forEach((p) => movesOf(p));

  // world(name, t), memoised per time.
  let memoT = null;
  let memo = new Map();
  const resolving = new Set();
  function world(name, t) {
    if (t !== memoT) {
      memoT = t;
      memo = new Map();
    }
    if (memo.has(name)) return memo.get(name);
    const p = byName.get(name);
    if (!p) throw new Error(`where() asks about "${name}", but there is no part with that name`);
    if (!moves.get(name)) return ID;
    if (resolving.has(name)) throw new Error(`the motion of part "${name}" depends on itself (${[...resolving, name].join(" → ")})`);
    resolving.add(name);
    try {
      let m = ID;
      for (const f of p.own) m = mul(onError(() => f(t), name), m);
      if (p.follow != null) m = mul(world(p.follow, t), m);
      // An inner where() at another time may have reset the memo.
      if (t !== memoT) {
        memoT = t;
        memo = new Map();
      }
      memo.set(name, m);
      return m;
    } finally {
      resolving.delete(name);
    }
  }

  bind?.(world);
  const moving = parts.filter((p) => moves.get(p.name));
  const count = moving.length ? Math.max(2, Math.min(1200, Math.round(loop * 60))) : 0;
  const frames = new Map(moving.map((p) => [p.name, new Float32Array(count * 12)]));
  const gaps = joints.map(() => 0);
  for (let i = 0; i < count; i++) {
    const t = (i / count) * loop;
    for (const p of moving) frames.get(p.name).set(world(p.name, t), i * 12);
    joints.forEach((j, k) => {
      const a = apply(world(j.a, t), j.point);
      const b = apply(world(j.b, t), j.point);
      gaps[k] = Math.max(gaps[k], Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    });
  }
  return { frames, count, gaps, world };
}

// The loop length when the script does not set one: the shortest whole
// number of seconds (up to 20) in which every spin and swing comes back to
// where it started, else 4 s.
export function defaultLoop(simple) {
  for (let L = 1; L <= 20; L++) {
    const ok = simple.every((m) => {
      const cycles = m.type === "spin" ? (m.rpm * L) / 60 : L / m.seconds;
      return Math.abs(cycles - Math.round(cycles)) < 0.01;
    });
    if (ok) return L;
  }
  return 4;
}
