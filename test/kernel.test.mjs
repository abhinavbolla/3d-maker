// Kernel tests: exact volumes for simple shapes, closed meshes for thousands
// of random shapes, the example scripts, and script error messages.
// Usage: node test/kernel.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compile } from "../src/kernel/sdf.js";
import { meshSDF, meshVolume, meshBounds, openEdges, toSTL, displayMesh } from "../src/kernel/mesh.js";
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
  const doc = readFileSync(new URL("../mcp/server.mjs", import.meta.url), "utf8");
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

test("linked motion: the documented crank keeps its joints closed", () => {
  // Same script as the example in mcp/server.mjs.
  const src = `loop(1);
part("Crank", cylinder(30, 10).rotateX(90), { spin: { axis: "y", rpm: 60 } });
const pin = [0, 0, 25], top = [0, 0, 125];
part("Piston", cylinder(20, 30).at(0, 0, 135), { motion: t => { const p = where("Crank", pin, t); return slide(0, 0, p[2] + Math.sqrt(100 ** 2 - p[0] ** 2) - top[2]); } });
part("Rod", capsule(pin, top, 5), { motion: t => link(pin, top, where("Crank", pin, t), where("Piston", top, t)) });
joint("Rod", "Crank", pin);
joint("Rod", "Piston", top);`;
  const doc = readFileSync(new URL("../mcp/server.mjs", import.meta.url), "utf8");
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

console.log(`${passed} tests passed`);
