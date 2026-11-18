// Pictures of the Export menu shut, open, and one step in (Drawing's
// formats), on a wide and a narrow window, light and dark, for a part and
// for a building. Written to runs/export-menu/, to look at by eye.
// Usage: node test/export-menu-run.mjs   (needs Google Chrome; uses port 5183)
import { startHarness, sleep, root } from "./harness.mjs";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const out = join(root, "runs", "export-menu");
mkdirSync(out, { recursive: true });
const h = await startHarness({ port: 5183 });
try {
  const w = await h.openWindow();
  const models = {
    part: 'part("Base", box(40, 40, 10), { color: "#4f7cac" });\npart("Peg", cylinder(5, 20).at(0, 0, 12), { color: "#d9a441" });',
    house: readFileSync(new URL("./models/house.js", import.meta.url), "utf8"),
  };
  for (const [model, script] of Object.entries(models)) {
    const r = await h.command(w, "set_model", { script });
    if (r.error) throw new Error(r.error);
    for (const [size, width, height] of [["wide", 1280, 800], ["narrow", 390, 760]]) {
      for (const dark of [false, true]) {
        if (model === "house" && (size === "narrow" || dark)) continue;
        await w.emulate({ width, height, dark });
        await sleep(600);
        const name = (state) => join(out, `${model}-${size}-${dark ? "dark" : "light"}-${state}.png`);
        if (!(await w('document.getElementById("export-menu").hidden'))) await w.key("Escape");
        writeFileSync(name("shut"), await w.screenshot());
        // Open by the keys, so the focus shows as it does for a keyboard user.
        await w('document.getElementById("export-button").focus(), true');
        await w.key("Enter");
        await sleep(200);
        writeFileSync(name("open"), await w.screenshot());
        await w.key("ArrowDown");
        await w.key("ArrowRight");
        await sleep(200);
        writeFileSync(name("drawing"), await w.screenshot());
        await w.key("Escape");
        await w.key("Escape");
      }
    }
  }
  console.log(`pictures in ${out}`);
} finally {
  await h.close();
}
process.exit(0);
