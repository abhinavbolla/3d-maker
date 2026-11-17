// Draws the small pictures of the examples on the empty window
// (src/examples/*.webp) with the app itself: each example's script is loaded
// into a headless app window, seen from the usual corner, and its studio
// picture is cut to 10:7 around the model and saved at twice its size on
// screen, as WebP.
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
    await w(`window.__draftsman.fit("iso")`);
    const { png } = await w("window.__draftsman.picture({ width: 1400 })");
    if (look) writeFileSync(join(look, `${ex.id}.png`), Buffer.from(png, "base64"));
    // Find the model (every pixel that differs from the backdrop, its
    // shadow included), cut a 10:7 box around it with a small margin, and
    // scale that down in the page's own canvas: a wide helicopter fills its
    // picture as well as a tall mug.
    const webp = await w(`(async () => {
      const img = new Image();
      img.src = "data:image/png;base64,${png}";
      await img.decode();
      const full = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
      const f = full.getContext("2d");
      f.drawImage(img, 0, 0);
      const px = f.getImageData(0, 0, img.width, img.height).data;
      const back = (x, y) => { const i = (y * img.width + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
      let x0 = img.width, y0 = img.height, x1 = 0, y1 = 0;
      for (let y = 0; y < img.height; y += 2) {
        const [r, g, b] = back(0, y); // the backdrop shades from top to bottom
        for (let x = 0; x < img.width; x += 2) {
          const i = (y * img.width + x) * 4;
          if (Math.abs(px[i] - r) + Math.abs(px[i + 1] - g) + Math.abs(px[i + 2] - b) < 40) continue;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
      }
      const W = 80, H = 56;
      let w = (x1 - x0) * 1.12, h = (y1 - y0) * 1.12;
      if (w / h < W / H) w = (h * W) / H; else h = (w * H) / W;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const c = Object.assign(document.createElement("canvas"), { width: W, height: H });
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(img, cx - w / 2, cy - h / 2, w, h, 0, 0, W, H);
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
