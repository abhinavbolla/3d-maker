// Loads a model script into a fresh app window (headless Chrome, no Claude),
// exports it as glTF (.glb), OBJ (with its MTL) and PLY the way Claude's
// tools do, times each, and checks each file with test/check-meshfile.mjs.
// The GLB is also loaded with three.js's own GLTFLoader and compared with
// the app: part names, triangles, sizes in millimetres, and the animation's
// length and poses against the motion the kernel samples for the view.
// Usage: TEST_PORT=5201 node test/meshfile-run.mjs model.js [out-dir]
import { startHarness } from "./harness.mjs";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { runScript } from "../src/kernel/script.js";
import { apply } from "../src/kernel/motion.js";
import { checkFile } from "./check-meshfile.mjs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node test/meshfile-run.mjs model.js [out-dir]");
  process.exit(2);
}
const keep = process.argv[3];
const dir = keep ?? mkdtempSync(join(tmpdir(), "draftsman-meshfile-"));
mkdirSync(dir, { recursive: true });
const name = basename(file, ".js");
const script = readFileSync(file, "utf8");
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

const h = await startHarness();
try {
  const w = await h.openWindow();
  const set = await h.command(w, "set_model", { script });
  if (set.error) throw new Error(set.error);
  // A screenshot waits for the fine meshes, which set the export's detail,
  // so every format is meshed alike.
  await h.command(w, "screenshot", { width: 256, height: 256 });
  const summary = set.result;
  const shown = summary.parts.filter((p) => !p.hidden && !p.empty);
  console.log(`${file}: ${summary.parts.length} parts (${shown.length} exported)${summary.motion ? `, motion loop ${summary.motion.loop_seconds} s` : ""}`);

  const exported = {};
  for (const kind of ["glb", "obj", "ply"]) {
    // Timed in the page: meshing, writing and the base64 the MCP server
    // takes, not the trip through the test's DevTools connection.
    const args = JSON.stringify(kind === "obj" ? { mtl: `${name}.obj` } : {});
    const r = await w(`(async () => { const t = performance.now(); try { const result = await window.__draftsman.call("export_${kind}", ${args}); return { result, ms: performance.now() - t }; } catch (e) { return { error: String(e.message ?? e) }; } })()`);
    const ms = Math.round(r.ms);
    if (r.error) throw new Error(`export_${kind}: ${r.error}`);
    const path = join(dir, `${name}.${kind}`);
    writeFileSync(path, Buffer.from(r.result.base64, "base64"));
    if (kind === "obj") writeFileSync(join(dir, r.result.mtl_name), Buffer.from(r.result.mtl_base64, "base64"));
    const c = checkFile(path);
    exported[kind] = { r: r.result, c, path };
    const size = r.result.bytes + (kind === "obj" ? Buffer.from(r.result.mtl_base64, "base64").length : 0);
    console.log(`     ${kind.toUpperCase()}: ${mb(size)}, ${r.result.triangles} triangles, export ${ms} ms in the app (meshing included)`);
    check(!c.problems.length, `${kind.toUpperCase()} reads back valid, every part closed${c.problems.length ? `: ${[...new Set(c.problems)].slice(0, 5).join("; ")}` : ""}`);
    check(c.parts.length === shown.length && c.parts.every((p, i) => p.name === shown[i].name), `${kind.toUpperCase()} has the ${shown.length} parts, named, in order`);
    check(c.parts.reduce((s, p) => s + p.triangles, 0) === r.result.triangles, `${kind.toUpperCase()} triangle count matches what the app reports`);
  }

  // Sizes against the app's own summary (meshed at a different detail, so
  // within a few cells).
  const worst = (c) =>
    Math.max(
      ...c.parts.map((p, i) => {
        const s = shown[i];
        return Math.max(...[0, 1, 2].map((k) => Math.max(Math.abs(p.bounds[k] - s.min[k]), Math.abs(p.bounds[k + 3] - s.max[k])) / Math.max(1, 3 * s.detail_mm)));
      }),
    );
  for (const kind of ["glb", "obj", "ply"]) {
    const x = worst(exported[kind].c);
    check(x <= 1, `${kind.toUpperCase()} part bounds in mm, Z up, agree with the app's within 3 cells (worst ${(x * 3).toFixed(2)} cells)`);
  }

  // three.js reads the GLB.
  const glb = readFileSync(exported.glb.path);
  const gltf = await new Promise((ok, fail) => new GLTFLoader().parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length), "", ok, fail));
  const scene = gltf.scene;
  const meshes = [];
  scene.traverse((o) => o.isMesh && meshes.push(o));
  const nodeOf = (n) => scene.getObjectByName(n) ?? scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n));
  check(meshes.length === shown.length, `GLTFLoader finds ${meshes.length} meshes for ${shown.length} parts`);
  const names = shown.filter((p) => nodeOf(p.name)).length;
  check(names === shown.length, `GLTFLoader finds every part by name (${names} of ${shown.length})`);
  const tris = meshes.reduce((s, m) => s + m.geometry.index.count / 3, 0);
  check(tris === exported.glb.r.triangles, `GLTFLoader counts ${tris} triangles`);
  // Bounds: the loader's box in metres, Y up, back to mm, Z up.
  let off = 0;
  for (const [i, p] of exported.glb.c.parts.entries()) {
    const m = nodeOf(shown[i].name);
    const g = (m.isMesh ? m : m.children.find((c) => c.isMesh)).geometry;
    g.computeBoundingBox();
    const b = g.boundingBox;
    const ours = [b.min.x, -b.max.z, b.min.y, b.max.x, -b.min.z, b.max.y].map((v) => v * 1000);
    off = Math.max(off, ...ours.map((v, k) => Math.abs(v - p.bounds[k])));
  }
  check(off < 0.01, `GLTFLoader's part boxes match the file's in mm (worst ${off.toFixed(4)} mm)`);
  const mats = new Set(meshes.map((m) => `${m.material.metalness}/${m.material.roughness}`));
  console.log(`     materials as three.js reads them (metalness/roughness): ${[...mats].join(", ")}`);

  // Motion: the clip's length is the loop, and poses at keys match the
  // kernel's own sampled frames (the ones the view plays).
  const res = runScript(script);
  if (summary.motion) {
    const clip = gltf.animations[0];
    check(clip && Math.abs(clip.duration - summary.motion.loop_seconds) < 1e-4, `the animation is ${clip?.duration.toFixed(3)} s, the motion's loop is ${summary.motion.loop_seconds} s`);
    const moving = res.parts.filter((p) => p.frames && shown.some((s) => s.name === p.name));
    const targets = new Set(clip.tracks.map((t) => t.name.split(".")[0]));
    check(targets.size === moving.length, `${targets.size} parts are animated, ${moving.length} move in the app`);
    const mixer = new THREE.AnimationMixer(scene);
    mixer.clipAction(clip).play();
    const count = res.motion.frames;
    let worstMM = 0, poses = 0;
    for (const k of [1, Math.round(count / 4), Math.round(count / 3), Math.round(count / 2), Math.round((3 * count) / 4), count - 1]) {
      const t = (k / count) * res.motion.loop;
      mixer.setTime(t);
      scene.updateMatrixWorld(true);
      for (const p of moving) {
        const node = nodeOf(p.name);
        const s = shown.find((x) => x.name === p.name);
        // Corners of the part's box, at rest, moved by the kernel's pose.
        for (const corner of [[s.min[0], s.min[1], s.min[2]], [s.max[0], s.max[1], s.max[2]], [s.min[0], s.max[1], s.max[2]]]) {
          const want = apply(Array.from(p.frames.subarray(k * 12, k * 12 + 12)), corner);
          const v = new THREE.Vector3(corner[0] / 1000, corner[2] / 1000, -corner[1] / 1000).applyMatrix4(node.matrixWorld);
          const got = [v.x * 1000, -v.z * 1000, v.y * 1000];
          worstMM = Math.max(worstMM, Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]));
          poses++;
        }
      }
    }
    check(worstMM < 0.05, `${poses} points on moving parts, at 6 moments, land where the app puts them (worst ${worstMM.toFixed(4)} mm)`);
  } else check(!gltf.animations.length, "a model without motion has no animation");
} catch (err) {
  console.error(err);
  failures.push(String(err.message ?? err));
} finally {
  await h.close();
  if (!keep) rmSync(dir, { recursive: true, force: true });
  else console.log(`files in ${dir}`);
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
