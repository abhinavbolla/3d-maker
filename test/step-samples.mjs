// Writes the STEP files a real CAD program is asked to open, and what each
// should hold. The scripts are in test/models/step; the numbers come from the
// kernel and from our own reader (test/check-step.mjs), and three are worked
// out by hand below. .github/workflows/step-freecad.yml opens the files in
// FreeCAD with test/freecad-check.py and compares.
// Usage: node test/step-samples.mjs out-dir
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { runScript } from "../src/kernel/script.js";
import { compile } from "../src/kernel/sdf.js";
import { meshSDF } from "../src/kernel/mesh.js";
import { exactParts, partsToSTEP } from "../src/kernel/step.js";
import { checkStep } from "./check-step.mjs";

const out = process.argv[2];
if (!out) {
  console.error("Usage: node test/step-samples.mjs out-dir");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const dir = new URL("./models/step/", import.meta.url).pathname;

// Volumes by hand, in mm3: a cylinder; a plate with rounded corners, four
// holes and a slot; a turned knob (cylinders, a torus and a sphere).
const BY_HAND = { "simple-cylinder": 75398.22, "plate-with-holes": 22246.35, "turned-part": 65471.61 };

const expected = {};
let failed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
  const name = basename(file, ".js");
  const r = runScript(readFileSync(join(dir, file), "utf8"));
  const parts = r.parts.filter((p) => !p.hidden);
  const exact = exactParts(parts);
  const meshes = parts.map((p, i) => {
    if (exact[i]) return undefined;
    const { f, box } = compile(p.node);
    return meshSDF(f, box, { budget: 6000 });
  });
  const step = partsToSTEP(parts, exact, meshes, { title: r.title, file: `${name}.step`, time: "2026-01-01T00:00:00" });
  const read = checkStep(step.text);
  writeFileSync(join(out, `${name}.step`), step.text);
  const total = read.parts.reduce((s, p) => s + p.volume, 0);
  const byHand = BY_HAND[name];
  const ok = !read.problems.length && (byHand === undefined || Math.abs(total - byHand) <= 1e-6 * byHand);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}.step: ${read.parts.length} parts (${step.exact.length} exact), ${step.faces} faces, volume ${total.toFixed(2)} mm3${byHand === undefined ? "" : `, by hand ${byHand}`}${read.problems.length ? `: ${read.problems.slice(0, 3).join("; ")}` : ""}`);
  expected[`${name}.step`] = {
    title: r.title,
    by_hand_volume: byHand ?? null,
    parts: read.parts.map((p) => ({ name: p.name, exact: step.exact.includes(p.name), solids: p.solids.length, volume: p.volume, bounds: p.bounds, colour: parts.find((q) => q.name === p.name)?.color ?? null })),
  };
}
writeFileSync(join(out, "expected.json"), JSON.stringify(expected, null, 1));
process.exit(failed ? 1 : 0);
