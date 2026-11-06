// The app's commands in a real app window (headless Chrome), without Claude:
// plans, step checks, appending code, ghosted screenshots, the run receipt.
// Usage: node test/app.test.mjs   (needs Google Chrome; uses port 5179)
import { startHarness, checks } from "./harness.mjs";

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
} catch (err) {
  fail(String(err.message ?? err));
  console.error(err);
} finally {
  await h.close();
}
process.exit(done());
