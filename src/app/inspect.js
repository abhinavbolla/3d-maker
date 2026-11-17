// Looking inside the model in the view: parts hidden, a section cut through
// it with its cut faces filled, and the parts moved apart (exploded). This is
// view state, not the model: exports, drawings and undo never see it.
//
// The view (viewport.js) calls in at a few places: when its parts change
// (attach), when it poses them (place), when it picks (pick), and before
// each frame (step). With nothing hidden, cut or exploded, every part is
// drawn exactly as before and a frame costs nothing more.
//
// Cut faces: a cut part keeps the side of the plane away from where its
// normal points. Its material clips at the plane and draws both sides of
// its faces. A closed mesh cut open shows its own inside, the back of its
// far faces, exactly where the cut face would be; those are drawn flat in
// the part's colour, so a solid looks solid. Nothing is added to a frame: no
// extra pass, no extra draw. The shadow map draws the back faces too, so a
// cut part casts the shadow of what is left of it.
import * as THREE from "three";

const EXPLODE_MS = 450;
const ease = (t) => t * t * (3 - 2 * t);

export function createInspect({ onChange }) {
  let parts = new Map(); // the view's parts: name -> { object, mesh, light, part }
  const hidden = new Set();
  let section = null; // { normal (to the side cut away), point, uncut: Set, axis, offset }
  // Exploded: how far (0 to 1), along what (null: away from the middle, or
  // "x", "y", "z"), and the groups that move together (lists of names).
  let explode = { factor: 0, axis: null, groups: [] };
  const offsets = new Map(); // name -> where it is now, Vector3
  const listeners = new Set(); // told after every change, for the line by the prompt
  const changed = (what) => {
    onChange(what);
    for (const f of listeners) f();
  };
  let from = new Map(), to = new Map(), started = 0, animating = false;

  // ---- what the view calls ----
  function attach(next) {
    parts = next;
    to = targets();
    // A model change jumps straight to where the parts belong.
    settle();
    apply();
    for (const f of listeners) f();
  }

  function apply() {
    let i = 0;
    for (const [name, entry] of parts) {
      entry.object.visible = !hidden.has(name);
      cut(entry, section && !section.uncut.has(name) ? section : null, i++);
    }
  }

  // Moves a posed part to where the exploded view has it.
  function place(name, matrix) {
    const o = offsets.get(name);
    if (o && (o.x || o.y || o.z)) matrix.premultiply(new THREE.Matrix4().makeTranslation(o.x, o.y, o.z));
  }
  const shift = (name) => offsets.get(name) ?? null;

  // One frame of the exploded view moving; true while it is still moving.
  function step(now = performance.now()) {
    if (!animating) return false;
    const t = Math.min((now - started) / EXPLODE_MS, 1);
    const k = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 1 : ease(t);
    for (const name of parts.keys()) offsets.set(name, (from.get(name) ?? new THREE.Vector3()).clone().lerp(to.get(name) ?? new THREE.Vector3(), k));
    if (t >= 1) animating = false;
    planes();
    if (!animating) changed({ moved: true, restage: true });
    return true;
  }
  // Ends the movement where it is going (pictures show where parts end up).
  function settle() {
    for (const name of parts.keys()) offsets.set(name, (to.get(name) ?? new THREE.Vector3()).clone());
    for (const name of [...offsets.keys()]) if (!parts.has(name)) offsets.delete(name);
    if (animating) changed({ moved: true, restage: true });
    animating = false;
    planes();
  }

  // The first hit of a click that is on something shown: not a hidden part,
  // not the part of a cut part that is cut away. A hit on the inside of a
  // cut part is on its cut face, so the point goes onto the plane.
  function pick(hits, ray) {
    for (const hit of hits) {
      if (!hit.object.parent?.visible) continue;
      const name = hit.object.userData.name;
      const plane = section && !section.uncut.has(name) ? partPlane(name) : null;
      if (!plane) return hit;
      if (plane.distanceToPoint(hit.point) < -1e-6) continue;
      const inside = hit.face && hit.face.normal.clone().transformDirection(hit.object.matrixWorld).dot(ray.direction) > 0;
      if (inside) {
        const at = ray.intersectPlane(plane, new THREE.Vector3());
        if (at) return { ...hit, point: at };
      }
      return hit;
    }
    return null;
  }

  // Parts asked for by name in a screenshot are shown for it even if hidden.
  function reveal(names) {
    const shown = [];
    for (const n of names ?? []) {
      const e = parts.get(n);
      if (e && !e.object.visible) (e.object.visible = true), shown.push(e);
    }
    return () => shown.forEach((e) => (e.object.visible = false));
  }

  // The parts shown, or undefined when every part is.
  const shownNames = () => (hidden.size && [...parts.keys()].some((n) => hidden.has(n)) ? [...parts.keys()].filter((n) => !hidden.has(n)) : undefined);

  // A box around every part where it is now and where it is going, for the
  // floor, the light and the shadow to reach.
  function stageBox() {
    const box = new THREE.Box3();
    for (const [name, { part }] of parts) {
      const b = part.mesh.bounds;
      if (!b) continue;
      for (const o of [offsets.get(name), to.get(name)]) {
        const v = o ?? new THREE.Vector3();
        box.expandByPoint(new THREE.Vector3(b[0] + v.x, b[1] + v.y, b[2] + v.z)).expandByPoint(new THREE.Vector3(b[3] + v.x, b[4] + v.y, b[5] + v.z));
      }
    }
    return box.isEmpty() ? null : box;
  }

  // ---- the section ----
  // A plane three.js clips with keeps where normal . p + constant >= 0: so
  // the plane faces away from the side cut away. It moves with the part when
  // the view is exploded, so each part is cut where it sits in the model.
  const partPlane = (name) => {
    const o = offsets.get(name) ?? new THREE.Vector3();
    const n = section.normal;
    return new THREE.Plane(n.clone().negate(), n.dot(section.point) + n.dot(o));
  };
  function planes() {
    if (!section) return;
    for (const [name, { mesh }] of parts) {
      const m = mesh.material;
      if (m.clippingPlanes?.length) m.clippingPlanes[0].copy(partPlane(name));
    }
  }

  // Whether the plane passes through a part's box, where the part is now.
  function crosses({ part }) {
    const b = part.mesh.bounds;
    if (!b) return false;
    const plane = partPlane(part.name);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 8; i++) {
      const d = plane.distanceToPoint(new THREE.Vector3(i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]));
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return lo < 0 && hi > 0;
  }

  function cut(entry, sec, index = 0) {
    const m = entry.mesh.material;
    if (!m.userData.capped) capShader(m);
    // Glass is clipped but not filled: its inside should stay clear.
    // Only a part the plane passes through shows its inside; a moving part
    // may pass through it at any time.
    const fill = Boolean(sec) && !m.transparent && (Boolean(entry.part.frames) || crosses(entry));
    const was = m.userData.cap.on;
    if (sec) {
      m.clippingPlanes = [partPlane(entry.part.name)];
      m.clipShadows = true;
    } else {
      m.clippingPlanes = null;
      m.clipShadows = false;
    }
    // Lighter and darker by turns, so the cut faces of neighbouring parts of
    // one colour (an assembly of grey metal) can be told apart.
    if (fill) m.userData.cap.value.set(entry.part.color).lerp(index % 2 ? BLACK : WHITE, index % 2 ? 0.14 : 0.12);
    m.userData.cap.on = fill;
    m.side = fill ? THREE.DoubleSide : THREE.FrontSide;
    // The shadow map draws back faces, as it does for any solid part.
    m.shadowSide = fill ? THREE.BackSide : null;
    // In front of the floor and its grid where the inside of a part's bottom
    // face lies in the floor's plane.
    m.polygonOffset = fill;
    m.polygonOffsetFactor = fill ? -1 : 0;
    m.polygonOffsetUnits = fill ? -4 : 0;
    if (fill !== was) m.needsUpdate = true;
  }

  // ---- what Claude asks for ----
  const known = (names) => {
    const unknown = names.filter((n) => !parts.has(n));
    if (unknown.length) throw new Error(`There is no part named ${unknown.map((n) => `"${n}"`).join(", ")}. Parts: ${[...parts.keys()].join(", ")}.`);
    return names;
  };
  function setHidden({ hide = [], show = [], only = null, all = false } = {}) {
    known([...hide, ...show, ...(only ?? [])]);
    const before = [...hidden];
    if (all) hidden.clear();
    if (only) {
      known(only);
      hidden.clear();
      for (const n of parts.keys()) if (!only.includes(n)) hidden.add(n);
    }
    for (const n of known(show)) hidden.delete(n);
    for (const n of known(hide)) hidden.add(n);
    if (parts.size && [...parts.keys()].every((n) => hidden.has(n))) {
      hidden.clear();
      before.forEach((n) => hidden.add(n));
      throw new Error("That would hide every part. Hide fewer, or use only to choose the parts to show.");
    }
    apply();
    changed({ moved: true });
  }

  // normal: a direction, towards the side cut away; point: on the plane.
  function setSection(spec) {
    if (!spec) section = null;
    else {
      const normal = new THREE.Vector3(...spec.normal).normalize();
      section = { normal, point: new THREE.Vector3(...spec.point), uncut: new Set(known(spec.uncut ?? [])), axis: spec.axis ?? null, offset: spec.offset ?? null };
    }
    apply();
    planes();
    changed({ moved: true });
  }

  function setExplode({ factor = 0, axis = null, groups = [] } = {}) {
    explode = { factor: Math.min(Math.max(factor, 0), 1), axis, groups };
    from = new Map([...parts.keys()].map((n) => [n, (offsets.get(n) ?? new THREE.Vector3()).clone()]));
    to = targets();
    started = performance.now();
    animating = true;
    changed({ moved: true, restage: true });
  }

  // Where each part goes at the exploded view's factor. Each group (a step
  // of the plan, or a part on its own) moves away from the middle of the
  // whole model, by as far again as its own middle is from there at a factor
  // of 1, or only along one axis. Then everything is lifted as needed so no
  // part goes below where the model stood.
  function targets() {
    const out = new Map();
    const bounds = new Map();
    for (const [name, { part }] of parts) if (part.mesh.bounds) bounds.set(name, part.mesh.bounds);
    if (!explode.factor || !bounds.size) return out;
    const all = new THREE.Box3();
    for (const b of bounds.values()) all.expandByPoint(new THREE.Vector3(b[0], b[1], b[2])).expandByPoint(new THREE.Vector3(b[3], b[4], b[5]));
    const middle = all.getCenter(new THREE.Vector3());
    const grouped = new Set();
    const groups = [];
    for (const g of explode.groups) {
      const names = g.filter((n) => bounds.has(n) && !grouped.has(n));
      names.forEach((n) => grouped.add(n));
      if (names.length) groups.push(names);
    }
    for (const n of bounds.keys()) if (!grouped.has(n)) groups.push([n]);
    const along = explode.axis ? new THREE.Vector3(explode.axis === "x" ? 1 : 0, explode.axis === "y" ? 1 : 0, explode.axis === "z" ? 1 : 0) : null;
    let low = Infinity;
    for (const names of groups) {
      const box = new THREE.Box3();
      for (const n of names) {
        const b = bounds.get(n);
        box.expandByPoint(new THREE.Vector3(b[0], b[1], b[2])).expandByPoint(new THREE.Vector3(b[3], b[4], b[5]));
      }
      const move = box.getCenter(new THREE.Vector3()).sub(middle);
      if (along) move.projectOnVector(along);
      move.multiplyScalar(explode.factor);
      for (const n of names) out.set(n, move.clone());
      low = Math.min(low, box.min.z + move.z);
    }
    const lift = Math.max(0, all.min.z - low);
    for (const v of out.values()) v.z += lift;
    return out;
  }

  function clear() {
    hidden.clear();
    section = null;
    apply();
    if (explode.factor) setExplode({ factor: 0 });
    else changed({ moved: true });
  }

  // What is in force, as Claude is told it and as the line by the prompt says it.
  function describe() {
    const present = [...parts.keys()];
    const hiddenNow = present.filter((n) => hidden.has(n));
    const r1 = (v) => Math.round(v * 10) / 10;
    const out = { active: false, line: "" };
    const words = [];
    if (section) {
      const s = { point_mm: section.point.toArray().map(r1), normal: section.normal.toArray().map((v) => Math.round(v * 1000) / 1000) };
      if (section.axis) Object.assign(s, { axis: section.axis, offset_mm: r1(section.offset), removed: section.normal.getComponent("xyz".indexOf(section.axis)) > 0 ? "+" : "-" });
      if (section.uncut.size) s.uncut = [...section.uncut];
      out.section = s;
      words.push(section.axis ? `Section at ${section.axis.toUpperCase()} = ${r1(section.offset)} mm` : `Section through ${s.point_mm.join(", ")} mm`);
    }
    if (hiddenNow.length) {
      out.hidden = hiddenNow;
      words.push(`${hiddenNow.length} ${hiddenNow.length === 1 ? "part" : "parts"} hidden`);
    }
    if (explode.factor) {
      out.explode = { factor: explode.factor, ...(explode.axis ? { axis: explode.axis } : {}) };
      words.push(explode.factor === 1 ? "Exploded" : `Exploded ${Math.round(explode.factor * 100)}%`);
    }
    out.active = words.length > 0;
    out.line = words.join(" · ");
    return out;
  }

  const subscribe = (f) => (listeners.add(f), () => listeners.delete(f));

  return { subscribe, attach, place, shift, step, settle, pick, reveal, shownNames, stageBox, setHidden, setSection, setExplode, clear, describe, animating: () => animating, exploded: () => explode.factor > 0 || offsets.size > 0 && [...offsets.values()].some((o) => o.lengthSq() > 0) };
}

const WHITE = new THREE.Color(1, 1, 1);
const BLACK = new THREE.Color(0, 0, 0);

// The inside of a cut part is drawn as its cut face, flat in the cap colour.
// It stays at the depth of the far wall it is really on: anything between
// the plane and that wall would have to be inside the solid, and solid parts
// do not overlap. The one exception is the floor, which the bottom of a part
// standing on it touches; the material's polygon offset keeps the part in
// front of it (see cut).
const CAP = /* glsl */ `#include <opaque_fragment>
  if (!gl_FrontFacing) gl_FragColor = vec4(capColor, diffuseColor.a);`;

// Adds the cut face to a part's material: where the inside of the mesh
// shows, it is drawn flat in the cap colour. Kept apart from the plain
// material's program, so an uncut part's shader is the same as before.
function capShader(m) {
  m.userData.capped = true;
  m.userData.cap = { value: new THREE.Color(), on: false };
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey;
  m.onBeforeCompile = function (shader, renderer) {
    before.call(this, shader, renderer);
    if (!m.userData.cap.on) return;
    shader.uniforms.capColor = m.userData.cap;
    shader.fragmentShader = "uniform vec3 capColor;\n" + shader.fragmentShader.replace("#include <opaque_fragment>", CAP);
  };
  m.customProgramCacheKey = function () {
    return key.call(this) + (m.userData.cap.on ? "|cap" : "");
  };
}
