// Types one prompt into a fresh app window (headless Chrome, your real Claude
// Code) and saves what came out: pictures, the script, the plan and the
// app's receipt. For trying hard prompts and comparing results over time.
// Usage: node test/run-prompt.mjs "a Black Hawk-style rotor head" [outDir]
// (PORT=5176 to run several at once)
import { startHarness } from "./harness.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const text = process.argv[2];
if (!text) {
  console.error('Usage: node test/run-prompt.mjs "prompt" [outDir]');
  process.exit(2);
}
const out = process.argv[3] ?? join(process.cwd(), "runs", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(out, { recursive: true });
const h = await startHarness({ port: Number(process.env.PORT ?? 5177) });
let code = 0;
try {
  const w = await h.openWindow();
  const t = Date.now();
  let lastLine = "";
  const reply = await h.prompt(w, text, {
    timeoutMs: Number(process.env.TIMEOUT_MIN ?? 45) * 60 * 1000,
    async onTick() {
      const line = `${await w('document.getElementById("status").textContent')} | ${await w('document.getElementById("progress").hidden ? "" : document.getElementById("progress-text").textContent')}`;
      if (line.replace(/\d+ s/, "") !== lastLine.replace(/\d+ s/, "")) console.log(`  ${line}`);
      lastLine = line;
    },
  });
  if (!reply.receipt) throw new Error("The window has no record of this run (it reloaded, or Claude never started).");
  const summary = await w("window.__3dmaker.summary()");
  for (const view of ["iso", "front", "top"]) {
    const shot = await h.command(w, "screenshot", { view, width: 1400, height: 1000 });
    if (shot.result) writeFileSync(join(out, `${view}.png`), Buffer.from(shot.result.png, "base64"));
  }
  // The script first, so a failed export or fit check loses nothing.
  writeFileSync(join(out, "model.js"), summary.script);
  const mesh = await w("window.__3dmaker.exportSTL()").catch(() => null);
  if (mesh?.base64) writeFileSync(join(out, "model.stl"), Buffer.from(mesh.base64, "base64"));
  const stl = await h.stlIsClosed(w).catch((e) => ({ closed: false, triangles: 0, error: String(e.message ?? e) }));
  const fit = (await h.command(w, "check_fit")).result ?? null;
  writeFileSync(join(out, "result.json"), JSON.stringify({ prompt: text, seconds: Math.round((Date.now() - t) / 1000), reply, stl, fit, summary: { ...summary, script: undefined } }, null, 1));
  console.log(`\n${Math.round((Date.now() - t) / 1000)} s · ${summary.parts.length} parts · plan ${summary.plan ? `${summary.plan.done} of ${summary.plan.total}` : "none"} · STL ${stl.closed ? "closed" : `NOT closed${stl.error ? ` (${stl.error})` : ""}`} · ${fit ? `${fit.overlaps.length} overlaps` : "fit not checked"}${summary.motion?.joints?.length ? ` · ${summary.motion.joints.length} joints, worst gap ${Math.max(...summary.motion.joints.map((j) => j.max_gap_mm))} mm` : ""}`);
  console.log(`Claude: ${reply.text}\nReceipt: ${JSON.stringify(reply.receipt)}\nSaved in ${out}`);
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await h.close();
}
process.exit(code);
