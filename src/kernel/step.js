// STEP export (ISO 10303-21 file, AP214 "automotive design" schema): one
// assembly of named, coloured parts, each a closed solid (MANIFOLD_SOLID_BREP)
// in millimetres. A part whose shape is known exactly (brep.js) is written
// with true planes, cylinders, cones, spheres and tori bounded by lines and
// circles; any other part is written as flat faces made from its mesh
// (facets.js).
//
// AP214 rather than AP242: every CAD program that reads STEP reads AP214,
// it carries part names, colours and assemblies, and this file uses nothing
// AP242 adds (tessellated shapes, product manufacturing information).
// Only the most common entities are used: ADVANCED_BREP_SHAPE_REPRESENTATION,
// MANIFOLD_SOLID_BREP, CLOSED_SHELL, ADVANCED_FACE, FACE_OUTER_BOUND,
// FACE_BOUND, EDGE_LOOP, ORIENTED_EDGE, EDGE_CURVE, VERTEX_POINT, LINE,
// CIRCLE and the five elementary surfaces. Full circles and closed surfaces
// have one vertex and a seam edge, as most CAD programs write them.

import { exactSolids } from "./brep.js";
import { facetedSolids } from "./facets.js";

export const SCHEMA = "AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }";

// A string as Part 21 writes it: ' doubled, \ doubled, anything outside
// printable ASCII as \X2\ UTF-16 hex \X0\.
export function stepString(s) {
  let out = "";
  let wide = "";
  const flush = () => {
    if (wide) out += `\\X2\\${wide}\\X0\\`;
    wide = "";
  };
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += ch === "'" ? "''" : ch === "\\" ? "\\\\" : ch;
    } else {
      for (let i = 0; i < ch.length; i++) wide += ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
    }
  }
  flush();
  return `'${out}'`;
}

// A real as Part 21 writes it: always with a decimal point ("1.", "-0.5",
// "1.5E-07"). Lengths are kept to 1e-9 mm, directions to 12 digits.
export function stepReal(v, digits = 12) {
  if (!Number.isFinite(v)) throw new Error(`STEP: not a number (${v})`);
  let s = Number(v.toPrecision(digits)).toString().toUpperCase();
  if (s === "-0") s = "0";
  const [m, e] = s.split("E");
  const mant = m.includes(".") ? m : `${m}.`;
  return e ? `${mant}E${e[0] === "-" ? "-" : ""}${e.replace(/^[+-]/, "").padStart(2, "0")}` : mant;
}
const len = (v) => stepReal(Math.round(v * 1e9) / 1e9, 15);

// "#8d939a" -> [r, g, b] in 0..1; anything else -> the app's default grey.
function rgb(c) {
  let m = /^#?([0-9a-f]{6})$/i.exec(String(c ?? ""));
  if (!m) {
    const s = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(String(c ?? ""));
    m = s ? [0, s[1] + s[1] + s[2] + s[2] + s[3] + s[3]] : [0, "9aa3ad"];
  }
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
}

// Writes the file. parts: [{ name, color, solids }], solids as brep.js makes
// them. opts: { title, file (the file name in the header), time (an ISO
// date-time; default now), tol (the file's length uncertainty, mm) }.
export function writeSTEP(parts, { title = "", file = "model.step", time = new Date().toISOString().slice(0, 19), tol = 1e-6 } = {}) {
  const lines = [];
  let n = 0;
  const add = (text) => {
    lines.push(`#${++n}=${text};`);
    return `#${n}`;
  };
  const list = (xs) => `(${xs.join(",")})`;
  const S = stepString;

  // Contexts and units.
  const app = add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${app})`);
  const prodCtx = add(`PRODUCT_CONTEXT('',${app},'mechanical')`);
  const defCtx = add(`PRODUCT_DEFINITION_CONTEXT('part definition',${app},'design')`);
  const mm = add("( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )");
  const rad = add("( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )");
  const sr = add("( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )");
  const unc = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${stepReal(tol, 6)}),${mm},'distance_accuracy_value','confusion accuracy')`);
  const ctx = add(`( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},${rad},${sr})) REPRESENTATION_CONTEXT('3D','3D context in millimetres') )`);

  const point = (p) => add(`CARTESIAN_POINT('',(${p.map(len).join(",")}))`);
  const direction = (d) => add(`DIRECTION('',(${d.map((x) => stepReal(Math.abs(x) < 1e-13 ? 0 : x, 10)).join(",")}))`);
  // o: a point already written (a vertex's, by its #id), or [x, y, z].
  // x: a direction already written (by its #id), or [x, y, z].
  const placement = (o, z, x) => add(`AXIS2_PLACEMENT_3D('',${typeof o === "string" ? o : point(o)},${direction(z)},${typeof x === "string" ? x : direction(x)})`);

  // Products: the assembly and one per part.
  const products = [];
  const product = (name, i) => {
    const p = add(`PRODUCT(${S(i)},${S(name)},'',(${prodCtx}))`);
    products.push(p);
    const pdf = add(`PRODUCT_DEFINITION_FORMATION('','',${p})`);
    const pd = add(`PRODUCT_DEFINITION('design','',${pdf},${defCtx})`);
    const pds = add(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
    return { pd, pds };
  };
  const top = product(title || "Model", "assembly");
  const topAxis = placement([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const topItems = [topAxis];
  const topRep = { id: null };
  const styled = [];
  const later = [];
  let faces = 0;

  parts.forEach((part, pi) => {
    const { pd, pds } = product(part.name, `part ${pi + 1}`);
    const axis = placement([0, 0, 0], [0, 0, 1], [1, 0, 0]);
    const rep = add(`SHAPE_REPRESENTATION(${S(part.name)},(${axis}),${ctx})`);
    add(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);
    const breps = part.solids.map((solid, si) => {
      faces += solid.faces.length;
      return writeSolid(solid, `${part.name}${part.solids.length > 1 ? ` ${si + 1}` : ""}`);
    });
    const brepRep = add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${S(part.name)},${list(breps)},${ctx})`);
    add(`SHAPE_REPRESENTATION_RELATIONSHIP('','',${rep},${brepRep})`);
    // The part in the assembly, where it is (the parts are already placed).
    const at = placement([0, 0, 0], [0, 0, 1], [1, 0, 0]);
    topItems.push(at);
    later.push({ pd, rep, axis, at, name: part.name, i: pi + 1 });
    const [r, g, b] = rgb(part.color);
    const colour = add(`COLOUR_RGB('',${stepReal(r, 6)},${stepReal(g, 6)},${stepReal(b, 6)})`);
    const fill = add(`FILL_AREA_STYLE('',(${add(`FILL_AREA_STYLE_COLOUR('',${colour})`)}))`);
    const side = add(`SURFACE_SIDE_STYLE('',(${add(`SURFACE_STYLE_FILL_AREA(${fill})`)}))`);
    const style = add(`PRESENTATION_STYLE_ASSIGNMENT((${add(`SURFACE_STYLE_USAGE(.BOTH.,${side})`)}))`);
    for (const brep of breps) styled.push(add(`STYLED_ITEM('color',(${style}),${brep})`));
  });
  topRep.id = add(`SHAPE_REPRESENTATION(${S(title || "Model")},${list(topItems)},${ctx})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(${top.pds},${topRep.id})`);
  for (const { pd, rep, axis, at, name, i } of later) {
    const use = add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE(${S(`NAUO${i}`)},${S(name)},'',${top.pd},${pd},$)`);
    const useShape = add(`PRODUCT_DEFINITION_SHAPE('Placement','',${use})`);
    const move = add(`ITEM_DEFINED_TRANSFORMATION('','',${axis},${at})`);
    const rel = add(`( REPRESENTATION_RELATIONSHIP('','',${rep},${topRep.id}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(${move}) SHAPE_REPRESENTATION_RELATIONSHIP() )`);
    add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(${rel},${useShape})`);
  }
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,${list(products)})`);
  if (styled.length) add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',${list(styled)},${ctx})`);

  function writeSolid(solid, name) {
    const vs = new Map(), ps = new Map(), es = new Map(), lineDir = new Map();
    // A vertex's point is also where the lines from it start, and where a
    // flat face made from a mesh is placed.
    const VP = (v) => {
      if (!ps.has(v)) ps.set(v, point(v.p));
      return ps.get(v);
    };
    const V = (v) => {
      if (!vs.has(v)) vs.set(v, add(`VERTEX_POINT('',${VP(v)})`));
      return vs.get(v);
    };
    const E = (e) => {
      if (es.has(e)) return es.get(e);
      const a = V(e.v0), b = V(e.v1);
      let curve, same = true;
      if (!e.curve) {
        const d = [0, 1, 2].map((k) => e.v1.p[k] - e.v0.p[k]), l = Math.hypot(...d);
        if (!(l > 0)) throw new Error(`STEP: an edge of "${name}" has no length`);
        const dir = direction(d.map((x) => x / l));
        lineDir.set(e, dir);
        curve = add(`LINE('',${VP(e.v0)},${add(`VECTOR('',${dir},${len(l)})`)})`);
      } else {
        const { o, z, x, r } = e.curve;
        curve = add(`CIRCLE('',${placement(o, z, x)},${len(r)})`);
        // Which way the edge goes round: the circle's own way is
        // counterclockwise about its axis.
        const p = e.v0.p, q = e.via;
        const u = [p[0] - o[0], p[1] - o[1], p[2] - o[2]], w = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
        same = (u[1] * w[2] - u[2] * w[1]) * z[0] + (u[2] * w[0] - u[0] * w[2]) * z[1] + (u[0] * w[1] - u[1] * w[0]) * z[2] > 0;
      }
      es.set(e, add(`EDGE_CURVE('',${a},${b},${curve},${same ? ".T." : ".F."})`));
      return es.get(e);
    };
    const faceIds = solid.faces.map((f) => {
      const bounds = f.loops.map((loop, li) => {
        const oes = loop.map(([e, fw]) => add(`ORIENTED_EDGE('',*,*,${E(e)},${fw ? ".T." : ".F."})`));
        const lp = add(`EDGE_LOOP('',${list(oes)})`);
        return add(`${li === 0 ? "FACE_OUTER_BOUND" : "FACE_BOUND"}('',${lp},.T.)`);
      });
      // A flat face from a mesh is placed at a corner, its x along an edge
      // from there (sharing that point and that direction).
      const s = f.surf, at = placement(s.at ? VP(s.at) : s.o, s.z, (s.xEdge && lineDir.get(s.xEdge)) || s.x);
      const surf =
        s.type === "plane" ? add(`PLANE('',${at})`)
        : s.type === "cylinder" ? add(`CYLINDRICAL_SURFACE('',${at},${len(s.r)})`)
        : s.type === "cone" ? add(`CONICAL_SURFACE('',${at},${len(s.r)},${stepReal(s.semi)})`)
        : s.type === "sphere" ? add(`SPHERICAL_SURFACE('',${at},${len(s.r)})`)
        : s.type === "torus" ? add(`TOROIDAL_SURFACE('',${at},${len(s.R)},${len(s.r)})`)
        : null;
      if (!surf) throw new Error(`STEP: unknown surface ${s.type}`);
      return add(`ADVANCED_FACE('',${list(bounds)},${surf},${f.same ? ".T." : ".F."})`);
    });
    const shell = add(`CLOSED_SHELL('',${list(faceIds)})`);
    return add(`MANIFOLD_SOLID_BREP(${S(name)},${shell})`);
  }

  const header = [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION((${S(`${title || "Model"}, ${parts.length} part${parts.length === 1 ? "" : "s"}`)}),'2;1');`,
    `FILE_NAME(${S(file)},${S(time)},(''),(''),'Draftsman','Draftsman','');`,
    `FILE_SCHEMA(('${SCHEMA}'));`,
    "ENDSEC;",
    "DATA;",
  ];
  return { text: `${header.join("\n")}\n${lines.join("\n")}\nENDSEC;\nEND-ISO-10303-21;\n`, entities: n, faces };
}

// ---- parts to solids ----
// Faceted parts are written from their own mesh, made coarser than the STL's
// so the file stays a sane size: 1000 surface cells (roughly twice as many
// triangles) plus 400 per faceted part, at most FACET_CELLS, over all
// faceted parts together, shared out by surface area, at least FACET_MIN per
// part. Thin parts get more, as the mesher refines them. Flat faces merge,
// so flat parts cost far less.
export const FACET_CELLS = 6000;
export const FACET_MIN = 150;

// Mesh detail for the faceted parts (null where a part is exact), from the
// meshes on screen, as kernel.js sizes STL exports: a part meshed at cell s
// with T triangles has about T/2 surface cells, (s/c)^2 times as many at c.
export function facetDetail(parts, cells = Math.min(FACET_CELLS, 1000 + 400 * parts.filter(Boolean).length)) {
  const est = parts.map((p) => (p ? (p.mesh.indices.length / 6) * p.mesh.cellSize ** 2 || 1 : 0));
  const cell = Math.sqrt(est.reduce((a, b) => a + b, 0) / cells) || Infinity;
  return { cell, budgets: est.map((e) => Math.max(FACET_MIN, Math.round(e / cell ** 2))) };
}

// The exact solids of each part, or null where it needs facets.
export function exactParts(parts) {
  return parts.map((p) => {
    try {
      return exactSolids(p.node);
    } catch {
      return null;
    }
  });
}

// parts: [{ name, color, node }]; meshes: for the parts with no exact form,
// a closed mesh each ({ positions, indices }), by index (others undefined).
// exact: what exactParts gave.
export function partsToSTEP(parts, exact, meshes, opts = {}) {
  let tol = 1e-6;
  const solids = parts.map((p, i) => {
    if (exact[i]) return { name: p.name, color: p.color, solids: exact[i], exact: true };
    const s = facetedSolids(meshes[i]);
    tol = Math.max(tol, ...s.map((q) => q.tol));
    return { name: p.name, color: p.color, solids: s, exact: false };
  });
  const { text, entities, faces } = writeSTEP(solids, { ...opts, tol: opts.tol ?? tol });
  return {
    text,
    entities,
    faces,
    exact: solids.filter((s) => s.exact).map((s) => s.name),
    faceted: solids.filter((s) => !s.exact).map((s) => s.name),
  };
}
