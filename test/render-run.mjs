// Loads a model script into a fresh app window (headless Chrome, no Claude)
// and saves what Claude would see: iso, front and top pictures, the parts and
// the fit check. For comparing a hand-edited model with what Claude made.
// Usage: node test/render-run.mjs runs/<name>/model.js [outDir] ["Part A,Part B"]
// The optional part list adds close-ups (side.png, close.png) framed on those parts.
// It also saves studio.png, the picture Export > Picture makes, from a low
// angle (framed on the listed parts if there are any).
import { startHarness } from "./harness.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node test/render-run.mjs model.js [outDir]");
  process.exit(2);
}
const out = process.argv[3] ?? dirname(file);
mkdirSync(out, { recursive: true });
const h = await startHarness({ port: Number(process.env.PORT ?? 5180) });
let code = 0;
try {
  const w = await h.openWindow();
  const t = Date.now();
  const set = await h.command(w, "set_model", { script: readFileSync(file, "utf8") });
  if (set.error) throw new Error(set.error);
  for (const view of ["iso", "front", "top"]) {
    const shot = await h.command(w, "screenshot", { view, width: 1400, height: 1000 });
    if (shot.error) throw new Error(shot.error);
    writeFileSync(join(out, `${view}.png`), Buffer.from(shot.result.png, "base64"));
  }
  const close = process.argv[4]?.split(",").map((n) => n.trim()).filter(Boolean);
  for (const [name, view] of close?.length ? [["side", "front"], ["close", "iso"]] : []) {
    const shot = await h.command(w, "screenshot", { view, parts: close, width: 1400, height: 1000 });
    if (shot.error) throw new Error(shot.error);
    writeFileSync(join(out, `${name}.png`), Buffer.from(shot.result.png, "base64"));
  }
  await w(`window.__3dmaker.fit("low", ${JSON.stringify(close?.length ? close : null)} ?? undefined)`);
  const studio = await w("window.__3dmaker.picture({ width: 2400 })");
  writeFileSync(join(out, "studio.png"), Buffer.from(studio.png, "base64"));
  const fit = (await h.command(w, "check_fit")).result ?? null;
  const parts = set.result.parts?.length ?? "?";
  console.log(`${file}: ${parts} parts, ${Math.round((Date.now() - t) / 1000)} s, ${fit ? `${fit.overlaps.length} overlaps` : "fit not checked"}${set.result.warnings?.length ? `, warnings: ${set.result.warnings.join("; ")}` : ""}`);
  if (fit?.overlaps.length) console.log(JSON.stringify(fit.overlaps.slice(0, 8), null, 1));
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await h.close();
}
process.exit(code);
