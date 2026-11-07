// Loads a saved run's script into a fresh app window (headless Chrome, no
// Claude) and times the STL export, checking it is closed.
// Usage: node test/export-run.mjs runs/<name>/model.js
import { startHarness } from "./harness.mjs";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node test/export-run.mjs model.js");
  process.exit(2);
}
const h = await startHarness({ port: Number(process.env.PORT ?? 5178) });
let code = 0;
try {
  const w = await h.openWindow();
  const set = await h.command(w, "set_model", { script: readFileSync(file, "utf8") });
  if (set.error) throw new Error(set.error);
  const t = Date.now();
  const stl = await h.stlIsClosed(w);
  console.log(`${file}: ${set.result.parts?.length ?? "?"} parts, export ${Date.now() - t} ms, ${stl.triangles} triangles, ${stl.closed ? "closed" : "NOT closed"}`);
  if (!stl.closed) code = 1;
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await h.close();
}
process.exit(code);
