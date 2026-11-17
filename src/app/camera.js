// A camera Claude can direct: where it stands, what it looks at, its lens,
// and moves from one place to another over a shot. Everything here is
// worked out from numbers alone (a time, a frame number), never from the
// clock, so a recording gives the same frames however slowly they are drawn.
//
// A camera is { position, target, up, lens } with three.js vectors, and lens
// the focal length in mm of a 35 mm (36 x 24 mm) camera. The 36 mm side
// spans the longer side of the picture, as photographers' lenses do on a
// full-frame camera: 24 mm is wide, 50 mm normal, 85 to 135 mm a portrait.
import * as THREE from "three";
import { VIEWS } from "./viewport.js";

const DEG = Math.PI / 180;
const Z = new THREE.Vector3(0, 0, 1);
const SENSOR = 36; // mm
export const LENS_MIN = 8;
export const LENS_MAX = 600;

// three.js's field of view (vertical, degrees) for a lens at an aspect.
export function lensToFov(mm, aspect) {
  const half = Math.atan(SENSOR / 2 / mm);
  return (aspect >= 1 ? 2 * Math.atan(Math.tan(half) / aspect) : 2 * half) / DEG;
}
export function fovToLens(fov, aspect) {
  const halfV = (fov * DEG) / 2;
  const half = aspect >= 1 ? Math.atan(Math.tan(halfV) * aspect) : halfV;
  return SENSOR / 2 / Math.tan(half);
}

// Directions as azimuth and elevation, in degrees. Azimuth 0 looks from the
// front (from -Y), 90 from the right (+X), 180 from the back, 270 from the
// left. Elevation 90 looks straight down.
const across = (az) => new THREE.Vector3(Math.sin(az * DEG), -Math.cos(az * DEG), 0);
export function direction(az, el) {
  return across(az).multiplyScalar(Math.cos(el * DEG)).addScaledVector(Z, Math.sin(el * DEG));
}
export function angles(dir) {
  const d = dir.clone().normalize();
  const flat = Math.hypot(d.x, d.y);
  return { az: flat < 1e-9 ? 0 : Math.atan2(d.x, -d.y) / DEG, el: Math.atan2(d.z, flat) / DEG };
}
// Straight down or up, the front of the model is at the bottom of the window.
function upFor(dir, az) {
  if (Math.abs(dir.clone().normalize().z) < 0.9995) return Z.clone();
  return across(az ?? angles(dir).az).multiplyScalar(-Math.sign(dir.z));
}

const vec = (v, what) => {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) throw new Error(`${what} must be [x, y, z] in mm.`);
  return new THREE.Vector3(...v);
};
const number = (v, what, min, max) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new Error(`${what} must be a number from ${min} to ${max}.`);
  return v;
};

// Points of the shown parts (as viewport.partsAt gives them), posed, in
// world coordinates: some of each part's vertices.
export function partPoints(parts, names) {
  const out = [];
  for (const [name, { matrix, points, clip }] of parts) {
    if (names && !names.includes(name)) continue;
    const p = points();
    for (let i = 0; i < p.length; i += 3) {
      const v = new THREE.Vector3(p[i], p[i + 1], p[i + 2]).applyMatrix4(matrix);
      // A section takes away what is on the negative side of its plane.
      if (!clip || clip.distanceToPoint(v) >= 0) out.push(v);
    }
  }
  return out;
}
const corners = (box) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));

// How far from the target the camera must stand, along dir, for every
// point to fall inside `fill` of the picture.
function fitDistance(points, target, dir, lens, aspect, fill = 0.9) {
  const fov = lensToFov(lens, aspect) * DEG;
  const tanV = Math.tan(fov / 2) * fill;
  const tanH = Math.tan(fov / 2) * aspect * fill;
  const d = dir.clone().normalize();
  const forward = d.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, upFor(d)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward);
  let dist = 0;
  const rel = new THREE.Vector3();
  const box = new THREE.Box3();
  for (const p of points) {
    rel.subVectors(p, target);
    const along = rel.dot(d);
    dist = Math.max(dist, along + Math.abs(rel.dot(right)) / tanH, along + Math.abs(rel.dot(up)) / tanV);
    box.expandByPoint(p);
  }
  const size = box.getSize(new THREE.Vector3()).length();
  return Math.max(dist, size * 0.05, 1);
}

export const toSaved = (cam) => ({ position: cam.position.toArray().map(r2), target: cam.target.toArray().map(r2), up: cam.up.toArray().map(r4), lens_mm: r2(cam.lens) });
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const fromSaved = (s) => ({ position: new THREE.Vector3(...s.position), target: new THREE.Vector3(...s.target), up: new THREE.Vector3(...(s.up ?? [0, 0, 1])), lens: s.lens_mm });
// What a camera says about itself to Claude.
export function describe(cam) {
  const { az, el } = angles(cam.position.clone().sub(cam.target));
  return { ...toSaved(cam), azimuth: Math.round(az * 10) / 10, elevation: Math.round(el * 10) / 10, distance_mm: Math.round(cam.position.distanceTo(cam.target)) };
}

const SPEC_KEYS = new Set(["view", "from", "azimuth", "elevation", "position", "target", "parts", "lens_mm", "distance", "fill"]);

// Works out a camera from what Claude asked for. spec: a saved view's name,
// a standard view's name ("iso", "front", ...), "current", or an object:
//   view       a saved view, a standard view or "current" to start from
//   from       [x, y, z]: the direction to look from (towards the camera)
//   azimuth, elevation  the same in degrees (see direction above)
//   position, target    where the camera stands and what it looks at, mm
//   parts      frame these parts (default: the whole model)
//   lens_mm    focal length; default the starting camera's
//   distance   stand this many times as far away as the framing gives (0.5 is twice as close)
//   fill       how much of the picture the framed box fills, 0.2 to 1 (default 0.9)
// ctx: { aspect, current() -> camera, views: { name: saved }, box(names) -> Box3 | null,
//        points(names) -> [Vector3] (some of their vertices, to frame them tightly),
//        partNames: Set, sweep: degrees the camera will turn round the target (to frame for all of it) }
export function resolveCamera(spec, ctx) {
  if (spec === undefined || spec === null) spec = "current";
  if (typeof spec === "string") spec = { view: spec };
  if (typeof spec !== "object" || Array.isArray(spec)) throw new Error("A camera is a view's name or an object such as { view, azimuth, elevation, parts, lens_mm }.");
  const unknown = Object.keys(spec).filter((k) => !SPEC_KEYS.has(k));
  if (unknown.length) throw new Error(`A camera has no setting ${unknown.map((k) => `"${k}"`).join(", ")}. It takes: ${[...SPEC_KEYS].join(", ")}.`);

  // The camera to start from.
  let base;
  const view = spec.view ?? "current";
  if (typeof view !== "string") throw new Error("view must be a name.");
  if (ctx.views?.[view]) base = fromSaved(ctx.views[view]);
  else if (view === "current") base = ctx.current();
  else if (!VIEWS[view]) throw new Error(`There is no view named "${view}". Use a standard view (${Object.keys(VIEWS).join(", ")}), "current"${Object.keys(ctx.views ?? {}).length ? `, or a saved view (${Object.keys(ctx.views).join(", ")})` : ""}.`);
  const lens = spec.lens_mm !== undefined ? number(spec.lens_mm, "lens_mm", LENS_MIN, LENS_MAX) : base?.lens ?? ctx.current().lens;

  let names;
  if (spec.parts !== undefined) {
    if (!Array.isArray(spec.parts) || !spec.parts.length) throw new Error("parts must be a list of part names.");
    const missing = spec.parts.filter((n) => !ctx.partNames.has(n));
    if (missing.length) throw new Error(`There is no part named ${missing.map((n) => `"${n}"`).join(", ")}.`);
    names = spec.parts;
  }
  let dir = null;
  if (spec.from !== undefined) dir = vec(spec.from, "from");
  if (spec.azimuth !== undefined || spec.elevation !== undefined) {
    const start = base ? angles(base.position.clone().sub(base.target)) : { az: 0, el: 20 };
    dir = direction(spec.azimuth !== undefined ? number(spec.azimuth, "azimuth", -720, 720) : start.az, spec.elevation !== undefined ? number(spec.elevation, "elevation", -90, 90) : start.el);
  }
  if (!dir && !base) dir = new THREE.Vector3(...VIEWS[view]);
  if (dir && !(dir.length() > 0)) throw new Error("from must not be [0, 0, 0].");
  const distance = spec.distance !== undefined ? number(spec.distance, "distance", 0.01, 100) : 1;
  const fill = spec.fill !== undefined ? number(spec.fill, "fill", 0.2, 1) : 0.9;

  let position, target;
  if (spec.position !== undefined) {
    position = vec(spec.position, "position");
    target = spec.target !== undefined ? vec(spec.target, "target") : (ctx.box(names) ?? new THREE.Box3(new THREE.Vector3(), new THREE.Vector3())).getCenter(new THREE.Vector3());
    if (position.distanceTo(target) < 1e-6) throw new Error("position and target must not be the same point.");
    position = target.clone().addScaledVector(position.clone().sub(target), distance);
  } else if (dir || names || spec.target !== undefined || spec.fill !== undefined) {
    // Framed: on the parts (or the whole model), from the direction asked
    // for or the starting camera's.
    // Framed on the parts' own points where there are any (what a section
    // leaves of them), else on their boxes.
    const shown = ctx.points?.(names);
    const box = shown?.length ? new THREE.Box3().setFromPoints(shown) : ctx.box(names);
    dir = (dir ?? (base ? base.position.clone().sub(base.target) : new THREE.Vector3(...VIEWS.iso))).normalize();
    target = spec.target !== undefined ? vec(spec.target, "target") : box ? box.getCenter(new THREE.Vector3()) : base?.target.clone() ?? new THREE.Vector3();
    let d = box ? 0 : (base?.position.distanceTo(base.target) ?? 500);
    if (box) {
      // A turn round the target is framed for every side it will see.
      const sweep = Math.min(Math.abs(ctx.sweep ?? 0), 360);
      const { az, el } = angles(dir);
      const steps = sweep ? Math.ceil(sweep / 15) : 0;
      const points = shown?.length ? shown : corners(box);
      for (let i = 0; i <= steps; i++) d = Math.max(d, fitDistance(points, target, steps ? direction(az + (Math.sign(ctx.sweep) * sweep * i) / steps, el) : dir, lens, ctx.aspect, fill));
    }
    position = target.clone().addScaledVector(dir, d * distance);
  } else {
    target = base.target.clone();
    position = target.clone().addScaledVector(base.position.clone().sub(base.target), distance);
  }
  const off = position.clone().sub(target);
  return { position, target, up: upFor(off), lens };
}

// Between two cameras, u from 0 to 1: the target slides straight across,
// and the camera swings round it (the shorter way), its distance and lens
// changing evenly in proportion, so a move in closes at an even pace.
export function between(a, b, u) {
  const target = a.target.clone().lerp(b.target, u);
  const oa = a.position.clone().sub(a.target);
  const ob = b.position.clone().sub(b.target);
  const A = angles(oa), B = angles(ob);
  // Looking straight down or up, the azimuth is the other camera's.
  const flatA = Math.abs(A.el) > 89.9, flatB = Math.abs(B.el) > 89.9;
  if (flatA && !flatB) A.az = B.az;
  if (flatB && !flatA) B.az = A.az;
  let turn = (((B.az - A.az) % 360) + 540) % 360 - 180;
  const az = A.az + turn * u;
  const el = A.el + (B.el - A.el) * u;
  const dist = Math.exp(Math.log(oa.length()) * (1 - u) + Math.log(ob.length()) * u);
  const off = direction(az, el).multiplyScalar(dist);
  return { position: target.clone().add(off), target, up: upFor(off, az), lens: Math.exp(Math.log(a.lens) * (1 - u) + Math.log(b.lens) * u) };
}

// A camera turned round its target's upright by `degrees` (positive is
// anticlockwise seen from above), raised by `rise` degrees.
export function orbit(cam, degrees, rise = 0) {
  const off = cam.position.clone().sub(cam.target);
  const { az, el } = angles(off);
  const e = Math.max(-89.5, Math.min(89.5, el + rise));
  const next = direction(az + degrees, e).multiplyScalar(off.length());
  return { position: cam.target.clone().add(next), target: cam.target.clone(), up: upFor(next, az + degrees), lens: cam.lens };
}

// A three.js camera for a camera at an aspect, with its clipping planes
// around a model of overall size `size` mm.
export function toThree(cam, aspect, size, out = new THREE.PerspectiveCamera()) {
  const dist = cam.position.distanceTo(cam.target);
  out.fov = lensToFov(cam.lens, aspect);
  out.aspect = aspect;
  out.near = Math.max(Math.min(dist * 0.02, size * 0.02), size * 2e-5, 1e-3);
  out.far = dist + cam.position.length() + size * 12;
  out.position.copy(cam.position);
  out.up.copy(cam.up);
  out.lookAt(cam.target);
  out.updateProjectionMatrix();
  out.updateMatrixWorld(true);
  return out;
}

// ---- shots ----
const EASE = {
  linear: (u) => u,
  in: (u) => u * u * u,
  out: (u) => 1 - (1 - u) ** 3,
  "in-out": (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2),
};
const MOVES = ["hold", "turntable", "orbit", "move", "follow"];
const SHOT_KEYS = new Set(["seconds", "move", "camera", "to", "degrees", "rise", "part", "ride", "ease", "motion", "speed"]);
export const MAX_SECONDS = 600;

// Plans a recording. shots: what Claude gave (see record_video in
// mcp/server.mjs). ctx: as for resolveCamera, plus partsAt(t) -> Map(name ->
// { matrix, bounds }) and hasMotion. Returns { frames, seconds, at(n) }
// where at(n) gives frame n's camera and motion time from n alone.
export function planShots(shots, { fps, startAt = 0, ...ctx }) {
  if (!Array.isArray(shots) || !shots.length) throw new Error("A recording needs at least one shot.");
  if (shots.length > 50) throw new Error("A recording can have at most 50 shots.");
  const planned = [];
  let frames = 0;
  let clock = startAt; // motion time where the shot starts
  let last = null; // the camera the previous shot ended on
  // A part's place at a motion time: its posed box, and its turn about the upright.
  const boxAt = (names, t) => {
    const all = ctx.partsAt(t);
    const box = new THREE.Box3();
    for (const [name, { matrix, bounds }] of all) if (!names || names.includes(name)) box.union(bounds.clone().applyMatrix4(matrix));
    return box.isEmpty() ? null : box;
  };
  const pointsAt = (names, t) => partPoints(ctx.partsAt(t), names);
  const yawAt = (name, t) => {
    const m = ctx.partsAt(t).get(name).matrix.elements;
    return Math.atan2(m[1], m[0]) / DEG;
  };

  shots.forEach((s, i) => {
    const what = `Shot ${i + 1}`;
    if (!s || typeof s !== "object") throw new Error(`${what} must be an object.`);
    const unknown = Object.keys(s).filter((k) => !SHOT_KEYS.has(k));
    if (unknown.length) throw new Error(`${what} has no setting ${unknown.map((k) => `"${k}"`).join(", ")}. A shot takes: ${[...SHOT_KEYS].join(", ")}.`);
    const seconds = number(s.seconds, `${what}: seconds`, 1 / fps, MAX_SECONDS);
    const move = s.move ?? (s.to !== undefined ? "move" : s.part !== undefined ? "follow" : "hold");
    if (!MOVES.includes(move)) throw new Error(`${what}: move must be one of ${MOVES.join(", ")}.`);
    if (move === "move" && s.to === undefined) throw new Error(`${what}: a move needs "to", the camera it ends on.`);
    if (move !== "move" && s.to !== undefined) throw new Error(`${what}: "to" is only for move: "move".`);
    const ease = s.ease ?? (move === "move" || move === "orbit" ? "in-out" : "linear");
    if (!EASE[ease]) throw new Error(`${what}: ease must be one of ${Object.keys(EASE).join(", ")}.`);
    const plays = s.motion ?? Boolean(ctx.hasMotion);
    if (typeof plays !== "boolean") throw new Error(`${what}: motion must be true or false.`);
    const speed = s.speed !== undefined ? number(s.speed, `${what}: speed`, -100, 100) : 1;
    const degrees = s.degrees !== undefined ? number(s.degrees, `${what}: degrees`, -3600, 3600) : move === "turntable" ? 360 : move === "orbit" ? 90 : 0;
    const rise = s.rise !== undefined ? number(s.rise, `${what}: rise`, -180, 180) : 0;
    const count = Math.max(1, Math.round(seconds * fps));
    const from = clock; // this shot's own start, kept: clock moves on to the next shot
    const motionAt = (k) => from + (plays ? (k / fps) * speed : 0);
    // Framing takes in where the parts go during the shot (a spinning rotor
    // is framed for its whole disc), except when following one part, which
    // is framed as it starts.
    const spread = plays && move !== "follow" ? [0, 1, 2, 3, 4, 5, 6, 7].map((i) => motionAt((i / 8) * count)) : [motionAt(0)];
    const camCtx = { ...ctx, box: (names) => boxAt(names, motionAt(0)), points: (names) => spread.flatMap((t) => pointsAt(names, t)), sweep: move === "turntable" || move === "orbit" ? degrees : 0, current: () => (last ? { ...last } : ctx.current()) };

    let start;
    try {
      start = s.camera !== undefined ? resolveCamera(s.camera, camCtx) : last ?? resolveCamera("current", camCtx);
    } catch (err) {
      throw new Error(`${what}: camera: ${err.message}`);
    }
    let cameraAt;
    if (move === "hold") cameraAt = () => start;
    else if (move === "turntable" || move === "orbit") cameraAt = (u) => orbit(start, degrees * u, rise * u);
    else if (move === "move") {
      let end;
      try {
        end = resolveCamera(s.to, { ...camCtx, sweep: 0, current: () => ({ ...start }) });
      } catch (err) {
        throw new Error(`${what}: to: ${err.message}`);
      }
      cameraAt = (u) => between(start, end, u);
    } else {
      // follow: the camera keeps where it stands relative to the part's
      // middle; with ride it also turns with the part about the upright.
      if (typeof s.part !== "string" || !ctx.partNames.has(s.part)) throw new Error(`${what}: follow needs "part", the name of a part in the model.`);
      if (s.ride !== undefined && typeof s.ride !== "boolean") throw new Error(`${what}: ride must be true or false.`);
      const centre = (t) => boxAt([s.part], t).getCenter(new THREE.Vector3());
      const c0 = centre(motionAt(0));
      // A camera that was not aimed anywhere in particular aims at the part.
      const aimed = s.camera !== undefined && typeof s.camera === "object" && (s.camera.target !== undefined || s.camera.parts !== undefined);
      const target0 = aimed ? start.target : c0;
      const offset = start.position.clone().sub(target0);
      const shift = target0.clone().sub(c0); // the aim's place relative to the part
      const yaw0 = s.ride ? yawAt(s.part, motionAt(0)) : 0;
      cameraAt = (u, t) => {
        const turn = s.ride ? yawAt(s.part, t) - yaw0 : 0;
        const q = new THREE.Quaternion().setFromAxisAngle(Z, turn * DEG);
        const target = centre(t).add(shift.clone().applyQuaternion(q));
        const off = offset.clone().applyQuaternion(q);
        return { position: target.clone().add(off), target, up: upFor(off), lens: start.lens };
      };
    }
    // The last frame of the film lands on the end of its last move, unless
    // the move comes back round to where it began (a whole turn).
    const loops = (move === "turntable" || move === "orbit") && Math.abs(degrees) % 360 === 0 && !rise;
    const lands = i === shots.length - 1 && count > 1 && move !== "hold" && move !== "follow" && !loops;
    const shape = EASE[ease];
    planned.push({ first: frames, count, seconds, move, time: motionAt, at: (k) => { const t = motionAt(k); return { camera: cameraAt(shape(lands ? k / (count - 1) : k / count), t), time: t }; } });
    last = cameraAt(1, motionAt(count));
    frames += count;
    clock = motionAt(count);
  });

  return {
    frames,
    seconds: frames / fps,
    shots: planned.map(({ first, count, seconds, move }) => ({ first, count, seconds, move })),
    // Frame n's camera and motion time, from n alone.
    // Frame n's motion time alone (the same number at(n) gives).
    timeAt(n) {
      const s = planned.findLast((p) => p.first <= n);
      return s.time(n - s.first);
    },
    at(n) {
      if (!(n >= 0 && n < frames)) throw new Error(`There is no frame ${n}.`);
      const s = planned.findLast((p) => p.first <= n);
      return { ...s.at(n - s.first), shot: planned.indexOf(s) };
    },
    end: last,
  };
}
