// Loads a model script into a fresh app window (headless Chrome, no Claude),
// records a video the way record_video does, and saves it.
// Usage: node test/video-run.mjs model.js out.mp4 [shots.json | turntable] [width] [height] [fps]
// shots.json: { "shots": [...], ...other record_video settings }.
import { startHarness } from "./harness.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const [file, out = "video.mp4", plan = "turntable", width = "1920", height = "1080", fps = "30"] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node test/video-run.mjs model.js out.mp4 [shots.json | turntable] [width] [height] [fps]");
  process.exit(2);
}
const args = plan === "turntable" ? { shots: [{ seconds: 4, move: "turntable", camera: { view: "iso" } }] } : JSON.parse(readFileSync(plan, "utf8"));
const h = await startHarness({ port: Number(process.env.PORT ?? 5184) });
let code = 0;
try {
  const w = await h.openWindow();
  const set = await h.command(w, "set_model", { script: readFileSync(file, "utf8") });
  if (set.error) throw new Error(set.error);
  const t = Date.now();
  const r = await h.command(w, "record_video", { width: Number(width), height: Number(height), fps: Number(fps), ...args });
  if (r.error) throw new Error(r.error);
  const pieces = [];
  for (let i = 0; i < r.result.pieces; i++) pieces.push(Buffer.from((await h.command(w, "video_part", { id: r.result.id, index: i })).result.base64, "base64"));
  writeFileSync(out, Buffer.concat(pieces));
  const { stills, ...facts } = r.result;
  stills.forEach((s) => writeFileSync(out.replace(/\.\w+$/, `-frame${s.frame}.jpg`), Buffer.from(s.jpeg, "base64")));
  console.log(`${file}: ${facts.frames} frames in ${((Date.now() - t) / 1000).toFixed(1)} s -> ${out}\n${JSON.stringify({ ...facts, end_camera: undefined })}`);
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await h.close();
}
process.exit(code);
