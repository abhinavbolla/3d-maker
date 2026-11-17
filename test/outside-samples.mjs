// Writes the mesh files (glTF, OBJ with its MTL, PLY, STL) and DXF files that
// outside programs are asked to open, and what the kernel says each holds.
// The files are made as the app makes them (src/app/kernel.js): each part
// meshed with meshPart, and for glTF and OBJ its vertices split along sharp
// edges with displayMesh. The numbers in expected.json come from the kernel's
// own meshes and drawing marks, not from reading the files back.
// .github/workflows/outside-programs.yml opens the mesh files in Blender
// (test/blender-check.py) and the DXF files in FreeCAD (test/freecad-dxf-check.py).
// Usage: node test/outside-samples.mjs out-dir
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runScript } from "../src/kernel/script.js";
import { compile } from "../src/kernel/sdf.js";
import { meshSDF, meshVolume, meshBounds, openEdges, displayMesh, toSTL } from "../src/kernel/mesh.js";
import { meshPart } from "../src/kernel/pieces.js";
import { toGLB, lookOf, LOOKS, srgb, toLinear } from "../src/kernel/gltf.js";
import { toOBJ, objWithMtl, mtlFileName, materialName } from "../src/kernel/obj.js";
import { toPLY } from "../src/kernel/ply.js";
import { drawingSVG, sectionCut } from "../src/kernel/drawing.js";
import { sheetDXF, outlineDXF } from "../src/kernel/dxf.js";
import { readSheet } from "../src/kernel/svgread.js";

const out = process.argv[2];
if (!out) {
  console.error("Usage: node test/outside-samples.mjs out-dir");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const model = (f) => readFileSync(new URL(`./models/${f}`, import.meta.url), "utf8");

// Every look, a part that turns, and shapes whose volumes are known by hand.
const LOOKS_SCRIPT = `title("Five looks");
part("Base", box(120, 80, 10).at(0, 0, 5), { color: "#4f7cac" });
part("Shaft", cylinder(8, 60).at(0, 0, 40), { color: "#8d939a", spin: { axis: "z", rpm: 60 } });
part("Knob", sphere(15).at(40, 20, 25), { color: "#d9a441", material: "plastic" });
part("Foot", box(20, 20, 6).at(-45, -25, -3), { color: "#222222" });
part("Cover", box(40, 2, 40).at(-30, 30, 30), { color: "#aaccee", material: "glass" });`;
const BY_HAND = { Base: 120 * 80 * 10, Shaft: Math.PI * 64 * 60, Knob: (4 / 3) * Math.PI * 15 ** 3, Foot: 20 * 20 * 6, Cover: 40 * 2 * 40, Cylinder: Math.PI * 400 * 60 };

const SAMPLES = [
  { name: "five-looks", script: LOOKS_SCRIPT },
  { name: "cylinder", script: model("step/simple-cylinder.js") },
  { name: "bracket", script: model("bracket.js") },
  { name: "rotor-head", script: model("claude-rotor-head.js"), budget: 4000 },
];

// Edges by vertex position, as a program that merges coincident vertices
// sees them: how many have one face (holes), two, or more (where closed
// shells of one part touch along an edge).
function edgesByPosition({ positions: p, indices: t }) {
  const ids = new Map();
  const id = (v) => {
    const k = `${Math.fround(p[v * 3])},${Math.fround(p[v * 3 + 1])},${Math.fround(p[v * 3 + 2])}`;
    if (!ids.has(k)) ids.set(k, ids.size);
    return ids.get(k);
  };
  const faces = new Map();
  let degenerate = 0;
  for (let n = 0; n < t.length; n += 3) {
    const [a, b, c] = [id(t[n]), id(t[n + 1]), id(t[n + 2])];
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = u < v ? `${u},${v}` : `${v},${u}`;
      faces.set(k, (faces.get(k) ?? 0) + 1);
    }
  }
  const by = { one: 0, two: 0, more: 0, odd: 0 };
  for (const n of faces.values()) {
    if (n === 1) by.one++;
    else if (n === 2) by.two++;
    else by.more++;
    if (n % 2) by.odd++;
  }
  return { vertices: ids.size, edges: faces.size, degenerate, ...by };
}

const expected = { mesh: {}, dxf: {} };
const r3 = (v) => Math.round(v * 1000) / 1000;

for (const s of SAMPLES) {
  const r = runScript(s.script);
  if (r.error) throw new Error(`${s.name}: ${r.error}`);
  const shown = r.parts.filter((p) => !p.hidden);
  const budget = s.budget ?? 6000;
  // As exportMeshes does: closed meshes for STL and PLY; with normals,
  // split along sharp edges, for glTF and OBJ.
  const plain = shown.map((p) => ({ name: p.name, color: p.color, ...meshPart(p.node, { budget }) }));
  const withNormals = shown.map((p) => ({ name: p.name, color: p.color, material: p.material, frames: p.frames, ...displayMesh(meshPart(p.node, { budget, normals: true })) }));
  for (const m of plain) if (openEdges(m) || m.incomplete) throw new Error(`${s.name}: ${m.name} is not closed as meshed`);

  writeFileSync(join(out, `${s.name}.glb`), toGLB(withNormals, { title: r.title, motion: r.motion }));
  const { obj, mtl } = toOBJ(withNormals, { title: r.title });
  writeFileSync(join(out, `${s.name}.obj`), objWithMtl(obj, mtlFileName(`${s.name}.obj`)));
  writeFileSync(join(out, mtlFileName(`${s.name}.obj`)), mtl);
  writeFileSync(join(out, `${s.name}.ply`), toPLY(plain, { title: r.title }));
  writeFileSync(join(out, `${s.name}.stl`), toSTL(plain));

  const part = (m, i, p) => {
    const look = lookOf(p);
    const L = LOOKS[look];
    return {
      name: m.name,
      triangles: m.indices.length / 3,
      bounds: meshBounds(m).map(r3),
      volume: meshVolume(m),
      solid_volume: p.volume ?? null,
      by_hand_volume: s.name === "five-looks" || s.name === "cylinder" ? BY_HAND[m.name] ?? null : null,
      edges: edgesByPosition(m),
      look,
      color_srgb: srgb(m.color),
      base_color: [...srgb(m.color).map(toLinear), L.alpha ?? 1],
      metallic: L.metallic,
      roughness: L.roughness,
      alpha: L.alpha ?? 1,
      mtl_name: materialName(m.name, i),
      gltf_material: `${m.name} (${look})`,
    };
  };
  const meshParts = (list) => list.map((m, i) => part(m, i, { ...shown[i], volume: plain[i].volume }));
  const moving = withNormals.filter((m) => m.frames?.length).map((m) => m.name);
  expected.mesh[s.name] = {
    title: r.title,
    // glTF and OBJ: split along sharp edges; PLY and STL: as meshed.
    split: meshParts(withNormals),
    plain: meshParts(plain),
    motion: r.motion && moving.length ? { loop_seconds: r.motion.loop, moving } : null,
  };
  const tris = plain.reduce((a, m) => a + m.indices.length / 3, 0);
  console.log(`${s.name}: ${shown.length} parts, ${tris} triangles as meshed, ${withNormals.reduce((a, m) => a + m.indices.length / 3, 0)} split${r.motion ? `, motion ${r.motion.loop} s` : ""}`);
}

// ---- DXF ----
// What sheetDXF writes for each mark: the same rules as src/kernel/dxf.js.
function sheetEntities(svg) {
  const { w, h, marks } = readSheet(svg);
  const counts = {}, byLayer = {}, edgesByLayer = {};
  const circles = [];
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const take = (x, y) => ((box[0] = Math.min(box[0], x)), (box[1] = Math.min(box[1], y)), (box[2] = Math.max(box[2], x)), (box[3] = Math.max(box[3], y)));
  let lineEdges = 0;
  for (const m of marks) {
    const layer = m.layer || "0";
    let type = null, edges = 0;
    if (m.kind === "line") {
      const n = m.pts.length / 2;
      type = n === 2 && !m.closed ? "LINE" : "POLYLINE";
      edges = m.closed ? n : n - 1;
    } else if (m.kind === "fill") {
      type = m.pts.length <= 8 ? "SOLID" : "POLYLINE";
      edges = m.pts.length / 2;
    } else if (m.kind === "circle" || m.kind === "disc") {
      type = "CIRCLE";
      circles.push({ layer, cx: m.cx, cy: h - m.cy, r: m.r });
      take(m.cx - m.r, h - m.cy - m.r), take(m.cx + m.r, h - m.cy + m.r);
    } else if (m.kind === "text") type = "TEXT";
    if (!type) continue;
    if (m.pts) for (let i = 0; i < m.pts.length; i += 2) take(m.pts[i], h - m.pts[i + 1]);
    counts[type] = (counts[type] ?? 0) + 1;
    byLayer[layer] ??= {};
    byLayer[layer][type] = (byLayer[layer][type] ?? 0) + 1;
    if (type !== "TEXT" && type !== "CIRCLE") {
      edgesByLayer[layer] = (edgesByLayer[layer] ?? 0) + edges;
      lineEdges += edges;
    }
  }
  return { sheet: [w, h], counts, byLayer, edgesByLayer, lineEdges, circles, box };
}

{
  // The angle bracket's drawing sheet, with hidden lines and a section.
  const r = runScript(model("bracket.js"));
  const parts = r.parts.map((p) => {
    const c = compile(p.node);
    const m = meshSDF(c.f, c.box, { budget: 30000 });
    return { name: p.name, node: p.node, ...c, positions: m.positions, indices: m.indices };
  });
  const { svg } = drawingSVG(parts, { title: r.title, date: "2026-01-31", hidden: true });
  const text = sheetDXF(svg);
  writeFileSync(join(out, "bracket-sheet.dxf"), text);
  const e = sheetEntities(svg);
  // The known circle: the biggest one on the sheet (the projection symbol's).
  const known = [...e.circles].sort((a, b) => b.r - a.r)[0];
  expected.dxf["bracket-sheet.dxf"] = { kind: "sheet", ...e, known_circle: known };
  console.log(`bracket-sheet.dxf: ${JSON.stringify(e.counts)}, ${e.circles.length} circles, extents ${e.box.map(r3)}`);

  // A plate's outline at 1:1: 120 x 80, four 9 mm holes and a 20 mm bore.
  const holes = [[-45, -25], [45, -25], [-45, 25], [45, 25]].map(([x, y]) => ({ t: "move", v: [x, y, 0], c: { t: "cylinder", r: 4.5, h: 20 } }));
  const node = { t: "subtract", a: { t: "box", s: [120, 80, 6] }, b: [...holes, { t: "cylinder", r: 10, h: 20 }] };
  const c = compile(node);
  const m = meshSDF(c.f, c.box, { budget: 30000 });
  const cut = sectionCut([{ name: "Plate", node, ...c, positions: m.positions, indices: m.indices }], { axis: "z", offset: 0 });
  const o = outlineDXF({ loops: cut.parts.flatMap((p) => p.loops) });
  writeFileSync(join(out, "plate-outline.dxf"), o.text);
  // By hand: the plate's corners, the bore at the middle.
  expected.dxf["plate-outline.dxf"] = {
    kind: "outline",
    counts: { CIRCLE: o.circles, POLYLINE: o.loops + o.lines },
    byLayer: { OUTLINE: { CIRCLE: o.circles, POLYLINE: o.loops + o.lines } },
    lineEdges: 4,
    edgesByLayer: { OUTLINE: 4 },
    circles: [[-45, -25, 4.5], [45, -25, 4.5], [-45, 25, 4.5], [45, 25, 4.5], [0, 0, 10]].map(([cx, cy, r]) => ({ layer: "OUTLINE", cx, cy, r })),
    box: [-60, -40, 60, 40],
    known_circle: { layer: "OUTLINE", cx: 0, cy: 0, r: 10 },
  };
  console.log(`plate-outline.dxf: ${o.circles} circles, ${o.loops} loops, ${o.lines} lines, box ${o.box.map(r3)}`);
}

writeFileSync(join(out, "expected.json"), JSON.stringify(expected, null, 1));
