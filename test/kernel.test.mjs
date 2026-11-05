// Kernel tests: exact volumes for simple shapes, closed meshes for thousands
// of random shapes, the example scripts, and script error messages.
// Usage: node test/kernel.test.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { compile } from "../src/kernel/sdf.js";
import { meshSDF, meshVolume, openEdges, toSTL } from "../src/kernel/mesh.js";
import { runScript } from "../src/kernel/script.js";

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

let passed = 0;
const test = (name, fn) => {
  const t = performance.now();
  fn();
  passed++;
  console.log(`ok  ${name} (${Math.round(performance.now() - t)} ms)`);
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

test("thin parts are not lost", () => {
  // A 50 mm thick blade, 5 m long: thinner than the first grid cells.
  const m = mesh({ t: "box", s: [5000, 300, 50] }, 6000);
  assert.ok(m.indices.length > 0 && openEdges(m) === 0);
  assert.ok(Math.abs(meshVolume(m) / (5000 * 300 * 50) - 1) < 0.05);
});

test("model scripts: example, test helicopter, Claude's helicopter", () => {
  const lamp = readFileSync(new URL("../mcp/server.mjs", import.meta.url), "utf8").match(/EXAMPLE\n([\s\S]*?)\n\nHOW TO WORK/)[1];
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

console.log(`${passed} tests passed`);
