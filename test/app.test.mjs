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

  // The view: a studio picture, the model's facts, materials, and moving
  // around the way CAD programs do.
  const still = await call("set_model", { script: 'part("Body", box(200, 80, 60).at(0, 0, 30), { color: "#b8483e" }); part("Window", box(60, 82, 30).at(40, 0, 50), { material: "glass" }); part("Wheel", cylinder(20, 10).rotateX(90).at(-60, -45, 20), { color: "#111111", material: "rubber" });' });
  check(!still.error, `a model with materials builds (${still.error ?? "ok"})`);
  check(/^3 parts, 200 × \d+ × \d+ mm$/.test(await w('document.getElementById("facts").textContent')), `the heading gives the parts and size (${await w('document.getElementById("facts").textContent')})`);
  check(!(await w('document.getElementById("views").hidden')) && (await w('document.getElementById("start").hidden')), "the view bar shows with a model, and the invitation is gone");
  const picture = async () => {
    const p = await w("window.__3dmaker.picture({ width: 320 })");
    return { ...p, bytes: Buffer.from(p.png, "base64") };
  };
  const first = await picture();
  check(first.bytes.subarray(1, 4).toString() === "PNG" && first.width === 320 && first.bytes.readUInt32BE(16) === 320, "Export > Picture makes a PNG of the asked width");
  // Scroll in over the wheel, well off the middle of the window: the camera
  // heads for the wheel, so the wheel stays under the pointer and grows.
  const moved = await w(`(async () => {
    const canvas = document.querySelector("#viewport canvas");
    const at = window.__3dmaker.screenPosition("Wheel");
    const before = { ...at };
    for (let i = 0; i < 6; i++) {
      canvas.dispatchEvent(new WheelEvent("wheel", { clientX: at.x, clientY: at.y, deltaY: -120, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
    const after = window.__3dmaker.screenPosition("Wheel");
    return { before, after };
  })()`);
  check(Math.hypot(moved.after.x - moved.before.x, moved.after.y - moved.before.y) < 12, `scrolling zooms to the pointer: the wheel stays under it (${JSON.stringify(moved)})`);
  check((await picture()).png !== first.png, "and the view has moved in");
  const turned = await w(`(async () => {
    const canvas = document.querySelector("#viewport canvas");
    const ev = (type, x, y, button = 0) => canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button, pointerId: 7, bubbles: true }));
    const body = () => window.__3dmaker.screenPosition("Body");
    const a = body();
    ev("pointerdown", 300, 300, 2); ev("pointermove", 340, 300, 2); ev("pointermove", 380, 300, 2); ev("pointerup", 380, 300, 2);
    const b = body();
    ev("pointerdown", 300, 300); ev("pointermove", 360, 320); ev("pointermove", 420, 340); ev("pointerup", 420, 340);
    return { slid: b.x - a.x, c: body(), b };
  })()`);
  check(turned.slid > 40, `a right-drag slides the view with the pointer (${Math.round(turned.slid)} px for 80)`);
  check(Math.hypot(turned.c.x - turned.b.x, turned.c.y - turned.b.y) > 5, "a drag turns the view");
  await w('window.__3dmaker.fit("top")');
  const fromTop = await w('window.__3dmaker.screenPosition("Body")');
  check(Math.abs(fromTop.x - 640) < 40, `Top brings the model back to the middle of the view (${JSON.stringify(fromTop)})`);

  // The view turns around its centre, the middle of the window, wherever
  // you grab, and shows that centre while it turns.
  const pivots = await w(`(async () => {
    const canvas = document.querySelector("#viewport canvas");
    const ev = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 8, bubbles: true }));
    const mid = canvas.getBoundingClientRect();
    window.__3dmaker.fit("iso");
    const idle = window.__3dmaker.turningPoint();
    const grab = window.__3dmaker.screenPosition("Wheel");
    ev("pointerdown", grab.x, grab.y); ev("pointermove", grab.x + 30, grab.y + 6);
    const started = window.__3dmaker.turningPoint();
    ev("pointermove", grab.x + 90, grab.y + 30);
    const later = window.__3dmaker.turningPoint();
    ev("pointerup", grab.x + 90, grab.y + 30);
    const after = window.__3dmaker.turningPoint();
    ev("pointerdown", 40, 120); ev("pointermove", 60, 124);
    const empty = window.__3dmaker.turningPoint();
    ev("pointerup", 60, 124);
    return { idle, started, later, after, empty, middle: { x: mid.left + mid.width / 2, y: mid.top + mid.height / 2 } };
  })()`);
  const pxBetween = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity);
  check(pivots.idle === null && pivots.after === null, "no turning point shows while the view is still");
  check(pxBetween(pivots.started, pivots.middle) < 3, `a drag on the model turns around the middle of the view (${JSON.stringify(pivots.started)} for ${JSON.stringify(pivots.middle)})`);
  check(pxBetween(pivots.later, pivots.middle) < 3, "and that centre stays put while the view turns");
  check(pxBetween(pivots.empty, pivots.middle) < 3, `a drag on empty space turns around the same centre (${JSON.stringify(pivots.empty)})`);

  // A press whose release never arrives (it ended outside the window) must
  // not stop the next drag from turning the view.
  const lost = await w(`(async () => {
    const canvas = document.querySelector("#viewport canvas");
    const ev = (type, x, y, id, first = false) => canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: id, isPrimary: first, bubbles: true }));
    ev("pointerdown", 200, 200, 31); ev("pointermove", 230, 210, 31);
    const before = window.__3dmaker.screenPosition("Wheel");
    ev("pointerdown", 300, 220, 32, true); ev("pointermove", 340, 230, 32, true); ev("pointermove", 420, 250, 32, true);
    const during = window.__3dmaker.turningPoint();
    ev("pointerup", 420, 250, 32, true);
    const after = window.__3dmaker.screenPosition("Wheel");
    return { moved: Math.hypot(after.x - before.x, after.y - before.y), during, still: window.__3dmaker.turningPoint() };
  })()`);
  check(lost.moved > 5 && lost.during !== null && lost.still === null, `a press that was never released does not block the next drag (${JSON.stringify(lost)})`);

  // The view cube follows the camera. A side, an edge or a corner looks from
  // there, and dragging the cube turns the view.
  const cube = await w(`(async () => {
    const faces = [...document.querySelectorAll("#viewcube .face")];
    const face = (name) => faces.find((f) => f.children[4].textContent === name);
    const lie = (name) => face(name).style.transform.match(/-?[\\d.]+/g).map(Number);
    const shown = () => faces.filter((f) => f.style.visibility !== "hidden").map((f) => f.children[4].textContent).sort().join();
    const straight = (name) => { const m = lie(name); return shown() === name && Math.abs(m[0] - 1) < 0.01 && Math.abs(m[3] - 1) < 0.01 && Math.abs(m[1]) < 0.01 && Math.abs(m[2]) < 0.01; };
    // The view turns over a few frames, and frames are slow without a GPU.
    const until = async (done) => { for (let i = 0; i < 150 && !done(); i++) await new Promise((r) => setTimeout(r, 100)); return done(); };
    const visible = !document.getElementById("viewcube").hidden;
    window.__3dmaker.fit("iso");
    await until(() => shown() === "Front,Right,Top");
    const first = shown();
    face("Top").children[4].click();
    const top = await until(() => straight("Top"));
    face("Top").children[8].click();
    const corner = await until(() => shown() === "Front,Right,Top");
    const cornerTitle = face("Top").children[8].title;
    face("Front").children[4].click();
    const front = await until(() => straight("Front"));
    const root = document.getElementById("viewcube");
    const r = root.getBoundingClientRect();
    const ev = (type, x, y) => root.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, button: 0, buttons: 1, pointerId: 41, bubbles: true }));
    const before = window.__3dmaker.screenPosition("Wheel");
    ev("pointerdown", 50, 50); ev("pointermove", 60, 52); ev("pointermove", 90, 64);
    const during = window.__3dmaker.turningPoint();
    ev("pointerup", 90, 64);
    const after = window.__3dmaker.screenPosition("Wheel");
    await until(() => shown() !== "Front");
    return { visible, sides: faces.length, places: root.querySelectorAll("button").length, first, top, corner, cornerTitle, front, dragged: Math.hypot(after.x - before.x, after.y - before.y), during, still: window.__3dmaker.turningPoint(), turned: shown() };
  })()`);
  check(cube.visible && cube.sides === 6 && cube.places === 54, `the view cube shows with a model (${JSON.stringify(cube)})`);
  check(cube.first === "Front,Right,Top", `from a corner it shows its front, right and top (${cube.first})`);
  check(cube.top, "choosing Top looks straight down, with the front at the bottom");
  check(cube.corner && cube.cornerTitle === "Look from the top front right", `choosing a corner looks from that corner (${cube.cornerTitle})`);
  check(cube.front, "choosing Front looks straight at the front, upright");
  check(cube.dragged > 5 && cube.during !== null && cube.still === null && cube.turned !== "Front", `dragging the cube turns the view (${JSON.stringify({ dragged: cube.dragged, turned: cube.turned })})`);

  // Two fingers on a trackpad slide the view with them, both ways. A mouse
  // wheel used after that still zooms.
  const swiped = await w(`(async () => {
    const canvas = document.querySelector("#viewport canvas");
    window.__3dmaker.fit("iso");
    const before = window.__3dmaker.screenPosition("Body");
    for (let i = 0; i < 4; i++) canvas.dispatchEvent(new WheelEvent("wheel", { clientX: before.x, clientY: before.y, deltaX: 20, deltaY: 10, bubbles: true, cancelable: true }));
    const after = window.__3dmaker.screenPosition("Body");
    for (let i = 0; i < 3; i++) canvas.dispatchEvent(new WheelEvent("wheel", { clientX: after.x, clientY: after.y, deltaY: -120, bubbles: true, cancelable: true }));
    const wheeled = window.__3dmaker.screenPosition("Body");
    const pinchAt = window.__3dmaker.screenPosition("Wheel");
    for (let i = 0; i < 3; i++) canvas.dispatchEvent(new WheelEvent("wheel", { clientX: after.x, clientY: after.y, deltaY: -6, ctrlKey: true, bubbles: true, cancelable: true }));
    const pinched = window.__3dmaker.screenPosition("Wheel");
    const downAt = window.__3dmaker.screenPosition("Body");
    for (let i = 0; i < 4; i++) canvas.dispatchEvent(new WheelEvent("wheel", { clientX: downAt.x, clientY: downAt.y, deltaY: 10, bubbles: true, cancelable: true }));
    const down = window.__3dmaker.screenPosition("Body");
    return { dx: after.x - before.x, dy: after.y - before.y, wheel: Math.hypot(wheeled.x - after.x, wheeled.y - after.y), pinch: Math.hypot(pinched.x - pinchAt.x, pinched.y - pinchAt.y), straight: { dx: down.x - downAt.x, dy: down.y - downAt.y } };
  })()`);
  // The surface under the pointer moves with the fingers (80 px, 40 px); the
  // middle of the body is further away, so it moves a little less.
  check(swiped.dx < -55 && swiped.dx > -90 && Math.abs(swiped.dy - swiped.dx / 2) < 4, `two fingers on a trackpad slide the view both ways (${JSON.stringify(swiped)})`);
  check(swiped.wheel < 12, `a mouse wheel still zooms to the pointer after that (${Math.round(swiped.wheel)} px)`);
  check(swiped.pinch > 3, `and a pinch zooms (${Math.round(swiped.pinch)} px)`);
  check(swiped.straight.dy < -15 && Math.abs(swiped.straight.dx) < 4, `and two fingers moved straight up slide the view, not zoom it (${JSON.stringify(swiped.straight)})`);
} catch (err) {
  fail(String(err.message ?? err));
  console.error(err);
} finally {
  await h.close();
}
process.exit(done());
