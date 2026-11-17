// Kernel tests: exact volumes for simple shapes, closed meshes for thousands
// of random shapes, the example scripts, and script error messages.
// Usage: node test/kernel.test.mjs [word]   (with a word, only tests whose name has it)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compile, threadRoot } from "../src/kernel/sdf.js";
import { checkPairs } from "../src/kernel/fit.js";
import { meshSDF, meshVolume, meshBounds, openEdges, toSTL, displayMesh, lightMesh } from "../src/kernel/mesh.js";
import { runScript } from "../src/kernel/script.js";
import { to3MF } from "../src/kernel/threemf.js";
import { meshPart, splitPieces } from "../src/kernel/pieces.js";
import { convexHullPlanes } from "../src/kernel/hull.js";
import { viewOutline, sectionCut, sectionView, sectionPlane, modelBounds, drawingSVG, titleLines, textWidth, LIMITS } from "../src/kernel/drawing.js";
import { check3MF } from "./check-3mf.mjs";
import { toGLB, lookOf } from "../src/kernel/gltf.js";
import { toOBJ, objWithMtl, mtlFileName } from "../src/kernel/obj.js";
import { toPLY } from "../src/kernel/ply.js";
import { apply } from "../src/kernel/motion.js";
import { checkGLB, checkOBJ, checkPLY } from "./check-meshfile.mjs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { exactSolids } from "../src/kernel/brep.js";
import { facetedSolids } from "../src/kernel/facets.js";
import { writeSTEP, exactParts } from "../src/kernel/step.js";
import { checkStep } from "./check-step.mjs";

const mesh = (node, budget = 40000) => {
  const { f, box } = compile(node);
  return meshSDF(f, box, { budget });
};

// Closedness the way slicers see it: by vertex position, not index.
function closedByPosition(m) {
  const stl = toSTL([m]);
  const dv = new DataView(stl.buffer);
  const ids = new Map();
  const edges = new Map();
  const vid = (o) => {
    const k = [0, 4, 8].map((d) => dv.getFloat32(o + d, true).toFixed(4)).join();
    if (!ids.has(k)) ids.set(k, ids.size);
    return ids.get(k);
  };
  for (let i = 0; i < dv.getUint32(80, true); i++) {
    const o = 84 + i * 50 + 12;
    const [a, b, c] = [vid(o), vid(o + 12), vid(o + 24)];
    if (a === b || b === c || a === c) return false;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const e = u < v ? `${u}-${v}` : `${v}-${u}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  return [...edges.values()].every((n) => n === 2);
}

// Tests run one after another, in order; a test may be async.
let passed = 0;
let queue = Promise.resolve();
const only = process.argv[2];
const test = (name, fn) => {
  if (only && !name.includes(only)) return;
  queue = queue.then(async () => {
    const t = performance.now();
    await fn();
    passed++;
    console.log(`ok  ${name} (${Math.round(performance.now() - t)} ms)`);
  });
};

test("volumes of simple shapes", () => {
  const cases = [
    [{ t: "sphere", r: 20 }, (4 / 3) * Math.PI * 8000],
    [{ t: "box", s: [40, 30, 20] }, 24000],
    [{ t: "cylinder", r: 10, h: 30 }, Math.PI * 3000],
    [{ t: "cone", r1: 10, r2: 4, h: 20 }, ((Math.PI * 20) / 3) * 156],
    [{ t: "torus", R: 20, r: 5 }, 2 * Math.PI ** 2 * 500],
    [{ t: "extrude", pts: [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]], h: 8 }, 4000],
    [{ t: "subtract", a: { t: "box", s: [40, 40, 40] }, b: [{ t: "cylinder", r: 10, h: 50 }] }, 64000 - Math.PI * 100 * 40],
  ];
  for (const [node, exact] of cases) {
    const m = mesh(node);
    assert.equal(openEdges(m), 0, `${node.t} is not closed`);
    const err = Math.abs(meshVolume(m) / exact - 1);
    assert.ok(err < 0.005, `${node.t} volume off by ${(err * 100).toFixed(2)}%`);
  }
});

test("sharp corners stay sharp", () => {
  const m = mesh({ t: "box", s: [40, 30, 20] });
  let corner = 0;
  // A rounded corner would be 0.3 to 0.5 of a cell away; sharp ones land within a few percent.
  const tol = m.cellSize * 0.06;
  for (let i = 0; i < m.positions.length; i += 3) if ([0, 1, 2].every((a) => Math.abs(Math.abs(m.positions[i + a]) - [20, 15, 10][a]) < tol)) corner++;
  assert.equal(corner, 8);
});

// How wrong the shading is: the angle between the normal the screen
// interpolates across each triangle and the true surface normal there,
// sampled at four points per triangle. Returns sorted angles in degrees.
function shadingError(f, { positions: P, indices: I, normals: N }) {
  const out = [];
  for (let n = 0; n < I.length; n += 3) {
    const [a, b, c] = [I[n] * 3, I[n + 1] * 3, I[n + 2] * 3];
    for (const [wa, wb, wc] of [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]]) {
      const [x, y, z] = [0, 1, 2].map((i) => wa * P[a + i] + wb * P[b + i] + wc * P[c + i]);
      const nn = [0, 1, 2].map((i) => wa * N[a + i] + wb * N[b + i] + wc * N[c + i]);
      const e = 1e-3;
      const g = [f(x + e, y, z) - f(x - e, y, z), f(x, y + e, z) - f(x, y - e, z), f(x, y, z + e) - f(x, y, z - e)];
      const cos = (nn[0] * g[0] + nn[1] * g[1] + nn[2] * g[2]) / (Math.hypot(...nn) * Math.hypot(...g));
      out.push((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
    }
  }
  return out.sort((x, y) => x - y);
}
const pct = (arr, q) => arr[Math.floor(arr.length * q)];
const meshOf = (node, opts) => {
  const { f, box } = compile(node);
  return meshSDF(f, box, opts);
};

test("sharp edges are drawn sharp, smooth surfaces smooth", () => {
  // A machined block: flat faces, sharp edges, a bore and a round boss.
  const node = { t: "subtract", a: { t: "union", c: [{ t: "box", s: [80, 60, 30] }, { t: "move", v: [0, 0, 20], c: { t: "cylinder", r: 15, h: 20 } }] }, b: [{ t: "cylinder", r: 8, h: 100 }] };
  const { f, box } = compile(node);
  const m = meshSDF(f, box, { budget: 6000, normals: true });
  const d = displayMesh(m);
  // Same surface: every triangle corner is where it was.
  assert.equal(d.indices.length, m.indices.length);
  for (let n = 0; n < m.indices.length; n++) for (let a = 0; a < 3; a++) assert.equal(d.positions[d.indices[n] * 3 + a], m.positions[m.indices[n] * 3 + a]);
  const before = shadingError(f, m);
  const after = shadingError(f, d);
  assert.ok(pct(after, 0.9) < 2, `shading error p90 ${pct(after, 0.9).toFixed(1)} deg`);
  assert.ok(pct(after, 0.9) < pct(before, 0.9) / 4, `p90 ${pct(before, 0.9).toFixed(1)} -> ${pct(after, 0.9).toFixed(1)} deg`);
  // A box corner gets three copies, each facing straight out of one face.
  const b = displayMesh(meshOf({ t: "box", s: [40, 30, 20] }, { normals: true }));
  const at = [];
  for (let i = 0; i < b.positions.length; i += 3) if (Math.hypot(b.positions[i] - 20, b.positions[i + 1] - 15, b.positions[i + 2] - 10) < 0.5) at.push([...b.normals.slice(i, i + 3)].map((v) => Math.round(v * 10) / 10));
  assert.deepEqual(at.map(String).sort(), ["0,0,1", "0,1,0", "1,0,0"]);
  // A sphere has no edges, so no vertex is split.
  const s = meshOf({ t: "sphere", r: 20 }, { normals: true });
  assert.equal(displayMesh(s).positions.length, s.positions.length);
});

test("with the distance function, small fillets are shaded round and sharp edges stay crisp", () => {
  // [shape, budget, p99 before (deg), p99 now must be under]: the shading
  // error without and with the distance function given to displayMesh.
  const cases = [
    // A 3 mm fillet at 2.6 mm cells: before, its faces were split apart and shaded flat.
    [{ t: "box", s: [40, 30, 20], r: 3 }, 1500, 9],
    [{ t: "torus", R: 20, r: 5 }, 1500, 3],
    [{ t: "sphere", r: 20 }, 1500, 0.5],
    [{ t: "cylinder", r: 10, h: 30 }, 6000, 1],
    // Sharp edges: shaded flat to the edge.
    [{ t: "subtract", a: { t: "union", c: [{ t: "box", s: [80, 60, 30] }, { t: "move", v: [0, 0, 20], c: { t: "cylinder", r: 15, h: 20 } }] }, b: [{ t: "cylinder", r: 8, h: 100 }] }, 6000, 1],
  ];
  for (const [node, budget, limit] of cases) {
    const { f, box } = compile(node);
    const m = meshSDF(f, box, { budget, normals: true });
    const before = shadingError(f, displayMesh(m));
    const d = displayMesh(m, undefined, f);
    const after = shadingError(f, d);
    const what = `${node.t} at budget ${budget}: p90 ${pct(before, 0.9).toFixed(1)} -> ${pct(after, 0.9).toFixed(1)}, p99 ${pct(before, 0.99).toFixed(1)} -> ${pct(after, 0.99).toFixed(1)} deg`;
    assert.ok(pct(after, 0.99) < limit, what);
    assert.ok(pct(after, 0.9) <= pct(before, 0.9) + 0.05, what);
    // The same surface, and every triangle corner where it was.
    assert.equal(d.indices.length, m.indices.length);
    for (let n = 0; n < m.indices.length; n += 7) for (let a = 0; a < 3; a++) assert.equal(d.positions[d.indices[n] * 3 + a], m.positions[m.indices[n] * 3 + a]);
  }
  // The filleted block's 3 mm fillets were shaded in facets: p90 26 degrees.
  const { f, box } = compile({ t: "box", s: [40, 30, 20], r: 3 });
  const r = meshSDF(f, box, { budget: 1500, normals: true });
  assert.ok(pct(shadingError(f, displayMesh(r, undefined, f)), 0.9) < 4);
  // A box corner still gets three copies, each facing straight out of one face.
  const b = compile({ t: "box", s: [40, 30, 20] });
  const bd = displayMesh(meshSDF(b.f, b.box, { normals: true }), undefined, b.f);
  const at = [];
  for (let i = 0; i < bd.positions.length; i += 3) if (Math.hypot(bd.positions[i] - 20, bd.positions[i + 1] - 15, bd.positions[i + 2] - 10) < 0.5) at.push([...bd.normals.slice(i, i + 3)].map((v) => Math.round(v * 100) / 100));
  assert.deepEqual(at.map(String).sort(), ["0,0,1", "0,1,0", "1,0,0"]);
});

test("the lighter copy of a mesh keeps its shape with far fewer triangles", () => {
  // Signed volume of a triangle mesh; it is only meaningful for a closed one.
  const volume = ({ positions: P, indices: I }) => {
    let v = 0;
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
      v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
    }
    return v / 6;
  };
  // A machined block with a bore and a boss.
  const node = { t: "subtract", a: { t: "union", c: [{ t: "box", s: [80, 60, 30] }, { t: "move", v: [0, 0, 20], c: { t: "cylinder", r: 15, h: 20 } }] }, b: [{ t: "cylinder", r: 8, h: 100 }] };
  const { f, box } = compile(node);
  const m = meshSDF(f, box, { budget: 40000, normals: true });
  const d = displayMesh(m);
  const l = lightMesh(d, m.cellSize * 3);
  assert.ok(l.indices.length < d.indices.length / 5, `${d.indices.length / 3} -> ${l.indices.length / 3} triangles`);
  assert.equal(l.normals.length, l.positions.length);
  for (const i of l.indices) assert.ok(i < l.positions.length / 3);
  // Every vertex is still on the surface, to within a cell.
  let off = 0;
  for (let i = 0; i < l.positions.length; i += 3) off = Math.max(off, Math.abs(f(l.positions[i], l.positions[i + 1], l.positions[i + 2])));
  assert.ok(off < m.cellSize * 3, `a vertex is ${off.toFixed(2)} mm off the surface (cell ${m.cellSize.toFixed(2)} mm)`);
  // The same solid: its volume and its overall size.
  assert.ok(Math.abs(volume(l) / volume(d) - 1) < 0.03, `volume ${volume(d).toFixed(0)} -> ${volume(l).toFixed(0)} mm3`);
  const [bd, bl] = [meshBounds(d), meshBounds(l)];
  for (let a = 0; a < 6; a++) assert.ok(Math.abs(bd[a] - bl[a]) < m.cellSize * 3, `bounds ${bd} -> ${bl}`);
  // A plate thinner than the merging cell keeps both its skins.
  const pm = meshPart({ t: "box", s: [200, 120, 4] }, { budget: 40000, normals: true });
  assert.ok(pm.indices.length > 3000 && pm.cellSize < 4, `the plate has ${pm.indices.length / 3} triangles at ${pm.cellSize.toFixed(2)} mm`);
  const pl = lightMesh(displayMesh(pm), 12);
  let up = 0, down = 0;
  for (let t = 0; t < pl.indices.length; t += 3) {
    const [a, b, c] = [pl.indices[t] * 3, pl.indices[t + 1] * 3, pl.indices[t + 2] * 3];
    const P = pl.positions;
    const nz = (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]);
    if (nz > 0) up += nz / 2;
    else down -= nz / 2;
  }
  assert.ok(up > 200 * 120 * 0.8 && down > 200 * 120 * 0.8, `the plate's top covers ${up.toFixed(0)} mm2 and its underside ${down.toFixed(0)} mm2 of 24000`);
});

test("a union of many parts gives exactly the nearest part's distance", () => {
  // Spheres and boxes spread out and overlapping, as in an assembly.
  const kids = [];
  for (let i = 0; i < 12; i++) {
    const at = [((i * 37) % 11) * 9 - 45, ((i * 53) % 7) * 12 - 36, ((i * 29) % 5) * 10 - 20];
    kids.push(i % 2 ? { t: "move", v: at, c: { t: "sphere", r: 6 + (i % 4) * 3 } } : { t: "move", v: at, c: { t: "box", s: [10 + i, 8, 14 - (i % 3)] } });
  }
  const u = compile({ t: "union", c: kids });
  const each = kids.map(compile);
  let x = 0.5;
  const rand = () => ((x = (x * 9301 + 49297) % 233280), (x / 233280) * 160 - 80);
  for (let n = 0; n < 4000; n++) {
    const p = [rand(), rand(), rand()];
    const want = Math.min(...each.map((q) => q.f(...p)));
    assert.ok(Math.abs(u.f(...p) - want) < 1e-12, `at ${p} union gives ${u.f(...p)}, nearest part ${want}`);
  }
});

test("3MF export: a valid zip with one named, coloured, closed object per part", async () => {
  const shapes = [
    ["Base & plate", "#8d939a", { t: "box", s: [40, 30, 6], r: 1 }],
    ['Knob "A"', "#c0603a", { t: "move", v: [0, 0, 12], c: { t: "sphere", r: 7 } }],
  ];
  const objects = shapes.map(([name, color, node]) => {
    const { f, box } = compile(node);
    return { name, color, ...meshSDF(f, box, { budget: 8000 }) };
  });
  const bytes = await to3MF(objects, { title: "Test <plate>" });
  const r = check3MF(Buffer.from(bytes));
  assert.deepEqual(r.problems, []);
  assert.equal(r.title, "Test &lt;plate&gt;");
  assert.deepEqual(r.objects.map((o) => [o.name, o.color, o.triangles]), objects.map((o) => [o.name, `${o.color.toUpperCase()}FF`, o.indices.length / 3]));
});

test("STEP: exact solids have the exact volumes of boxes, cylinders, cones, spheres, tori, capsules, extrusions and revolves", () => {
  const PI = Math.PI;
  const holes = { t: "subtract2", a: { t: "rect2", w: 40, h: 30, r: 5 }, b: [{ t: "move2", v: [10, 0], c: { t: "circle2", r: 3 } }, { t: "move2", v: [-10, 0], c: { t: "circle2", r: 3 } }] };
  const cases = [
    [{ t: "box", s: [10, 20, 30], r: 0 }, 6000, { plane: 6 }],
    [{ t: "cylinder", r: 5, h: 10, round: 0 }, PI * 250, { plane: 2, cylinder: 1 }],
    [{ t: "cone", r1: 5, r2: 2, h: 10 }, ((PI * 10) / 3) * 39, { plane: 2, cone: 1 }],
    [{ t: "cone", r1: 5, r2: 0, h: 10 }, ((PI * 10) / 3) * 25, { plane: 1, cone: 1 }],
    [{ t: "sphere", r: 7 }, (4 / 3) * PI * 343, { sphere: 1 }],
    [{ t: "torus", R: 10, r: 3 }, 2 * PI * PI * 10 * 9, { torus: 1 }],
    [{ t: "capsule", a: [0, 0, 0], b: [10, 5, 3], r1: 2, r2: 2 }, PI * 4 * Math.hypot(10, 5, 3) + (4 / 3) * PI * 8, { sphere: 2, cylinder: 1 }],
    [{ t: "rotate", deg: [10, 20, 30], c: { t: "move", v: [5, 0, 0], c: { t: "box", s: [10, 20, 30], r: 0 } } }, 6000, { plane: 6 }],
    [{ t: "mirror", axis: 0, c: { t: "move", v: [5, 1, 2], c: { t: "cone", r1: 5, r2: 2, h: 10 } } }, ((PI * 10) / 3) * 39, { plane: 2, cone: 1 }],
    [{ t: "extrude", p: holes, h: 5 }, (40 * 30 - (4 - PI) * 25 - 2 * PI * 9) * 5, { plane: 6, cylinder: 6 }],
    [{ t: "revolve", p: { t: "move2", v: [7, 0], c: { t: "rect2", w: 4, h: 10 } } }, PI * (81 - 25) * 10, { plane: 2, cylinder: 2 }],
    [{ t: "revolve", p: { t: "move2", v: [4, 0], c: { t: "rect2", w: 4, h: 6 } }, angle: 90 }, (PI / 4) * 32 * 6, { plane: 4, cylinder: 2 }],
    [{ t: "revolve", p: { t: "subtract2", a: { t: "move2", v: [10, 0], c: { t: "rect2", w: 8, h: 8 } }, b: [{ t: "move2", v: [10, 0], c: { t: "circle2", r: 2 } }] } }, 2 * PI * 10 * (64 - PI * 4), { plane: 2, cylinder: 2, torus: 1 }],
    [{ t: "symmetric", axis: 1, c: { t: "move", v: [0, 20, 0], c: { t: "sphere", r: 5 } } }, (8 / 3) * PI * 125, { sphere: 2 }],
  ];
  for (const [node, volume, surfaces] of cases) {
    const solids = exactSolids(node);
    assert.ok(solids, `${node.t} comes out exact`);
    const r = checkStep(writeSTEP([{ name: node.t, color: "#4f7cac", solids }], { time: "2026-01-01T00:00:00" }).text, { tol: 1e-7 });
    assert.deepEqual(r.problems, [], node.t);
    const p = r.parts[0];
    assert.deepEqual(p.surfaces, surfaces, `${node.t}: ${JSON.stringify(p.surfaces)}`);
    assert.ok(Math.abs(p.volume - volume) < 1e-6 * volume, `${node.t}: volume ${p.volume}, exact ${volume}`);
  }
});

test("STEP: script shapes come out exact where they can, and match the kernel's meshes", () => {
  const r = runScript(`
    part("Plate", extrude(rect(80, 40, 6).cut(circle(6).move(-25, 0), circle(6).move(25, 0)), 8).at(0, -150, 4));
    part("Slot", extrude(path([0, 0]).line(40, 0).arc([50, 10], [40, 20]).line(0, 20).close(), 5).rotateX(30).at(10, 20, 30));
    part("Cam", extrude(path([0, 0]).line(40, 0).tangentArc(40, 20).line(0, 20).radiusArc(0, 0, 10).close(), 2));
    part("Lid", extrude(polygon([[0, 0], [60, 0], [60, 30], [20, 45], [0, 30]], 6), 4).at(100, 0, 0));
    part("Bearing", revolve(rect(10, 8).cut(circle(2)).move(20, 0)));
    part("Pin", cylinder(4, 30, 1).rotateY(90).at(0, 0, 50));
    part("Knob", union(sphere(8).at(0, 0, 100), torus(20, 3).at(0, 0, 80), cone(10, 0, 20).at(50, 50, 50)));
    part("Rod", capsule([0, 0, 0], [30, 10, 5], 4, 2).at(-50, 0, 0));
    part("Feet", cylinder(3, 10).at(40, 0, 0).radial(6));
    part("Block", box(20, 20, 20).cut(cylinder(5, 30)));
    part("Blend", union(sphere(10), sphere(8).at(12, 0, 0), 4));
    part("Rounded", box(20, 20, 20, 2));
  `);
  const exact = exactParts(r.parts);
  assert.deepEqual(r.parts.filter((p, i) => !exact[i]).map((p) => p.name), ["Block", "Blend", "Rounded"]);
  r.parts.forEach((p, i) => {
    if (!exact[i]) return;
    const { f, box } = compile(p.node);
    const m = meshSDF(f, box, { budget: 30000 });
    const c = checkStep(writeSTEP([{ name: p.name, color: p.color, solids: exact[i] }], { time: "x" }).text, { tol: 1e-6 });
    assert.deepEqual(c.problems, [], p.name);
    const q = c.parts[0], mv = meshVolume(m), mb = meshBounds(m);
    assert.ok(Math.abs(q.volume - mv) < 0.005 * mv, `${p.name}: volume ${q.volume}, mesh ${mv}`);
    q.bounds.forEach((x, k) => assert.ok(Math.abs(x - mb[k]) < m.cellSize, `${p.name}: box ${q.bounds}, mesh ${mb}`));
  });
  // The arcs the script drew are arcs in the file: the slot's end is one
  // cylinder face, not 90 flat ones.
  const slot = checkStep(writeSTEP([{ name: "Slot", solids: exact[1] }], { time: "x" }).text).parts[0];
  assert.deepEqual(slot.surfaces, { plane: 5, cylinder: 1 });
});

test("STEP: a faceted part is a closed solid with its mesh's volume, and flat faces merge", () => {
  const cases = [
    // An L of two boxes that overlap: flat all over, so a few big faces (and
    // slivers where the mesh rounds its corners a little).
    ["L", { t: "union", c: [{ t: "box", s: [60, 40, 5], r: 0 }, { t: "move", v: [-27.5, 0, 15], c: { t: "box", s: [5, 40, 30], r: 0 } }] }, 0.04],
    ["Blend", { t: "union", c: [{ t: "sphere", r: 10 }, { t: "move", v: [12, 0, 0], c: { t: "sphere", r: 8 } }], k: 4 }, null],
    ["Two pieces", { t: "union", c: [{ t: "subtract", a: { t: "box", s: [10, 10, 10], r: 0 }, b: [{ t: "sphere", r: 6 }] }, { t: "move", v: [30, 0, 0], c: { t: "box", s: [10, 10, 10], r: 1 } }] }, null],
  ];
  for (const [name, node, maxFaces] of cases) {
    const { f, box } = compile(node);
    const m = meshSDF(f, box, { budget: 6000 });
    const solids = facetedSolids(m);
    const r = checkStep(writeSTEP([{ name, color: "#888", solids }], { time: "x" }).text);
    assert.deepEqual(r.problems, [], name);
    const p = r.parts[0], mv = meshVolume(m);
    assert.ok(Math.abs(p.volume - mv) < 1e-6 * mv, `${name}: volume ${p.volume}, mesh ${mv}`);
    assert.deepEqual(Object.keys(p.surfaces), ["plane"]);
    if (maxFaces) assert.ok(p.faces <= maxFaces * m.indices.length / 3, `${name}: ${p.faces} faces from ${m.indices.length / 3} triangles`);
    if (name === "Two pieces") assert.equal(p.solids.length, 2);
  }
});

test("STEP: names, colours and the assembly read back, and the checker finds broken files", () => {
  const parts = [
    { name: "Base 'A' \\ Größe", color: "#4f7cac", solids: exactSolids({ t: "box", s: [40, 40, 10], r: 0 }) },
    { name: "Peg", color: "#d9a441", solids: exactSolids({ t: "move", v: [0, 0, 12], c: { t: "cylinder", r: 5, h: 20, round: 0 } }) },
  ];
  const { text } = writeSTEP(parts, { title: "Peg & base", time: "2026-01-01T00:00:00" });
  const r = checkStep(text);
  assert.deepEqual(r.problems, []);
  assert.equal(r.assembly, "Peg & base");
  assert.deepEqual(r.parts.map((p) => p.name), ["Base 'A' \\ Größe", "Peg"]);
  assert.match(text, /PRODUCT\('part 1','Base ''A'' \\\\ Gr\\X2\\00F600DF\\X0\\e'/);
  assert.deepEqual(r.parts.map((p) => p.colour.map((c) => Math.round(c * 255))), [[0x4f, 0x7c, 0xac], [0xd9, 0xa4, 0x41]]);
  // Broken on purpose: each of these must be found.
  const breaks = [
    [/ADVANCED_FACE\('',\((#\d+)\),(#\d+),\.T\.\)/, "ADVANCED_FACE('',($1),$2,.F.)", /volume|not positive|right way/],
    [/ORIENTED_EDGE\('',\*,\*,(#\d+),\.T\.\)/, "ORIENTED_EDGE('',*,*,$1,.F.)", /not closed|once each way/],
    [/CIRCLE\('',(#\d+),5\.\)/, "CIRCLE('',$1,5.1)", /off/],
    [/VECTOR\('',(#\d+),([\d.]+)\)/, "VECTOR('',$1)", /arguments/],
    [/#1=APPLICATION_CONTEXT/, "#1=APPLICATION_CONTEXT_X", /unknown entity/],
    [/(EDGE_LOOP\('',\()#\d+,/, "$1#999999,", /not defined/],
  ];
  for (const [find, put, want] of breaks) {
    assert.ok(find.test(text), String(find));
    const b = checkStep(text.replace(find, put));
    assert.ok(b.problems.some((p) => want.test(p)), `${find}: ${b.problems.slice(0, 3).join("; ") || "no problems found"}`);
  }
});

test("small pieces of a big part keep their detail, and the volume stays right", () => {
  // A 600 mm plate with 8 M10 bolts on it: meshed whole, the plate's cells
  // are too big for a bolt head; in pieces, each bolt gets its own.
  const r = runScript('let p = box(600, 600, 20);\nconst bolts = [];\nfor (let i = 0; i < 8; i++) bolts.push(bolt("M10", 30, { thread: false }).at(-250 + i * 70, 0, 10));\npart("Plate", p.add(bolts));');
  const node = r.parts[0].node;
  assert.ok(splitPieces(node).length > 8, "the plate and every bolt are pieces");
  const whole = compile(node);
  const one = meshSDF(whole.f, whole.box, { budget: 6000 });
  const split = meshPart(node, { budget: 6000 });
  assert.ok(!split.incomplete, "every piece is closed");
  // Each piece is its own closed shell: every edge used exactly twice.
  assert.equal(openEdges(split), 0, "the mesh in pieces is closed");
  assert.ok(split.indices.length > 3 * one.indices.length, `${split.indices.length / 3} triangles in pieces, ${one.indices.length / 3} whole`);
  // Same volume as meshing it whole very finely.
  const fine = meshSDF(whole.f, whole.box, { budget: 400000 });
  const v = meshVolume(fine);
  assert.ok(Math.abs(split.volume - v) / v < 0.002, `volume ${split.volume} in pieces, ${v} whole`);
  // A part with no small pieces is meshed exactly as before.
  const cube = compile({ t: "box", s: [10, 10, 10] });
  assert.equal(meshPart({ t: "box", s: [10, 10, 10] }, { budget: 2000 }).indices.length, meshSDF(cube.f, cube.box, { budget: 2000 }).indices.length);
});

test("views: a solid from side, top and front outlines", () => {
  // Side: x -50..50, z 30..70. Top: x -40..60, y -5..15. Front: a circle at
  // height 50 that clips the corners. The solid is what all three share.
  const r = runScript('const b = views({ side: rect(100, 40).move(0, 50), top: rect(100, 20).move(10, 5), front: circle(19).move(5, 50) });\nprint(bounds(b));\npart("A", b);');
  assert.equal(r.error, undefined);
  const b = JSON.parse(r.prints[0]);
  assert.deepEqual(b.min.map(Math.round), [-40, -5, 31]);
  assert.deepEqual(b.max.map(Math.round), [50, 15, 69]);
  const { f, box } = compile(r.parts[0].node);
  const v = meshVolume(meshSDF(f, box, { budget: 40000 }));
  // 90 mm long, cross-section = the 20 x 40 rectangle inside the circle.
  assert.ok(v > 90 * 600 && v < 90 * 800, `volume ${v}`);
  assert.match(runScript('part("A", views({ side: rect(10, 10) }));').error, /at least two/);
  assert.match(runScript('part("A", views({ side: rect(10, 10), back: rect(10, 10) }));').error, /unknown option "back"/);
});

test("views with round: rounded sections sized by the side and top outlines", () => {
  // Side: x -50..50, z 30..70. Top: x -50..50, y -5..15. round 2 makes every
  // section an ellipse 20 wide and 40 tall: an elliptic cylinder.
  const shape = (opts) => `views({ side: rect(100, 40).move(0, 50), top: rect(100, 20).move(0, 5), ${opts} })`;
  const r = runScript(`const b = ${shape("round: 2")};\nprint(bounds(b));\npart("A", b);`);
  assert.equal(r.error, undefined, r.error);
  const b = JSON.parse(r.prints[0]);
  assert.deepEqual(b.min.slice(1).map(Math.round), [-5, 30]);
  assert.deepEqual(b.max.slice(1).map(Math.round), [15, 70]);
  assert.ok(b.min[0] < -49 && b.max[0] > 49, `length ${b.min[0]}..${b.max[0]}`);
  close(volumeOf(`part("A", ${shape("round: 2")});`), Math.PI * 10 * 20 * 100, 0.03, "oval body");
  // Higher round fills out towards the box; tumble narrows the top half.
  const square = volumeOf(`part("A", ${shape("round: 8")});`);
  assert.ok(square > 0.9 * 20 * 40 * 100 && square < 20 * 40 * 100, `round 8 volume ${square}`);
  const leaning = volumeOf(`part("A", ${shape("round: 8, tumble: 0.3")});`);
  assert.ok(leaning < square * 0.97, `tumble ${leaning} vs ${square}`);
  // A table changes the section along the length: square at one end, oval at the other.
  const mixed = volumeOf(`part("A", ${shape("round: [[-50, 8], [50, 2]]")});`);
  assert.ok(mixed < square && mixed > Math.PI * 10 * 20 * 100, `mixed volume ${mixed}`);
  assert.match(runScript(`part("A", views({ side: rect(10, 10), top: rect(10, 10), front: rect(10, 10), round: 3 }));`).error, /leave out front/);
  assert.match(runScript(`part("A", views({ side: rect(10, 10), top: rect(10, 10), tumble: 0.2 }));`).error, /go with round/);
});

test("thin edges and thin rods come out whole, not bitten or speckled", () => {
  // A twisted wing whose trailing edge tapers to nothing: along the span,
  // its edge in the mesh must follow a smooth line, without bites a cell
  // deep (they were, before flat parts were meshed stretched).
  const wing = runScript('part("W", loft([[0, airfoil("0012", 200).move(-50, 0).rotate(6)], [1500, airfoil("0012", 200).move(-50, 0).rotate(-4)]]).rotateX(-90));');
  const m = meshPart(wing.parts[0].node, { budget: 6000 });
  const P = m.positions, bins = Math.floor(1290 / (2 * m.cellSize)), te = new Array(bins).fill(-Infinity);
  for (let i = 0; i < P.length; i += 3) {
    const b = Math.floor(((P[i + 1] - 105) / 1290) * bins);
    if (b >= 0 && b < bins) te[b] = Math.max(te[b], P[i]);
  }
  const worst = Math.max(...te.map((v, b) => Math.max(...te.slice(Math.max(0, b - 3), b + 4)) - v));
  assert.ok(worst < 0.75 * m.cellSize, `trailing edge bitten ${worst.toFixed(1)} mm deep with ${m.cellSize.toFixed(1)} mm cells`);
  // Wire spokes 8 mm thick on a 600 mm wheel: every spoke is there all along
  // (on the wheel's coarse cells they were speckled).
  const wheel = runScript('const s = []; for (let i = 0; i < 24; i++) { const a = i * 15 * Math.PI / 180; s.push(capsule([60 * Math.cos(a), 60 * Math.sin(a), 0], [280 * Math.cos(a + 0.3), 280 * Math.sin(a + 0.3), i % 2 ? 30 : -30], 4)); }\npart("S", union(s).add(torus(290, 12)));');
  const w = meshPart(wheel.parts[0].node, { budget: 3000 });
  const near = new Set();
  const key = (x, y, z) => `${Math.round(x / 5)},${Math.round(y / 5)},${Math.round(z / 5)}`;
  for (let i = 0; i < w.positions.length; i += 3) near.add(key(w.positions[i], w.positions[i + 1], w.positions[i + 2]));
  let shown = 0, total = 0;
  for (let i = 0; i < 24; i++)
    for (let t = 0.1; t <= 0.9; t += 0.02) {
      const a = i * 15 * Math.PI / 180, x = (1 - t) * 60 * Math.cos(a) + t * 280 * Math.cos(a + 0.3), y = (1 - t) * 60 * Math.sin(a) + t * 280 * Math.sin(a + 0.3), z = t * (i % 2 ? 30 : -30);
      total++;
      let hit = false;
      for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) for (let dz = -1; dz <= 1 && !hit; dz++) hit = near.has(key(x + dx * 5, y + dy * 5, z + dz * 5));
      if (hit) shown++;
    }
  assert.equal(shown, total, `${total - shown} of ${total} points along the spokes have no mesh near them`);
  assert.equal(openEdges(w), 0);
});

test("a part can name its material", () => {
  const r = runScript('part("Tyre", sphere(10), { material: "rubber" }); part("Rim", sphere(5));');
  assert.equal(r.error, undefined);
  assert.equal(r.parts[0].material, "rubber");
  assert.equal(r.parts[1].material, null);
  assert.equal(runScript('part("A", sphere(10), { material: "brushed" }); part("B", sphere(10), { material: "anodised" });').parts.map((p) => p.material).join(), "brushed,anodised");
  assert.match(runScript('part("A", sphere(10), { material: "wood" });').error, /material must be one of metal, brushed, anodised, paint, plastic, rubber, glass/);
});

test("tube takes smooth as a radius, or true and false as sweep does", () => {
  const pts = "[[0, 0, 0, 5], [50, 0, 0, 5], [50, 50, 0, 5]]";
  for (const s of ["", ", 3", ", true", ", false"]) assert.equal(runScript(`part("T", tube(${pts}${s}));`).error, undefined, `tube(...${s})`);
  assert.match(runScript(`part("T", tube(${pts}, "yes"));`).error, /tube smooth/);
});

test("hulls of many points on flat faces stay tidy and quick", () => {
  // A grid of points on each face of a cube: every point but the corners
  // lies in a face plane, which used to tangle the hull's faces.
  const pts = [];
  for (let i = 0; i <= 12; i++)
    for (let j = 0; j <= 12; j++)
      for (const [a, b, c] of [[i, j, 0], [i, j, 12], [i, 0, j], [i, 12, j], [0, i, j], [12, i, j]]) pts.push([a * 1.0001, b, c]);
  const t = performance.now();
  const planes = convexHullPlanes(pts);
  assert.equal(planes.length, 6, `${planes.length} planes`);
  assert.ok(performance.now() - t < 500, `${Math.round(performance.now() - t)} ms`);
});

test("big parts are meshed as finely as asked, whatever the budget", () => {
  const { f, box } = compile({ t: "box", s: [1000, 1000, 20] });
  const coarse = meshSDF(f, box, { budget: 2000 });
  const fine = meshSDF(f, box, { budget: 2000, maxCell: 10 });
  assert.ok(coarse.cellSize > 10, `budget alone gives ${coarse.cellSize} mm cells`);
  assert.ok(fine.cellSize <= 10 * Math.SQRT2 && fine.cellSize > 10 / Math.SQRT2, `maxCell 10 gives ${fine.cellSize} mm cells`);
  assert.equal(openEdges(fine), 0);
});

// Volume of a one-part script, meshed finely; also checks the mesh is closed.
const volumeOf = (script, budget = 120000) => {
  const r = runScript(script);
  assert.equal(r.error, undefined, r.error);
  const m = meshOf(r.parts[0].node, { budget });
  assert.equal(openEdges(m), 0, `${script} is not closed`);
  return meshVolume(m);
};
const meshBoundsOf = (r) => meshBounds(meshOf(r.parts[0].node, { budget: 40000 }));
const close = (got, exact, tol, what) => assert.ok(Math.abs(got / exact - 1) < tol, `${what}: ${got.toFixed(1)}, expected ${exact.toFixed(1)} (${((got / exact - 1) * 100).toFixed(2)}%)`);

test("profiles: circles, rects, arcs, curves, rounded corners and cut-outs have exact areas", () => {
  const area = (profile) => volumeOf(`part("A", extrude(${profile}, 10))`) / 10;
  close(area("circle(10)"), Math.PI * 100, 0.004, "circle");
  close(area("rect(40, 20, 5)"), 800 - (4 - Math.PI) * 25, 0.004, "rounded rect");
  close(area("path([0, -10]).line(50, -10).radiusArc(50, 10, 10).line(0, 10).radiusArc(0, -10, 10).close()"), 1000 + Math.PI * 100, 0.004, "slot from radius arcs");
  close(area("path([-10, 0]).arc([0, 10], [10, 0]).close()"), (Math.PI * 100) / 2, 0.004, "half disc from a three-point arc");
  close(area("path([0, 0]).line(20, 0).tangentArc(20, 20).close()"), 200 + (Math.PI * 100) / 2, 0.004, "tangent arc");
  close(area("path([0, 0]).curve([10, 20], [20, 0]).close()"), (2 / 3) * 200, 0.006, "quadratic curve");
  close(area("polygon([[0, 0], [20, 0], [20, 20], [0, 20]], 4)"), 400 - (4 - Math.PI) * 16, 0.004, "polygon with rounded corners");
  close(area("rect(40, 40).cut(circle(10))"), 1600 - Math.PI * 100, 0.004, "rect with a hole");
  close(area("circle(10).add(circle(10).move(15, 0))"), 2 * Math.PI * 100 - (2 * 100 * Math.acos(0.75) - 7.5 * Math.sqrt(100 - 56.25) * 2), 0.006, "two joined circles");
  close(area('airfoil("0012", 100)'), 822, 0.01, "NACA 0012 (0.0822 x chord squared)");
  // A spline goes through every point it is given.
  const r = runScript('part("A", extrude(path([0, 0]).spline([[30, 10], [60, 0], [30, 40]]).close(), 1))');
  const { f } = compile(r.parts[0].node);
  for (const [x, y] of [[0, 0], [30, 10], [60, 0], [30, 40]]) assert.ok(Math.abs(f(x, y, 0)) < 1e-3, `spline misses [${x}, ${y}]`);
});

test("revolve through part of a turn", () => {
  close(volumeOf('part("A", revolve(rect(10, 20).move(30, 0), 180))'), 200 * 30 * Math.PI, 0.004, "half turn");
  close(volumeOf('part("A", revolve([[20, 0], [40, 0], [40, 10], [20, 10]], 90))'), (Math.PI / 4) * (1600 - 400) * 10, 0.004, "quarter turn");
});

test("sweep: rings, mitred frames, springs, twists and flat ends", () => {
  // Pappus: area x distance travelled by its centre.
  close(volumeOf('part("A", sweep(circle(5), path([0, 0]).radiusArc(100, 0, 50).radiusArc(0, 0, 50).close()))'), Math.PI * 25 * 2 * Math.PI * 50, 0.006, "swept ring");
  close(volumeOf('part("A", sweep(rect(20, 10), [[0, 0, 0], [200, 0, 0], [200, 150, 0], [0, 150, 0]], { closed: true, smooth: false }))'), 200 * 700, 0.004, "mitred picture frame");
  close(volumeOf('part("A", sweep(rect(10, 10), [[0, 0, 0], [100, 0, 0]]))'), 10000, 0.004, "straight sweep with flat ends");
  close(volumeOf('part("A", sweep(rect(20, 6), [[0, 0, 0], [0, 0, 100]], { twist: 90 }))'), 12000, 0.006, "twisted bar");
  const L = 5 * Math.hypot(2 * Math.PI * 20, 8);
  close(volumeOf('part("A", sweep(circle(2), helix(20, 8, 5)))'), Math.PI * 4 * L, 0.01, "coil spring");
  // The profile's y axis points up: a 20 wide, 6 tall rect swept along X is 6 tall.
  const b = meshBoundsOf(runScript('part("A", sweep(rect(20, 6), [[0, 0, 0], [100, 0, 0]]))'));
  assert.ok(Math.abs(b[5] - 3) < 0.1 && Math.abs(b[4] - 10) < 0.1, `top at z = ${b[5]}, side at y = ${b[4]}`);
});

test("loft: tapers are exact, and a wing's sections stay in proportion", () => {
  close(volumeOf('part("A", loft([[0, circle(30)], [100, circle(50)]]))'), ((Math.PI * 100) / 3) * (900 + 2500 + 1500), 0.005, "cone frustum from two circles");
  close(volumeOf('part("A", loft([[0, rect(20, 20)], [100, rect(40, 40)]]))'), (100 / 3) * (400 + 1600 + 800), 0.005, "pyramid frustum from two squares");
  // Similar airfoils (root 200, tip 100, tip moved back): a frustum too.
  const A1 = volumeOf('part("A", extrude(airfoil("0012", 200), 1))'), A2 = A1 / 4;
  close(volumeOf('part("A", loft([[0, airfoil("0012", 200)], [300, airfoil("0012", 100).move(50, 0)]]))'), (300 / 3) * (A1 + A2 + Math.sqrt(A1 * A2)), 0.01, "tapered wing");
  // A smooth loft through three sections never bulges past them.
  const r = runScript('part("A", loft([[0, circle(20)], [50, circle(40)], [100, circle(20)]]))');
  const { f } = compile(r.parts[0].node);
  for (let z = 0; z <= 100; z += 5) assert.ok(f(40.01, 0, z) > 0, `bulges past radius 40 at z = ${z}`);
  assert.ok(f(30, 0, 25) < 0 && f(30, 0, 75) < 0, "it is smooth, not pinched, between sections");
});

test("profile and path mistakes are explained", () => {
  assert.match(runScript('part("A", extrude(path([0, 0]).line(10, 0).line(10, 10), 5))').error, /not closed\. End it with \.close\(\)/);
  assert.match(runScript('part("A", extrude(box(1, 1, 1), 5))').error, /expects a profile .* got a 3D shape/);
  assert.match(runScript('part("A", loft([[10, circle(5)], [0, circle(5)]]))').error, /heights must increase/);
  assert.match(runScript('part("A", sweep(circle(1), [[0, 0, 0]]))').error, /at least 2 points/);
  assert.match(runScript('part("A", extrude(path([0, 0]).radiusArc(100, 0, 10).close(), 1))').error, /too small to reach/);
});

test("the documented profile, sweep and loft example runs and every part is closed", () => {
  const doc = readFileSync(new URL("../mcp/reference.mjs", import.meta.url), "utf8");
  const src = doc.match(/EXAMPLE: profiles, sweep and loft\n([\s\S]*?)\n\n/)[1].split("\n").map((l) => l.trim()).join("\n");
  const r = runScript(src);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.parts.map((p) => p.name), ["Glass", "Rail", "Spring", "Wing", "Bracket"]);
  for (const p of r.parts) {
    const m = meshOf(p.node, { budget: 20000 });
    assert.ok(m.indices.length > 0 && openEdges(m) === 0, `${p.name} is not a closed solid`);
  }
});

test("random shapes always give closed meshes", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const R = (a, b) => a + (b - a) * rnd();
  const prim = () => {
    const n = [
      { t: "sphere", r: R(3, 20) },
      { t: "box", s: [R(1, 40), R(1, 40), R(0.5, 30)] },
      { t: "cylinder", r: R(1, 15), h: R(1, 40) },
      { t: "torus", R: R(8, 20), r: R(0.5, 5) },
      { t: "capsule", a: [R(-20, 20), R(-20, 20), R(-20, 20)], b: [R(-20, 20), R(-20, 20), R(-20, 20)], r1: R(0.5, 8), r2: R(0.5, 8) },
      { t: "shell", th: R(0.3, 3), c: { t: "sphere", r: R(5, 20) } },
    ][Math.floor(rnd() * 6)];
    return { t: "move", v: [R(-15, 15), R(-15, 15), R(-15, 15)], c: { t: "rotate", deg: [R(0, 360), R(0, 360), R(0, 360)], c: n } };
  };
  let count = 0;
  for (let s = 0; s < 400; s++) {
    const op = ["union", "subtract", "intersect"][Math.floor(rnd() * 3)];
    const [a, b, c] = [prim(), prim(), prim()];
    const k = rnd() < 0.5 ? 0 : R(1, 8);
    const node = op === "subtract" ? { t: "union", c: [{ t: "subtract", a, b: [b], k }, c] } : { t: op, c: [a, b, c], k };
    for (const budget of [800, 4000]) {
      const m = mesh(node, budget);
      if (!m.indices.length) continue;
      count++;
      assert.equal(openEdges(m), 0, `scene ${s} budget ${budget}: open or shared edges`);
      assert.ok(closedByPosition(m), `scene ${s} budget ${budget}: not closed by position`);
    }
  }
  console.log(`    ${count} meshes`);
});

test("random profiles, sweeps, lofts and partial revolves always give closed meshes", () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const R = (a, b) => (a + (b - a) * rnd()).toFixed(2);
  const prof = () =>
    [
      () => `circle(${R(2, 12)})`,
      () => `rect(${R(4, 20)}, ${R(4, 20)}, ${R(0, 1.5)})`,
      () => `polygon([${Array.from({ length: 7 }, (_, i) => `[${(Math.cos(i * 0.9) * R(4, 12)).toFixed(2)}, ${(Math.sin(i * 0.9) * R(4, 12)).toFixed(2)}]`).join(", ")}], ${R(0, 2)})`,
      () => `path([0, 0]).line(${R(8, 16)}, 0).tangentArc(${R(8, 16)}, ${R(6, 12)}).curve([${R(0, 8)}, ${R(10, 16)}], [0, ${R(4, 10)}]).close()`,
      () => `airfoil("${["0012", "2412", "4415"][Math.floor(rnd() * 3)]}", ${R(10, 30)}).move(-10, 0)`,
      () => `rect(${R(10, 20)}, ${R(10, 20)}).cut(circle(${R(1, 4)}))`,
    ][Math.floor(rnd() * 6)]();
  const solid = () =>
    [
      () => `extrude(${prof()}, ${R(2, 30)})`,
      () => `revolve(${prof()}.move(${R(12, 20)}, 0), ${R(30, 360)})`,
      () => `sweep(${prof()}.scale(0.4), [[0, 0, 0], [${R(-30, 30)}, ${R(-30, 30)}, ${R(10, 30)}], [${R(-30, 30)}, ${R(-30, 30)}, ${R(30, 50)}]], { twist: ${R(0, 180)} })`,
      () => `sweep(circle(${R(0.8, 3)}), helix(${R(8, 15)}, ${R(4, 10)}, ${R(1, 3)}))`,
      () => `loft([[0, ${prof()}], [${R(10, 30)}, ${prof()}], [${R(35, 60)}, ${prof()}]], { smooth: ${rnd() < 0.5} })`,
    ][Math.floor(rnd() * 5)]();
  let count = 0;
  for (let s = 0; s < 120; s++) {
    const op = ["union", "subtract", "intersect"][Math.floor(rnd() * 3)];
    const script = `part("A", ${op}(${solid()}.rotate(${R(0, 90)}, ${R(0, 90)}, 0), ${solid()}.move(${R(-10, 10)}, ${R(-10, 10)}, ${R(-10, 10)})${rnd() < 0.5 ? `, ${R(1, 5)}` : ""}))`;
    const r = runScript(script);
    assert.equal(r.error, undefined, `${script}: ${r.error}`);
    for (const budget of [1500, 6000]) {
      const m = meshOf(r.parts[0].node, { budget });
      if (!m.indices.length) continue;
      count++;
      assert.equal(openEdges(m), 0, `scene ${s} budget ${budget}: open or shared edges\n${script}`);
      assert.ok(closedByPosition(m), `scene ${s} budget ${budget}: not closed by position\n${script}`);
    }
  }
  console.log(`    ${count} meshes`);
});

test("a cell cap never gives an empty or open mesh", () => {
  // Many thin rings: the detail search wants far more cells than allowed.
  const rings = { t: "union", c: Array.from({ length: 40 }, (_, i) => ({ t: "move", v: [(i % 8) * 30, Math.floor(i / 8) * 30, 0], c: { t: "torus", R: 12, r: 0.4 } })) };
  const { f, box } = compile(rings);
  const m = meshSDF(f, box, { budget: 400000, maxCells: 200000 });
  assert.ok(m.indices.length > 0, "mesh is empty");
  assert.equal(m.incomplete, false);
  assert.equal(openEdges(m), 0);
});

test("thin parts are not lost", () => {
  // A 50 mm thick blade, 5 m long: thinner than the first grid cells.
  const m = mesh({ t: "box", s: [5000, 300, 50] }, 6000);
  assert.ok(m.indices.length > 0 && openEdges(m) === 0);
  assert.ok(Math.abs(meshVolume(m) / (5000 * 300 * 50) - 1) < 0.05);
});

test("thin plates, tubes, blades and pins never mesh to nothing or lose a wall", () => {
  // [shape, budget, exact volume, tolerance]. A 1 mm plate at 3.2 mm cells
  // used to mesh to nothing: every grid corner and cell centre fell outside it.
  const tube = (R, w, h) => ({ t: "subtract", a: { t: "cylinder", r: R, h }, b: [{ t: "cylinder", r: R - w, h: h + 2 }] });
  const cases = [
    [{ t: "box", s: [200, 120, 1] }, 1500, 24000, 0.01],
    [{ t: "box", s: [200, 120, 1] }, 20000, 24000, 0.01],
    [{ t: "box", s: [200, 120, 0.6] }, 6000, 14400, 0.01],
    [{ t: "box", s: [200, 120, 0.8] }, 20000, 19200, 0.01],
    [{ t: "box", s: [200, 120, 0.8] }, 40000, 19200, 0.01],
    [{ t: "box", s: [500, 500, 2] }, 1500, 500000, 0.01],
    [{ t: "move", v: [7, 3, 0.3], c: { t: "box", s: [300, 80, 1.5] } }, 1500, 36000, 0.01],
    [{ t: "cylinder", r: 100, h: 1 }, 1500, Math.PI * 1e4, 0.01],
    [{ t: "box", s: [600, 60, 1.2] }, 1500, 43200, 0.02],
    [{ t: "rotate", deg: [20, 35, 10], c: { t: "box", s: [1000, 300, 3] } }, 20000, 900000, 0.01],
    [tube(50, 1, 100), 20000, Math.PI * (2500 - 49 * 49) * 100, 0.01],
    [{ t: "cylinder", r: 1, h: 40 }, 1500, Math.PI * 40, 0.05],
    // A 1 mm rod at 0.8 mm cells comes out fat, never thin or broken.
    [{ t: "rotate", deg: [0, 90, 0], c: { t: "cylinder", r: 0.5, h: 200 } }, 1500, Math.PI * 0.25 * 200, 0.35],
  ];
  for (const [node, budget, exact, tol] of cases) {
    const m = mesh(node, budget);
    const what = `${JSON.stringify(node).slice(0, 70)} at budget ${budget} (cell ${m.cellSize.toFixed(2)} mm)`;
    assert.ok(m.indices.length > 0, `${what} is empty`);
    assert.equal(openEdges(m), 0, `${what} is not closed`);
    assert.ok(Math.abs(meshVolume(m) / exact - 1) < tol, `${what}: volume ${meshVolume(m).toFixed(0)} of ${exact.toFixed(0)}`);
    assert.equal(m.thickened, undefined, `${what} was drawn thicker`);
  }
  // Walls far thinner than any cell the budget allows (a 0.5 mm tube 400 mm
  // long, a 0.8 mm shell, a tilted 3 mm sheet at a small budget) are drawn a
  // little more than a cell thick, whole, instead of in shreds or not at all.
  for (const [node, budget, exact, wall] of [
    [tube(20, 0.5, 400), 1500, Math.PI * (400 - 19.5 ** 2) * 400, 0.5],
    [tube(100, 0.8, 300), 1500, Math.PI * (100 ** 2 - 99.2 ** 2) * 300, 0.8],
    [{ t: "shell", th: 0.8, c: { t: "box", s: [200, 150, 100] } }, 1500, 200 * 150 * 100 - 198.4 * 148.4 * 98.4, 0.8],
    [{ t: "rotate", deg: [20, 35, 10], c: { t: "box", s: [1000, 300, 3] } }, 1500, 900000, 3],
  ]) {
    const m = mesh(node, budget);
    const what = `${JSON.stringify(node).slice(0, 70)} at budget ${budget}`;
    assert.ok(m.thickened > 0, `${what} was not drawn thicker`);
    assert.equal(openEdges(m), 0, `${what} is not closed`);
    // Every wall is there: no less than the true volume, and no more than
    // walls a cell and a half thick would hold.
    const v = meshVolume(m);
    assert.ok(v > exact && v < exact * ((1.5 * m.cellSize) / wall), `${what}: volume ${v.toFixed(0)} of ${exact.toFixed(0)}`);
  }
  // A part through meshPart, as the app meshes it, the same.
  const p = meshPart({ t: "box", s: [200, 120, 1] }, { budget: 20000, normals: true });
  assert.ok(p.indices.length > 1000 && Math.abs(p.volume / 24000 - 1) < 0.01, `plate part: ${p.indices.length / 3} triangles, volume ${p.volume.toFixed(0)}`);
});

test("pieces that are the same piece, or share a box, give no edge with four triangles", () => {
  // The rotor head's mast: a centred bar in radial(6) is itself again turned
  // by 180 degrees, and the three bars left share one box. Meshed one by one
  // they made one surface twice, and their ends in one plane twice.
  const r = runScript('part("Mast", cylinder(110, 450).move(0, 0, 455).add(box(12, 232, 150).move(0, 0, 790).radial(6, "z")));');
  for (const [budget, maxCell] of [[9375, 19], [40000, 4]]) {
    const m = meshPart(r.parts[0].node, { budget, maxCell });
    assert.equal(openEdges(m), 0);
    assert.ok(closedByPosition(m), `budget ${budget}: edges shared by more than two triangles`);
  }
});

test("model scripts: example, test helicopter, Claude's helicopter", () => {
  const lamp = readFileSync(new URL("../mcp/reference.mjs", import.meta.url), "utf8").match(/EXAMPLE\n([\s\S]*?)\n\n[A-Z]/)[1];
  for (const src of [lamp, ...["helicopter.js", "claude-helicopter.js"].map((f) => readFileSync(new URL(`./models/${f}`, import.meta.url), "utf8"))]) {
    const r = runScript(src);
    assert.equal(r.error, undefined, r.error);
    for (const p of r.parts) {
      const { f, box } = compile(p.node);
      const m = meshSDF(f, box, { budget: 6000 });
      assert.ok(m.indices.length > 0, `${p.name} is empty`);
      assert.equal(openEdges(m), 0, `${p.name} is not closed`);
    }
  }
});

test("script errors name the line", () => {
  assert.equal(runScript("const a = box(10, 10, 10);\n\npart('A', a.move(0, 0, 'x'));").error, 'Line 3: move must be a number, got "x"');
  assert.equal(runScript("part('A', sphere(5));\nfoo();").error, "Line 2: foo is not defined");
  assert.match(runScript("const x = 1;").error, /made no parts/);
  assert.match(runScript("part('A', sphere(5)); part('A', sphere(3));").error, /two parts named "A"/);
  assert.match(runScript("part('A', box(10, 10, 10, 6));").error, /more than half/);
});

test("slider values override defaults and are clamped", () => {
  const src = "const r = param('Radius', 10, { min: 5, max: 20, part: 'Ball' }); part('Ball', sphere(r)); print(r);";
  assert.deepEqual(runScript(src, { "Ball / Radius": 15 }).prints, ["15"]);
  assert.deepEqual(runScript(src, { "Ball / Radius": 99 }).prints, ["20"]);
  assert.deepEqual(runScript(src).prints, ["10"]);
});

test("linked motion: the documented crank keeps its joints closed", () => {
  // Same script as the example in mcp/reference.mjs.
  const src = `loop(1);
part("Crank", cylinder(30, 10).rotateX(90).at(0, -10, 0), { spin: { axis: "y", rpm: 60 } });
const pin = [0, 0, 25], top = [0, 0, 125];
part("Piston", cylinder(20, 30).at(0, 0, 135), { motion: t => { const p = where("Crank", pin, t); return slide(0, 0, p[2] + Math.sqrt(100 ** 2 - p[0] ** 2) - top[2]); } });
part("Rod", capsule(pin, top, 5), { motion: t => link(pin, top, where("Crank", pin, t), where("Piston", top, t)) });
joint("Rod", "Crank", pin);
joint("Rod", "Piston", top);`;
  const doc = readFileSync(new URL("../mcp/reference.mjs", import.meta.url), "utf8");
  for (const line of src.split("\n")) assert.ok(doc.includes(line.trim()), `the documented example has: ${line}`);
  const r = runScript(src);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.motion.loop, 1);
  assert.equal(r.motion.frames, 60);
  for (const j of r.motion.joints) assert.ok(j.max_gap_mm < 0.01, `${j.a}-${j.b} opens by ${j.max_gap_mm} mm`);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.motion.links[0].max_stretch_mm < 0.01, "the rod never stretches");
  // The piston only moves up and down, between 100 - 25 and 100 + 25 above the pin's centre.
  const piston = r.parts.find((p) => p.name === "Piston").frames;
  const zs = [];
  for (let i = 0; i < 60; i++) {
    assert.ok(Math.abs(piston[i * 12 + 3]) < 1e-6 && Math.abs(piston[i * 12 + 7]) < 1e-6, "piston stays on its axis");
    zs.push(piston[i * 12 + 11]);
  }
  assert.ok(Math.abs(Math.max(...zs) - 0) < 0.01 && Math.abs(Math.min(...zs) - -50) < 0.5, `piston stroke ${Math.min(...zs)}..${Math.max(...zs)}`);
  // Nothing in it hits anything: the rod runs beside the crank, and the
  // overlap at its pinned ends is left out.
  assert.deepEqual(fitOf(r), []);
});

test("Claude's rotor head: every joint holds and it exports closed", () => {
  const r = runScript(readFileSync(new URL("./models/claude-rotor-head.js", import.meta.url), "utf8"));
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.parts.length, 47);
  assert.equal(r.motion.joints.length, 29);
  for (const j of r.motion.joints) assert.ok(j.max_gap_mm < 1, `${j.a}-${j.b} opens by ${j.max_gap_mm} mm`);
  assert.deepEqual(r.warnings, []);
  const { f, box } = compile({ t: "union", c: r.parts.map((p) => p.node) });
  const m = meshSDF(f, box, { budget: 120000 });
  assert.equal(m.incomplete, false);
  assert.equal(openEdges(m), 0);
});

test("linked motion: follow, loop, errors and joint warnings", () => {
  // A follower is moved by its own motion first, then by its parent's.
  const r = runScript(`loop(4); part("Hub", sphere(5), { spin: { rpm: 15 } }); part("Blade", box(100, 10, 2).at(60, 0, 0), { follow: "Hub", motion: t => turn(10, "x") }); part("Base", box(10, 10, 10));`);
  assert.equal(r.error, undefined, r.error);
  const blade = r.parts.find((p) => p.name === "Blade").frames;
  const quarter = 60; // 1 s of 4 s = a quarter turn at 15 rpm
  const at = (f, i, p) => [0, 1, 2].map((k) => f[i * 12 + k * 4] * p[0] + f[i * 12 + k * 4 + 1] * p[1] + f[i * 12 + k * 4 + 2] * p[2] + f[i * 12 + k * 4 + 3]);
  const tip = at(blade, quarter, [110, 0, 0]);
  assert.ok(Math.abs(tip[0]) < 1e-3 && Math.abs(tip[1] - 110) < 1e-3, `the blade tip turned with the hub: ${tip}`);
  assert.equal(r.parts.find((p) => p.name === "Base").frames, null, "a part that never moves has no frames");
  assert.equal(runScript(`part("A", box(1, 1, 1), { spin: { rpm: 45 } });`).motion.loop, 4, "45 rpm completes whole turns in 4 s");
  assert.equal(runScript(`part("A", box(1, 1, 1));`).motion, null);

  assert.equal(runScript(`part("A", box(1, 1, 1));
part("B", box(1, 1, 1), { motion: t => nope(t) });`).error, 'Line 2: in the motion of part "B": nope is not defined');
  assert.match(runScript(`part("A", box(1, 1, 1), { motion: t => 5 });`).error, /must return a pose/);
  assert.match(runScript(`part("A", box(1, 1, 1), { follow: "B" }); part("B", box(1, 1, 1), { follow: "A" });`).error, /follow each other in a circle/);
  assert.match(runScript(`part("A", box(1, 1, 1), { follow: "Nope" });`).error, /no part with that name/);
  assert.match(runScript(`part("A", box(1, 1, 1)); joint("A", "Nope", [0, 0, 0]);`).error, /no part with that name/);
  assert.match(runScript(`part("A", box(1, 1, 1)); where("A", [0, 0, 0], 0);`).error, /inside a part's motion/);
  const apart = runScript(`part("A", box(1, 1, 1), { spin: { rpm: 60 } }); part("B", box(1, 1, 1).at(10, 0, 0)); joint("A", "B", [10, 0, 0]);`);
  assert.equal(apart.motion.joints[0].max_gap_mm, 20);
  // Without any joint(), a stretched link is still caught, and the missing joints are pointed out.
  const loose = runScript(`part("Crank", box(1, 1, 1), { spin: { axis: "y", rpm: 60 } });
const pin = [0, 0, 25], top = [0, 0, 125];
part("Rod", capsule(pin, top, 5), { motion: t => link(pin, top, where("Crank", pin, t), top) });`);
  assert.equal(loose.motion.links[0].part, "Rod");
  assert.ok(loose.motion.links[0].max_stretch_mm > 40, `stretch ${loose.motion.links[0].max_stretch_mm}`);
  assert.ok(loose.warnings.some((w) => /comes off one end/.test(w)) && loose.warnings.some((w) => /no joint\(\) is declared/.test(w)), loose.warnings.join("; "));
  assert.match(apart.warnings[0], /comes apart by up to 20 mm/);
});

// ---- round 2: threads, holes, fasteners, draft, fit ----

// Every pair of a script's parts, checked over its motion like the app does.
function fitOf(r, opts = {}) {
  const parts = r.parts.filter((p) => !p.hidden);
  const pairs = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) pairs.push([i, j]);
  const count = r.motion?.frames ?? 0;
  const step = Math.max(1, Math.ceil(count / 120));
  const frames = count ? Array.from({ length: Math.ceil(count / step) }, (_, k) => k * step) : [0];
  return checkPairs(parts, pairs, { frames, frameCount: count, loop: r.motion?.loop ?? 0, joints: r.joints ?? [], ...opts });
}
const run = (src) => {
  const r = runScript(src);
  assert.equal(r.error, undefined, r.error);
  return r;
};
const partMesh = (r, name, budget = 40000) => {
  const { f, box } = compile(r.parts.find((p) => p.name === name).node);
  return meshSDF(f, box, { budget });
};

test("threads: the exact volume of a helical ISO profile", () => {
  // A helix swept profile r = g(u) has volume pi * L * mean(g^2) over a turn.
  for (const [r, p] of [[5, 1.5], [3, 0.5], [12, 1.75]]) {
    const L = 10 * p;
    const r1 = threadRoot(r, p);
    const g = (u) => (u <= p / 16 ? r : u >= (3 * p) / 8 ? r1 : r - ((u - p / 16) / ((5 * p) / 16)) * (r - r1));
    let s = 0;
    const N = 100000;
    for (let i = 0; i < N; i++) s += g(Math.abs(-p / 2 + ((i + 0.5) * p) / N)) ** 2;
    const exact = (Math.PI * L * s) / N;
    for (const left of [false, true]) {
      const m = mesh({ t: "thread", r, p, z0: 0, z1: L, left }, 60000);
      assert.equal(openEdges(m), 0);
      const err = Math.abs(meshVolume(m) / exact - 1);
      assert.ok(err < 0.003, `M${2 * r}x${p}${left ? " left" : ""} volume off by ${(err * 100).toFixed(2)}%`);
    }
  }
  // Right-handed: turning it anticlockwise (seen from above) moves a crest up.
  const { f } = compile({ t: "thread", r: 5, p: 2, z0: -10, z1: 10 });
  const crest = (deg) => {
    const a = (deg * Math.PI) / 180;
    // The middle of the tooth near the crest: where the solid is at radius 4.9.
    let sum = 0, n = 0;
    for (let z = -1; z <= 1; z += 0.001) if (f(4.9 * Math.cos(a), 4.9 * Math.sin(a), z) < 0) (sum += z), n++;
    return sum / n;
  };
  assert.ok(Math.abs(crest(0)) < 0.01 && Math.abs(crest(90) - 0.5) < 0.01, `crest at 0° ${crest(0)}, at 90° ${crest(90)}`);
});

test("draft: sides lean in by the angle, exactly", () => {
  const t = Math.tan((5 * Math.PI) / 180), h = 40;
  // A round boss becomes a cone frustum; a rectangle a pyramid frustum.
  const R = 30, r = R - h * t;
  const cone = (Math.PI * h * (R * R + R * r + r * r)) / 3;
  const [w, d] = [80, 50], [w2, d2] = [80 - 2 * h * t, 50 - 2 * h * t];
  const pyramid = (h * (w * d + w2 * d2 + Math.sqrt(w * d * w2 * d2))) / 3;
  for (const [node, exact] of [
    [{ t: "extrude", p: { t: "circle2", r: R }, h, draft: 5 }, cone],
    [{ t: "extrude", p: { t: "rect2", w, h: d }, h, draft: 5 }, pyramid],
  ]) {
    const m = mesh(node);
    assert.equal(openEdges(m), 0);
    const err = Math.abs(meshVolume(m) / exact - 1);
    assert.ok(err < 0.004, `${node.p.t} draft volume off by ${(err * 100).toFixed(2)}%`);
  }
  // Out-drafted sides grow, and the bottom keeps its profile.
  const out = mesh({ t: "extrude", p: { t: "circle2", r: 20 }, h: 20, draft: -10 });
  const b = meshBounds(out);
  assert.ok(Math.abs(b[3] - (20 + 20 * Math.tan((10 * Math.PI) / 180))) < 0.1, `top radius ${b[3]}`);
  assert.match(runScript('part("A", extrude(circle(5), 10, { draft: 60 }));').error, /between -45 and 45/);
});

test("holes and fasteners: real sizes, and they fit", () => {
  const doc = readFileSync(new URL("../mcp/reference.mjs", import.meta.url), "utf8");
  const example = doc.match(/EXAMPLE: a bracket bolted down\n([\s\S]*?)\n\n/)[1];
  const r = run(example);
  for (const p of r.parts) {
    const { f, box } = compile(p.node);
    const m = meshSDF(f, box, { budget: 20000 });
    assert.equal(openEdges(m), 0, `${p.name} is not closed`);
  }
  // Bolt in its tapped hole, socket head flush in its counterbore, washer
  // under the head: everything touches, nothing passes through.
  assert.deepEqual(fitOf(r), []);
  const T = 20;
  const socket = meshBounds(partMesh(r, "Socket bolt"));
  assert.ok(Math.abs(socket[5] - T) < 0.1, `socket head top at ${socket[5]}, plate top at ${T}`);
  const hex = meshBounds(partMesh(r, "Hex bolt"));
  assert.ok(Math.abs(hex[3] - hex[0] - 13 / Math.cos(Math.PI / 6)) < 0.2 && Math.abs(hex[4] - hex[1] - 13) < 0.2, `M8 hex head ${hex[3] - hex[0]} x ${hex[4] - hex[1]}`);
  assert.ok(Math.abs(hex[5] - (T + 1.6 + 5.3)) < 0.1 && Math.abs(hex[2] - (T + 1.6 - 16)) < 0.1, `hex bolt from ${hex[2]} to ${hex[5]}`);

  // A bolt screwed into a hole that is not tapped, or not drilled, is caught.
  const plain = fitOf(run('part("Plate", box(40, 40, 10).at(0, 0, 5).cut(hole("M6", 10).at(0, 0, 10))); part("Bolt", bolt("M6", 8).at(0, 0, 10));'));
  assert.deepEqual(plain, [], "a bolt in its clearance hole fits");
  const drilled = fitOf(run('part("Plate", box(40, 40, 10).at(0, 0, 5).cut(hole(5, 10).at(0, 0, 10))); part("Bolt", bolt("M6", 8).at(0, 0, 10));'));
  // Threads mate on the pitch diameter (M6: 5.35), 0.175 mm past a 5 mm hole's wall, over 8 mm.
  const ring = 2 * Math.PI * 2.59 * 0.175 * 8 / 1000;
  assert.ok(drilled.length === 1 && Math.abs(drilled[0].overlap_mm - 0.175) < 0.03 && Math.abs(drilled[0].volume_cm3 / ring - 1) < 0.25, `an untapped 5 mm hole: ${JSON.stringify(drilled)}, ring ${ring}`);
  const solid = fitOf(run('part("Plate", box(40, 40, 10).at(0, 0, 5)); part("Bolt", bolt("M6", 8).at(0, 0, 10));'));
  const shank = (Math.PI * 2.675 ** 2 * 8) / 1000;
  assert.ok(solid.length === 1 && Math.abs(solid[0].overlap_mm - 5.35) < 0.05 && Math.abs(solid[0].volume_cm3 / shank - 1) < 0.03, `no hole at all: ${JSON.stringify(solid)}, shank ${shank}`);
  assert.deepEqual(solid[0].where, { min: [-2.7, -2.7, 2], max: [2.7, 2.7, 10] });
  // A flat head sits flush in its countersink; a nut threads onto a bolt.
  assert.deepEqual(fitOf(run('part("Plate", box(40, 40, 10).at(0, 0, 5).cut(hole("M5", 10, { csink: true }).at(0, 0, 10))); part("Bolt", bolt("M5", 16, { head: "flat" }).at(0, 0, 10)); part("Nut", nut("M5").rotateX(180).at(0, 0, 0));')), []);

  // Sizes, and every fastener in every size is a closed solid.
  const m6 = run('const m = metric("M6"); print(m.pitch, m.clearance, m.tapDrill, m.hex.s, m.socket.k, m.washer.D); part("A", sphere(1));').prints[0];
  assert.equal(m6, "1 6.6 5 10 6 12");
  for (const size of ["M2", "M3", "M5", "M8", "M12", "M20", "M36"]) {
    const r2 = run(`part("Hex", bolt("${size}", 30)); part("Socket", bolt("${size}", 30, { head: "socket" })); part("Flat", bolt("${size}", 30, { head: "flat", thread: false })); part("Nut", nut("${size}")); part("Washer", washer("${size}")); part("Rod", thread("${size}", 20));`);
    for (const p of r2.parts) {
      const { f, box } = compile(p.node);
      const m = meshSDF(f, box, { budget: 6000 });
      assert.ok(m.indices.length > 0 && openEdges(m) === 0, `${size} ${p.name} is not a closed solid`);
    }
  }
  assert.match(runScript('part("A", bolt("M7", 10));').error, /unknown thread size "M7"/);
  assert.match(runScript('part("A", hole(5, 10, { tapped: true }));').error, /need a metric size/);
  assert.match(runScript('part("A", thread(10, 20));').error, /needs \{ pitch \}/);
  // A script may still use these names for its own things.
  assert.equal(runScript('const hole = cylinder(3, 20); const bolt = 4; part("A", box(20, 20, 5).cut(hole));').error, undefined);
});

test("fit: overlaps measured exactly, gaps, and collisions in motion", () => {
  const r = run('part("A", box(40, 40, 40)); part("B", box(40, 40, 40).at(30, 0, 0)); part("C", sphere(10).at(0, 0, 29)); part("D", box(10, 10, 10).at(0, 0, 25.05)); part("E", sphere(10).at(0, 0, 45));');
  const fits = fitOf(r);
  const ab = fits.find((x) => x.a === "A" && x.b === "B");
  assert.ok(ab && Math.abs(ab.volume_cm3 - 16) < 0.05 && Math.abs(ab.overlap_mm - 10) < 0.1, JSON.stringify(ab));
  assert.deepEqual(ab.where, { min: [10, -20, -20], max: [20, 20, 20] });
  // A sphere 1 mm into a face: a cap of height 1, pi h^2 (3R - h) / 3.
  const ac = fits.find((x) => x.a === "A" && x.b === "C");
  assert.ok(ac && Math.abs(ac.volume_cm3 - Math.PI * 29 / 3 / 1000) < 0.002 && Math.abs(ac.overlap_mm - 1) < 0.05, JSON.stringify(ac));
  // 0.05 mm apart, or just touching, is not an overlap.
  assert.ok(!fits.some((x) => x.a === "A" && x.b === "D"), "a box 0.05 mm above another does not overlap it");
  const gap = fitOf(r, { gap: true }).find((x) => x.a === "A" && x.b === "E");
  assert.ok(Math.abs(gap.gap_mm - 15) < 0.05, `gap ${gap.gap_mm}`);

  // A spinning blade hits a post a twelfth of a turn in (atan(100 / 200)).
  const hit = fitOf(run('loop(1); part("Blade", box(300, 20, 4).at(150, 0, 200), { spin: { axis: "z", rpm: 60 } }); part("Post", cylinder(10, 150).at(200, 100, 150)); part("Hub", cylinder(15, 10).at(0, 0, 200), { follow: "Blade" });'));
  const bp = hit.find((x) => x.b === "Post");
  assert.ok(bp && Math.abs(bp.at_seconds - Math.atan2(100, 200) / (2 * Math.PI)) < 0.02 && Math.abs(bp.overlap_mm - 4) < 0.1, JSON.stringify(bp));
  // The hub moves with the blade: their overlap is found once, with no moment.
  const hub = hit.find((x) => x.b === "Hub");
  assert.ok(hub && hub.at_seconds === undefined, JSON.stringify(hub));

  // One joint on four copies leaves out only that copy's overlap; the other
  // three are listed, with how many joints the pair shares.
  const copies = 'part("Horns", sphere(10).at(50, 0, 0).radial(4, "z")); part("Links", capsule([50, 0, 0], [50, 0, -60], 4).radial(4, "z"));';
  const one = fitOf(run(`${copies} joint("Links", "Horns", [50, 0, 0]);`))[0];
  assert.ok(one && one.joints === 1 && one.where.max[0] < 0 + 15 && one.where.min[0] < -40, JSON.stringify(one));
  const all = fitOf(run(`${copies} for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; joint("Links", "Horns", [50 * Math.cos(a), 50 * Math.sin(a), 0]); }`));
  assert.deepEqual(all, []);
});

// ---- round 3: bend, twist, taper, lattices, text, hull ----

// How fast a distance function changes at its fastest, sampled around its box.
function steepest(f, box, n = 40000) {
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const a = [0, 1, 2].map((k) => box[k] + (box[k + 3] - box[k]) * (Math.random() * 1.4 - 0.2));
    const d = [0, 1, 2].map(() => (Math.random() - 0.5) * 0.02);
    const b = a.map((v, k) => v + d[k]);
    worst = Math.max(worst, Math.abs(f(...a) - f(...b)) / Math.hypot(...d));
  }
  return worst;
}
const volumeErr = (node, exact, budget = 60000, slope = 1.02) => {
  const { f, box } = compile(node);
  const m = meshSDF(f, box, { budget });
  assert.equal(openEdges(m), 0, `${node.t} is not closed`);
  assert.ok(steepest(f, box) < slope, `${node.t} changes faster than distance`);
  return Math.abs(meshVolume(m) / exact - 1);
};

test("twist, taper and bend: exact volumes, and safe distances", () => {
  const bar = { t: "box", s: [40, 20, 100] };
  // Twisting never changes volume.
  assert.ok(volumeErr({ t: "twist", deg: 90, c: bar }, 80000) < 0.002);
  // Taper to sx, sy: area scales by (1 + (sx-1)t)(1 + (sy-1)t), integrated over t.
  const [sx, sy] = [0.5, 0.25];
  assert.ok(volumeErr({ t: "taper", s: [sx, sy], c: bar }, 80000 * (1 + (sx - 1 + sy - 1) / 2 + ((sx - 1) * (sy - 1)) / 3)) < 0.002);
  // Bending keeps the length at z = 0: a bar centred on it keeps its volume;
  // a bar on top of it (z from 0 to t, bent away) gains L w t^2 / 2R.
  assert.ok(volumeErr({ t: "bend", r: 100, c: { t: "box", s: [200, 20, 20] } }, 80000) < 0.002);
  assert.ok(volumeErr({ t: "bend", r: -100, c: { t: "move", v: [0, 0, 10], c: { t: "box", s: [200, 20, 20] } } }, 200 * 20 * (20 + 400 / 200)) < 0.002);
  // A bar a quarter of a circle long bends into a quarter of a ring.
  const R = 50;
  const q = meshBounds(mesh({ t: "bend", r: R, c: { t: "box", s: [(Math.PI * R) / 2, 10, 2] } }));
  assert.ok(Math.abs(q[3] - (R + 1) * Math.sin(Math.PI / 4)) < 0.3 && Math.abs(q[5] - R * (1 - Math.cos(Math.PI / 4)) - Math.cos(Math.PI / 4)) < 0.3, `quarter bend reaches ${q}`);
  assert.match(runScript('part("A", box(400, 10, 10).bend(50));').error, /too small/);
  assert.match(runScript('part("A", box(40, 10, 30).at(0, 0, 15).bend(20));').error, /smaller than the shape is thick/);
});

test("lattices: grid exact, gyroid and diamond walls as thick as asked", () => {
  // Square struts w wide every a: 3 a w^2 - 2 w^3 per cell.
  assert.ok(volumeErr({ t: "lattice", kind: "grid", cell: 20, wall: 2, c: { t: "box", s: [60, 60, 60] } }, 27 * (3 * 20 * 4 - 2 * 8)) < 0.006);
  // A thickened minimal surface holds area * t + (curvature) t^3 / 12; these
  // fractions are the exact thickened surfaces, found by projecting onto them.
  // Near thick walls the projected distance can change up to about 1.6 times
  // faster than distance; the mesh stays closed and the volume right.
  for (const [kind, wall, frac] of [["gyroid", 2, 0.304], ["gyroid", 4, 0.5834]]) {
    const err = volumeErr({ t: "lattice", kind, cell: 20, wall, c: { t: "box", s: [60, 60, 60] } }, 216000 * frac, 300000, 1.7);
    assert.ok(err < 0.015, `${kind} ${wall} mm walls off by ${(err * 100).toFixed(1)}%`);
  }
  const d = compile({ t: "lattice", kind: "diamond", cell: 20, wall: 2, c: { t: "box", s: [60, 60, 60] } });
  assert.equal(openEdges(meshSDF(d.f, d.box, { budget: 40000 })), 0);
  // Honeycomb walls of w in cells a across: 1 - ((a - w) / a)^2 of the area.
  const hc = { t: "lattice", kind: "honeycomb", cell: 10, wall: 1.2, c: { t: "box", s: [200, 200, 5] } };
  assert.ok(volumeErr(hc, 200000 * (1 - (8.8 / 10) ** 2), 200000) < 0.02);
  assert.match(runScript('part("A", box(10, 10, 10).lattice("foam", 5, 1));').error, /lattice kind/);
  assert.match(runScript('part("A", box(10, 10, 10).lattice("gyroid", 10, 4));').error, /too thick for a 10 mm gyroid cell \(at most 3\)/);
  const skin = run('part("A", box(60, 60, 60).lattice("gyroid", 20, 2, { skin: 3 }));');
  assert.equal(skin.parts[0].node.t, "union");
});

test("text: our own font, exact strokes, every character", () => {
  // One stroke: a pen line 10 long, 1 wide, with round ends.
  const I = run('part("I", extrude(text("I", 10, { pen: 1 }), 1));');
  assert.ok(Math.abs(meshVolume(partMesh(I, "I")) / (10 + Math.PI / 4) - 1) < 0.01);
  // Centred on the origin; "left" starts the baseline there.
  const c = meshBounds(partMesh(run('part("T", extrude(text("HH", 10, { pen: 1 }), 1));'), "T"));
  assert.ok(Math.abs(c[0] + c[3]) < 0.05 && Math.abs(c[1] + c[4]) < 0.05 && Math.abs(c[4] - 5.5) < 0.05, `centred: ${c}`);
  const l = meshBounds(partMesh(run('part("T", extrude(text("H", 10, { pen: 1, align: "left" }), 1));'), "T"));
  assert.ok(Math.abs(l[0] + 0.5) < 0.05 && Math.abs(l[1] + 0.5) < 0.05, `left: ${l}`);
  // Every character the reference lists is drawn, and is a closed solid.
  const all = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;!?'\"-+=_/\\|()[]#%*<>$°&@";
  const r = run(`part("All", extrude(text(${JSON.stringify(all)}, 8), 1));`);
  assert.equal(openEdges(partMesh(r, "All", 80000)), 0);
  assert.match(runScript('part("A", extrude(text("a~b{", 5), 1));').error, /font does not have: "~", "\{"/);
  // An open path drawn with a pen is a profile too.
  const slot = run('part("S", extrude(path([0, 0]).line(30, 0).stroke(6), 2));');
  assert.ok(Math.abs(meshVolume(partMesh(slot, "S")) / ((30 * 6 + Math.PI * 9) * 2) - 1) < 0.01);
});

test("hull: exact around flat faces, and close around curves", () => {
  const cases = [
    ['hull(sphere(10), sphere(10).at(50, 0, 0))', Math.PI * 100 * 50 + (4 / 3) * Math.PI * 1000, 0.005],
    ["hull(box(40, 30, 20))", 24000, 0.005],
    ["hull(box(40, 30, 20).rotate(20, 30, 40))", 24000, 0.012],
    ["hull([[0, 0, 0], [30, 0, 0], [0, 30, 0], [0, 0, 30]].map((p) => box(0.02, 0.02, 0.02).at(...p)))", 30 ** 3 / 6, 0.01],
    ["hull(cylinder(10, 40), sphere(10).at(0, 0, 40))", Math.PI * 100 * 60 + (2 / 3) * Math.PI * 1000, 0.01],
  ];
  for (const [src, exact, tol] of cases) {
    const r = run(`part("H", ${src});`);
    const { f, box } = compile(r.parts[0].node);
    const m = meshSDF(f, box, { budget: 60000 });
    assert.equal(openEdges(m), 0);
    const err = Math.abs(meshVolume(m) / exact - 1);
    assert.ok(err < tol, `${src}: off by ${(err * 100).toFixed(2)}%`);
    assert.ok(steepest(f, box, 10000) < 1.001, `${src} changes faster than distance`);
  }
  // A second run of the same script reuses the hull.
  const t = performance.now();
  run('part("H", hull(sphere(10), sphere(10).at(50, 0, 0)));');
  assert.ok(performance.now() - t < 50, "the hull was measured again");
  assert.match(runScript('part("A", hull(box(10, 10, 0.001)));').error, /hull/);
});

test("random twists, tapers, bends, lattices, text and hulls always give closed meshes", () => {
  let seed = 23;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const R = (a, b) => (a + (b - a) * rnd()).toFixed(2);
  const base = () =>
    [
      () => `box(${R(10, 40)}, ${R(10, 40)}, ${R(10, 60)}, ${R(0, 3)})`,
      () => `cylinder(${R(5, 20)}, ${R(10, 60)})`,
      () => `extrude(polygon([[${R(8, 15)}, 0], [0, ${R(8, 15)}], [-${R(8, 15)}, 0], [0, -${R(8, 15)}]], ${R(0, 2)}), ${R(10, 50)})`,
      () => `extrude(text("${["Ag", "3D", "x?", "B&8"][Math.floor(rnd() * 4)]}", ${R(8, 20)}), ${R(1, 5)})`,
      () => `hull(sphere(${R(3, 10)}), box(${R(4, 12)}, ${R(4, 12)}, ${R(4, 12)}).at(${R(10, 30)}, ${R(-5, 5)}, ${R(-5, 5)}))`,
    ][Math.floor(rnd() * 5)]();
  const warp = (s) =>
    [
      () => `${s}.twist(${R(-200, 200)})`,
      () => `${s}.taper(${R(0.2, 1.8)}, ${R(0.2, 1.8)})`,
      () => `${s}.bend(${rnd() < 0.5 ? "" : "-"}${R(40, 120)})`,
      () => `${s}.lattice("${["gyroid", "diamond", "grid", "honeycomb"][Math.floor(rnd() * 4)]}", ${R(6, 12)}, ${R(0.8, 1.8)}${rnd() < 0.5 ? `, { skin: ${R(0.8, 2)} }` : ""})`,
      () => `${s}.rotate(${R(0, 90)}, ${R(0, 90)}, 0)`,
    ][Math.floor(rnd() * 5)]();
  let count = 0;
  for (let i = 0; i < 70; i++) {
    const src = `part("A", ${warp(warp(base()))});`;
    const r = runScript(src);
    if (r.error) {
      assert.match(r.error, /bend radius/, `${src}: ${r.error}`);
      continue;
    }
    const { f, box } = compile(r.parts[0].node);
    for (const budget of [1500, 8000]) {
      const m = meshSDF(f, box, { budget });
      if (!m.indices.length) continue;
      count++;
      assert.equal(openEdges(m), 0, `${src} budget ${budget}: open edges`);
    }
  }
  console.log(`    ${count} meshes`);
  assert.ok(count > 100);
});

test("the documented round 3 example runs and every part is closed", () => {
  const doc = readFileSync(new URL("../mcp/reference.mjs", import.meta.url), "utf8");
  const example = doc.match(/EXAMPLE: text, wrapping, twist, taper, lattice, hull\n([\s\S]*?)\n\n/)[1];
  const r = run(example);
  for (const p of r.parts) {
    const { f, box } = compile(p.node);
    assert.equal(openEdges(meshSDF(f, box, { budget: 20000 })), 0, `${p.name} is not closed`);
  }
  // bounds() measures the label: it covers about 105° of the mug.
  assert.ok(Math.abs(Number(r.prints[0]) - 104.7) < 1, `label covers ${r.prints[0]}°`);
  // The label sits on the mug's surface: from radius 40 to 41 off its axis.
  const m = partMesh(r, "Label");
  let rmin = Infinity, rmax = 0;
  for (let i = 0; i < m.positions.length; i += 3) {
    const rr = Math.hypot(m.positions[i], m.positions[i + 1] - 200);
    (rmin = Math.min(rmin, rr)), (rmax = Math.max(rmax, rr));
  }
  assert.ok(rmin > 39.9 && rmax < 41.2, `label from radius ${rmin} to ${rmax}`);
});

// ---- 2D drawings ----

// A part as the drawing code takes it: its mesh and its distance function.
const drawn = (name, node, budget = 30000) => {
  const c = compile(node);
  const m = meshSDF(c.f, c.box, { budget });
  return { name, ...c, positions: m.positions, indices: m.indices };
};
// Every point of a view's lines: [[u, v], ...].
const linePoints = (view, name) => (view.parts.find((p) => p.name === name)?.lines ?? []).flatMap((L) => Array.from({ length: L.length / 2 }, (_, i) => [L[i * 2], L[i * 2 + 1]]));
const extent = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
// How far a point is from the outline of a w x h rectangle about the origin.
const offRect = ([x, y], w, h) => Math.max(Math.abs(x) - w / 2, Math.abs(y) - h / 2) > 0 ? Math.hypot(Math.max(Math.abs(x) - w / 2, 0), Math.max(Math.abs(y) - h / 2, 0)) : Math.min(w / 2 - Math.abs(x), h / 2 - Math.abs(y));

test("drawing: views of a block with a hole are the right size, and hidden edges are left out", () => {
  // 100 x 60 x 40 with a 20 mm hole down through it.
  const block = [drawn("Block", { t: "subtract", a: { t: "box", s: [100, 60, 40] }, b: [{ t: "cylinder", r: 10, h: 60 }] })];
  const front = linePoints(viewOutline(block, "front"), "Block");
  const size = (b) => [b[2] - b[0], b[3] - b[1]];
  const [fw, fh] = size(extent(front));
  assert.ok(Math.abs(fw - 100) < 0.1 && Math.abs(fh - 40) < 0.1, `front view is ${fw.toFixed(2)} x ${fh.toFixed(2)}`);
  // From the front the hole is hidden: every line is on the 100 x 40 outline.
  const stray = Math.max(...front.map((p) => offRect(p, 100, 40)));
  assert.ok(stray < 0.1, `a front view line is ${stray.toFixed(2)} mm inside the outline`);
  const [sw, sh] = size(extent(linePoints(viewOutline(block, "left"), "Block")));
  assert.ok(Math.abs(sw - 60) < 0.1 && Math.abs(sh - 40) < 0.1, `side view is ${sw.toFixed(2)} x ${sh.toFixed(2)}`);
  // From the top: the 100 x 60 outline and the hole's circle, nothing else.
  const top = linePoints(viewOutline(block, "top"), "Block");
  const [tw, th] = size(extent(top));
  assert.ok(Math.abs(tw - 100) < 0.1 && Math.abs(th - 60) < 0.1, `top view is ${tw.toFixed(2)} x ${th.toFixed(2)}`);
  const circle = top.filter((p) => Math.hypot(...p) < 15);
  const radii = circle.map((p) => Math.hypot(...p));
  assert.ok(circle.length > 30 && Math.min(...radii) > 9.9 && Math.max(...radii) < 10.15, `the hole is drawn from radius ${Math.min(...radii).toFixed(2)} to ${Math.max(...radii).toFixed(2)}`);
  const turn = new Set(circle.map((p) => Math.floor((Math.atan2(p[1], p[0]) / Math.PI + 1) * 12)));
  assert.equal(turn.size, 24, "the hole's circle goes all the way round");
  assert.ok(Math.max(...top.filter((p) => Math.hypot(...p) >= 15).map((p) => offRect(p, 100, 60))) < 0.1);
  // A round surface has no edges of its own: a sphere is one outline, even meshed coarsely.
  const ball = linePoints(viewOutline([drawn("Ball", { t: "sphere", r: 30 }, 1500)], "front"), "Ball");
  assert.ok(ball.length > 20 && ball.every((p) => Math.hypot(...p) > 29.5), `a sphere has lines inside its outline (${Math.min(...ball.map((p) => Math.hypot(...p))).toFixed(1)} mm from its centre)`);
});

test("drawing: a part behind another is hidden where it is covered", () => {
  // A 40 mm cube in front; behind it a bar that reaches out on both sides,
  // and a small block wholly covered.
  const parts = [
    drawn("Cube", { t: "box", s: [40, 40, 40] }),
    drawn("Bar", { t: "move", v: [0, 60, 0], c: { t: "box", s: [100, 10, 20] } }),
    drawn("Small", { t: "move", v: [5, 40, 3], c: { t: "box", s: [12, 12, 12] } }),
  ];
  const front = viewOutline(parts, "front");
  const bar = linePoints(front, "Bar");
  assert.ok(bar.length > 4 && Math.min(...bar.map((p) => Math.abs(p[0]))) > 19.9, `the bar shows behind the cube (${Math.min(...bar.map((p) => Math.abs(p[0]))).toFixed(2)} mm from the middle)`);
  const b = extent(bar);
  assert.ok(Math.abs(b[0] + 50) < 0.1 && Math.abs(b[2] - 50) < 0.1 && Math.abs(b[3] - 10) < 0.1, "the bar's ends are drawn in full");
  assert.equal(linePoints(front, "Small").length, 0, "a covered part has no lines");
  // From the back the bar is in front: it covers the small block, and the
  // cube shows above and below it. From above nothing covers anything.
  const back = viewOutline(parts, "back");
  assert.equal(linePoints(back, "Small").length, 0);
  const cube = linePoints(back, "Cube");
  assert.ok(cube.length > 4 && Math.min(...cube.map((p) => Math.abs(p[1]))) > 9.9 && Math.abs(extent(cube)[3] - 20) < 0.1, "the cube shows above and below the bar");
  const top = viewOutline(parts, "top");
  assert.ok(Math.abs(extent(linePoints(top, "Small"))[2] - 11) < 0.1 && Math.abs(extent(linePoints(top, "Bar"))[3] - 65) < 0.1);
});

test("drawing: sections have the exact area, and sharp corners", () => {
  const block = [drawn("Block", { t: "subtract", a: { t: "box", s: [100, 60, 40] }, b: [{ t: "cylinder", r: 10, h: 60 }] })];
  // By default: across the longest axis (X) at its middle, through the hole.
  const plane = sectionPlane(modelBounds(block));
  assert.equal(plane.axis, "x");
  assert.ok(Math.abs(plane.offset) < 0.05);
  const cases = [
    [block, plane, 60 * 40 - 20 * 40],
    [block, { axis: "x", offset: 30 }, 60 * 40],
    [block, { axis: "z", offset: 5 }, 100 * 60 - Math.PI * 100],
    [block, { axis: "y", offset: 8 }, 100 * 40 - 2 * Math.sqrt(100 - 64) * 40],
    [[drawn("Tube", { t: "shell", th: 2, c: { t: "cylinder", r: 25, h: 80 } })], { axis: "z", offset: 0 }, Math.PI * (625 - 529)],
    [[drawn("Ball", { t: "sphere", r: 30 })], { axis: "y", offset: 18 }, Math.PI * (900 - 324)],
  ];
  for (const [parts, at, exact] of cases) {
    const cut = sectionCut(parts, at);
    const err = Math.abs(cut.area / exact - 1);
    assert.ok(err < 0.01, `${parts[0].name} cut at ${at.axis} = ${at.offset}: ${cut.area.toFixed(1)} mm2, exact ${exact.toFixed(1)} (${(err * 100).toFixed(2)}% off)`);
    // Far closer than 1% in fact: the outline comes from the function, not the mesh.
    assert.ok(err < 0.0005, `${parts[0].name} cut is ${(err * 100).toFixed(3)}% off`);
  }
  // The section through the hole is two 20 x 40 rectangles, each four exact corners.
  const loops = sectionCut(block, plane).parts[0].loops;
  assert.deepEqual(loops.map((l) => l.length / 2), [4, 4]);
  for (const l of loops) for (let i = 0; i < l.length; i += 2) assert.ok(Math.abs(Math.abs(Math.abs(l[i]) - 20) - 10) < 1e-6 && Math.abs(Math.abs(l[i + 1]) - 20) < 1e-6, `corner at ${l[i]}, ${l[i + 1]}`);
  // What is seen beyond the cut: the far half of the hole's wall, between the cut faces.
  const beyond = sectionView(block, plane).beyond.flatMap((p) => p.lines.flatMap((L) => Array.from(L)));
  assert.ok(beyond.length > 0 && beyond.every((v, i) => (i % 2 ? Math.abs(v) < 20.1 : Math.abs(v) < 30.1)));
  assert.throws(() => sectionPlane(modelBounds(block), { axis: "x", offset: 80 }), /misses the model, which runs from -50 to 50 mm along x/);
  assert.throws(() => sectionPlane(modelBounds(block), { axis: "w" }), /"x", "y" or "z"/);
});

test("drawing: the sheet has three views, a section, the overall sizes and a title block", () => {
  const block = [drawn("Block", { t: "subtract", a: { t: "box", s: [100, 60, 40] }, b: [{ t: "cylinder", r: 10, h: 60 }] })];
  const d = drawingSVG(block, { title: "Block & hole", date: "2026-01-31" });
  assert.equal(d.scale, "1:1");
  assert.ok(Math.abs(d.section.area - 1600) < 1);
  const label = (kind) => d.svg.match(new RegExp(`data-dimension="${kind}"[^>]*>([^<]*)<`))?.[1];
  assert.deepEqual([label("width"), label("depth"), label("height")], ["100", "60", "40"]);
  for (const id of ["view-front", "view-top", "view-left", "view-iso", "section-A", "cutting-line", "dimensions", "title-block", "border", "grid", "centring-marks"]) assert.ok(d.svg.includes(`id="${id}"`), `the sheet has no ${id}`);
  assert.match(d.svg, /width="420mm" height="297mm" viewBox="0 0 420 297"/);
  // On paper at 1:1 the front view is 100 x 40 mm, and nothing in the views
  // is drawn outside the frame.
  const front = d.svg.match(/<g id="view-front"[\s\S]*?<\/g>/)[0];
  const xy = (s) => [...s.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const b = extent(xy(front));
  assert.ok(Math.abs(b[2] - b[0] - 100) < 0.05 && Math.abs(b[3] - b[1] - 40) < 0.05, `front view on paper is ${(b[2] - b[0]).toFixed(2)} x ${(b[3] - b[1]).toFixed(2)} mm`);
  const drawing = d.svg.slice(d.svg.indexOf('<g id="view-front"'), d.svg.indexOf('<g id="title-block"'));
  assert.ok(xy(drawing).every(([x, y]) => x >= 20 && x <= 410 && y >= 10 && y <= 287), "a line leaves the sheet's frame");
  // Wide lines are twice the narrow ones (ISO 128), and the frame is 0.7 (ISO 5457).
  assert.match(front, /stroke-width="0.5"/);
  assert.match(d.svg, /class="hatch" stroke-width="0.25"/);
  assert.match(d.svg, /<rect id="border"[^>]*stroke-width="0.7"/);
  // The scale steps through the standard ones as the model grows, and the
  // third angle puts the view from the right in.
  const big = (k) => [drawn("Big", { t: "box", s: [100 * k, 60 * k, 40 * k] }, 4000)];
  assert.deepEqual([0.2, 2, 4, 9, 30, 60].map((k) => drawingSVG(big(k)).scale), ["5:1", "1:2", "1:5", "1:10", "1:20", "1:50"]);
  const third = drawingSVG(big(1), { projection: "third" }).svg;
  assert.match(third, /id="view-right"/);
  assert.match(third, /id="projection"[^>]*>Third angle</);
});

// The text with this id on a sheet: { x, y, size, s }.
const sheetText = (svg, id) => {
  const m = svg.match(new RegExp(`<text x="([\\d.-]+)" y="([\\d.-]+)" font-size="([\\d.]+)" id="${id}"[^>]*>([^<]*)<`));
  return m && { x: +m[1], y: +m[2], size: +m[3], s: m[4].replace(/&amp;/g, "&") };
};

test("drawing: the title block has every field ISO 7200 asks for, and fills only what it was given", () => {
  const block = [drawn("Block", { t: "box", s: [100, 60, 40] }, 4000)];
  const d = drawingSVG(block, { title: "Block & hole", date: "2026-01-31", info: { number: "3DM-4K7Q2X" } }).svg;
  const tb = d.match(/<g id="title-block"[\s\S]*?\n<\/g>/)[0];
  // The eight mandatory fields, each with its cell.
  for (const l of ["Legal owner", "Identification number", "Date of issue", "Sheet", "Title", "Approved by", "Created by", "Document type"]) assert.ok(tb.includes(`>${l}</text>`), `no ${l} field`);
  assert.equal(sheetText(d, "title").s, "Block & hole");
  assert.equal(sheetText(d, "title").size, 5);
  assert.equal(sheetText(d, "date").s, "2026-01-31");
  assert.equal(sheetText(d, "sheet").s, "1/1");
  assert.equal(sheetText(d, "number").s, "3DM-4K7Q2X");
  assert.equal(sheetText(d, "number").size, 5);
  assert.equal(sheetText(d, "document-type").s, "Part drawing");
  assert.equal(sheetText(d, "scale").s, "1:1");
  assert.equal(sheetText(d, "units").s, "mm");
  assert.equal(sheetText(d, "projection").s, "First angle");
  // Nothing nobody gave: no names, no revision, no tolerances.
  for (const id of ["created-by", "approved-by", "owner", "revision", "subtitle", "tolerances"]) assert.equal(sheetText(d, id), null, `${id} is filled in`);
  assert.ok(!tb.includes("General tolerances"));
  // 180 mm wide, at the bottom right against the frame, with a 0.7 outline.
  assert.match(tb, /<rect x="230" y="260" width="180" height="27" stroke-width="0.7"\/>/);
  // The credit is outside the frame, and in the metadata only as a comment.
  const credit = sheetText(d, "credit");
  assert.ok(credit && credit.x < 20 && !tb.includes("Draftsman"), "the credit is in the title block");
  assert.match(d, /<dc:identifier>3DM-4K7Q2X<\/dc:identifier>/);
  assert.ok(!/<dc:creator>/.test(d));
  // The projection symbol at its ISO 5456-2 size for 3.5 mm lettering:
  // circles 3.5 and 7 across, a cone 7 long, lines 0.35.
  const sym = d.match(/<g id="projection-symbol" stroke-width="([\d.]+)">([\s\S]*?)<\/g>/);
  assert.equal(sym[1], "0.35");
  assert.deepEqual([...sym[2].matchAll(/<circle [^>]*r="([\d.]+)"/g)].map((m) => +m[1] * 2), [3.5, 7]);
  const cone = [...sym[2].match(/<path d="([^"]+)"/)[1].matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  assert.ok(Math.abs(cone[1][0] - cone[0][0] - 7) < 1e-6 && Math.abs(cone[3][1] - cone[0][1] - 3.5) < 1e-6 && Math.abs(cone[2][1] - cone[1][1] - 7) < 1e-6, `cone ${JSON.stringify(cone)}`);
  // First angle: the end view right of the cone; third angle: left of it.
  const cx = (svg) => +svg.match(/<circle cx="([\d.]+)"/)[1];
  const coneX = (svg) => +svg.match(/<g id="projection-symbol"[^>]*><path d="M([\d.]+)/)[1];
  assert.ok(cx(d) > coneX(d));
  const t3 = drawingSVG(block, { projection: "third" }).svg;
  assert.ok(cx(t3) < coneX(t3));

  // Every field at its limit, in the widest letters there are: each value
  // is on the sheet whole, inside its cell, at 2.5 mm or more.
  const right = { "created-by": 285, "approved-by": 285, "document-type": 285, title: 355, "title-2": 355, subtitle: 355, "subtitle-2": 355, owner: 410, "owner-2": 410, number: 410, revision: 367, date: 392, sheet: 410, tolerances: 410 };
  const ids = { createdBy: ["created-by"], approvedBy: ["approved-by"], owner: ["owner", "owner-2"], number: ["number"], revision: ["revision"], subtitle: ["subtitle", "subtitle-2"], tolerances: ["tolerances"] };
  for (const letter of ["W", "—", "図", "m"]) {
    const info = Object.fromEntries(Object.entries(LIMITS).map(([k, n]) => [k, letter.repeat(n)]));
    // A title of 30 of them (ISO 7200's figure, which titleLines keeps to).
    const svg = drawingSVG(block, { title: letter.repeat(30), date: "2026-01-31", info: { ...info, type: "Assembly drawing" } }).svg;
    for (const [id, edge] of Object.entries(right)) {
      const t = sheetText(svg, id);
      if (!t && /-2$/.test(id)) continue;
      assert.ok(t, `no ${id} with ${letter}`);
      assert.ok(t.x + textWidth(t.s, t.size) <= edge - 1, `${id} "${t.s}" at ${t.size} mm runs to ${(t.x + textWidth(t.s, t.size)).toFixed(1)}, past ${edge}`);
      assert.ok(t.size >= 2.5, `${id} is lettered ${t.size} mm high`);
    }
    // Whole: the rows of each field put together give the value back.
    for (const [k, [id, id2]] of Object.entries(ids)) assert.equal((sheetText(svg, id)?.s ?? "") + (id2 ? sheetText(svg, id2)?.s ?? "" : "").replace(/^ /, ""), info[k], `${k} in ${letter} is not whole`);
    assert.equal((sheetText(svg, "title")?.s ?? "") + (sheetText(svg, "title-2")?.s ?? ""), letter.repeat(30));
  }
  // One more than a cell can hold is refused, not cut short.
  assert.throws(() => drawingSVG(block, { title: "Block", info: { createdBy: "—".repeat(22) } }), /Created by "—+" is too long for its cell/);
  const named = drawingSVG(block, { title: "Block", info: { createdBy: "Ana Ruiz", owner: "Example Works Ltd" } }).svg;
  assert.match(named, /<dc:creator>Ana Ruiz<\/dc:creator>/);
});

test("drawing: the section's name sits over what it cuts, and the isometric view has no scale", () => {
  // A plate with a block standing on one end: the cut across the middle
  // goes through the plate only, so the section is 50 mm lower than the box.
  const bracket = [drawn("Bracket", { t: "union", c: [{ t: "box", s: [100, 60, 10] }, { t: "move", v: [-40, 0, 30], c: { t: "box", s: [20, 60, 50] } }] })];
  const d = drawingSVG(bracket, { title: "Bracket" }).svg;
  const name = d.match(/<text x="[\d.]+" y="([\d.]+)"[^>]*id="section-name"/);
  const cut = [...d.match(/class="cut-outline"[^>]* d="([^"]+)"/)[1].matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => +m[1]);
  const gap = Math.min(...cut) - +name[1];
  assert.ok(gap > 2 && gap < 6, `A–A stands ${gap.toFixed(1)} mm above the cut face`);
  // Drawn, and no scale given on it: nothing is measured on a pictorial view.
  const iso = d.match(/<g id="view-iso"[\s\S]*?<\/g>/)?.[0];
  assert.ok(iso && !/Scale|data-scale/.test(iso));
});

test("drawing: a long title is split the way ISO 7200 suggests, and never stops a drawing", () => {
  assert.deepEqual(titleLines("Bearing block", ""), { title: "Bearing block", subtitle: "", shortened: false });
  assert.deepEqual(titleLines(""), { title: "Untitled", subtitle: "", shortened: false });
  // Fits the cell on one or two lines: kept whole.
  assert.deepEqual(titleLines("Black Hawk-style main rotor head"), { title: "Black Hawk-style main rotor head", subtitle: "", shortened: false });
  // 96 characters: the first words in the title, the rest in the supplementary title.
  const long = "Main gearbox input pinion housing with integral oil jets and chip detector port, left hand side.";
  assert.equal(long.length, 96);
  const s = titleLines(long);
  assert.ok(s.title.length <= 30 && !s.shortened, JSON.stringify(s));
  assert.equal(`${s.title} ${s.subtitle}`, long);
  // A supplementary title of the user's own stays, and the title has its cell to itself.
  assert.deepEqual(titleLines(long, "Prototype"), { title: long, subtitle: "Prototype", shortened: false });
  // Too long even for that: cut at a word, with "…".
  const huge = `${long} `.repeat(4).trim();
  const h = titleLines(huge), g = titleLines(huge, "Prototype");
  assert.ok(h.shortened && h.subtitle.endsWith("…") && huge.startsWith(`${h.title} ${h.subtitle.slice(0, -1)}`), JSON.stringify(h));
  assert.ok(g.shortened && g.title.endsWith("…") && g.subtitle === "Prototype" && huge.startsWith(g.title.slice(0, -1)), JSON.stringify(g));
  // And the sheets are made, with every line inside its cell.
  const block = [drawn("Block", { t: "box", s: [100, 60, 40] }, 4000)];
  for (const [title, subtitle] of [[long, ""], [long, "Prototype"], [huge, ""], [huge, "Prototype"]]) {
    const svg = drawingSVG(block, { title, info: { subtitle } }).svg;
    for (const id of ["title", "title-2", "subtitle", "subtitle-2"]) {
      const t = sheetText(svg, id);
      if (t) assert.ok(t.x + textWidth(t.s, t.size) <= 354 && t.size >= 2.5, `${id} "${t.s}" at ${t.size} mm`);
    }
  }
});

test("drawing: the frame has ISO 5457's grid and centring marks", () => {
  const d = drawingSVG([drawn("Block", { t: "box", s: [100, 60, 40] }, 4000)]).svg;
  const grid = d.match(/<g id="grid"[\s\S]*?<\/g>/)[0];
  const marks = [...grid.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)</g)].map((m) => ({ x: +m[1], y: +m[2], s: m[3] }));
  const top = marks.filter((m) => m.y < 10).sort((a, b) => a.x - b.x).map((m) => m.s).join("");
  const left = marks.filter((m) => m.x < 20).sort((a, b) => a.y - b.y).map((m) => m.s).join("");
  assert.equal(top, "12345678");
  assert.equal(left, "ABCDEF");
  assert.equal(marks.length, 2 * 8 + 2 * 6);
  // Fields are 50 mm long from the middle of each side: the inner field
  // boundaries along the top fall at 60, 110, ... 360.
  const ticks = [...grid.matchAll(/M([\d.]+) 5V10/g)].map((m) => +m[1]);
  assert.deepEqual(ticks, [60, 110, 160, 210, 260, 310, 360]);
  assert.match(d, /<path id="centring-marks" stroke-width="0.7"[^>]*d="M210 5V20M210 292V277M15 148.5H30M415 148.5H400"/);
  assert.equal(sheetText(d, "sheet-size").s, "A3");
});

test("drawing: Claude's rotor head draws, with its mast, hub and gearbox cut by the section", () => {
  const r = runScript(readFileSync(new URL("./models/claude-rotor-head.js", import.meta.url), "utf8"), {});
  const parts = r.parts.map((p) => {
    const m = meshPart(p.node, { budget: 3000 });
    return { name: p.name, ...compile(p.node), positions: m.positions, indices: m.indices };
  });
  const d = drawingSVG(parts, { title: r.title, section: { axis: "y", offset: 0 } });
  assert.equal(d.scale, "1:50");
  const cut = sectionCut(parts, { axis: "y", offset: 0 });
  const names = cut.parts.map((p) => p.name);
  for (const n of ["Gearbox top", "Rotor mast", "Hub", "Blade 1", "Blade 3"]) assert.ok(names.includes(n), `${n} is not cut`);
  assert.ok(!names.includes("Blade 2") && !names.includes("Blade 4"), "a blade that lies along Y, off the plane, is cut");
  assert.ok((d.svg.match(/class="cut"/g) ?? []).length === names.length);
  // An assembly this crowded at 1:50 is drawn in the 0.25 line group, so
  // the hub does not fill in; the block above is drawn in the 0.5 group.
  assert.match(d.svg, /<g id="view-top"[^>]*stroke-width="0.25"/);
  assert.equal(d.svg.match(/<text [^>]*id="document-type"[^>]*>([^<]*)</)[1], "Assembly drawing");
});

// ---- glTF, OBJ and PLY ----

// A crank, a rod linked to it and a sliding piston: spin, follow, link and
// slide, with a glass and a plastic part.
const CRANK = `title("Crank & piston");
loop(1);
part("Base", box(120, 60, 8).at(0, 0, -60), { color: "#4f7cac" });
part("Crank", cylinder(30, 10).rotateX(90).at(0, -10, 0), { color: "#8d939a", spin: { axis: "y", rpm: 60 } });
part("Crank pin", sphere(5).at(0, -2, 25), { color: "#d9a441", material: "plastic", follow: "Crank" });
const pin = [0, 0, 25], top = [0, 0, 125];
part("Piston", cylinder(20, 30).at(0, 0, 135), { color: "#222222", motion: t => { const p = where("Crank", pin, t); return slide(0, 0, p[2] + Math.sqrt(100 ** 2 - p[0] ** 2) - top[2]); } });
part("Rod", capsule(pin, top, 5), { color: "#9aa3ad", motion: t => link(pin, top, where("Crank", pin, t), where("Piston", top, t)) });
part("Cover", box(40, 2, 40).at(60, 30, 100), { color: "#aaccee", material: "glass" });
joint("Rod", "Crank", pin);
joint("Rod", "Piston", top);`;
const crankParts = () => {
  const r = runScript(CRANK);
  assert.equal(r.error, undefined);
  return { r, parts: r.parts.map((p) => ({ name: p.name, color: p.color, material: p.material, frames: p.frames, ...displayMesh(meshPart(p.node, { budget: 3000, normals: true })) })) };
};

test("glTF: named parts in metres with Y up, materials, and the motion as an animation three.js plays", async () => {
  const { r, parts } = crankParts();
  const glb = toGLB(parts, { title: r.title, motion: r.motion });
  const c = checkGLB(Buffer.from(glb));
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.parts.map((p) => [p.name, p.triangles]), parts.map((p) => [p.name, p.indices.length / 3]));
  // Bounds back in our millimetres, Z up, as meshed.
  for (const [i, p] of c.parts.entries()) {
    const b = meshBounds(parts[i]);
    p.bounds.forEach((v, k) => assert.ok(Math.abs(v - b[k]) < 1e-3, `${p.name} bound ${k}: ${v} vs ${b[k]}`));
  }
  const look = Object.fromEntries(c.parts.map((p) => [p.name, [p.material.metallic, p.material.roughness, p.material.alphaMode]]));
  assert.deepEqual(look, { Base: [0, 0.46, "OPAQUE"], Crank: [0.92, 0.36, "OPAQUE"], "Crank pin": [0, 0.52, "OPAQUE"], Piston: [0, 0.93, "OPAQUE"], Rod: [0.92, 0.36, "OPAQUE"], Cover: [0, 0.05, "BLEND"] });
  // The look without a material is picked as the view picks it.
  for (const color of ["#4f7cac", "#8d939a", "#222222", "#2f3338", "#b8483e", "#9aa3ad", "#c8c8c0", "#3a3f2a"]) {
    const hsl = new THREE.Color(color).getHSL({});
    assert.equal(lookOf({ color }), hsl.s >= 0.16 ? "paint" : hsl.l < 0.16 ? "rubber" : "metal", color);
  }
  assert.equal(c.animations.length, 1);
  assert.ok(Math.abs(c.animations[0].duration - 1) < 1e-6);
  assert.equal(c.animations[0].parts, 4, "crank, pin, piston and rod move");

  // three.js's own loader: the same parts, and poses at the keys where the
  // kernel puts them.
  const g = await new Promise((ok, fail) => new GLTFLoader().parse(glb.buffer, "", ok, fail));
  const byName = (n) => g.scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n));
  assert.ok(parts.every((p) => byName(p.name)?.isMesh));
  const mixer = new THREE.AnimationMixer(g.scene);
  mixer.clipAction(g.animations[0]).play();
  const count = r.motion.frames;
  let worst = 0;
  for (const k of [7, 15, 30, 44, 59]) {
    mixer.setTime((k / count) * r.motion.loop);
    g.scene.updateMatrixWorld(true);
    for (const p of r.parts.filter((x) => x.frames)) {
      for (const at of [[0, 0, 25], [0, 0, 125], [30, -10, 0]]) {
        const want = apply(Array.from(p.frames.subarray(k * 12, k * 12 + 12)), at);
        const v = new THREE.Vector3(at[0] / 1000, at[2] / 1000, -at[1] / 1000).applyMatrix4(byName(p.name).matrixWorld);
        worst = Math.max(worst, Math.hypot(v.x * 1000 - want[0], -v.z * 1000 - want[1], v.y * 1000 - want[2]));
      }
    }
  }
  assert.ok(worst < 0.01, `poses are off by up to ${worst} mm`);
  // Without motion, no animation.
  assert.equal(checkGLB(Buffer.from(toGLB(parts.map((p) => ({ ...p, frames: null }))))).animations.length, 0);
});

test("OBJ and MTL: one object per part with normals, in mm with Y up; PLY: one coloured mesh", () => {
  const { r, parts } = crankParts();
  const { obj, mtl } = toOBJ(parts, { title: r.title });
  const o = checkOBJ(objWithMtl(obj, mtlFileName("Crank & piston.obj")), mtl);
  assert.deepEqual(o.problems, []);
  assert.equal(o.mtllib, "Crank-piston.mtl");
  assert.deepEqual(o.parts.map((p) => [p.name, p.triangles]), parts.map((p) => [p.name, p.indices.length / 3]));
  for (const [i, p] of o.parts.entries()) {
    const b = meshBounds(parts[i]);
    p.bounds.forEach((v, k) => assert.ok(Math.abs(v - b[k]) < 1e-3, `${p.name} bound ${k}: ${v} vs ${b[k]}`));
  }
  assert.deepEqual(o.parts[0].material.Kd, [0x4f / 255, 0x7c / 255, 0xac / 255].map((v) => +v.toFixed(4)));
  assert.deepEqual(o.parts.map((p) => [p.material.Pm, p.material.Pr, p.material.d]).slice(-2), [[0.92, 0.36, 1], [0, 0.05, 0.36]]);

  // PLY gets the closed meshes with shared vertices, as STL and 3MF do.
  const plain = r.parts.map((p) => ({ name: p.name, color: p.color, ...meshPart(p.node, { budget: 3000 }) }));
  const ply = checkPLY(Buffer.from(toPLY(plain, { title: r.title })));
  assert.deepEqual(ply.problems, []);
  assert.deepEqual(ply.parts.map((p) => [p.name, p.triangles, p.colors]), plain.map((p) => [p.name, p.indices.length / 3, [p.color]]));
  for (const [i, p] of ply.parts.entries()) {
    const b = meshBounds(plain[i]);
    p.bounds.forEach((v, k) => assert.ok(Math.abs(v - b[k]) < 1e-3));
  }
});

test("measure: volume, centre of mass and nearest points from the distance functions", async () => {
  const { solidMoments, nearestPoints } = await import("../src/kernel/measure.js");
  const cases = [
    [{ t: "sphere", r: 20 }, (4 / 3) * Math.PI * 8000],
    [{ t: "cylinder", r: 10, h: 30 }, Math.PI * 3000],
    [{ t: "torus", R: 20, r: 5 }, 2 * Math.PI ** 2 * 500],
    [{ t: "subtract", a: { t: "box", s: [40, 40, 40] }, b: [{ t: "cylinder", r: 10, h: 50 }] }, 64000 - Math.PI * 100 * 40],
  ];
  for (const [node, exact] of cases) {
    const { f, box } = compile(node);
    const r = solidMoments(f, box);
    assert.ok(Math.abs(r.volume / exact - 1) < 0.001, `${node.t} volume off by ${((r.volume / exact - 1) * 100).toFixed(3)}%`);
    assert.ok(Math.hypot(...r.centre) < 0.01, `${node.t} centre of mass at ${r.centre}`);
  }
  // A half cylinder's centre of mass is 4r / 3 pi from its flat face.
  const half = compile(runScript('part("H", cylinder(30, 10).cut(box(100, 100, 20).at(0, -50, 0)));', {}).parts[0].node);
  const h = solidMoments(half.f, half.box);
  assert.ok(Math.abs(h.volume / (Math.PI * 450 * 10) - 1) < 0.001, `half cylinder volume ${h.volume}`);
  assert.ok(Math.abs(h.centre[1] - 40 / Math.PI) < 0.02, `half cylinder centre of mass at y ${h.centre[1]}, ${40 / Math.PI} expected`);
  const a = runScript('part("A", box(40, 20, 10).at(0, 0, 5)); part("B", cylinder(10, 20).at(50, 0, 10));', {}).parts.map((p) => compile(p.node));
  const region = [0, 1, 2].map((i) => Math.min(a[0].box[i], a[1].box[i])).concat([3, 4, 5].map((i) => Math.max(a[0].box[i], a[1].box[i])));
  const g = nearestPoints(a[0].f, a[1].f, region, { cell: 0.02 });
  assert.ok(Math.abs(g.gap - 20) < 0.01 && Math.abs(g.a[0] - 20) < 0.01 && Math.abs(g.b[0] - 40) < 0.01, JSON.stringify(g));
});

test("the app's Claude is allowed every tool the server offers", () => {
  const server = readFileSync(new URL("../mcp/server.mjs", import.meta.url), "utf8");
  const offered = [...server.matchAll(/^tool\(\s*"(\w+)"/gm)].map((m) => m[1]).sort();
  const app = readFileSync(new URL("../src/app/claude.js", import.meta.url), "utf8");
  const allowed = JSON.parse(app.match(/const TOOLS = (\[[^\]]*\])/)[1]).sort();
  assert.ok(offered.length >= 10);
  assert.deepEqual(allowed, offered);
  // Claude Code shows only the first 4096 characters of a server's
  // instructions, so the language lives in the reference tool instead.
  const instructions = server.match(/const INSTRUCTIONS = `([\s\S]*?)`;/)[1];
  assert.ok(instructions.length < 3000, `server instructions are ${instructions.length} characters`);
  assert.match(instructions, /call the reference tool/);
  assert.match(app, /import \{ REFERENCE \} from "..\/..\/mcp\/reference.mjs"/);
});

await queue;
console.log(`${passed} tests passed`);
