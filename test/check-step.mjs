// Checks a STEP file on its own terms, sharing no code with the writer:
//  - the Part 21 file parses, and every #reference points at an entity;
//  - each entity is one this checker knows from AP214 (ISO 10303-214), with
//    the right number and kinds of arguments, and references of the right
//    types;
//  - the product structure: an assembly whose parts are named products,
//    each with a solid, in millimetres;
//  - every solid is closed: each face loop is closed, and every edge of a
//    shell is used exactly twice, once each way;
//  - geometry agrees with topology: every vertex lies on the curves of its
//    edges and on the surfaces of its faces, and points along every edge lie
//    on the surfaces of both faces it bounds, within `tol`;
//  - loops face outward: a flat face's loops go round its outward normal
//    the right way, and each solid's volume, worked out from its faces alone
//    (divergence theorem, edges sampled finely), is positive;
//  - volume and bounding box per part, for the caller to compare.
// Usage: node test/check-step.mjs model.step
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---- Part 21 ----
export function parseStep(text) {
  const problems = [];
  const head = /^ISO-10303-21;\s*HEADER;([\s\S]*?)ENDSEC;\s*DATA;([\s\S]*?)ENDSEC;\s*END-ISO-10303-21;\s*$/.exec(text);
  if (!head) return { problems: ["not an ISO-10303-21 file with one HEADER and one DATA section"], entities: new Map(), header: "" };
  const header = head[1];
  const entities = new Map();
  let s = head[2], i = 0;
  const ws = () => {
    while (i < s.length) {
      if (/\s/.test(s[i])) i++;
      else if (s.startsWith("/*", i)) i = s.indexOf("*/", i) + 2;
      else break;
    }
  };
  const fail = (m) => {
    throw new Error(`${m} at "${s.slice(Math.max(0, i - 30), i + 30).replace(/\s+/g, " ")}"`);
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === "'") {
      let out = "";
      i++;
      for (;;) {
        if (i >= s.length) fail("unterminated string");
        if (s[i] === "'") {
          if (s[i + 1] === "'") (out += "'"), (i += 2);
          else break;
        } else out += s[i++];
      }
      i++;
      return { k: "str", v: decode(out), raw: out };
    }
    if (c === "#") {
      const m = /^#(\d+)/.exec(s.slice(i, i + 20));
      if (!m) fail("bad reference");
      i += m[0].length;
      return { k: "ref", v: +m[1] };
    }
    if (c === "$") return i++, { k: "unset" };
    if (c === "*") return i++, { k: "derived" };
    if (c === ".") {
      const m = /^\.([A-Z_][A-Z0-9_]*)\./.exec(s.slice(i, i + 80));
      if (!m) fail("bad enumeration");
      i += m[0].length;
      return { k: "enum", v: m[1] };
    }
    if (c === "(") {
      i++;
      const items = [];
      ws();
      if (s[i] === ")") return i++, { k: "list", v: items };
      for (;;) {
        items.push(value());
        ws();
        if (s[i] === ",") i++;
        else if (s[i] === ")") return i++, { k: "list", v: items };
        else fail("expected , or )");
      }
    }
    const num = /^[+-]?\d+(\.\d*)?([eE][+-]?\d+)?/.exec(s.slice(i, i + 40));
    if (num) {
      i += num[0].length;
      // Part 21 reals have a decimal point; integers do not.
      return num[1] !== undefined ? { k: "real", v: +num[0] } : { k: "int", v: +num[0] };
    }
    const typed = /^[A-Z_][A-Z0-9_]*/.exec(s.slice(i, i + 80));
    if (typed) {
      i += typed[0].length;
      ws();
      if (s[i] !== "(") fail("expected ( after a type name");
      i++;
      const v = value();
      ws();
      if (s[i] !== ")") fail("expected ) after a typed value");
      i++;
      return { k: "typed", type: typed[0], v };
    }
    fail("unexpected character");
  };
  const record = () => {
    ws();
    const m = /^[A-Z_][A-Z0-9_]*/.exec(s.slice(i, i + 100));
    if (!m) fail("expected an entity name");
    i += m[0].length;
    const args = value();
    if (args.k !== "list") fail("expected arguments");
    return { type: m[0], args: args.v };
  };
  try {
    for (;;) {
      ws();
      if (i >= s.length) break;
      const m = /^#(\d+)\s*=\s*/.exec(s.slice(i, i + 40));
      if (!m) fail("expected #id=");
      i += m[0].length;
      const id = +m[1];
      if (entities.has(id)) fail(`#${id} defined twice`);
      ws();
      let e;
      if (s[i] === "(") {
        // A complex entity: several partial records, names in alphabetical order.
        i++;
        const parts = [];
        for (;;) {
          ws();
          if (s[i] === ")") break;
          parts.push(record());
        }
        i++;
        const names = parts.map((p) => p.type);
        if (names.join() !== [...names].sort().join()) problems.push(`#${id}: complex entity parts not in alphabetical order (${names.join(" ")})`);
        e = { id, type: names.join("+"), parts };
      } else e = { id, ...record() };
      ws();
      if (s[i] !== ";") fail("expected ;");
      i++;
      entities.set(id, e);
    }
  } catch (err) {
    problems.push(`does not parse: ${err.message}`);
  }
  return { problems, entities, header };
}

// Part 21 string escapes: \\ is \, \X2\ hex \X0\ is UTF-16, \X\hh one byte.
function decode(s) {
  let out = "";
  for (let i = 0; i < s.length; ) {
    if (s.startsWith("\\X2\\", i)) {
      const end = s.indexOf("\\X0\\", i);
      const hex = s.slice(i + 4, end);
      for (let k = 0; k < hex.length; k += 4) out += String.fromCharCode(parseInt(hex.slice(k, k + 4), 16));
      i = end + 4;
    } else if (s.startsWith("\\X\\", i)) {
      out += String.fromCharCode(parseInt(s.slice(i + 3, i + 5), 16));
      i += 5;
    } else if (s.startsWith("\\\\", i)) {
      out += "\\";
      i += 2;
    } else out += s[i++];
  }
  return out;
}

// ---- the AP214 entities used, with their attributes ----
// Kinds: s string, r real, i integer, b .T./.F., e enumeration, * derived,
// L(x) list of x, and a reference given as the types it may point to
// (A|B). A ? after a kind allows $.
const SCHEMA = {
  APPLICATION_CONTEXT: ["s"],
  APPLICATION_PROTOCOL_DEFINITION: ["s", "s", "i", "APPLICATION_CONTEXT"],
  PRODUCT_CONTEXT: ["s", "APPLICATION_CONTEXT", "s"],
  PRODUCT_DEFINITION_CONTEXT: ["s", "APPLICATION_CONTEXT", "s"],
  PRODUCT: ["s", "s", "s", "L(PRODUCT_CONTEXT)"],
  PRODUCT_DEFINITION_FORMATION: ["s", "s", "PRODUCT"],
  PRODUCT_DEFINITION: ["s", "s", "PRODUCT_DEFINITION_FORMATION", "PRODUCT_DEFINITION_CONTEXT"],
  PRODUCT_DEFINITION_SHAPE: ["s", "s", "PRODUCT_DEFINITION|NEXT_ASSEMBLY_USAGE_OCCURRENCE"],
  PRODUCT_RELATED_PRODUCT_CATEGORY: ["s", "s?", "L(PRODUCT)"],
  SHAPE_DEFINITION_REPRESENTATION: ["PRODUCT_DEFINITION_SHAPE", "SHAPE_REPRESENTATION|ADVANCED_BREP_SHAPE_REPRESENTATION"],
  SHAPE_REPRESENTATION: ["s", "L(AXIS2_PLACEMENT_3D)", "CONTEXT"],
  ADVANCED_BREP_SHAPE_REPRESENTATION: ["s", "L(MANIFOLD_SOLID_BREP)", "CONTEXT"],
  SHAPE_REPRESENTATION_RELATIONSHIP: ["s", "s", "SHAPE_REPRESENTATION", "ADVANCED_BREP_SHAPE_REPRESENTATION"],
  NEXT_ASSEMBLY_USAGE_OCCURRENCE: ["s", "s", "s", "PRODUCT_DEFINITION", "PRODUCT_DEFINITION", "s?"],
  ITEM_DEFINED_TRANSFORMATION: ["s", "s", "AXIS2_PLACEMENT_3D", "AXIS2_PLACEMENT_3D"],
  CONTEXT_DEPENDENT_SHAPE_REPRESENTATION: ["REPRESENTATION_RELATIONSHIP+REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION+SHAPE_REPRESENTATION_RELATIONSHIP", "PRODUCT_DEFINITION_SHAPE"],
  UNCERTAINTY_MEASURE_WITH_UNIT: ["T(LENGTH_MEASURE)", "UNIT", "s", "s"],
  CARTESIAN_POINT: ["s", "L(r)"],
  DIRECTION: ["s", "L(r)"],
  VECTOR: ["s", "DIRECTION", "r"],
  AXIS2_PLACEMENT_3D: ["s", "CARTESIAN_POINT", "DIRECTION", "DIRECTION"],
  LINE: ["s", "CARTESIAN_POINT", "VECTOR"],
  CIRCLE: ["s", "AXIS2_PLACEMENT_3D", "r"],
  PLANE: ["s", "AXIS2_PLACEMENT_3D"],
  CYLINDRICAL_SURFACE: ["s", "AXIS2_PLACEMENT_3D", "r"],
  CONICAL_SURFACE: ["s", "AXIS2_PLACEMENT_3D", "r", "r"],
  SPHERICAL_SURFACE: ["s", "AXIS2_PLACEMENT_3D", "r"],
  TOROIDAL_SURFACE: ["s", "AXIS2_PLACEMENT_3D", "r", "r"],
  VERTEX_POINT: ["s", "CARTESIAN_POINT"],
  EDGE_CURVE: ["s", "VERTEX_POINT", "VERTEX_POINT", "LINE|CIRCLE", "b"],
  ORIENTED_EDGE: ["s", "*", "*", "EDGE_CURVE", "b"],
  EDGE_LOOP: ["s", "L(ORIENTED_EDGE)"],
  FACE_OUTER_BOUND: ["s", "EDGE_LOOP", "b"],
  FACE_BOUND: ["s", "EDGE_LOOP", "b"],
  ADVANCED_FACE: ["s", "L(FACE_OUTER_BOUND|FACE_BOUND)", "PLANE|CYLINDRICAL_SURFACE|CONICAL_SURFACE|SPHERICAL_SURFACE|TOROIDAL_SURFACE", "b"],
  CLOSED_SHELL: ["s", "L(ADVANCED_FACE)"],
  MANIFOLD_SOLID_BREP: ["s", "CLOSED_SHELL"],
  COLOUR_RGB: ["s", "r", "r", "r"],
  FILL_AREA_STYLE_COLOUR: ["s", "COLOUR_RGB"],
  FILL_AREA_STYLE: ["s", "L(FILL_AREA_STYLE_COLOUR)"],
  SURFACE_STYLE_FILL_AREA: ["FILL_AREA_STYLE"],
  SURFACE_SIDE_STYLE: ["s", "L(SURFACE_STYLE_FILL_AREA)"],
  SURFACE_STYLE_USAGE: ["e", "SURFACE_SIDE_STYLE"],
  PRESENTATION_STYLE_ASSIGNMENT: ["L(SURFACE_STYLE_USAGE)"],
  STYLED_ITEM: ["s", "L(PRESENTATION_STYLE_ASSIGNMENT)", "MANIFOLD_SOLID_BREP"],
  MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION: ["s", "L(STYLED_ITEM)", "CONTEXT"],
};
// Partial records of the complex entities used.
const PARTIAL = {
  LENGTH_UNIT: [],
  PLANE_ANGLE_UNIT: [],
  SOLID_ANGLE_UNIT: [],
  NAMED_UNIT: ["*"],
  SI_UNIT: ["e?", "e"],
  GEOMETRIC_REPRESENTATION_CONTEXT: ["i"],
  GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT: ["L(UNCERTAINTY_MEASURE_WITH_UNIT)"],
  GLOBAL_UNIT_ASSIGNED_CONTEXT: ["L(UNIT)"],
  REPRESENTATION_CONTEXT: ["s", "s"],
  REPRESENTATION_RELATIONSHIP: ["s", "s", "SHAPE_REPRESENTATION", "SHAPE_REPRESENTATION"],
  REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION: ["ITEM_DEFINED_TRANSFORMATION"],
  SHAPE_REPRESENTATION_RELATIONSHIP: [],
};
const COMPLEX = {
  CONTEXT: "GEOMETRIC_REPRESENTATION_CONTEXT+GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT+GLOBAL_UNIT_ASSIGNED_CONTEXT+REPRESENTATION_CONTEXT",
  UNIT: ["LENGTH_UNIT+NAMED_UNIT+SI_UNIT", "NAMED_UNIT+PLANE_ANGLE_UNIT+SI_UNIT", "NAMED_UNIT+SI_UNIT+SOLID_ANGLE_UNIT"],
};
const typeMatches = (e, want) =>
  want.split("|").some((w) => (w === "CONTEXT" ? e.type === COMPLEX.CONTEXT : w === "UNIT" ? COMPLEX.UNIT.includes(e.type) : e.type === w));

function checkArgs(where, args, kinds, entities, problems) {
  if (args.length !== kinds.length) return problems.push(`${where}: ${args.length} arguments, expected ${kinds.length}`);
  args.forEach((a, k) => checkValue(`${where} argument ${k + 1}`, a, kinds[k], entities, problems));
}
function checkValue(where, a, kind, entities, problems) {
  if (kind.endsWith("?")) {
    if (a.k === "unset") return;
    kind = kind.slice(0, -1);
  }
  const bad = (what) => problems.push(`${where}: ${what}, expected ${kind}`);
  if (kind.startsWith("L(")) {
    if (a.k !== "list" || !a.v.length) return bad(a.k === "list" ? "an empty list" : a.k);
    return a.v.forEach((x, i) => checkValue(`${where}[${i}]`, x, kind.slice(2, -1), entities, problems));
  }
  if (kind.startsWith("T(")) return a.k === "typed" && a.type === kind.slice(2, -1) && a.v.k === "real" ? undefined : bad(a.k);
  if (kind === "s") return a.k === "str" ? undefined : bad(a.k);
  if (kind === "r") return a.k === "real" ? undefined : bad(a.k);
  if (kind === "i") return a.k === "int" ? undefined : bad(a.k);
  if (kind === "*") return a.k === "derived" ? undefined : bad(a.k);
  if (kind === "b") return a.k === "enum" && (a.v === "T" || a.v === "F") ? undefined : bad(a.k);
  if (kind === "e") return a.k === "enum" ? undefined : bad(a.k);
  if (a.k !== "ref") return bad(a.k);
  const t = entities.get(a.v);
  if (!t) return problems.push(`${where}: #${a.v} is not defined`);
  if (!typeMatches(t, kind)) bad(`#${a.v} is ${t.type}`);
}

// ---- small vector helpers ----
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => mul(a, 1 / norm(a));
const TAU = 2 * Math.PI;

// ---- the checks ----
// tol: how far (mm) a vertex or edge point may be from a curve or surface it
// lies on: by default 1e-5 mm plus a millionth of the solid's largest coordinate.
export function checkStep(text, { tol } = {}) {
  const { problems, entities, header } = parseStep(text);
  const out = { problems, parts: [], assembly: null, entities: entities.size, counts: {} };
  if (problems.length && !entities.size) return out;
  if (!/FILE_SCHEMA\s*\(\s*\(\s*'AUTOMOTIVE_DESIGN/.test(header)) problems.push("FILE_SCHEMA is not AUTOMOTIVE_DESIGN (AP214)");
  for (const h of ["FILE_DESCRIPTION", "FILE_NAME", "FILE_SCHEMA"]) if (!header.includes(h)) problems.push(`header has no ${h}`);

  // Every entity known, with the right arguments.
  for (const e of entities.values()) {
    out.counts[e.type] = (out.counts[e.type] ?? 0) + 1;
    if (e.parts) {
      for (const p of e.parts) {
        const kinds = PARTIAL[p.type];
        if (!kinds) problems.push(`#${e.id}: unknown partial entity ${p.type}`);
        else checkArgs(`#${e.id} ${p.type}`, p.args, kinds, entities, problems);
      }
      if (![COMPLEX.CONTEXT, ...COMPLEX.UNIT, SCHEMA.CONTEXT_DEPENDENT_SHAPE_REPRESENTATION[0]].includes(e.type)) problems.push(`#${e.id}: unexpected complex entity ${e.type}`);
      continue;
    }
    const kinds = SCHEMA[e.type];
    if (!kinds) problems.push(`#${e.id}: unknown entity ${e.type}`);
    else checkArgs(`#${e.id} ${e.type}`, e.args, kinds, entities, problems);
  }
  if (problems.length) return out;

  const all = (type) => [...entities.values()].filter((e) => e.type === type);
  const get = (a) => entities.get(a.v);
  // Units: millimetres.
  const lengthUnit = all("LENGTH_UNIT+NAMED_UNIT+SI_UNIT")[0];
  const si = lengthUnit?.parts.find((p) => p.type === "SI_UNIT");
  if (!si || si.args[0].v !== "MILLI" || si.args[1].v !== "METRE") problems.push("length unit is not millimetres");
  const angle = all("NAMED_UNIT+PLANE_ANGLE_UNIT+SI_UNIT")[0];
  if (!angle || angle.parts.find((p) => p.type === "SI_UNIT").args[1].v !== "RADIAN") problems.push("plane angle unit is not radians");

  // Products: names, and which is the assembly.
  const pdOf = new Map(); // product definition id -> product name
  for (const pd of all("PRODUCT_DEFINITION")) pdOf.set(pd.id, get(get(pd.args[2]).args[2]).args[1].v);
  const uses = all("NEXT_ASSEMBLY_USAGE_OCCURRENCE");
  const parents = new Set(uses.map((u) => u.args[3].v)), children = uses.map((u) => u.args[4].v);
  if (parents.size !== 1) problems.push(`expected one assembly, found ${parents.size}`);
  const root = [...parents][0];
  out.assembly = pdOf.get(root);
  if (new Set(children).size !== children.length) problems.push("a part is used twice in the assembly");
  // Each part: product definition -> shape -> shape representation -> brep representation.
  const sdrByPd = new Map();
  for (const sdr of all("SHAPE_DEFINITION_REPRESENTATION")) {
    const def = get(get(sdr.args[0]).args[2]);
    if (def.type === "PRODUCT_DEFINITION") sdrByPd.set(def.id, get(sdr.args[1]));
  }
  const brepOf = new Map();
  for (const r of all("SHAPE_REPRESENTATION_RELATIONSHIP")) brepOf.set(r.args[2].v, get(r.args[3]));
  // Shape representations placed in the assembly (rep_1 of a relationship with a transformation).
  const placed = new Set(all(SCHEMA.CONTEXT_DEPENDENT_SHAPE_REPRESENTATION[0]).map((r) => r.parts[0].args[2].v));
  for (const c of all("CONTEXT_DEPENDENT_SHAPE_REPRESENTATION")) {
    const nauo = get(get(c.args[1]).args[2]);
    if (nauo.type !== "NEXT_ASSEMBLY_USAGE_OCCURRENCE") problems.push(`#${c.id}: not the shape of an assembly use`);
  }
  // Colours by solid.
  const colourOf = new Map();
  for (const si of all("STYLED_ITEM")) {
    const usage = get(get(si.args[1].v[0]).args[0].v[0]);
    const fill = get(get(get(usage.args[1]).args[1].v[0]).args[0]);
    const c = get(get(fill.args[1].v[0]).args[1]);
    colourOf.set(si.args[2].v, c.args.slice(1).map((a) => a.v));
  }

  for (const child of children) {
    const name = pdOf.get(child);
    const rep = sdrByPd.get(child);
    const part = { name, solids: [], volume: 0, bounds: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], faces: 0, surfaces: {} };
    out.parts.push(part);
    if (!rep) {
      problems.push(`part "${name}" has no shape`);
      continue;
    }
    if (!placed.has(rep.id)) problems.push(`part "${name}" is not placed in the assembly`);
    const brep = rep.type === "ADVANCED_BREP_SHAPE_REPRESENTATION" ? rep : brepOf.get(rep.id);
    if (!brep) {
      problems.push(`part "${name}" has no solid`);
      continue;
    }
    for (const ref of brep.args[1].v) {
      const solid = checkSolid(get(ref), entities, tol, problems, `part "${name}"`);
      solid.colour = colourOf.get(ref.v) ?? null;
      part.solids.push(solid);
      part.volume += solid.volume;
      part.faces += solid.faces;
      for (const [k, v] of Object.entries(solid.surfaces)) part.surfaces[k] = (part.surfaces[k] ?? 0) + v;
      for (let k = 0; k < 3; k++) {
        part.bounds[k] = Math.min(part.bounds[k], solid.bounds[k]);
        part.bounds[k + 3] = Math.max(part.bounds[k + 3], solid.bounds[k + 3]);
      }
    }
    part.colour = part.solids[0]?.colour ?? null;
  }
  return out;
}

// Geometry of the entities a solid uses.
function geometry(entities) {
  const get = (id) => entities.get(id);
  const P = (id) => get(id).args[1].v.map((x) => x.v);
  const D = (id) => unit(get(id).args[1].v.map((x) => x.v));
  const frame = (id) => {
    const a = get(id).args;
    const o = P(a[1].v), z = D(a[2].v), xr = D(a[3].v);
    const x = unit(sub(xr, mul(z, dot(xr, z))));
    return { o, x, y: cross(z, x), z };
  };
  const local = (f, p) => {
    const d = sub(p, f.o);
    return [dot(d, f.x), dot(d, f.y), dot(d, f.z)];
  };
  const world = (f, [a, b, c]) => addv(f.o, addv(mul(f.x, a), addv(mul(f.y, b), mul(f.z, c))));
  return { get, P, D, frame, local, world };
}

// A surface: distance from it, and for curved ones (u, v) coordinates and
// g(v) = (x - o) . (dx/du cross dx/dv), the integrand of the volume.
function surfaceOf(e, G) {
  const f = G.frame(e.args[1].v);
  const t = e.type;
  if (t === "PLANE") return { type: "plane", f, dist: (p) => Math.abs(G.local(f, p)[2]) };
  if (t === "CYLINDRICAL_SURFACE") {
    const r = e.args[2].v;
    return { type: "cylinder", f, dist: (p) => { const q = G.local(f, p); return Math.abs(Math.hypot(q[0], q[1]) - r); }, uv: (q) => [Math.atan2(q[1], q[0]), q[2]], g: () => r * r, pole: () => false, at: (u, v) => G.world(f, [r * Math.cos(u), r * Math.sin(u), v]) };
  }
  if (t === "CONICAL_SURFACE") {
    const R = e.args[2].v, a = e.args[3].v, ta = Math.tan(a);
    if (!(a > 0 && a < Math.PI / 2) || R < 0) return { bad: `cone half angle ${a} or radius ${R} out of range` };
    const rho = (v) => R + v * ta;
    return {
      type: "cone", f,
      dist: (p) => { const q = G.local(f, p); return Math.abs(Math.hypot(q[0], q[1]) - rho(q[2])) * Math.cos(a) + (rho(q[2]) < -1e-9 ? Math.abs(rho(q[2])) : 0); },
      uv: (q) => [Math.atan2(q[1], q[0]), q[2]], g: (v) => rho(v) * R, pole: (q) => Math.abs(rho(q[2])) < 1e-9 * (1 + R),
      at: (u, v) => G.world(f, [rho(v) * Math.cos(u), rho(v) * Math.sin(u), v]),
    };
  }
  if (t === "SPHERICAL_SURFACE") {
    const r = e.args[2].v;
    return {
      type: "sphere", f,
      dist: (p) => Math.abs(norm(sub(p, f.o)) - r),
      uv: (q) => [Math.atan2(q[1], q[0]), Math.atan2(q[2], Math.hypot(q[0], q[1]))], g: (v) => r ** 3 * Math.cos(v), pole: (q) => Math.hypot(q[0], q[1]) < 1e-9 * r,
      at: (u, v) => G.world(f, [r * Math.cos(v) * Math.cos(u), r * Math.cos(v) * Math.sin(u), r * Math.sin(v)]),
    };
  }
  if (t === "TOROIDAL_SURFACE") {
    const R = e.args[2].v, r = e.args[3].v;
    if (!(R > r && r > 0)) return { bad: `torus radii ${R}, ${r} out of range` };
    return {
      type: "torus", f, periodicV: true,
      dist: (p) => { const q = G.local(f, p); return Math.abs(Math.hypot(Math.hypot(q[0], q[1]) - R, q[2]) - r); },
      uv: (q) => [Math.atan2(q[1], q[0]), Math.atan2(q[2], Math.hypot(q[0], q[1]) - R)], g: (v) => r * (R + r * Math.cos(v)) * (R * Math.cos(v) + r), pole: () => false,
      at: (u, v) => G.world(f, [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]),
    };
  }
  return { bad: `unknown surface ${t}` };
}

// A curve: distance from it, and points along an edge on it.
function curveOf(e, G) {
  if (e.type === "LINE") {
    const o = G.P(e.args[1].v), vec = G.get(e.args[2].v), d = G.D(vec.args[1].v);
    if (!(vec.args[2].v > 0)) return { bad: "line vector of no length" };
    return { type: "line", dist: (p) => norm(cross(sub(p, o), d)), points: (a, b, n) => Array.from({ length: n + 1 }, (_, k) => addv(a, mul(sub(b, a), k / n))), area: (a, b) => mul(cross(a, b), 0.5) };
  }
  const f = G.frame(e.args[1].v), r = e.args[2].v;
  if (!(r > 0)) return { bad: "circle of no radius" };
  return {
    type: "circle",
    dist: (p) => { const q = G.local(f, p); return Math.hypot(q[2], Math.hypot(q[0], q[1]) - r); },
    // From a to b, counterclockwise about the axis if same, else clockwise;
    // a full turn when a and b are the same point.
    points: (a, b, n, same, closed) => {
      const { ta, sweep } = arc(a, b, same, closed);
      const k = Math.max(4, Math.ceil((n * Math.abs(sweep)) / TAU));
      const pts = Array.from({ length: k + 1 }, (_, j) => { const t = ta + (sweep * j) / k; return G.world(f, [r * Math.cos(t), r * Math.sin(t), 0]); });
      pts[0] = a;
      pts[k] = b;
      return pts;
    },
    // Half the integral of p cross dp along the arc, exactly.
    area: (a, b, same, closed) => {
      const { ta, sweep } = arc(a, b, same, closed), tb = ta + sweep;
      const chord = addv(mul(f.x, Math.cos(tb) - Math.cos(ta)), mul(f.y, Math.sin(tb) - Math.sin(ta)));
      return mul(addv(mul(cross(f.o, chord), r), mul(f.z, r * r * sweep)), 0.5);
    },
  };
  function arc(a, b, same, closed) {
    const ta = Math.atan2(...[1, 0].map((k) => G.local(f, a)[k]));
    const tb = Math.atan2(...[1, 0].map((k) => G.local(f, b)[k]));
    let sw = same ? tb - ta : ta - tb;
    sw = ((sw % TAU) + TAU) % TAU;
    if (closed) sw = TAU;
    return { ta, sweep: same ? sw : -sw };
  }
}

function checkSolid(brep, entities, tolIn, problems, where) {
  const G = geometry(entities);
  const shell = G.get(brep.args[1].v);
  const out = { name: brep.args[0].v, faces: 0, surfaces: {}, volume: 0, bounds: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], maxOff: 0, faceData: [] };
  const faces = shell.args[1].v.map((r) => G.get(r.v));
  out.faces = faces.length;
  // Tolerance from the solid's size.
  let big = 0;
  const points = (id) => G.P(G.get(id).args[1].v);
  const edgeIds = new Set();
  for (const f of faces) for (const b of f.args[1].v) for (const oe of G.get(G.get(b.v).args[1].v).args[1].v) edgeIds.add(G.get(oe.v).args[3].v);
  for (const id of edgeIds) for (const k of [1, 2]) big = Math.max(big, ...points(G.get(id).args[k].v).map(Math.abs));
  const tol = tolIn ?? 1e-5 + 1e-6 * big;
  const off = (what, d) => {
    out.maxOff = Math.max(out.maxOff, d);
    if (d > tol) problems.push(`${where}: ${what} is ${d.toExponential(2)} mm off (tolerance ${tol.toExponential(2)})`);
  };
  const box = (p) => {
    for (let k = 0; k < 3; k++) (out.bounds[k] = Math.min(out.bounds[k], p[k])), (out.bounds[k + 3] = Math.max(out.bounds[k + 3], p[k]));
  };

  const curves = new Map(), uses = new Map(), facesOfEdge = new Map();
  const curve = (id) => curves.get(id) ?? (curves.set(id, curveOf(G.get(id), G)), curves.get(id));
  let volume = 0;
  for (const face of faces) {
    const surf = surfaceOf(G.get(face.args[2].v), G);
    if (surf.bad) {
      problems.push(`${where}: face #${face.id}: ${surf.bad}`);
      continue;
    }
    out.surfaces[surf.type] = (out.surfaces[surf.type] ?? 0) + 1;
    const same = face.args[3].v === "T";
    const bounds = face.args[1].v.map((r) => G.get(r.v));
    if (bounds.filter((b) => b.type === "FACE_OUTER_BOUND").length > 1) problems.push(`${where}: face #${face.id} has more than one outer bound`);
    let vecArea = [0, 0, 0], S = 0;
    const domain = [], loops3 = [];
    for (const b of bounds) {
      const loopSense = b.args[2].v === "T";
      let oes = G.get(b.args[1].v).args[1].v.map((r) => G.get(r.v));
      if (!loopSense) oes = oes.reverse();
      // Walk the loop: each oriented edge from its start to its end.
      const walk = [];
      let prevEnd = null, firstStart = null;
      for (const oe of oes) {
        const ec = G.get(oe.args[3].v);
        const fw = (oe.args[4].v === "T") === loopSense;
        const [a, bb] = fw ? [ec.args[1].v, ec.args[2].v] : [ec.args[2].v, ec.args[1].v];
        if (prevEnd !== null && prevEnd !== a) problems.push(`${where}: face #${face.id}: loop #${b.args[1].v} is not closed at #${oe.id}`);
        if (firstStart === null) firstStart = a;
        prevEnd = bb;
        const u = uses.get(ec.id) ?? [];
        u.push(fw ? 1 : -1);
        uses.set(ec.id, u);
        const fs = facesOfEdge.get(ec.id) ?? [];
        fs.push(surf);
        facesOfEdge.set(ec.id, fs);
        // Vertices on the curve and on this face's surface.
        const c = curve(ec.args[3].v);
        if (c.bad) {
          problems.push(`${where}: edge #${ec.id}: ${c.bad}`);
          continue;
        }
        const pa = points(ec.args[1].v), pb = points(ec.args[2].v);
        off(`vertex #${ec.args[1].v} from the curve of edge #${ec.id}`, c.dist(pa));
        off(`vertex #${ec.args[2].v} from the curve of edge #${ec.id}`, c.dist(pb));
        // Points along the edge, in the curve's direction, then turned to the loop's.
        const sameSense = ec.args[4].v === "T";
        const flat = surf.type === "plane", closed = ec.args[1].v === ec.args[2].v;
        const steps = c.type === "line" ? (flat ? 1 : 256) : flat ? 256 : 4096;
        let pts = c.type === "line" ? c.points(pa, pb, steps) : c.points(pa, pb, steps, sameSense, closed);
        const ea = c.area(pa, pb, sameSense, closed);
        vecArea = addv(vecArea, fw ? ea : mul(ea, -1));
        if (c.type === "line" && !sameSense) problems.push(`${where}: edge #${ec.id}: a line edge that runs against its line`);
        if (!fw) pts = pts.slice().reverse();
        for (const p of [pts[0], pts[pts.length - 1], pts[pts.length >> 1]]) off(`a point of edge #${ec.id} from face #${face.id}`, surf.dist(p));
        walk.push(...pts.slice(0, -1));
      }
      if (prevEnd !== firstStart) problems.push(`${where}: face #${face.id}: loop #${b.args[1].v} does not end where it starts`);
      for (const p of walk) box(p);
      loops3.push(walk);
      if (surf.type !== "plane") {
        const r = loopIntegral(walk, surf, same, G);
        if (!r.closed) problems.push(`${where}: face #${face.id}: loop #${b.args[1].v} does not close on its surface`);
        S += r.S;
        domain.push(r.uv);
      }
    }
    // Flux of x/3 through the face.
    if (surf.type === "plane") {
      const n = mul(surf.f.z, same ? 1 : -1);
      const a = norm(vecArea);
      if (a > 0 && dot(vecArea, n) < 0.999 * a) problems.push(`${where}: face #${face.id}: its loops do not go round its outward normal the right way`);
      volume += dot(surf.f.o, vecArea) / 3;
    } else {
      volume += (S + dot(surf.f.o, vecArea)) / 3;
      // The box: points of the face inside its loops, on a grid in (u, v).
      for (const p of facePoints(domain, surf)) box(p);
    }
    // What the face is, as read, for drawing it (render-step.mjs).
    out.faceData.push({ surf, same, loops: loops3, uv: domain });
  }
  for (const [id, u] of uses) {
    if (u.length !== 2 || u[0] + u[1] !== 0) problems.push(`${where}: edge #${id} is used ${u.length} times (${u.map((s) => (s > 0 ? "+" : "-")).join("")}), not once each way`);
  }
  // Points along each edge lie on both faces it bounds.
  for (const [id, fs] of facesOfEdge) {
    const ec = G.get(id), c = curve(ec.args[3].v);
    if (c.bad) continue;
    const pa = points(ec.args[1].v), pb = points(ec.args[2].v);
    const pts = c.type === "line" ? c.points(pa, pb, 4) : c.points(pa, pb, 16, ec.args[4].v === "T", ec.args[1].v === ec.args[2].v);
    for (const s of fs) for (const p of pts) off(`a point of edge #${id} from a face it bounds`, s.dist(p));
  }
  out.volume = volume;
  if (!(volume > 0)) problems.push(`${where}: volume ${volume} is not positive (faces point inward)`);
  return out;
}

// The integral of u g(v) dv round a loop on a curved surface, with u (and v
// on a torus) followed continuously. At a pole (a point on the axis) u is
// free: the loop goes along the pole from the u it came in at to the u it
// leaves at, the way that keeps the face on its left.
function loopIntegral(pts, surf, same, G) {
  const q = pts.map((p) => G.local(surf.f, p));
  const n = q.length;
  const start = q.findIndex((p) => !surf.pole(p));
  if (start < 0) return { S: 0, uv: [], closed: false };
  const uv = [];
  let lastU = null, lastV = null, pole = null;
  const near = (x, ref) => (ref === null ? x : x + TAU * Math.round((ref - x) / TAU));
  // Round the loop from a point off the axis, and back to it.
  for (let k = 0; k <= n; k++) {
    const p = q[(start + k) % n];
    let [u, v] = surf.uv(p);
    if (surf.periodicV) v = near(v, lastV);
    if (surf.pole(p)) {
      pole = v;
      lastV = v;
      continue;
    }
    if (pole !== null) {
      // North pole (above its neighbours) with the face on the left of a
      // loop that is counterclockwise in (u, v): u goes down along it;
      // at a south pole up; on a clockwise loop the other way.
      const down = pole > v === same;
      let d = (((u - lastU) % TAU) + TAU) % TAU;
      if (down) d = d === 0 ? -TAU : d - TAU;
      else if (d === 0) d = TAU;
      uv.push([lastU, pole], [lastU + d, pole]);
      u = lastU + d;
      pole = null;
    } else u = near(u, lastU);
    uv.push([u, v]);
    lastU = u;
    lastV = v;
  }
  const [a, b] = [uv[0], uv[uv.length - 1]];
  const closed = Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  let S = 0;
  for (let i = 0; i + 1 < uv.length; i++) {
    const [u0, v0] = uv[i], [u1, v1] = uv[i + 1];
    S += 0.5 * (u0 * surf.g(v0) + u1 * surf.g(v1)) * (v1 - v0);
  }
  return { S, uv, closed };
}

// Points of a curved face: a grid in (u, v) over its loops' range, kept
// where inside the loops (even-odd).
function facePoints(fine, surf) {
  // The loops thinned to at most ~300 points each, for speed (the box is
  // checked to a fraction of a cell, not to the last micrometre).
  const domain = fine.map((l) => l.filter((_, i) => i % Math.ceil(l.length / 300) === 0));
  const all = domain.flat();
  if (!all.length) return [];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [u, v] of all) (u0 = Math.min(u0, u)), (u1 = Math.max(u1, u)), (v0 = Math.min(v0, v)), (v1 = Math.max(v1, v));
  const out = [];
  const N = 40;
  for (let i = 0; i <= N; i++)
    for (let j = 0; j <= N; j++) {
      const u = u0 + ((u1 - u0) * (i + 0.5)) / (N + 1), v = v0 + ((v1 - v0) * (j + 0.5)) / (N + 1);
      let s = false;
      for (const loop of domain)
        for (let a = 0, b = loop.length - 1; a < loop.length; b = a++) {
          const [ua, va] = loop[a], [ub, vb] = loop[b];
          if (va > v !== vb > v && u < ((ub - ua) * (v - va)) / (vb - va) + ua) s = !s;
        }
      if (s) out.push(surf.at(u, v));
    }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node test/check-step.mjs model.step");
    process.exit(2);
  }
  const text = readFileSync(file, "latin1");
  const r = checkStep(text);
  const mb = (Buffer.byteLength(text) / 1e6).toFixed(2);
  console.log(`${file}: ${mb} MB, ${r.entities} entities, assembly "${r.assembly}", ${r.parts.length} parts`);
  for (const p of r.parts) {
    const b = p.bounds.map((x) => x.toFixed(2));
    console.log(`  ${p.name}: ${p.solids.length} solid${p.solids.length === 1 ? "" : "s"}, ${p.faces} faces (${Object.entries(p.surfaces).map(([k, v]) => `${v} ${k}`).join(", ")}), volume ${p.volume.toFixed(1)} mm3, box [${b.slice(0, 3)}] to [${b.slice(3)}]`);
  }
  console.log(r.problems.length ? `${r.problems.length} problems:\n${r.problems.slice(0, 40).join("\n")}` : "no problems");
  process.exit(r.problems.length ? 1 : 0);
}
