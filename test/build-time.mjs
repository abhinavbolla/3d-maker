// How long a model takes to build, and a fingerprint of what was built.
//
// Runs each model the way the app does: the script, then every part meshed at
// preview detail, then again at fine detail sized from the preview's real
// surface (see detailFor in src/app/kernel.js), each with the drawing copy
// and the lighter copy the worker makes. One thread, so the times are the
// work itself, not how many workers the machine has.
//
// For each model and quality it prints the time, the triangles, and a hash of
// every vertex and index. A change that should only make builds faster must
// leave the hash as it was.
//
// Usage: node test/build-time.mjs [--runs 3] [--json out.json] [--parts] [model.js ...]
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { runScript } from "../src/kernel/script.js";
import { compile } from "../src/kernel/sdf.js";
import { meshArea, displayMesh, lightMesh } from "../src/kernel/mesh.js";
import { meshPart } from "../src/kernel/pieces.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const runs = Number(opt("--runs", 3));
const jsonOut = opt("--json", null);
const perPart = args.includes("--parts");
const valued = new Set(["--runs", "--json"]);
const named = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
const models = named.length ? named : ["claude-helicopter.js", "claude-rotor-head.js", "helicopter.js", "bracket.js", "house.js"].map((f) => new URL(`./models/${f}`, import.meta.url).pathname);

// The app's own numbers (src/app/kernel.js). Kept in step by hand: the app's
// module starts workers, so it cannot be loaded here.
const QUALITY = {
  preview: { budget: (n) => Math.min(40000, Math.max(6000, 600000 / n)), cells: 80000, partCap: 150000 },
  fine: { budget: (n) => Math.min(160000, Math.max(24000, 2400000 / n)), cells: 600000, partCap: 1200000 },
};
const LIGHT_FROM = 4000, LIGHT_CELLS = 3;
function boxArea(parts) {
  let a = 0;
  for (const { box } of parts) {
    if (!box || !(box[3] >= box[0])) continue;
    const [x, y, z] = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
    a += 2 * (x * y + y * z + z * x);
  }
  return Number.isFinite(a) ? a : 0;
}
function detailFor(parts, quality) {
  const q = QUALITY[quality];
  const n = 2 ** Math.ceil(Math.log2(Math.max(1, parts.length)));
  const budget = Math.round(q.budget(n));
  const area = parts.every((p) => p.mesh?.area >= 0) ? parts.reduce((a, p) => a + (p.hidden ? 0 : p.mesh.area), 0) : boxArea(parts);
  const maxCell = area > 0 ? 2 ** (Math.round(4 * Math.log2(Math.sqrt(area / q.cells))) / 4) : Infinity;
  return { budget, maxCell, maxCells: q.partCap };
}

// What the worker does for one "mesh" job.
function meshJob(node, detail, hash) {
  const t0 = performance.now();
  const m = meshPart(node, { ...detail, normals: true });
  const t1 = performance.now();
  const d = displayMesh(m, undefined, compile(node).f);
  const t2 = performance.now();
  const light = d.indices.length >= LIGHT_FROM * 3 ? lightMesh(d, m.cellSize * LIGHT_CELLS) : null;
  const t3 = performance.now();
  for (const a of [m.positions, m.indices, d.positions, d.normals, d.indices]) hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  if (light) for (const a of [light.positions, light.normals, light.indices]) hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  return { mesh: { area: meshArea(m), cellSize: m.cellSize }, triangles: m.indices.length / 3, volume: m.volume, ms: { mesh: t1 - t0, display: t2 - t1, light: t3 - t2 } };
}

function build(src) {
  const t0 = performance.now();
  const r = runScript(src, {});
  if (r.error) throw new Error(r.error);
  for (const p of r.parts) p.box = compile(p.node).box;
  const out = { script: performance.now() - t0 };
  for (const quality of ["preview", "fine"]) {
    const detail = detailFor(r.parts, quality);
    const hash = createHash("sha256");
    const sum = { mesh: 0, display: 0, light: 0, triangles: 0, volume: 0, parts: [] };
    for (const p of r.parts) {
      const j = meshJob(p.node, detail, hash);
      p.mesh = j.mesh;
      for (const k of ["mesh", "display", "light"]) sum[k] += j.ms[k];
      sum.triangles += j.triangles;
      sum.volume += j.volume;
      sum.parts.push({ name: p.name, ms: j.ms.mesh + j.ms.display + j.ms.light, triangles: j.triangles });
    }
    out[quality] = { ...sum, total: sum.mesh + sum.display + sum.light, hash: hash.digest("hex").slice(0, 16) };
  }
  return out;
}

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const results = {};
for (const path of models) {
  const name = path.split("/").pop();
  const src = readFileSync(path, "utf8");
  const all = [];
  for (let i = 0; i < runs; i++) all.push(build(src));
  const row = { script: median(all.map((r) => r.script)) };
  for (const quality of ["preview", "fine"]) {
    const q = all.map((r) => r[quality]);
    if (new Set(q.map((r) => r.hash)).size > 1) throw new Error(`${name}: two runs built different meshes`);
    row[quality] = { ms: median(q.map((r) => r.total)), mesh: median(q.map((r) => r.mesh)), display: median(q.map((r) => r.display)), light: median(q.map((r) => r.light)), triangles: q[0].triangles, volume: q[0].volume, hash: q[0].hash, parts: q[0].parts };
  }
  results[name] = row;
  for (const quality of ["preview", "fine"]) {
    const q = row[quality];
    console.log(`${name.padEnd(24)} ${quality.padEnd(8)} ${q.ms.toFixed(0).padStart(6)} ms  (mesh ${q.mesh.toFixed(0)}, drawing copy ${q.display.toFixed(0)}, light copy ${q.light.toFixed(0)})  ${String(q.triangles).padStart(8)} triangles  ${q.hash}`);
    if (perPart) for (const p of [...q.parts].sort((a, b) => b.ms - a.ms).slice(0, 8)) console.log(`    ${p.name.padEnd(28)} ${p.ms.toFixed(0).padStart(6)} ms ${String(p.triangles).padStart(8)}`);
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1));
