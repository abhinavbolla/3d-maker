// The app's commands in a real app window (headless Chrome), without Claude:
// plans, step checks, appending code, ghosted screenshots, exports, the run receipt.
// Usage: node test/app.test.mjs   (needs Google Chrome; uses port 5179)
import { startHarness, checks, STEPPED_FRAMES, GL_COUNTER, sleep } from "./harness.mjs";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { check3MF } from "./check-3mf.mjs";
import { checkGLB, checkOBJ, checkPLY } from "./check-meshfile.mjs";
import { checkStep } from "./check-step.mjs";

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
  check(/not changed/.test(bad.error ?? "") && (await w("window.__draftsman.state().parts.length")) === 3, "a broken append is refused and the model is kept");
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
  check((await w("window.__draftsman.plan()")) === null && (await w('document.getElementById("progress").hidden')), "a new, unrelated model clears the old plan");

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
    const path = join(tmpdir(), `draftsman-${process.pid}-${Date.now()}.stl`);
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
  // As STEP: both parts named, coloured, closed solids, and exact (a box and a cylinder).
  const st = await call("export_step");
  const rs = st.result ? checkStep(Buffer.from(st.result.base64, "base64").toString("latin1")) : { problems: [st.error], parts: [] };
  const stepParts = rs.parts.map((p) => `${p.name} ${p.colour?.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")} ${Object.keys(p.surfaces).sort().join("+")} ${Math.round(p.volume)}`).join(", ");
  check(!rs.problems.length && st.result.exact_parts.join() === "Base,Peg" && stepParts === `Base 4f7cac plane 16000, Peg d9a441 cylinder+plane ${Math.round(Math.PI * 25 * 20)}`, `STEP has both parts as exact, named, coloured solids (${stepParts || rs.problems.slice(0, 3)})`);

  // glTF, OBJ (with its MTL) and PLY, read back by test/check-meshfile.mjs.
  const glb = await call("export_glb");
  const rg = glb.result ? checkGLB(Buffer.from(glb.result.base64, "base64")) : { problems: [glb.error], parts: [] };
  check(!rg.problems.length && rg.parts.map((p) => `${p.name} ${Math.round(p.bounds[5] - p.bounds[2])}`).join(", ") === "Base 10, Peg 20" && !rg.animations.length, `GLB has both parts, named, closed, sized in mm (${rg.parts.map((p) => `${p.name} ${p.triangles}`).join(", ") || rg.problems})`);
  const ob = await call("export_obj", { mtl: "peg.obj" });
  const ro = ob.result ? checkOBJ(Buffer.from(ob.result.base64, "base64").toString(), Buffer.from(ob.result.mtl_base64, "base64").toString()) : { problems: [ob.error], parts: [] };
  check(!ro.problems.length && ro.mtllib === "peg.mtl" && ro.parts.map((p) => p.name).join(", ") === "Base, Peg", `OBJ and its MTL have both parts, with normals and materials (${ro.problems.join("; ") || ro.parts.map((p) => p.material?.name).join(", ")})`);
  const pl = await call("export_ply");
  const rp = pl.result ? checkPLY(Buffer.from(pl.result.base64, "base64")) : { problems: [pl.error], parts: [] };
  check(!rp.problems.length && rp.parts.map((p) => `${p.name} ${p.colors}`).join(", ") === "Base #4f7cac, Peg #d9a441", `PLY has both parts, coloured per vertex (${rp.parts.map((p) => `${p.name} ${p.colors}`).join(", ") || rp.problems})`);
  // The same from the Export menu: each saves its file (an OBJ also its MTL).
  await w(`(() => { window.__saved = []; HTMLAnchorElement.prototype.click = function () { window.__saved.push(this.download); }; return true; })()`);
  for (const kind of ["glb", "obj", "ply"]) {
    await w(`document.querySelector('#export-menu [data-export="${kind}"]').click(), true`);
    for (let i = 0; i < 100 && !/^Exported/.test(await w('document.getElementById("status").textContent')); i++) await sleep(100);
    await w(`document.getElementById("status").textContent = "", true`);
  }
  const saved = await w("window.__saved");
  check(saved.join(", ") === "model.glb, model.obj, model.mtl, model.ply", `the Export menu saves glTF, OBJ with its MTL, and PLY (${saved.join(", ")})`);

  // The same model as a drawing: a well-formed SVG sheet with three views,
  // a section through both parts, and the overall sizes (40 x 40, and 27
  // high from under the base to the top of the peg).
  const readSheet = (r) =>
    w(`(() => {
    const svg = new TextDecoder().decode(Uint8Array.from(atob(${JSON.stringify(r.result?.base64 ?? "")}), (c) => c.charCodeAt(0)));
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const lines = (sel) => [...doc.querySelectorAll(sel)].map((p) => p.getAttribute("d") ?? "").join("").split("M").length - 1;
    return {
      error: doc.querySelector("parsererror")?.textContent ?? null,
      root: doc.documentElement.nodeName,
      size: doc.documentElement.getAttribute("width") + " x " + doc.documentElement.getAttribute("height"),
      views: ["front", "top", doc.querySelector("#view-left") ? "left" : "right", "iso"].map((v) => lines("#view-" + v + " path")),
      parts: [...doc.querySelectorAll("#view-front path")].map((p) => p.getAttribute("data-part")).join(", "),
      cut: [...doc.querySelectorAll("#section-A .cut")].map((g) => g.getAttribute("data-part")).join(", "),
      hatch: lines("#section-A .hatch"),
      sizes: ["width", "depth", "height"].map((k) => doc.querySelector('[data-dimension="' + k + '"]')?.textContent).join(" x "),
      title: doc.querySelector("#title-block #scale")?.textContent,
      side: doc.querySelector("#view-left") ? "left" : "right",
      fields: Object.fromEntries(["created-by", "approved-by", "owner", "number", "revision", "date", "document-type", "title", "projection"].map((id) => [id, doc.querySelector("#title-block #" + id)?.textContent ?? ""])),
      menu: document.querySelector('#export-menu [data-export="svg"] span')?.textContent,
    };
  })()`);
  const dr = await call("export_drawing");
  const sheet = await readSheet(dr);
  check(dr.result && !sheet.error && sheet.root === "svg" && sheet.size === "420mm x 297mm", `export gives a well-formed A3 drawing (${dr.error ?? sheet.error ?? sheet.size})`);
  check(sheet.views.every((n) => n > 0) && sheet.parts === "Base, Peg", `the drawing has front, top, side and isometric views of both parts (${JSON.stringify(sheet.views)} lines, ${sheet.parts})`);
  check(sheet.cut === "Base, Peg" && sheet.hatch > 5 && dr.result?.section.axis === "x" && Math.abs(dr.result.section.cut_area_mm2 - (40 * 10 + 10 * 20)) < 1, `and a hatched section through both (${sheet.cut}, ${dr.result?.section.cut_area_mm2} mm2)`);
  check(sheet.sizes === "40 x 40 x 27" && sheet.title === dr.result?.scale && sheet.menu === "Drawing", `with the overall sizes and the scale, and the Export menu offers it (${sheet.sizes}, ${sheet.title})`);
  const across = await call("export_drawing", { axis: "z", offset: 15 });
  check(across.result?.section.axis === "z" && across.result.section.parts_cut.join() === "Peg" && Math.abs(across.result.section.cut_area_mm2 - Math.PI * 25) < 0.1, `a section can be put anywhere (${JSON.stringify(across.result?.section ?? across.error)})`);
  check(/misses the model/.test((await call("export_drawing", { axis: "z", offset: 60 })).error ?? ""), "a section that misses the model is refused");

  // The title block with nothing said: honest and complete. A number is
  // made up once for the document; nobody's name is filled in; the date of
  // issue is today.
  const f0 = sheet.fields;
  const today = await w('(() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()');
  check(/^3DM-[0-9A-HJKMNP-TV-Z]{6}$/.test(f0.number) && f0.date === today && f0["document-type"] === "Assembly drawing", `the title block has a made-up number, today's date and the document type (${JSON.stringify(f0)})`);
  check(!f0["created-by"] && !f0["approved-by"] && !f0.owner && !f0.revision, `and no name, owner, approver or revision that nobody gave (${JSON.stringify(f0)})`);
  check(/Created by, legal owner and approved by left blank\. To fill in or change a field, tell Claude, e\.g\. "drawn by …, owner …"\.$/.test(dr.result?.line ?? ""), `the line says what is blank and how to fill it (${dr.result?.line})`);
  check(dr.result?.isometric_view === true, "and says the isometric view was drawn");
  check(across.result?.sheet.identification_number === f0.number, "the number stays the same on the next drawing");

  // First or third angle from the region the system's language names; with
  // none named, ISO's first angle.
  const angle = async (lang) => {
    await w(`Object.defineProperty(navigator, "language", { configurable: true, get: () => ${JSON.stringify(lang)} }); Object.defineProperty(navigator, "languages", { configurable: true, get: () => [${JSON.stringify(lang)}] }); true`);
    const r = await call("export_drawing");
    return `${(await readSheet(r)).side} ${r.result?.sheet.projection}`;
  };
  const angles = { "en-US": await angle("en-US"), "en-GB": await angle("en-GB"), "ja-JP": await angle("ja-JP"), "fr-CA": await angle("fr-CA"), ja: await angle("ja"), en: await angle("en"), de: await angle("de") };
  check(angles["en-US"] === "right third angle (from your region, US)" && angles["ja-JP"].startsWith("right third") && angles.ja === "right third angle (from your region, JP)" && angles["fr-CA"].startsWith("right third") && angles["en-GB"] === "left first angle (from your region, GB)", `third angle in the US, Canada and Japan (plain "ja" too), first in Britain (${JSON.stringify(angles)})`);
  check(angles.en === "left first angle (ISO's default: your system names no region)" && angles.de.startsWith("left first angle (ISO"), `a language with no region gets first angle, not the US's third (${angles.en})`);

  // Said in a prompt: Claude passes it on, the sheet shows it, and the app
  // remembers it, names for the user and the rest for the document.
  const said = await call("export_drawing", { drawn_by: "Ana Ruiz", owner: "Example Works Ltd", number: "BRK-0042", revision: "A", projection: "third", tolerances: "ISO 2768-m" });
  const named = await readSheet(said);
  check(named.fields["created-by"] === "Ana Ruiz" && named.fields.owner === "Example Works Ltd" && named.fields.number === "BRK-0042" && named.fields.revision === "A" && named.side === "right" && !named.fields["approved-by"], `what the user said goes on the sheet (${JSON.stringify(named.fields)})`);
  check(/Created by, legal owner, revision and general tolerances as given\. Approved by left blank\./.test(said.result?.line ?? ""), `and the line says so (${said.result?.line})`);
  const again = await call("export_drawing");
  const kept = await readSheet(again);
  check(kept.fields["created-by"] === "Ana Ruiz" && kept.fields.owner === "Example Works Ltd" && kept.fields.number === "BRK-0042", "the next drawing has them too");
  check(!JSON.stringify(again.result?.sheet).includes("Ana Ruiz") && !again.result?.line.includes("Ana Ruiz") && again.result?.sheet.created_by === "(filled in, as remembered)" && /Created by, legal owner, revision and general tolerances as remembered\./.test(again.result?.line), `a remembered name is on the sheet but not sent back to Claude (${again.result?.line})`);
  const stored = await w('({ user: localStorage.getItem("draftsman:drawing"), doc: localStorage.getItem("draftsman:autosave") })');
  check(/Ana Ruiz/.test(stored.user) && /BRK-0042/.test(stored.doc) && !/Ana Ruiz|Example Works/.test(stored.doc), "names are kept for the user, not in the model, which keeps its number");

  // Limits (ISO 7200's lengths): a value at the limit fits whole, one over is refused.
  const atLimit = await call("export_drawing", { number: "WWWWWWWWWWWWWWWW", revision: "WW", drawn_by: "W".repeat(20) });
  const full = await readSheet(atLimit);
  check(full.fields.number === "W".repeat(16) && full.fields.revision === "WW" && full.fields["created-by"] === "W".repeat(20), `values at their limits are on the sheet whole (${JSON.stringify(full.fields)})`);
  const over = await Promise.all([{ number: "W".repeat(17) }, { revision: "ABC" }, { drawn_by: "W".repeat(21) }, { owner: "W".repeat(41) }].map((a) => call("export_drawing", a)));
  check(/at most 16 characters/.test(over[0].error) && /Revision holds at most 2/.test(over[1].error) && /Created by holds at most 20/.test(over[2].error) && /Legal owner holds at most 40/.test(over[3].error), `longer ones are refused, saying the limit (${over.map((o) => o.error).join(" | ")})`);
  await call("export_drawing", { number: "BRK-0042", revision: "A", drawn_by: "Ana Ruiz" });

  // A failed export remembers nothing it was told.
  const failed = await call("export_drawing", { drawn_by: "Zed Quist", number: "FAIL-1", axis: "z", offset: 9999 });
  const after = await readSheet(await call("export_drawing"));
  check(/misses the model/.test(failed.error ?? "") && after.fields["created-by"] === "Ana Ruiz" && after.fields.number === "BRK-0042", `a failed export remembers nothing (${JSON.stringify(after.fields)})`);

  // An approval goes on the sheet it is given with, and no other: it is
  // never remembered, so no one's name is saved in the model.
  const approvedCall = await call("export_drawing", { approved_by: "J. Smith" });
  const approved = await readSheet(approvedCall);
  const next = await call("export_drawing");
  const nextSheet = await readSheet(next);
  const savedDoc = await w('new Promise((r) => setTimeout(r, 500)).then(() => localStorage.getItem("draftsman:autosave"))');
  check(approved.fields["approved-by"] === "J. Smith" && /Approved by as given\./.test(approvedCall.result?.line ?? ""), `an approval goes on the sheet it is given with (${approvedCall.result?.line})`);
  check(!nextSheet.fields["approved-by"] && /Approved by left blank\./.test(next.result?.line ?? "") && nextSheet.fields.revision === "A", `and the next sheet has an empty line to sign (${next.result?.line})`);
  check(!/J\. Smith|Ana Ruiz|Example Works/.test(savedDoc) && /BRK-0042/.test(savedDoc), "no one's name is saved in the model");

  // A long title() never stops a drawing: it continues in the supplementary
  // title, gives way to one the user gave, and is cut with "…" only when
  // even that cannot hold it.
  const longTitle = "Main gearbox input pinion housing with integral oil jets and chip detector port, left hand side.";
  await call("edit_model", { old_text: 'part("Base"', new_text: `title(${JSON.stringify(longTitle)});\npart("Base"` });
  const long1 = await call("export_drawing");
  const long2 = await call("export_drawing", { subtitle: "Prototype B, for the rig test" });
  await call("edit_model", { old_text: `title(${JSON.stringify(longTitle)});`, new_text: `title(${JSON.stringify(`${longTitle} `.repeat(4).trim())});` });
  const long3 = await call("export_drawing", { subtitle: "" });
  check(longTitle.length === 96 && long1.result && `${long1.result.sheet.title} ${long1.result.sheet.supplementary_title}` === longTitle && !/shortened/.test(long1.result.line), `a 96-character title is drawn whole, split into the supplementary title (${JSON.stringify(long1.result?.sheet.title ?? long1.error)})`);
  check(long2.result?.sheet.supplementary_title === "Prototype B, for the rig test" && long2.result.sheet.title === longTitle, `with the user's supplementary title, theirs stays and the title has its cell (${long2.result?.sheet.title ?? long2.error})`);
  check(long3.result && long3.result.sheet.supplementary_title.endsWith("…") && /The model's title was too long for the title block and is shortened on the sheet\./.test(long3.result.line), `a title too long even for both is cut at a word, and the line says so (${long3.result?.sheet.supplementary_title ?? long3.error})`);
  await call("edit_model", { old_text: `title(${JSON.stringify(`${longTitle} `.repeat(4).trim())});\n`, new_text: "" });

  // The number belongs to the document: kept through Claude rewriting the
  // script, a new one for New, and each document's own back through undo.
  await call("set_model", { script: 'part("Base", box(40, 40, 10), { color: "#4f7cac" });\npart("Peg", cylinder(6, 20).at(0, 0, 12));' });
  const rewritten = (await call("export_drawing")).result?.sheet.identification_number;
  const undo = () => w('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })); new Promise((r) => setTimeout(r, 1500))');
  const redo = () => w('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true })); new Promise((r) => setTimeout(r, 1500))');
  const numberNow = async () => (await call("export_drawing")).result?.sheet.identification_number;
  await w('document.querySelector(\'[data-action="new"]\').click(); new Promise((r) => setTimeout(r, 1000))');
  await call("set_model", { script: 'part("Other", box(30, 30, 30));' });
  const fresh = await numberNow();
  await undo();
  await undo();
  const back = await numberNow();
  check(rewritten === "BRK-0042" && /^3DM-/.test(fresh) && back === "BRK-0042", `the number stays through set_model, New starts afresh, and undo brings the old number back (${rewritten}, ${fresh}, ${back})`);
  // Open a file with a number of its own, then undo and redo across it.
  const file = JSON.stringify({ version: 2, script: 'part("Opened", box(25, 25, 25));', values: {}, drawing: { number: "FILE-0001", revision: "B" } });
  await w(`(() => {
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== "file") return click.call(this);
      HTMLInputElement.prototype.click = click;
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(file)}], "other.json"));
      this.files = dt.files;
      this.dispatchEvent(new Event("change"));
    };
    document.querySelector('[data-action="open"]').click();
    return new Promise((r) => setTimeout(r, 1500));
  })()`);
  const opened = await numberNow();
  await undo();
  const before = await numberNow();
  await redo();
  const reopened = await numberNow();
  check(opened === "FILE-0001" && before === "BRK-0042" && reopened === "FILE-0001", `an opened file keeps its own number, and undo gives the previous model its own (${opened}, ${before}, ${reopened})`);

  // Making a number does not upset a build or a fine pass under way.
  await w('document.querySelector(\'[data-action="new"]\').click(); new Promise((r) => setTimeout(r, 1000))');
  const racePlate = 'part("Plate", box(400, 400, 10));\nfor (let i = 0; i < 31; i++) part("Bolt " + i, cylinder(3, 8).at(-150 + i * 10, 0, 9));';
  const raceDetail = async () => (await w("window.__draftsman.summary()")).parts.find((p) => p.name === "Plate")?.detail_mm;
  await call("set_model", { script: racePlate });
  const raceCoarse = await raceDetail();
  await call("export_drawing");
  await call("screenshot", { view: "top", width: 300, height: 300 });
  const raceFine = await raceDetail();
  const inFlight = await w(`Promise.all([window.__draftsman.call("set_model", { script: ${JSON.stringify(racePlate.replace("400, 400", "410, 400"))} }), window.__draftsman.call("export_drawing", {})]).then(([, d]) => d.sheet.identification_number)`);
  const settled = await numberNow();
  check(raceFine < raceCoarse, `the fine pass still lands after an export makes a number (${raceCoarse} mm, then ${raceFine} mm)`);
  check(inFlight === settled, `a change on its way does not lose the number made meanwhile (${inFlight}, then ${settled})`);

  await call("export_drawing", { drawn_by: "", owner: "", projection: "" });
  // Export > Drawing, without Claude, says the same in the status line.
  const status = await w(`(async () => {
    document.getElementById("status").textContent = "";
    document.querySelector('#export-menu [data-export="svg"]').click();
    for (let i = 0; i < 300 && !/Exported/.test(document.getElementById("status").textContent); i++) await new Promise((r) => setTimeout(r, 100));
    return document.getElementById("status").textContent;
  })()`);
  check(/^Exported \S+\.svg\. Drawing 3DM-\w{6}, \w+ angle( \(from your region\))?, [\d:]+\. Created by, legal owner and approved by left blank\. To fill in or change a field, tell Claude/.test(status), `Export > Drawing says what went on the sheet (${status})`);

  // Detail: after a change the model is meshed again finely in the
  // background, and Claude's pictures wait for it.
  const plate = 'part("Plate", box(400, 400, 10));\nfor (let i = 0; i < 31; i++) part("Bolt " + i, cylinder(3, 8).at(-150 + i * 10, 0, 9));';
  const detail = async () => (await w("window.__draftsman.summary()")).parts.find((p) => p.name === "Plate")?.detail_mm;
  await call("set_model", { script: plate });
  const coarse = await detail();
  await call("screenshot", { view: "top", width: 300, height: 300 });
  const finer = await detail();
  check(finer > 0 && finer < coarse, `the big part is meshed finer in the background (${coarse} mm cells, then ${finer} mm)`);
  // A newer change wins over a fine pass that was still running.
  await call("set_model", { script: plate.replace("400, 400", "300, 300") });
  await call("set_model", { script: 'part("Cube", box(20, 20, 20));' });
  await call("screenshot", { width: 300, height: 300 });
  check(JSON.stringify(await w("window.__draftsman.state().parts")) === '["Cube"]', "a fine pass that finishes late does not bring back an old model");

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
    const p = await w("window.__draftsman.picture({ width: 320 })");
    return { ...p, bytes: Buffer.from(p.png, "base64") };
  };
  const first = await picture();
  check(first.bytes.subarray(1, 4).toString() === "PNG" && first.width === 320 && first.bytes.readUInt32BE(16) === 320, "Export > Picture makes a PNG of the asked width");
  // Scroll in over the wheel, well off the middle of the window: the camera
  // heads for the wheel, so the wheel stays under the pointer and grows.
  const moved = await w(`(async () => {
    const canvas = document.querySelector("#viewport canvas");
    const at = window.__draftsman.screenPosition("Wheel");
    const before = { ...at };
    for (let i = 0; i < 6; i++) {
      canvas.dispatchEvent(new WheelEvent("wheel", { clientX: at.x, clientY: at.y, deltaY: -120, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
    const after = window.__draftsman.screenPosition("Wheel");
    return { before, after };
  })()`);
  check(Math.hypot(moved.after.x - moved.before.x, moved.after.y - moved.before.y) < 12, `scrolling zooms to the pointer: the wheel stays under it (${JSON.stringify(moved)})`);
  check((await picture()).png !== first.png, "and the view has moved in");
  const turned = await w(`(async () => {
    const canvas = document.querySelector("#viewport canvas");
    const ev = (type, x, y, button = 0) => canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button, pointerId: 7, bubbles: true }));
    const body = () => window.__draftsman.screenPosition("Body");
    const a = body();
    ev("pointerdown", 300, 300, 2); ev("pointermove", 340, 300, 2); ev("pointermove", 380, 300, 2); ev("pointerup", 380, 300, 2);
    const b = body();
    ev("pointerdown", 300, 300); ev("pointermove", 360, 320); ev("pointermove", 420, 340); ev("pointerup", 420, 340);
    return { slid: b.x - a.x, c: body(), b };
  })()`);
  check(turned.slid > 40, `a right-drag slides the view with the pointer (${Math.round(turned.slid)} px for 80)`);
  check(Math.hypot(turned.c.x - turned.b.x, turned.c.y - turned.b.y) > 5, "a drag turns the view");
  await w('window.__draftsman.fit("top")');
  const fromTop = await w('window.__draftsman.screenPosition("Body")');
  check(Math.abs(fromTop.x - 640) < 40, `Top brings the model back to the middle of the view (${JSON.stringify(fromTop)})`);

  // The view turns around its centre, the middle of the window, wherever
  // you grab, and shows that centre while it turns.
  const pivots = await w(`(async () => {
    const canvas = document.querySelector("#viewport canvas");
    const ev = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 8, bubbles: true }));
    const mid = canvas.getBoundingClientRect();
    window.__draftsman.fit("iso");
    const idle = window.__draftsman.turningPoint();
    const grab = window.__draftsman.screenPosition("Wheel");
    ev("pointerdown", grab.x, grab.y); ev("pointermove", grab.x + 30, grab.y + 6);
    const started = window.__draftsman.turningPoint();
    ev("pointermove", grab.x + 90, grab.y + 30);
    const later = window.__draftsman.turningPoint();
    ev("pointerup", grab.x + 90, grab.y + 30);
    const after = window.__draftsman.turningPoint();
    ev("pointerdown", 40, 120); ev("pointermove", 60, 124);
    const empty = window.__draftsman.turningPoint();
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
    const before = window.__draftsman.screenPosition("Wheel");
    ev("pointerdown", 300, 220, 32, true); ev("pointermove", 340, 230, 32, true); ev("pointermove", 420, 250, 32, true);
    const during = window.__draftsman.turningPoint();
    ev("pointerup", 420, 250, 32, true);
    const after = window.__draftsman.screenPosition("Wheel");
    return { moved: Math.hypot(after.x - before.x, after.y - before.y), during, still: window.__draftsman.turningPoint() };
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
    window.__draftsman.fit("iso");
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
    const before = window.__draftsman.screenPosition("Wheel");
    ev("pointerdown", 50, 50); ev("pointermove", 60, 52); ev("pointermove", 90, 64);
    const during = window.__draftsman.turningPoint();
    ev("pointerup", 90, 64);
    const after = window.__draftsman.screenPosition("Wheel");
    await until(() => shown() !== "Front");
    return { visible, sides: faces.length, places: root.querySelectorAll("button").length, first, top, corner, cornerTitle, front, dragged: Math.hypot(after.x - before.x, after.y - before.y), during, still: window.__draftsman.turningPoint(), turned: shown() };
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
    window.__draftsman.fit("iso");
    const before = window.__draftsman.screenPosition("Body");
    for (let i = 0; i < 4; i++) canvas.dispatchEvent(new WheelEvent("wheel", { clientX: before.x, clientY: before.y, deltaX: 20, deltaY: 10, bubbles: true, cancelable: true }));
    const after = window.__draftsman.screenPosition("Body");
    for (let i = 0; i < 3; i++) canvas.dispatchEvent(new WheelEvent("wheel", { clientX: after.x, clientY: after.y, deltaY: -120, bubbles: true, cancelable: true }));
    const wheeled = window.__draftsman.screenPosition("Body");
    const pinchAt = window.__draftsman.screenPosition("Wheel");
    for (let i = 0; i < 3; i++) canvas.dispatchEvent(new WheelEvent("wheel", { clientX: after.x, clientY: after.y, deltaY: -6, ctrlKey: true, bubbles: true, cancelable: true }));
    const pinched = window.__draftsman.screenPosition("Wheel");
    const downAt = window.__draftsman.screenPosition("Body");
    for (let i = 0; i < 4; i++) canvas.dispatchEvent(new WheelEvent("wheel", { clientX: downAt.x, clientY: downAt.y, deltaY: 10, bubbles: true, cancelable: true }));
    const down = window.__draftsman.screenPosition("Body");
    return { dx: after.x - before.x, dy: after.y - before.y, wheel: Math.hypot(wheeled.x - after.x, wheeled.y - after.y), pinch: Math.hypot(pinched.x - pinchAt.x, pinched.y - pinchAt.y), straight: { dx: down.x - downAt.x, dy: down.y - downAt.y } };
  })()`);
  // The surface under the pointer moves with the fingers (80 px, 40 px); the
  // middle of the body is further away, so it moves a little less.
  check(swiped.dx < -55 && swiped.dx > -90 && Math.abs(swiped.dy - swiped.dx / 2) < 4, `two fingers on a trackpad slide the view both ways (${JSON.stringify(swiped)})`);
  check(swiped.wheel < 12, `a mouse wheel still zooms to the pointer after that (${Math.round(swiped.wheel)} px)`);
  check(swiped.pinch > 3, `and a pinch zooms (${Math.round(swiped.pinch)} px)`);
  check(swiped.straight.dy < -15 && Math.abs(swiped.straight.dx) < 4, `and two fingers moved straight up slide the view, not zoom it (${JSON.stringify(swiped.straight)})`);

  // Crease shading: a block standing on a plate, seen from the top. A
  // finished frame with the shading is darker in the corner where the block
  // meets the plate, and the same as without it on the open plate, on the
  // block's top, on the floor beside the plate and on the background.
  await call("set_model", { script: 'part("Plate", box(200, 200, 20).at(0, 0, 10), { color: "#9aa3ad", material: "plastic" }); part("Block", box(50, 50, 60).at(50, 50, 50), { color: "#9aa3ad", material: "plastic" });' });
  await w('window.__draftsman.fit("top")');
  const shade = await w(`(() => {
    const read = (creases) => {
      const c = window.__draftsman.frame({ creases });
      const x = Object.assign(document.createElement("canvas"), { width: c.width, height: c.height }).getContext("2d");
      x.drawImage(c, 0, 0);
      return x.getImageData(0, 0, c.width, c.height);
    };
    const plain = read(false), shaded = read(true);
    const k = plain.width / document.querySelector("#viewport canvas").clientWidth;
    const P = window.__draftsman.screenPosition("Plate"), B = window.__draftsman.screenPosition("Block");
    const dark = (x, y) => { const i = (Math.round(y * k) * plain.width + Math.round(x * k)) * 4; return [0, 1, 2].reduce((m, c) => Math.max(m, plain.data[i + c] - shaded.data[i + c]), -255); };
    const patch = (x, y) => { let m = 0; for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) m = Math.max(m, Math.abs(dark(x + dx, y + dy))); return m; };
    // From the block's middle towards the plate's, across the corner.
    const along = []; for (let t = 0; t <= 1; t += 0.01) along.push(dark(B.x + (P.x - B.x) * t, B.y + (P.y - B.y) * t));
    const floor = { x: P.x + (P.x - B.x) * 2.3, y: P.y + (P.y - B.y) * 2.3 };
    return { crease: Math.max(...along), plate: patch(P.x, P.y), block: patch(B.x, B.y), floor: patch(floor.x, floor.y), background: patch(10, 10) };
  })()`);
  check(shade.crease >= 15, `the crease shading darkens the corner where two parts meet (by ${shade.crease} of 255)`);
  check(shade.plate <= 1 && shade.block <= 1, `and leaves open flat faces as they were (${shade.plate} and ${shade.block} of 255 at most)`);
  check(shade.floor <= 1 && shade.background <= 1, `and the floor and the background (${shade.floor} and ${shade.background} of 255 at most)`);
  // A finished frame at a given size, for recording: read while it is on the
  // canvas, shaded, and the window's own size back afterwards.
  const sizedFrame = await w(`(() => {
    const c = document.querySelector("#viewport canvas"), before = [c.width, c.height];
    const got = window.__draftsman.frame({ width: 640, height: 360 }, (k) => {
      const x = Object.assign(document.createElement("canvas"), { width: k.width, height: k.height }).getContext("2d");
      x.drawImage(k, 0, 0);
      const d = x.getImageData(0, 0, k.width, k.height).data;
      let parts = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[i + 2]) < 30 && d[i] > 90 && d[i] < 200) parts++;
      return { size: [k.width, k.height], parts };
    });
    return { ...got, before, after: [c.width, c.height] };
  })()`);
  check(sizedFrame.size.join() === "640,360" && sizedFrame.parts > 1000 && sizedFrame.after.join() === sizedFrame.before.join(), `frame() draws at a given size and gives the window its size back (${JSON.stringify(sizedFrame)})`);

  // ---- Looking inside and checking, by prompt: hide, section, explode, measure ----
  // A block, a can and a ball whose sizes, volumes and gaps are known by hand.
  await call("set_model", { script: 'part("Block", box(40, 20, 10).at(0, 0, 5), { color: "#3060c0" });\npart("Can", cylinder(10, 30).at(50, 0, 15), { color: "#d0a020" });\npart("Ball", sphere(15).at(0, 60, 15), { color: "#c03020" });' });
  await call("screenshot", { width: 200, height: 150 }); // waits for the fine mesh
  // Pixels of a PNG, counted in the page: how many are near a colour, and the
  // box (in pixels) around them.
  const near = (png, rgb, tol = 40) =>
    w(`(async () => {
      const img = new Image();
      img.src = "data:image/png;base64,${png}";
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const [r, gr, b] = ${JSON.stringify(rgb)};
      let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - gr) + Math.abs(d[i + 2] - b) > ${tol}) continue;
        const x = (i / 4) % c.width, y = Math.floor(i / 4 / c.width);
        n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      return { n, x0, y0, x1, y1 };
    })()`);
  const pixelAt = (png, x, y) =>
    w(`(async () => {
      const img = new Image();
      img.src = "data:image/png;base64,${png}";
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return [...g.getImageData(${x}, ${y}, 1, 1).data].slice(0, 3);
    })()`);
  const snap = async (args) => (await call("screenshot", { width: 600, height: 450, ...args })).result.png;
  const stlBefore = (await call("export_stl")).result;
  await w('window.__draftsman.fit("iso")');
  const pictureBefore = (await w("window.__draftsman.picture({ width: 400 })")).png;
  const isoBefore = await snap({});

  // Measure: numbers from the exact shapes, checked against hand values.
  const m = (await call("measure", { parts: ["Block", "Can", "Ball"], material: "aluminium", between: ["Block", "Can"], points: [[0, 0, 0], [3, 4, 12]] })).result;
  const [mb, mc, ms] = m?.parts ?? [];
  const within = (v, exact, rel) => Math.abs(v / exact - 1) <= rel;
  check(within(mb?.volume_cm3, 8, 0.001) && within(mc?.volume_cm3, (Math.PI * 100 * 30) / 1000, 0.001) && within(ms?.volume_cm3, ((4 / 3) * Math.PI * 15 ** 3) / 1000, 0.001), `measure gives each volume within 0.1% (${mb?.volume_cm3}, ${mc?.volume_cm3}, ${ms?.volume_cm3} cm3; 8, 9.425, 14.137 by hand)`);
  check(JSON.stringify([mb?.centre_of_mass_mm, mc?.centre_of_mass_mm, ms?.centre_of_mass_mm]) === "[[0,0,5],[50,0,15],[0,60,15]]", `and each centre of mass to 0.1 mm (${JSON.stringify([mb?.centre_of_mass_mm, mc?.centre_of_mass_mm, ms?.centre_of_mass_mm])})`);
  check(within(mb?.mass_g, 21.6, 0.001) && within(m?.total.mass_g, 2.7 * (8 + 3 * Math.PI * 100 / 100 + (4 / 3) * Math.PI * 3.375), 0.001), `the block weighs 21.6 g in aluminium, and the three ${m?.total.mass_g} g (${mb?.mass_g} g)`);
  check(within(mb?.surface_area_cm2, 28, 0.01) && within(mc?.surface_area_cm2, (2 * Math.PI * 10 * 30 + 2 * Math.PI * 100) / 100, 0.01), `surface areas within 1% (${mb?.surface_area_cm2}, ${mc?.surface_area_cm2} cm2)`);
  check(Math.abs(m?.between.distance_mm - 20) <= 0.02 && m.between.nearest_on_a_mm[0] === 20 && m.between.nearest_on_b_mm[0] === 40, `the block and the can are 20 mm apart, nearest at x 20 and 40 (${JSON.stringify(m?.between)})`);
  check(m?.points.distance_mm === 13, `two points 13 mm apart (${JSON.stringify(m?.points)})`);
  check(/No density known for "unobtainium"/.test((await call("measure", { part: "Block", material: "unobtainium" })).error ?? "") && /no part named "Nope"/.test((await call("measure", { part: "Nope" })).error ?? ""), "an unknown material or part is refused, naming what is known");

  // Hide: the part's pixels and its pick go; the export does not change.
  const ballRed = [192, 48, 32];
  const topBefore = await snap({ view: "top" });
  const redShown = await near(topBefore, ballRed, 90);
  await w('window.__draftsman.fit("iso")');
  const click = (name) => w(`(() => { const c = document.querySelector("#viewport canvas"), p = window.__draftsman.screenPosition(${JSON.stringify(name)}); const at = { clientX: p.x, clientY: p.y, button: 0, pointerId: 5, bubbles: true }; c.dispatchEvent(new PointerEvent("pointerdown", at)); c.dispatchEvent(new PointerEvent("pointerup", at)); const s = window.__draftsman.state().selected; window.__draftsman.select(null); return s; })()`);
  const pickedBefore = await click("Ball");
  const hid = await call("hide_parts", { hide: ["Ball"] });
  const redHidden = await near(await snap({ view: "top" }), ballRed, 90);
  const pickedHidden = await click("Ball");
  check(redShown.n > 2000 && redHidden.n === 0, `a hidden part is gone from the picture (${redShown.n} red pixels, then ${redHidden.n})`);
  check(pickedBefore === "Ball" && pickedHidden !== "Ball", `and a click where it was does not pick it (${pickedBefore}, then ${pickedHidden})`);
  check(hid.result?.view.hidden?.join() === "Ball" && (await w('document.getElementById("inspect-line").textContent')).startsWith("1 part hidden"), `the line above the prompt says so (${await w('document.getElementById("inspect-line").textContent')})`);
  check((await snap({ view: "top", parts: ["Ball"] })) && (await near(await snap({ view: "top", parts: ["Ball"] }), ballRed, 90)).n > 2000, "a screenshot that names a hidden part shows it");
  check(/no part named "Nope"/.test((await call("hide_parts", { only: ["Nope"] })).error ?? ""), "hiding an unknown part is refused");
  check(/would hide every part/.test((await call("hide_parts", { hide: ["Block", "Can"] })).error ?? ""), "and so is hiding every part");
  await call("hide_parts", { all: true });

  // Section: the cut faces are filled and flat, and lie on the plane.
  // From above, the view frames x -20 to 60 and y -10 to 75 (with 6% to
  // spare): 225 / 45.05 px per mm, and the block's top face at x 0, y 5 is
  // at pixel (200, 362).
  const topWholePng = await snap({ view: "top" });
  const topColour = await pixelAt(topWholePng, 200, 362);
  const topWhole = await near(topWholePng, topColour, 24);
  const frontWhole = await snap({ view: "front" });
  const sec = await call("section_view", { axis: "y", offset: 0, remove: "-" });
  check(sec.result?.parts_cut.join() === "Block,Can" && sec.result.look_into_it_from === "front", `a section across y cuts the block and the can, and says where to look from (${JSON.stringify(sec.result ?? sec.error)})`);
  const topCutPng = await snap({ view: "top" });
  const topCut = await near(topCutPng, topColour, 24);
  // Seen from above the block reached from y -10 to 10 (100 px); cut at 0 it
  // reaches from 0 to 10, and its top face is shaded as before.
  check(topWhole.n > 1000 && Math.abs((topCut.y1 - topCut.y0 + 1) / (topWhole.y1 - topWhole.y0 + 1) - 0.5) < 0.04 && Math.abs(topCut.y0 - topWhole.y0) <= 1, `from above, the cut block ends at the plane: half as deep (${topCut.y1 - topCut.y0 + 1} px of ${topWhole.y1 - topWhole.y0 + 1}; top face ${topColour}, then ${await pixelAt(topCutPng, 200, 340)})`);
  const frontCut = await snap({ view: "front" });
  // The front view looks into the cut. It frames x -20 to 60 and z 0 to 30
  // (with 6% to spare): 300 / 42.4 px per mm. The block's cut face is 40 x
  // 10 mm and the can's 20 x 30 mm, each filled in its own colour and
  // hatched over it, so a colour picked on the face (fill or hatch) covers
  // the whole face: its area is the box around it.
  const ppm = 300 / 42.4;
  const toPx = (x, z) => [Math.round(300 + (x - 20) * ppm), Math.round(225 - (z - 15) * ppm)];
  const blockColour = await pixelAt(frontCut, ...toPx(0, 5));
  const canColour = await pixelAt(frontCut, ...toPx(50, 15));
  const blockFace = await near(frontCut, blockColour, 6);
  const canFace = await near(frontCut, canColour, 6);
  const areaMm = (f) => Math.round(((f.x1 - f.x0 + 1) * (f.y1 - f.y0 + 1)) / ppm ** 2);
  check(frontCut !== frontWhole && Math.abs(areaMm(blockFace) / 400 - 1) < 0.04 && Math.abs(areaMm(canFace) / 600 - 1) < 0.04 && blockFace.n > 0.1 * areaMm(blockFace) * ppm ** 2, `the cut faces are filled and hatched: ${areaMm(blockFace)} and ${areaMm(canFace)} mm2 (400 and 600 exact)`);
  check(Math.abs((blockFace.x1 - blockFace.x0 + 1) / ppm - 40) < 0.5 && Math.abs((canFace.y1 - canFace.y0 + 1) / ppm - 30) < 0.5, `and the right size: ${((blockFace.x1 - blockFace.x0 + 1) / ppm).toFixed(1)} mm wide, ${((canFace.y1 - canFace.y0 + 1) / ppm).toFixed(1)} mm high`);
  const lineNow = await w('document.getElementById("inspect-line").textContent');
  check(/^Section at Y = 0 mm/.test(lineNow), `the line says where the section is (${lineNow})`);
  await call("section_view", { axis: "y", offset: 0, remove: "-", uncut: ["Can"] });
  const canWhole = await near(await snap({ view: "front" }), canColour, 6);
  check(canWhole.n < canFace.n / 4, `a part left uncut keeps its own face (${canWhole.n} px of the cut colour, ${canFace.n} when cut)`);
  check(/misses the model/.test((await call("section_view", { axis: "z", offset: 500 })).error ?? ""), "a section that misses the model is refused");
  // A plane at any angle: through the can's axis, facing x and y alike.
  check((await call("section_view", { point: [50, 0, 0], normal: [1, -1, 0] })).result?.parts_cut.join() === "Can", "a plane at any angle cuts what it passes through");

  // Explode: parts move apart from the middle, all stay above the floor, and
  // they come back together.
  await call("section_view", { off: true });
  const until = (js) => w(`(async () => { for (let i = 0; i < 600 && !(${js}); i++) await new Promise((r) => setTimeout(r, 50)); return ${js}; })()`);
  const ex = await call("explode_view", { factor: 1 });
  await until("!window.__draftsman.exploding()");
  const offs = await w('["Block", "Can", "Ball"].map((n) => window.__draftsman.offset(n).map((v) => Math.round(v * 10) / 10))');
  // The middle of all three is (20, 32.5, 15); each part goes as far again
  // from it, and all are lifted 10 mm so the block stays on the floor.
  check(JSON.stringify(offs) === "[[-20,-32.5,0],[30,-32.5,10],[-20,27.5,10]]", `exploded, each part moves away from the middle (${JSON.stringify(offs)}; ${ex.result?.view.says ?? ex.error})`);
  const exShot = await snap({ view: "iso" });
  await call("explode_view", { factor: 0 });
  await until("!window.__draftsman.exploding()");
  check(exShot !== isoBefore && JSON.stringify(await w('["Block", "Can", "Ball"].map((n) => window.__draftsman.offset(n))')) === "[[0,0,0],[0,0,0],[0,0,0]]", "and at 0 they are back together");
  await call("explode_view", { factor: 0.5, axis: "z" });
  await until("!window.__draftsman.exploding()");
  const up = await w('window.__draftsman.offset("Can")');
  check(up[0] === 0 && up[1] === 0 && Math.abs(up[2] - 5) < 1e-6, `along one axis at half: the can rises 5 mm and nothing else (${up})`);
  check(/no plan/.test((await call("explode_view", { together: "steps" })).error ?? ""), "keeping steps together without a plan is refused");

  // All at once, then cleared: the exports never changed, and clearing gives
  // back exactly the picture from before.
  await call("hide_parts", { hide: ["Ball"] });
  await call("section_view", { axis: "x", offset: 0 });
  await call("explode_view", { factor: 1 });
  const stlDuring = (await call("export_stl")).result;
  const drawingDuring = (await call("export_drawing", { axis: "z", offset: 5 })).result;
  check(stlDuring?.base64 === stlBefore?.base64 && drawingDuring?.section.parts_cut.join() === "Block,Can,Ball", `exports are unchanged while parts are hidden, cut and exploded (${stlDuring?.triangles} triangles, ${stlBefore?.triangles} before; the drawing cuts ${drawingDuring?.section.parts_cut.join(", ")})`);
  const allLine = await w('document.getElementById("inspect-line").textContent');
  check(allLine === "Section at X = 0 mm · 1 part hidden · Exploded×", `one line says it all (${allLine})`);
  await w('document.getElementById("inspect-line").click()');
  await until("!window.__draftsman.exploding()");
  check(await w('document.getElementById("inspect-line").hidden'), "a click on the line clears it");
  await w('window.__draftsman.fit("iso")');
  check((await snap({})) === isoBefore, "and the view is exactly as it was before");
  check((await w("window.__draftsman.picture({ width: 400 })")).png === pictureBefore, "the studio picture too");
  await call("section_view", { axis: "z", offset: 5 });
  const esc = () => w('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true');
  await w('window.__draftsman.select("Block")');
  await esc();
  const firstEsc = await w('[window.__draftsman.state().selected, document.getElementById("inspect-line").hidden]');
  await esc();
  const secondEsc = await w('document.getElementById("inspect-line").hidden');
  check(firstEsc[0] === null && firstEsc[1] === false && secondEsc === true, `Esc deselects first, then shows the whole model (${JSON.stringify(firstEsc)}, ${secondEsc})`);

  // A section with the crease shading and the edges: a block with a peg on
  // it, cut down the middle and seen straight into the cut. The cut faces
  // are hatched; the shading leaves them as they are; with edges on, the
  // line where the peg's cut face meets the block's is drawn, and no line
  // of the half cut away or of the back of the parts shows on a cut face.
  await call("set_model", { script: 'part("Block", box(80, 40, 40).at(0, 0, 20), { color: "#9aa3ad", material: "brushed" });\npart("Peg", cylinder(10, 40).at(0, 0, 60), { color: "#9aa3ad", material: "anodised" });' });
  await call("screenshot", { width: 200, height: 150 });
  const into = (await call("section_view", { axis: "y", offset: 0 })).result?.look_into_it_from;
  await w(`window.__draftsman.fit(${JSON.stringify(into)})`);
  // Each against the same frame without shading or edges.
  const cutLook = await w(`(async () => {
    const read = async (creases, edges) => {
      await window.__draftsman.call("set_look", { edges });
      const c = window.__draftsman.frame({ creases });
      const x = Object.assign(document.createElement("canvas"), { width: c.width, height: c.height }).getContext("2d");
      x.drawImage(c, 0, 0);
      return x.getImageData(0, 0, c.width, c.height);
    };
    const plain = await read(false, false), shaded = await read(true, false), edged = await read(true, true);
    await window.__draftsman.call("set_look", { edges: false });
    const k = plain.width / document.querySelector("#viewport canvas").clientWidth;
    const at = (img, x, y) => { const i = (Math.round(y * k) * img.width + Math.round(x * k)) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
    const dark = (img, x, y) => { const a = at(plain, x, y), b = at(img, x, y); return Math.max(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };
    const B = window.__draftsman.screenPosition("Block"), P = window.__draftsman.screenPosition("Peg");
    const out = {};
    for (const [name, img] of [["shaded", shaded], ["edges", edged]]) {
      // The block's cut face around its middle.
      let most = 0;
      for (let dx = -10; dx <= 10; dx++) for (let dy = -4; dy <= 4; dy++) most = Math.max(most, Math.abs(dark(img, B.x + dx, B.y + dy)));
      // Up from the block's middle to the peg's: where their cut faces meet.
      let line = 0; for (let t = 0; t <= 1; t += 0.005) line = Math.max(line, dark(img, B.x + (P.x - B.x) * t, B.y + (P.y - B.y) * t));
      out[name] = { cutFace: most, meet: line };
    }
    let lo = 255, hi = 0;
    for (let dx = -10; dx <= 10; dx++) for (let dy = -4; dy <= 4; dy++) { const v = at(plain, B.x + dx, B.y + dy)[1]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    out.hatch = hi - lo;
    return out;
  })()`);
  check(into && cutLook.shaded.cutFace <= 1 && cutLook.shaded.meet <= 1, `with a section, the crease shading leaves the flat cut faces as they are (${JSON.stringify(cutLook.shaded)})`);
  check(cutLook.hatch >= 25, `cut faces are hatched over their fill (${cutLook.hatch} levels between hatch and fill)`);
  check(cutLook.edges.cutFace <= 1 && cutLook.edges.meet >= 60, `with edges on, the line where two cut faces meet is drawn, and nothing else on the cut face: no line of the half cut away or of the parts' backs (${JSON.stringify(cutLook.edges)})`);
  await call("clear_view");

  // What the view costs the GPU, counted below three.js on a Retina-sized
  // window, with the rotor head (47 parts that turn). A still view draws
  // nothing. Motion draws at up to 60 frames a second, 30 while another
  // window has focus and none while the page is hidden, in at most three
  // passes (the shadow map, the floor's mirror, the view) within a stated
  // size, the shadow and the mirror from lighter copies of the parts. The
  // shadow map is drawn again when parts change, and left alone while only
  // the view turns.
  const g = await h.openWindow({ scale: 2, preload: STEPPED_FRAMES + GL_COUNTER });
  await h.command(g, "set_model", { script: readFileSync(new URL("./models/claude-rotor-head.js", import.meta.url), "utf8") });
  await h.command(g, "screenshot", { width: 200, height: 150 }); // waits for the fine mesh
  // The page's focus and visibility, set by the test: page(hidden, focused).
  await g(`(() => {
    let hidden = false, focused = true;
    Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible"), configurable: true });
    document.hasFocus = () => focused;
    window.page = (h, f) => { hidden = h; focused = f; document.dispatchEvent(new Event("visibilitychange")); };
  })()`);
  const cost = (js) => g(`(async () => { window.__gl.take(); { ${js}; } const c = window.__gl.take(); const px = document.querySelector("#viewport canvas"); return { ...c, canvas: px.width * px.height }; })()`);
  const perFrame = (c, k) => c[k] / Math.max(c.frames, 1);
  await g(`document.getElementById("play").click(); window.__frames.step(2)`);
  const idle = await cost(`for (let i = 0; i < 5; i++) window.__draftsman.select(null); const c = document.querySelector("#viewport canvas"); for (let i = 0; i < 20; i++) c.dispatchEvent(new PointerEvent("pointermove", { clientX: 300 + i, clientY: 300, bubbles: true })); window.__frames.step(120); await new Promise((r) => setTimeout(r, 2000))`);
  check(idle.draws === 0, `a still view draws nothing in 120 frames, nor in 2 s of timers, hovered and with the app's state re-rendered (${JSON.stringify(idle)})`);
  const shadowDrawn = (c) => c.frames > 0 && c.passes === 3 * c.frames;
  const slid = await cost(`await window.__draftsman.setValue("Collective (mm)", 25); window.__frames.step(2)`);
  await h.command(g, "screenshot", { width: 200, height: 150 });
  await g("window.__frames.step(2)");
  const shotAt = await cost(`await window.__draftsman.call("screenshot", { width: 200, height: 150, at: 0.5 }); window.__gl.take(); window.__frames.step(2)`);
  const pic = await cost(`window.__draftsman.picture({ width: 320 }); window.__gl.take(); window.__frames.step(2)`);
  check(shadowDrawn(slid) && shadowDrawn(shotAt) && shadowDrawn(pic), `while paused, the shadow map is drawn again after a slider change, a screenshot and a picture (${[slid, shotAt, pic].map((c) => `${c.passes} passes in ${c.frames} frames`).join("; ")})`);
  const orbit = await cost(`const c = document.querySelector("#viewport canvas"); const ev = (t, x) => c.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: 300, button: 0, buttons: 1, pointerId: 9, bubbles: true })); ev("pointerdown", 300); for (let i = 1; i <= 6; i++) { ev("pointermove", 300 + i * 10); window.__frames.step(1); } ev("pointerup", 360); window.__frames.step(1)`);
  check(orbit.frames === 7 && orbit.passes === 2 * orbit.frames, `turning the view draws each frame without the shadow map (${orbit.frames} frames, ${orbit.passes} passes)`);
  await g(`document.getElementById("play").click(); window.__frames.step(2)`);
  const at60 = await cost(`window.__frames.step(30)`);
  const at120 = await cost(`window.__frames.step(60, 120)`);
  check(at60.frames >= 29 && at120.frames >= 29 && at120.frames <= 31, `moving parts draw 60 frames a second: every frame at 60 Hz, every other at 120 Hz (${at60.frames} of 30, ${at120.frames} of 60)`);
  check(perFrame(at60, "passes") <= 3 && perFrame(at60, "pixels") <= 2.4 * at60.canvas && perFrame(at60, "samples") <= 6 * at60.canvas, `in at most 3 passes, 2.4 pixels and 6 samples per window pixel (${perFrame(at60, "passes")} passes, ${(perFrame(at60, "pixels") / at60.canvas).toFixed(2)} pixels, ${(perFrame(at60, "samples") / at60.canvas).toFixed(2)} samples)`);
  // The shadow and the mirror are drawn from the parts' lighter copies, so a
  // moving frame draws far fewer triangles than a picture, which draws the
  // full meshes three times over.
  const whole = await cost(`window.__draftsman.picture({ width: 320 })`);
  await g("window.__frames.step(2)");
  check(perFrame(at60, "triangles") < whole.triangles * 0.45, `a moving frame draws ${Math.round(perFrame(at60, "triangles") / 1000)} thousand triangles; a picture, from the full meshes, ${Math.round(whole.triangles / 1000)} thousand`);
  // The lighter copies are never what a click picks.
  const hit = await g(`(() => { window.__draftsman.fit(); const c = document.querySelector("#viewport canvas"), name = window.__draftsman.state().parts[0], p = window.__draftsman.screenPosition(name); const at = { clientX: p.x, clientY: p.y, button: 0, pointerId: 3, bubbles: true }; c.dispatchEvent(new PointerEvent("pointerdown", at)); c.dispatchEvent(new PointerEvent("pointerup", at)); return window.__draftsman.state().selected; })()`);
  check(typeof hit === "string" && hit.length > 0, `a click on a part still picks a part ("${hit}")`);
  await g(`window.__draftsman.select(null); window.__frames.step(2)`);
  const blurred = await cost(`window.page(false, false); window.__frames.step(30); window.__frames.step(60, 120)`);
  check(blurred.frames >= 28 && blurred.frames <= 32, `with another window in focus they draw 30 a second (${blurred.frames} in 30 frames at 60 Hz and 60 at 120 Hz)`);
  const hidden = await cost(`window.page(true, false); window.__frames.step(30)`);
  const shown = await cost(`window.page(false, true); window.__frames.step(30)`);
  check(hidden.draws === 0 && shown.frames >= 29, `a hidden page draws nothing, and motion goes on when it shows (${hidden.draws} draws hidden, ${shown.frames} of 30 frames back)`);

  // A section through the turning rotor head adds no pass, no draw and no
  // triangle to a moving frame: the cut faces are the parts' own insides.
  const uncut = await cost(`window.__frames.step(30)`);
  await h.command(g, "section_view", { axis: "y", offset: 0 });
  await g("window.__frames.step(2)");
  const sectioned = await cost(`window.__frames.step(30)`);
  const per = (c) => ["passes", "draws", "triangles", "pixels", "samples"].map((k) => Math.round(perFrame(c, k))).join(" / ");
  check(sectioned.frames >= 29 && perFrame(sectioned, "passes") === perFrame(uncut, "passes") && perFrame(sectioned, "draws") === perFrame(uncut, "draws") && perFrame(sectioned, "triangles") === perFrame(uncut, "triangles"), `a section costs a moving frame no extra pass, draw or triangle (passes / draws / triangles / pixels / samples per frame: ${per(uncut)} uncut, ${per(sectioned)} cut)`);
  // Hidden parts are not drawn at all.
  await h.command(g, "hide_parts", { hide: ["Blade 1", "Blade 2", "Blade 3", "Blade 4"] });
  await g("window.__frames.step(2)");
  const fewer = await cost(`window.__frames.step(30)`);
  check(perFrame(fewer, "draws") < perFrame(sectioned, "draws") && perFrame(fewer, "triangles") < perFrame(sectioned, "triangles"), `hiding the blades draws less (${per(fewer)})`);
  await h.command(g, "clear_view");

  // Crease shading costs nothing while things move: it is worked out once,
  // when the view has rested, in one step of three passes, then nothing is
  // drawn. A change that leaves the view as it was (a selection) keeps it.
  await g(`document.getElementById("play").click(); window.__frames.step(2)`);
  const quiet = await cost(`window.__frames.step(10)`);
  await sleep(600);
  const rested = await cost(`window.__frames.step(1)`);
  const overlay = () => g(`(() => { const o = document.querySelectorAll("#viewport canvas")[1]; return Boolean(o && !o.hidden && o.width); })()`);
  const shownAfter = await overlay();
  check(quiet.draws === 0 && rested.frames === 1 && rested.passes === 3 && shownAfter, `once the view rests, the crease shading is worked out in one step of 3 passes (${(rested.samples / rested.canvas).toFixed(2)} samples per window pixel, ${Math.round(rested.triangles / 1000)} thousand triangles), not before (${quiet.draws} draws)`);
  const restAfter = await cost(`window.__frames.step(120); await new Promise((r) => setTimeout(r, 2000))`);
  check(restAfter.draws === 0, `after that a still view draws nothing (${JSON.stringify(restAfter)})`);
  const picked2 = await cost(`window.__draftsman.select(window.__draftsman.state().parts[0]); window.__frames.step(2)`);
  check(picked2.frames >= 1 && picked2.passes === 2 * picked2.frames && (await overlay()), `a selection draws the view once and keeps the shading (${picked2.passes} passes in ${picked2.frames} frames)`);
  await g(`window.__draftsman.select(null); window.__frames.step(2)`);
  // Turning the view with the shading on and with it off costs the same.
  const turnFrom = (js) => cost(`window.__draftsman.fit(); ${js}; window.__frames.step(1); window.__gl.take(); const c = document.querySelector("#viewport canvas"); const ev = (t, x) => c.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: 300, button: 0, buttons: 1, pointerId: 9, bubbles: true })); ev("pointerdown", 300); for (let i = 1; i <= 6; i++) { ev("pointermove", 300 + i * 10); window.__frames.step(1); } ev("pointerup", 360); window.__frames.step(1)`);
  const turnOff = await turnFrom(`window.__draftsman.look({ creases: false })`);
  const turnOn = await turnFrom(`window.__draftsman.look({ creases: true })`);
  const sameCost = (a, b) => ["frames", "passes", "draws", "pixels", "samples", "triangles"].every((k) => a[k] === b[k]);
  check(turnOn.frames === 7 && sameCost(turnOff, turnOn) && !(await overlay()), `turning the view costs the same with the shading as without, and hides it (${JSON.stringify(turnOn)})`);
  // Edges: lines beside each part, a few draws more, no pass, sample or triangle more.
  const turnEdges = await turnFrom(`await window.__draftsman.call("set_look", { edges: true })`);
  const remembered = await g(`localStorage.getItem("draftsman:look")`);
  const turnPlain = await turnFrom(`await window.__draftsman.call("set_look", { edges: false })`);
  const partCount = (await g("window.__draftsman.state().parts")).length;
  check(turnEdges.passes === turnOn.passes && turnEdges.samples === turnOn.samples && turnEdges.triangles === turnOn.triangles && turnEdges.draws > turnOn.draws && turnEdges.draws <= turnOn.draws + turnOn.frames * partCount, `edges on adds lines (${turnEdges.draws - turnOn.draws} draws more in ${turnOn.frames} frames) and no pass, sample or triangle`);
  check(sameCost(turnPlain, turnOn) && /"edges":false/.test(await g(`localStorage.getItem("draftsman:look")`)) && /"edges":true/.test(remembered), `edges off takes them away again, and the choice is remembered (${remembered})`);
  // Exploding: while the parts move the shading is gone and each frame is a
  // plain one; once they rest it is worked out again for where they are.
  await g("window.__frames.step(2)");
  await sleep(600);
  await g("window.__frames.step(1)");
  const shadeImage = () => g(`(() => { const o = document.querySelectorAll("#viewport canvas")[1]; return o.hidden ? null : o.toDataURL(); })()`);
  const beforeExplode = await shadeImage();
  await h.command(g, "explode_view", { factor: 1, axis: "z" });
  const exploding = await cost(`for (let i = 0; i < 8; i++) { window.__frames.step(1); await new Promise((r) => setTimeout(r, 20)); }`);
  const hiddenWhileMoving = (await shadeImage()) === null;
  for (let i = 0; i < 100 && (await g("window.__draftsman.exploding()")); i++) await g("window.__frames.step(1); new Promise((r) => setTimeout(r, 50))");
  await g("window.__frames.step(2)");
  await sleep(600);
  const reshaded = await cost(`window.__frames.step(1)`);
  const afterExplode = await shadeImage();
  check(beforeExplode && hiddenWhileMoving && exploding.frames > 0 && exploding.passes <= 3 * exploding.frames && exploding.passes >= 2 * exploding.frames, `while an exploded view moves the shading is hidden and frames are plain (${exploding.passes} passes in ${exploding.frames} frames)`);
  check(reshaded.passes === 3 && afterExplode && afterExplode !== beforeExplode, `when it stops, the shading is worked out again for the parts where they now are (${reshaded.passes} passes)`);
  await h.command(g, "clear_view");
  await g("window.__frames.step(2)");

  // An empty window offers the examples; one click opens a ready model
  // without Claude, loaded only then, with a clean undo history and two
  // prompts to try. They go when a model is there, or as soon as you type.
  const { EXAMPLES } = await import("../src/examples/list.js");
  const e = await h.openWindow({ preload: `localStorage.removeItem("draftsman:autosave")` });
  const startShown = async () => !(await e('document.getElementById("start").hidden'));
  const offered = await e(`[...document.querySelectorAll("#ideas [data-example]")].map((b) => b.dataset.example)`);
  check((await startShown()) && offered.join() === EXAMPLES.map((x) => x.id).join() && offered.length >= 4, `an empty window offers ${offered.length} examples (${offered.join(", ")})`);
  const pics = await e(`Promise.all([...document.querySelectorAll("#ideas img")].map((i) => i.decode().then(() => i.naturalWidth + "x" + i.naturalHeight, () => "broken")))`);
  check(pics.length === EXAMPLES.length && pics.every((p) => p === "80x56"), `each has its picture (${pics.join(", ")})`);
  const type = (text) => e(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); })()`);
  await type("a lamp");
  const hiddenWhileTyping = !(await startShown());
  await type("");
  check(hiddenWhileTyping && (await startShown()), "they go as soon as you type, and come back when the box is empty again");
  const fetched = (id) => e(`performance.getEntriesByType("resource").some((r) => r.name.includes("/examples/${id}.js"))`);
  check(!(await fetched("mug")), "no example script is loaded before one is chosen");
  const openExample = async (id) => {
    await e(`document.querySelector('#ideas [data-example="${id}"]').click()`);
    for (let i = 0; i < 300 && !(await e("window.__draftsman.state().parts.length")); i++) await sleep(100);
    return e("window.__draftsman.state()");
  };
  const mug = await openExample("mug");
  check(mug.title === "Coffee mug" && mug.parts.join() === "Mug,Handle,Coaster" && (await fetched("mug")), `the mug opens with its parts (${mug.parts.join(", ")}), its script loaded only now`);
  check(!(await startShown()), "the examples are gone once a model is there");
  check(JSON.stringify(await e("window.__draftsman.history()")) === '{"undo":0,"redo":0}', "undo history starts clean");
  check((await e('document.getElementById("input").placeholder')) === "Try “make it 120 mm tall” or “write COFFEE around the side”", "the prompt box suggests two prompts to try");
  // It is a normal document: sliders, undo, and the suggestion lasts as long as the script is the example's.
  await e(`window.__draftsman.setValue("Mug / Height", 120)`);
  const tall = await e("window.__draftsman.summary()");
  check(Math.abs(tall.overall.size[2] - 127) < 1.5 && JSON.stringify(await e("window.__draftsman.history()")) === '{"undo":1,"redo":0}', `its Height slider makes it 120 mm tall (${tall.overall.size[2]} mm with the coaster and lip) and can be undone`);
  await e(`(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })); })()`);
  for (let i = 0; i < 100 && (await e("window.__draftsman.history().undo")); i++) await sleep(100);
  check(JSON.stringify(await e("window.__draftsman.history()")) === '{"undo":0,"redo":1}' && !(await startShown()), "undo goes back to the example as it opened, not to an empty window");
  // New brings the examples back; the biggest opens with every part.
  await e(`document.querySelector('[data-action="new"]').click()`);
  for (let i = 0; i < 100 && (await e("window.__draftsman.state().parts.length")); i++) await sleep(100);
  check(await startShown(), "New brings the examples back");
  for (const id of ["bracket", "rotor-head", "helicopter"]) {
    await e(`document.querySelector('[data-action="new"]').click()`);
    for (let i = 0; i < 100 && (await e("window.__draftsman.state().parts.length")); i++) await sleep(100);
    const t = Date.now();
    const s = await openExample(id);
    const want = EXAMPLES.find((x) => x.id === id);
    check(s.parts.length === want.parts && s.title, `the ${want.name.toLowerCase()} opens with ${s.parts.length} parts in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    if (id !== "bracket") continue;
    const fit = await h.command(e, "check_fit");
    check(fit.result?.overlaps.length === 0, `the bracket's bolts, washers and nuts fit without overlaps (${fit.result?.checked_pairs} pairs checked)`);
  }
} catch (err) {
  fail(String(err.message ?? err));
  console.error(err);
} finally {
  await h.close();
}
process.exit(done());
