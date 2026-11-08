// The app's commands in a real app window (headless Chrome), without Claude:
// plans, step checks, appending code, ghosted screenshots, the run receipt.
// Usage: node test/app.test.mjs   (needs Google Chrome; uses port 5179)
import { startHarness, checks } from "./harness.mjs";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { check3MF } from "./check-3mf.mjs";

const { check, fail, done } = checks();
const h = await startHarness({ port: 5179 });

try {
  const w = await h.openWindow();
  const call = (name, args) => h.command(w, name, args);

  // A plan must name parts, and each part belongs to one step.
  check(/lists no parts/.test((await call("set_plan", { steps: [{ name: "Base", parts: [] }, { name: "Arm", parts: ["Arm"] }] })).error), "a step without parts is refused");
  check(/is in two steps/.test((await call("set_plan", { steps: [{ name: "Base", parts: ["Base"] }, { name: "Arm", parts: ["Base"] }] })).error), "a part in two steps is refused");

  const plan = await call("set_plan", {
    steps: [
      { name: "Base", parts: ["Base"] },
      { name: "Arm", parts: ["Arm", "Elbow"] },
      { name: "Shade", parts: ["Shade"] },
    ],
  });
  check(plan.result?.total === 3 && plan.result.done === 0 && plan.result.next === "Base", "set_plan returns 0 of 3 done, next Base");
  check((await w('document.getElementById("progress-text").textContent')).startsWith("0 of 3 done"), "the progress line shows 0 of 3");

  // Step 1: write the start of the script.
  await call("set_model", { script: 'title("Lamp");\nconst H = 200;\npart("Base", cylinder(60, 12).at(0, 0, 6));' });
  check(/no step named/.test((await call("finish_step", { step: "Nope" })).error), "finishing an unknown step is refused");
  const early = await call("finish_step", { step: "Arm" });
  check(/missing: Arm, Elbow/.test(early.error ?? ""), "finishing a step whose parts are not built yet is refused, naming them");
  const s1 = await call("finish_step", { step: "Base" });
  check(s1.result?.plan.done === 1 && s1.result.parts[0]?.name === "Base", "finishing Base passes and returns its size");
  check(typeof s1.result?.png === "string" && s1.result.png.length > 1000, "finish_step returns a picture of the step");

  // finish_step lists the step's parts that pass into other parts.
  await call("set_plan", { steps: [{ name: "Base", parts: ["Base"] }, { name: "Post", parts: ["Post"] }] });
  await call("set_model", { script: 'part("Base", cylinder(60, 12).at(0, 0, 6));\npart("Post", cylinder(5, 50).at(0, 0, 30));' });
  const sunk = await call("finish_step", { step: "Post" });
  const o = sunk.result?.overlaps?.[0];
  check(o?.a === "Base" && o.b === "Post" && Math.abs(o.overlap_mm - 7) < 0.1 && /cut a hole/.test(sunk.result.overlaps_note), `finish_step reports a post sunk into the base (${JSON.stringify(o)})`);
  await call("edit_model", { old_text: "at(0, 0, 30)", new_text: "at(0, 0, 37)" });
  check(!(await call("finish_step", { step: "Post" })).result?.overlaps, "a post standing on the base has no overlaps");
  await call("set_plan", {
    steps: [
      { name: "Base", parts: ["Base"] },
      { name: "Arm", parts: ["Arm", "Elbow"] },
      { name: "Shade", parts: ["Shade"] },
    ],
  });
  await call("set_model", { script: 'title("Lamp");\nconst H = 200;\npart("Base", cylinder(60, 12).at(0, 0, 6));' });
  await call("finish_step", { step: "Base" });

  // Step 2: appended code can use earlier constants.
  const app = await call("append_to_model", { code: 'part("Arm", capsule([0, 0, 12], [0, 0, H], 8));\npart("Elbow", sphere(14).at(0, 0, H));' });
  check(!app.error && app.result.parts.length === 3, "append_to_model adds parts that use earlier constants");
  const bad = await call("append_to_model", { code: "nope();" });
  check(/not changed/.test(bad.error ?? "") && (await w("window.__3dmaker.state().parts.length")) === 3, "a broken append is refused and the model is kept");
  // A part that exists but has no surface does not pass.
  await call("edit_model", { old_text: "sphere(14).at(0, 0, H)", new_text: "sphere(14).at(0, 0, H).cut(sphere(20).at(0, 0, H))" });
  check(/empty \(no surface\): Elbow/.test((await call("finish_step", { step: "Arm" })).error ?? ""), "a step with an empty part is refused");
  await call("edit_model", { old_text: ".cut(sphere(20).at(0, 0, H))", new_text: "" });
  check((await call("finish_step", { step: "Arm" })).result?.plan.done === 2, "after the fix, Arm passes");

  // Ghosted screenshot of chosen parts works and leaves the view as it was.
  const shot = await call("screenshot", { parts: ["Arm", "Elbow"], view: "front" });
  check(!shot.error && shot.result.png.length > 1000, "a screenshot of chosen parts with the rest shown faintly");
  check(/no part named "Ghost"/.test((await call("screenshot", { parts: ["Ghost"] })).error ?? ""), "a screenshot of an unknown part is refused");

  // Replanning keeps finished steps that did not change.
  const re = await call("set_plan", {
    steps: [
      { name: "Base", parts: ["Base"] },
      { name: "Arm", parts: ["Arm", "Elbow"] },
      { name: "Shade", parts: ["Shade"] },
      { name: "Switch", parts: ["Switch"] },
    ],
  });
  check(re.result?.done === 2 && re.result.total === 4, "replanning keeps the two finished steps");
  check((await w('document.getElementById("progress-text").textContent')).startsWith("2 of 4 done · next: Shade"), "the progress line shows 2 of 4, next Shade");

  // get_model reports the plan so a later prompt can continue it.
  const model = await call("get_model");
  check(model.result?.plan?.next === "Shade", "get_model includes the plan and the next step");

  // A whole new model with none of the plan's parts drops the stale plan.
  await call("set_model", { script: 'part("Cube", box(20, 20, 20));' });
  check((await w("window.__3dmaker.plan()")) === null && (await w('document.getElementById("progress").hidden')), "a new, unrelated model clears the old plan");

  // Export gives a closed STL.
  const stl = await h.stlIsClosed(w);
  check(stl.closed && stl.triangles > 0, `export gives a closed STL (${stl.triangles} triangles)`);

  // Two parts, one sunk into the other: as separate shells, as one solid
  // (one shell, less triangles: the hidden faces go), and as a 3MF with both
  // parts named and coloured.
  await call("set_model", { script: 'part("Base", box(40, 40, 10), { color: "#4f7cac" });\npart("Peg", cylinder(5, 20).at(0, 0, 12), { color: "#d9a441" });' });
  const shells = await call("export_stl");
  const solid = await call("export_stl", { solid: true });
  const stlClosed = (r) => {
    const path = join(tmpdir(), `3d-maker-${process.pid}-${Date.now()}.stl`);
    writeFileSync(path, Buffer.from(r.base64, "base64"));
    try {
      return execFileSync(process.execPath, [new URL("./check-stl.mjs", import.meta.url).pathname, path], { encoding: "utf8" });
    } catch {
      return null;
    } finally {
      rmSync(path, { force: true });
    }
  };
  const shellsOut = stlClosed(shells.result), solidOut = stlClosed(solid.result);
  check(shellsOut && solidOut && solid.result.triangles < shells.result.triangles, `one solid is closed and smaller (${solid.result?.triangles} triangles, ${shells.result?.triangles} as two shells)`);
  const m3 = await call("export_3mf");
  const r3 = m3.result ? check3MF(Buffer.from(m3.result.base64, "base64")) : { problems: [m3.error], objects: [] };
  check(!r3.problems.length && r3.objects.map((o) => `${o.name} ${o.color}`).join(", ") === "Base #4F7CACFF, Peg #D9A441FF", `3MF has both parts, named, coloured and closed (${r3.objects.map((o) => `${o.name} ${o.color} ${o.triangles}`).join(", ") || r3.problems})`);

  // Detail: after a change the model is meshed again finely in the
  // background, and Claude's pictures wait for it.
  const plate = 'part("Plate", box(400, 400, 10));\nfor (let i = 0; i < 31; i++) part("Bolt " + i, cylinder(3, 8).at(-150 + i * 10, 0, 9));';
  const detail = async () => (await w("window.__3dmaker.summary()")).parts.find((p) => p.name === "Plate")?.detail_mm;
  await call("set_model", { script: plate });
  const coarse = await detail();
  await call("screenshot", { view: "top", width: 300, height: 300 });
  const finer = await detail();
  check(finer > 0 && finer < coarse, `the big part is meshed finer in the background (${coarse} mm cells, then ${finer} mm)`);
  // A newer change wins over a fine pass that was still running.
  await call("set_model", { script: plate.replace("400, 400", "300, 300") });
  await call("set_model", { script: 'part("Cube", box(20, 20, 20));' });
  await call("screenshot", { width: 300, height: 300 });
  check(JSON.stringify(await w("window.__3dmaker.state().parts")) === '["Cube"]', "a fine pass that finishes late does not bring back an old model");

  // Linked motion: the crank from the docs plays, and screenshots at
  // different moments show different poses.
  const crank = await call("set_model", {
    script: `loop(1);
part("Crank", cylinder(30, 10).rotateX(90).at(0, -10, 0), { spin: { axis: "y", rpm: 60 } });
const pin = [0, 0, 25], top = [0, 0, 125];
part("Piston", cylinder(20, 30).at(0, 0, 135), { motion: t => { const p = where("Crank", pin, t); return slide(0, 0, p[2] + Math.sqrt(100 ** 2 - p[0] ** 2) - top[2]); } });
part("Rod", capsule(pin, top, 5), { motion: t => link(pin, top, where("Crank", pin, t), where("Piston", top, t)) });
joint("Rod", "Crank", pin);
joint("Rod", "Piston", top);`,
  });
  check(!crank.error && crank.result.motion?.joints.every((j) => j.max_gap_mm < 0.01), `the crank's joints stay closed (${JSON.stringify(crank.result?.motion?.joints?.map((j) => j.max_gap_mm))})`);
  check(!(await w('document.getElementById("play").hidden')), "the Play/Pause button appears for a moving model");
  const pngAt = async (at) => (await call("screenshot", { view: "front", at, width: 400, height: 400 })).result.png;
  const [p0, p25, p100] = [await pngAt(0), await pngAt(0.25), await pngAt(1)];
  check(p0 !== p25, "a screenshot a quarter of the way through the loop shows a different pose");
  check(p0 === p100, "the loop comes back to where it started");
  const apart = await call("set_model", { script: 'part("A", box(10, 10, 10), { spin: { rpm: 60 } }); part("B", box(10, 10, 10).at(30, 0, 0)); joint("A", "B", [30, 0, 0]);' });
  check(apart.result?.warnings?.some((x) => /comes apart by up to 60 mm/.test(x)), "a joint that comes apart is reported to Claude");

  // check_fit: the crank's parts never hit each other; a spinning blade that
  // hits a post is found, with when; two named parts give their gap.
  await call("set_model", { script: `loop(1);
part("Crank", cylinder(30, 10).rotateX(90).at(0, -10, 0), { spin: { axis: "y", rpm: 60 } });
const pin = [0, 0, 25], top = [0, 0, 125];
part("Piston", cylinder(20, 30).at(0, 0, 135), { motion: t => { const p = where("Crank", pin, t); return slide(0, 0, p[2] + Math.sqrt(100 ** 2 - p[0] ** 2) - top[2]); } });
part("Rod", capsule(pin, top, 5), { motion: t => link(pin, top, where("Crank", pin, t), where("Piston", top, t)) });
joint("Rod", "Crank", pin);
joint("Rod", "Piston", top);` });
  const clean = await call("check_fit");
  check(clean.result?.overlaps.length === 0 && clean.result.checked_pairs > 0 && /during the motion/.test(clean.result.note), `the documented crank has no overlaps (${JSON.stringify(clean.result ?? clean.error)})`);
  await call("set_model", { script: 'loop(1); part("Blade", box(300, 20, 4).at(150, 0, 200), { spin: { axis: "z", rpm: 60 } }); part("Post", cylinder(10, 250).at(200, 100, 125)); part("Wall", box(10, 100, 400).at(-350, 0, 200));' });
  const strike = await call("check_fit");
  const bp = strike.result?.overlaps?.[0];
  check(bp?.a === "Blade" && bp.b === "Post" && Math.abs(bp.at_seconds - 0.07) < 0.02, `a blade striking a post is found, with when (${JSON.stringify(bp)})`);
  const gap = await call("check_fit", { parts: ["Blade", "Wall"] });
  check(Math.abs(gap.result?.gap_mm - 45) < 0.2, `the gap between the blade and the wall (${gap.result?.gap_mm} mm, 45 expected)`);
  check(/no visible part named "Nope"/.test((await call("check_fit", { parts: ["Nope"] })).error ?? ""), "check_fit with an unknown part is refused");
} catch (err) {
  fail(String(err.message ?? err));
  console.error(err);
} finally {
  await h.close();
}
process.exit(done());
