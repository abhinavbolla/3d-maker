// Validates a binary STL: structure, size, and that the mesh is closed
// (every edge shared by exactly two triangles), which slicers need.
// Usage: node test/check-stl.mjs model.stl
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node test/check-stl.mjs model.stl");
  process.exit(2);
}
const buf = readFileSync(file);
const count = buf.readUInt32LE(80);
const problems = [];
if (buf.length !== 84 + count * 50) problems.push(`length ${buf.length} does not match ${count} triangles`);

const key = (x, y, z) => `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
const ids = new Map();
const vid = (x, y, z) => {
  const k = key(x, y, z);
  if (!ids.has(k)) ids.set(k, ids.size);
  return ids.get(k);
};
const edges = new Map();
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
let degenerate = 0;
let signedVolume = 0;

for (let i = 0; i < count; i++) {
  const o = 84 + i * 50 + 12;
  const p = [0, 1, 2].map((j) => [0, 1, 2].map((k) => buf.readFloatLE(o + j * 12 + k * 4)));
  if (p.flat().some((v) => !Number.isFinite(v))) problems.push(`triangle ${i} has a non-finite coordinate`);
  for (const v of p) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], v[k])), (max[k] = Math.max(max[k], v[k]));
  const [a, b, c] = p.map((v) => vid(...v));
  if (a === b || b === c || a === c) {
    degenerate++;
    continue;
  }
  for (const [u, v] of [[a, b], [b, c], [c, a]]) {
    const e = u < v ? `${u}-${v}` : `${v}-${u}`;
    edges.set(e, (edges.get(e) ?? 0) + 1);
  }
  const [p0, p1, p2] = p;
  signedVolume +=
    (p0[0] * (p1[1] * p2[2] - p1[2] * p2[1]) - p0[1] * (p1[0] * p2[2] - p1[2] * p2[0]) + p0[2] * (p1[0] * p2[1] - p1[1] * p2[0])) / 6;
}

const open = [...edges.values()].filter((n) => n !== 2).length;
if (open) problems.push(`${open} edges are not shared by exactly two triangles (mesh is not closed)`);
if (count === 0) problems.push("no triangles");

const size = max.map((v, i) => +(v - min[i]).toFixed(2));
console.log(`${file}`);
console.log(`  triangles ${count}, vertices ${ids.size}, degenerate ${degenerate}`);
console.log(`  size ${size.join(" x ")} mm, volume ${(Math.abs(signedVolume) / 1000).toFixed(1)} cm3`);
console.log(problems.length ? `  INVALID: ${problems.join("; ")}` : "  valid, closed mesh");
process.exit(problems.length ? 1 : 0);
