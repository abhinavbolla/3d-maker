// End to end through the real prompt box, with your real Claude Code.
// Opens app windows in headless Chrome, types prompts, and checks what
// actually happened instead of trusting Claude's reply:
//   - the window that asked has the part it asked for, at the size it asked
//     for (measured from the mesh), with the hole (from its volume)
//   - the follow-up with a part selected changed that part, in the same chat
//   - the exported STL is a closed mesh
//   - another open window was not touched
//   - a bigger model is built with a plan, every step finished, and every
//     part the plan names exists
// Uses your Claude plan (three prompts, usually 3-8 minutes).
// Usage: npm run test:e2e   (needs Google Chrome; uses port 5178)
import { startHarness, checks } from "./harness.mjs";

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const { check, fail, done } = checks();
const h = await startHarness();
const secs = (t) => Math.round((Date.now() - t) / 1000);

try {
  const a = await h.openWindow();
  const b = await h.openWindow();
  const bBefore = await b("window.__3dmaker.state().script");

  // ---- 1: something with a known size and volume ----
  console.log("prompt 1 (window A)…");
  let t = Date.now();
  const r1 = await h.prompt(a, 'Make one part named "Block": a 30 mm cube sitting on the ground, with a 10 mm diameter hole straight through it from top to bottom. Nothing else.');
  console.log(`  Claude (${secs(t)} s): ${r1.text}\n  receipt: ${JSON.stringify(r1.receipt)}`);
  let s = await a("window.__3dmaker.summary()");
  let block = s.parts.find((p) => p.name === "Block");
  check(r1.receipt?.changed === true, "the window that asked shows a changed model");
  check(Boolean(block?.size), `part "Block" exists (parts: ${s.parts.map((p) => p.name).join(", ")})`);
  if (block?.size) {
    check(block.size.every((d) => near(d, 30, 1)), `Block measures 30 x 30 x 30 mm (got ${block.size.join(" x ")})`);
    const expected = 27 - (Math.PI * 25 * 30) / 1000; // cube minus hole, cm3
    check(near(block.volume_cm3, expected, expected * 0.04), `Block volume shows the hole: ${block.volume_cm3} cm3, expected ${expected.toFixed(1)}`);
    check(near(block.min[2], 0, 1), `Block sits on the ground (bottom at z = ${block.min[2]})`);
  }
  check(!s.plan, "a one-part model is made without a plan");

  // ---- 2: follow-up with the part selected ----
  check(Boolean(await a("window.__3dmaker.state().session")), "the model remembers its Claude chat, so follow-ups continue it");
  console.log("prompt 2 (window A, Block selected)…");
  await a('window.__3dmaker.select("Block")');
  t = Date.now();
  const r2 = await h.prompt(a, "Make this 50 mm wide along X. Keep the height, depth and the hole.");
  console.log(`  Claude (${secs(t)} s): ${r2.text}\n  receipt: ${JSON.stringify(r2.receipt)}`);
  check(r2.receipt?.changed === true, "the follow-up changed the model");
  s = await a("window.__3dmaker.summary()");
  block = s.parts.find((p) => p.name === "Block");
  if (block?.size) {
    check(near(block.size[0], 50, 1) && near(block.size[1], 30, 1) && near(block.size[2], 30, 1), `Block is now 50 x 30 x 30 mm (got ${block.size.join(" x ")})`);
    const expected = 45 - (Math.PI * 25 * 30) / 1000;
    check(near(block.volume_cm3, expected, expected * 0.04), `the hole is still there: ${block.volume_cm3} cm3, expected ${expected.toFixed(1)}`);
  } else check(false, 'part "Block" still exists');

  const stl = await h.stlIsClosed(a);
  check(stl.closed, `exported STL is a closed mesh (${stl.triangles} triangles)`);
  check((await b("window.__3dmaker.state().script")) === bBefore, "window B, open the whole time, was not changed");

  // ---- 3: a bigger model is built with a plan ----
  console.log("prompt 3 (window B)…");
  t = Date.now();
  const r3 = await h.prompt(b, "A desk fan: weighted round base, upright stand with a tilt joint, motor housing, five spinning blades on a hub, and a front and rear wire guard.", { timeoutMs: 15 * 60 * 1000 });
  console.log(`  Claude (${secs(t)} s): ${r3.text}\n  receipt: ${JSON.stringify(r3.receipt)}`);
  s = await b("window.__3dmaker.summary()");
  const plan = s.plan;
  check(Boolean(plan) && plan.total >= 3, `it was built with a plan (${plan ? `${plan.total} steps: ${plan.steps.map((x) => x.name).join(", ")}` : "no plan"})`);
  if (plan) {
    check(plan.done === plan.total, `every step was finished (${plan.done} of ${plan.total})`);
    const have = new Set(s.parts.filter((p) => p.size).map((p) => p.name));
    const missing = plan.steps.flatMap((x) => x.parts).filter((p) => !have.has(p));
    check(!missing.length, `every part the plan names exists and is solid${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
    check(r3.receipt?.steps >= plan.total, `the app saw each step being checked (${r3.receipt?.steps} finish_step calls)`);
  }
  check(s.parts.some((p) => p.motion?.length), "something spins");
  const stl3 = await h.stlIsClosed(b);
  check(stl3.closed, `the fan's STL is a closed mesh (${stl3.triangles} triangles)`);
} catch (err) {
  fail(String(err.message ?? err));
  console.error(err);
} finally {
  await h.close();
}
process.exit(done());
