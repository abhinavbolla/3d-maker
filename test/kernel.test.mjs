// Node smoke test for the kernel: builds a mug and every primitive, exports STL and STEP.
import opencascade from "replicad-opencascadejs";
import { initKernel, buildScene, exportScene } from "../src/kernel/kernel.js";
import { emptyDoc, KINDS } from "../src/model/schema.js";
import { addShape, makeBoolean, addFeature } from "../src/model/ops.js";
import assert from "node:assert/strict";

const t0 = Date.now();
initKernel(await opencascade());
console.log(`kernel ready in ${Date.now() - t0} ms`);

let doc = emptyDoc();
for (const kind of Object.keys(KINDS)) doc = addShape(doc, { kind, position: [doc.nodes.length * 40, 0, 0] }).doc;
let r = buildScene(doc);
for (const m of r) {
  assert.ok(!m.error, `${m.id}: ${m.error}`);
  assert.ok(m.triangles.length > 0 && m.volume > 0, m.id);
}
console.log("primitives ok:", r.map((m) => `${m.id}=${m.volume.toFixed(0)}`).join(" "));

// Mug: body cylinder shelled from the top, torus handle, minus the inside.
doc = emptyDoc();
let body, handle, hole;
({ doc, id: body } = addShape(doc, { kind: "cylinder", params: { radius: 40, height: 95 }, name: "Body" }));
doc = addFeature(doc, body, { type: "fillet", radius: 8, edges: "bottom" }).doc;
doc = addFeature(doc, body, { type: "shell", thickness: 4, open: "top" }).doc;
({ doc, id: handle } = addShape(doc, { kind: "torus", params: { majorRadius: 24, minorRadius: 6 }, position: [40, 0, 50], rotation: [90, 0, 0] }));
// The handle torus pokes into the cup; cut it back with a cylinder the size of the inside.
({ doc, id: hole } = addShape(doc, { kind: "cylinder", params: { radius: 36, height: 95 }, position: [0, 0, 4] }));
let tmp;
({ doc, id: tmp } = makeBoolean(doc, "union", [body, handle], "Mug + handle"));
({ doc } = makeBoolean(doc, "subtract", [tmp, hole], "Mug"));
// A failing feature must report a readable error, not crash the scene.
let bad = addShape(emptyDoc(), { kind: "box" });
bad = addFeature(bad.doc, bad.id, { type: "fillet", radius: 50 });
const badResult = buildScene(bad.doc)[0];
assert.match(badResult.error, /radius is probably too large/);
r = buildScene(doc);
assert.equal(r.length, 1);
assert.ok(!r[0].error, r[0].error);
console.log("mug volume", r[0].volume.toFixed(0), "bounds", JSON.stringify(r[0].bounds.map((p) => p.map((v) => +v.toFixed(2)))));

const stl = new Uint8Array(await exportScene(doc, "stl").arrayBuffer());
const tris = new DataView(stl.buffer).getUint32(80, true);
assert.equal(stl.length, 84 + tris * 50, "binary STL length matches triangle count");
const step = await exportScene(doc, "step").text();
assert.ok(step.startsWith("ISO-10303-21"), "STEP header");
console.log(`stl ${tris} triangles, ${stl.length} bytes; step ${step.length} chars; total ${Date.now() - t0} ms`);
