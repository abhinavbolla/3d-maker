// Loads a model script into a fresh app window (headless Chrome, no Claude),
// exports it as STEP the way Export > STEP does, saves the file and checks it
// with check-step.mjs.
// Usage: node test/step-run.mjs model.js [out.step]
import { startHarness } from "./harness.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { checkStep } from "./check-step.mjs";

const [file, out = "model.step"] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node test/step-run.mjs model.js [out.step]");
  process.exit(2);
}
const h = await startHarness({ port: Number(process.env.PORT ?? 5182) });
let code = 0;
try {
  const w = await h.openWindow();
  const set = await h.command(w, "set_model", { script: readFileSync(file, "utf8") });
  if (set.error) throw new Error(set.error);
  const t = Date.now();
  const r = await h.command(w, "export_step");
  if (r.error) throw new Error(r.error);
  const ms = Date.now() - t;
  const { base64, ...facts } = r.result;
  const bytes = Buffer.from(base64, "base64");
  writeFileSync(out, bytes);
  const c = checkStep(bytes.toString("latin1"));
  console.log(`${file}: ${set.result.parts?.length ?? "?"} parts, STEP in ${ms} ms, ${(bytes.length / 1e6).toFixed(2)} MB, ${facts.faces} faces, ${facts.exact_parts.length} parts exact, ${facts.faceted_parts.length} faceted -> ${out}`);
  console.log(`exact: ${facts.exact_parts.join(", ") || "none"}`);
  console.log(c.problems.length ? `${c.problems.length} problems:\n${c.problems.slice(0, 20).join("\n")}` : `check-step: no problems (${c.parts.length} parts, ${c.entities} entities)`);
  if (c.problems.length) code = 1;
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await h.close();
}
process.exit(code);
