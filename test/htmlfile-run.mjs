// Loads a model script into a fresh app window (headless Chrome, no Claude),
// exports it as one HTML file the way Claude's export_html does, checks the
// file with test/check-meshfile.mjs, then opens it from disk (file://) in a
// window of its own and looks at it: drawn (not blank), turned by a drag,
// moving if the model has motion, also on a dark background, with no request
// leaving the page and no console errors. Saves the file and its screenshots.
// Usage: TEST_PORT=5201 node test/htmlfile-run.mjs model.js [out-dir]
import { startHarness, sleep } from "./harness.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { checkHTML } from "./check-meshfile.mjs";

// Opens the HTML file at path in its own window and takes its pictures.
// win: an app window, where the PNGs are read (so the file's own page does
// nothing but show the model). Returns the measurements and the PNGs.
export async function lookAtHTML(h, win, path, { motion = false } = {}) {
  // Pixels that differ from another picture of the same page (by more
  // than 24 in red + green + blue): the share of the window, their mean
  // brightness and the box round them.
  const diff = (png, other) =>
    win(`(async () => {
      const read = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width; c.height = img.height;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, c.width, c.height);
      };
      const a = await read(${JSON.stringify(png)}), b = await read(${JSON.stringify(other)});
      const W = a.width, H = a.height, d = a.data, e = b.data;
      let n = 0, bright = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (Math.abs(d[i] - e[i]) + Math.abs(d[i + 1] - e[i + 1]) + Math.abs(d[i + 2] - e[i + 2]) <= 24) continue;
        n++; bright += (d[i] + d[i + 1] + d[i + 2]) / 3;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      return { share: n / (W * H), brightness: n ? Math.round(bright / n) : 0, box: [x0, y0, x1, y1], background: [...e.slice(0, 3)] };
    })()`);
  // The page with the model hidden: its background and words alone.
  const empty = async (page) => {
    await page.evaluate("document.getElementById('view').style.visibility = 'hidden'");
    await sleep(100);
    const png = await page.screenshot();
    await page.evaluate("document.getElementById('view').style.visibility = ''");
    await sleep(100);
    return png;
  };
  const url = pathToFileURL(resolve(path)).href;
  const drawn = async (page, n = 1) => {
    for (let i = 0; i < 300; i++) {
      if (Number(await page.evaluate("document.documentElement.dataset.drawn || 0").catch(() => 0)) >= n) return true;
      await sleep(100);
    }
    return false;
  };
  const out = { url };
  const page = await h.openPage(url);
  out.drew = await drawn(page);
  await sleep(motion ? 200 : 600);
  const first = await page.screenshot();
  await page.drag([480, 330], [640, 270]);
  await sleep(400);
  const turned = await page.screenshot();
  out.turned = await diff(turned, first);
  if (motion) {
    // Still camera, half a second later: the parts have moved.
    const before = await page.screenshot();
    await sleep(500);
    const after = await page.screenshot();
    out.moving = (await diff(after, before)).share;
  }
  const bg = await empty(page);
  out.first = await diff(first, bg);
  out.title = await page.evaluate("[document.title, document.getElementById('title').textContent, document.getElementById('size').textContent]");
  out.requests = page.requests.filter((u) => u !== url);
  out.errors = [...page.errors];
  await page.close();
  const dark = await h.openPage(url, { dark: true });
  await drawn(dark);
  await sleep(600);
  const night = await dark.screenshot();
  out.dark = await diff(night, await empty(dark));
  out.requests.push(...dark.requests.filter((u) => u !== url));
  out.errors.push(...dark.errors);
  await dark.close();
  out.pngs = { first, turned, dark: night };
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node test/htmlfile-run.mjs model.js [out-dir]");
    process.exit(2);
  }
  const dir = process.argv[3] ?? join(fileURLToPath(new URL("..", import.meta.url)), "runs", "html");
  mkdirSync(dir, { recursive: true });
  const name = basename(file, ".js");
  const failures = [];
  const check = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const h = await startHarness();
  try {
    const w = await h.openWindow();
    const set = await h.command(w, "set_model", { script: readFileSync(file, "utf8") });
    if (set.error) throw new Error(set.error);
    // The app's own view, to set beside the file's.
    const app = await h.command(w, "screenshot", { width: 960, height: 640 });
    writeFileSync(join(dir, `${name}-app.png`), Buffer.from(app.result.png, "base64"));
    const t = Date.now();
    const r = await h.command(w, "export_html");
    if (r.error) throw new Error(r.error);
    const ms = Date.now() - t;
    const glb = await h.command(w, "export_glb");
    const path = join(dir, `${name}.html`);
    writeFileSync(path, Buffer.from(r.result.base64, "base64"));
    const c = checkHTML(readFileSync(path, "utf8"));
    check(!c.problems.length, `${path}: ${r.result.bytes} bytes (GLB ${glb.result?.bytes}), ${c.parts.length} parts, ${r.result.triangles} triangles, ${c.parts.filter((p) => p.closed).length} closed, in ${ms} ms${c.problems.length ? `: ${c.problems.slice(0, 5).join("; ")}` : ""}`);
    const motion = Boolean(c.loop);
    const v = await lookAtHTML(h, w, path, { motion });
    for (const [k, png] of Object.entries(v.pngs)) writeFileSync(join(dir, `${name}-${k}.png`), Buffer.from(png, "base64"));
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    check(v.drew && v.first.share > 0.03, `drawn from ${v.url}: the model covers ${pct(v.first.share)} of the window, box ${v.first.box.join(",")}, brightness ${v.first.brightness} on ${v.first.background}`);
    check(v.turned.share > 0.01, `a drag turns it: ${pct(v.turned.share)} of pixels changed`);
    if (motion) check(v.moving > 0.002, `its motion plays: ${pct(v.moving)} of pixels changed in half a second with the camera still`);
    check(v.dark.share > 0.03 && v.dark.background.every((x) => x < 80), `on a dark background (${v.dark.background}) too: ${pct(v.dark.share)}, brightness ${v.dark.brightness}`);
    check(!v.requests.length, `no request left the page${v.requests.length ? `: ${v.requests.slice(0, 3).join(", ")}` : ""}`);
    check(!v.errors.length, `no console errors${v.errors.length ? `: ${v.errors.slice(0, 3).join("; ")}` : ""}`);
    console.log(`title ${JSON.stringify(v.title)}; pictures in ${dir}/${name}-*.png`);
  } catch (err) {
    check(false, String(err.stack ?? err));
  } finally {
    await h.close();
  }
  process.exit(failures.length ? 1 : 0);
}
