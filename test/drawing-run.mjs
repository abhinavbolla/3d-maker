// Loads a model script into a fresh app window (headless Chrome, no Claude),
// exports its drawing the way Export > Drawing does, and saves the SVG.
// Usage: node test/drawing-run.mjs model.js [out.svg] [axis] [offset]
import { startHarness } from "./harness.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const [file, out = "drawing.svg", axis, offset] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node test/drawing-run.mjs model.js [out.svg] [axis] [offset]");
  process.exit(2);
}
const h = await startHarness({ port: Number(process.env.PORT ?? 5181) });
let code = 0;
try {
  const w = await h.openWindow();
  const set = await h.command(w, "set_model", { script: readFileSync(file, "utf8") });
  if (set.error) throw new Error(set.error);
  const t = Date.now();
  const d = await h.command(w, "export_drawing", { axis, offset: offset === undefined ? undefined : Number(offset) });
  if (d.error) throw new Error(d.error);
  const { base64, ...facts } = d.result;
  writeFileSync(out, Buffer.from(base64, "base64"));
  console.log(`${file}: ${set.result.parts?.length ?? "?"} parts, drawing in ${Date.now() - t} ms -> ${out}\n${JSON.stringify(facts)}`);
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await h.close();
}
process.exit(code);
