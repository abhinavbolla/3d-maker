// Draws the small pictures of the examples on the empty window
// (src/examples/*.webp) with the app itself: each example's script is loaded
// into a headless app window, seen from the usual corner, and its studio
// picture is cut to 10:7 and saved at twice its size on screen, as WebP.
// Usage: node test/example-pictures.mjs [outDir]   (outDir also gets each
// example's full studio picture, to look at)
import { startHarness } from "./harness.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLES } from "../src/examples/list.js";

const root = new URL("../src/examples/", import.meta.url).pathname;
const look = process.argv[2];
if (look) mkdirSync(look, { recursive: true });
const h = await startHarness({ port: 5186 });
let code = 0;
try {
  for (const ex of EXAMPLES) {
    const w = await h.openWindow();
    const set = await h.command(w, "set_model", { script: readFileSync(join(root, `${ex.id}.js`), "utf8") });
    if (set.error) throw new Error(`${ex.id}: ${set.error}`);
    await h.command(w, "screenshot", { width: 64, height: 64 }); // waits for the fine mesh
    await w(`window.__3dmaker.fit("iso")`);
    const { png } = await w("window.__3dmaker.picture({ width: 900 })");
    if (look) writeFileSync(join(look, `${ex.id}.png`), Buffer.from(png, "base64"));
    // Cut the middle out at 10:7 and scale it down in the page's own canvas.
    const webp = await w(`(async () => {
      const img = new Image();
      img.src = "data:image/png;base64,${png}";
      await img.decode();
      const W = 80, H = 56, scale = Math.min(img.width / W, img.height / H) * 0.8;
      const c = Object.assign(document.createElement("canvas"), { width: W, height: H });
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(img, (img.width - W * scale) / 2, (img.height - H * scale) / 2, W * scale, H * scale, 0, 0, W, H);
      return c.toDataURL("image/webp", 0.8).split(",")[1];
    })()`);
    const bytes = Buffer.from(webp, "base64");
    writeFileSync(join(root, `${ex.id}.webp`), bytes);
    console.log(`${ex.id}: ${set.result.parts.length} parts, picture ${bytes.length} bytes`);
  }
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await h.close();
}
process.exit(code);
