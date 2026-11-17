// The MCP server with no app window open: it builds the model itself, in
// Node, and writes its files; tools that draw answer at once that they need
// the app; a window that connects gets every call, as before.
// The server's bridge is on a port of its own (DRAFTSMAN_BRIDGE_PORT=0), so
// it can never reach a Draftsman window open on this machine.
// Usage: node test/headless.test.mjs [server.mjs] (needs neither the app nor
// Claude). Give dist-mcp/server.mjs after npm run build to test the bundled
// server the desktop app carries.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runScript } from "../src/kernel/script.js";
import { measureJob } from "../src/kernel/measure.js";
import { checkStep } from "./check-step.mjs";
import { checks } from "./harness.mjs";

const root = new URL("..", import.meta.url).pathname;
const out = `${root}runs/headless-test`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const bracket = readFileSync(`${root}test/models/bracket.js`, "utf8");
const { check, done } = checks();

// The kernel's own figures for the bracket: each part's exact volume, from
// its distance function (good to about 0.1%).
const exact = Object.fromEntries(runScript(bracket).parts.map((p) => [p.name, measureJob({ what: "solid", node: p.node }).volume / 1000]));
const exactTotal = Object.values(exact).reduce((a, b) => a + b, 0);
const near = (a, b, share) => Math.abs(a - b) <= share * Math.abs(b);

const transport = new StdioClientTransport({ command: process.execPath, args: [process.argv[2] ?? `${root}mcp/server.mjs`], env: { ...process.env, DRAFTSMAN_BRIDGE_PORT: "0" }, stderr: "pipe" });
let stderr = "";
const port = new Promise((resolve) => {
  transport.stderr.on("data", (d) => {
    stderr += d;
    const m = stderr.match(/bridge listening on 127\.0\.0\.1:(\d+)/);
    if (m) resolve(Number(m[1]));
  });
});
const client = new Client({ name: "headless-test", version: "1" });
await client.connect(transport);
const bridgePort = await port;
check(bridgePort < 7457 || bridgePort > 7466, `the bridge is on a port of its own (${bridgePort}), not one app windows look on`);

const text = (r) => r.content.map((c) => c.text ?? "").join("\n");
const timed = async (name, args = {}) => {
  const t = performance.now();
  const r = await client.callTool({ name, arguments: args });
  return { r, ms: Math.round(performance.now() - t), data: r.isError ? null : (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() };
};

try {
  // The first call waits for a window for 8 s after the server started; later ones do not.
  const first = await timed("get_model");
  check(!first.r.isError && first.data?.script === "" && first.data.parts.length === 0, `get_model with no window: an empty model (${first.ms} ms, waiting for a window once)`);

  const set = await timed("set_model", { script: bracket });
  const parts = Object.fromEntries((set.data?.parts ?? []).map((p) => [p.name, p]));
  console.log(`  set_model: ${JSON.stringify(set.data)}`);
  check(!set.r.isError && set.data.title === "Angle bracket", `set_model builds the bracket with no window (${set.ms} ms)`);
  check(String(parts.Bracket?.size) === "120,80,70" && String(parts.Bush?.size) === "28,28,16", `sizes as the script makes them: Bracket ${parts.Bracket?.size}, Bush ${parts.Bush?.size}`);
  for (const [name, v] of Object.entries(exact)) check(near(parts[name]?.volume_cm3, v, 0.01), `${name}: volume ${parts[name]?.volume_cm3} cm3 against the kernel's exact ${v.toFixed(2)} cm3 (within 1%)`);

  const again = await timed("get_model");
  check(again.data?.script === bracket && again.ms < 1000, `get_model returns the script, without waiting again (${again.ms} ms)`);

  const broken = await timed("set_model", { script: "const a = 1;\n\nnope();" });
  check(broken.r.isError && /^Line 3: nope is not defined/.test(text(broken.r)) && /not changed/.test(text(broken.r)), `a script error comes back with its line: ${JSON.stringify(text(broken.r))}`);
  check((await timed("get_model")).data?.parts.length === 2, "and the model is left as it was");

  const edited = await timed("edit_model", { old_text: "cylinder(14, 16)", new_text: "cylinder(15, 16)" });
  check(String(edited.data?.parts.find((p) => p.name === "Bush")?.size) === "30,30,16", "edit_model rebuilds it");
  await timed("set_model", { script: bracket });

  const m = await timed("measure", { part: "Bracket", material: "aluminium" });
  const mb = m.data?.parts?.[0];
  check(near(mb?.volume_cm3, exact.Bracket, 0.002) && mb.mass_g > 0, `measure: Bracket ${mb?.volume_cm3} cm3, ${mb?.mass_g} g of aluminium (${m.ms} ms)`);

  const fit = await timed("check_fit");
  check(fit.data?.checked_pairs >= 1 && fit.data.overlaps.length === 0, `check_fit: ${fit.data?.checked_pairs} pair checked, no overlaps (${fit.ms} ms)`);

  // Files, read back with the repo's own checkers.
  const stl = await timed("export_stl", { path: `${out}/bracket.stl` });
  let stlOut = "";
  try {
    stlOut = execFileSync(process.execPath, [`${root}test/check-stl.mjs`, stl.data.path], { encoding: "utf8" });
  } catch (err) {
    stlOut = String(err.stdout ?? err);
  }
  const stlVolume = Number(/volume ([\d.]+) cm3/.exec(stlOut)?.[1]);
  check(/valid, closed mesh/.test(stlOut), `export_stl writes a closed STL (${stl.data?.triangles} triangles, ${stl.ms} ms)`);
  check(near(stlVolume, exactTotal, 0.02), `the STL holds ${stlVolume} cm3, against the kernel's exact ${exactTotal.toFixed(2)} cm3 (within 2%)`);

  const step = await timed("export_step", { path: `${out}/bracket.step` });
  const sr = checkStep(readFileSync(step.data.path, "latin1"));
  const stepVolume = sr.parts.reduce((s, p) => s + p.volume, 0) / 1000;
  check(sr.problems.length === 0 && sr.parts.length === 2, `export_step writes a valid STEP of 2 closed solids (${step.ms} ms)${sr.problems.length ? `: ${sr.problems.slice(0, 3)}` : ""}`);
  check(near(stepVolume, exactTotal, 0.01), `the STEP holds ${stepVolume.toFixed(2)} cm3 (exact: ${step.data.exact_parts?.join(", ") || "none"}), against ${exactTotal.toFixed(2)} cm3 (within 1%)`);

  const drawing = await timed("export_drawing", { path: `${out}/bracket.svg` });
  check(!drawing.r.isError && /<svg/.test(readFileSync(drawing.data.path, "utf8")) && /^Drawing /.test(drawing.data.line), `export_drawing writes the sheet (${drawing.data?.scale}, ${drawing.ms} ms)`);

  // Tools that draw say so at once.
  for (const name of ["screenshot", "save_picture", "set_camera"]) {
    const v = await timed(name, name === "save_picture" ? { path: `${out}/no.png` } : {});
    check(v.r.isError && text(v.r).startsWith(`${name} needs the Draftsman app open`) && v.ms < 500, `${name} answers that it needs the app, in ${v.ms} ms`);
  }

  // A script reaches no more of Node than of a web worker.
  const reach = await timed("set_model", { script: 'print(typeof process, typeof Buffer, typeof global, typeof fetch);\npart("A", box(10, 10, 10));' });
  check(String(reach.data?.printed) === "undefined undefined undefined undefined", `a script cannot reach process, Buffer, global or fetch: ${reach.data?.printed}`);
  const imp = await timed("set_model", { script: 'import("node:fs");\npart("A", box(10, 10, 10));' });
  check(imp.r.isError && /cannot import/.test(text(imp.r)), "nor import modules");

  // A window that connects gets the calls, and keeps its own model.
  const seen = [];
  const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}`, { origin: "http://localhost:5173" });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    seen.push(msg.method);
    ws.send(JSON.stringify({ id: msg.id, result: { script: "the window's script" } }));
  });
  await new Promise((ok, fail) => (ws.on("open", ok), ws.on("error", fail)));
  ws.send(JSON.stringify({ type: "hello", app: "draftsman", version: 3, window: "test-window" }));
  await new Promise((r) => setTimeout(r, 150));
  const fwd = await timed("get_model");
  check(fwd.data?.script === "the window's script" && seen.includes("get_model"), `with a window connected, get_model goes to it (${fwd.ms} ms)`);
  const shot = await timed("set_model", { script: bracket });
  check(seen.includes("set_model"), "and so does set_model: nothing runs in the server");
  void shot;
  ws.close();
  await new Promise((r) => setTimeout(r, 150));
  // Once it has gone, a call waits for it (it may be reloading), then the
  // server's own model is used again: an empty one, not the one from before.
  const after = await timed("get_model");
  check(after.data?.script === "" && after.ms > 7000 && after.ms < 9500, `after the window goes, a call waits for it once (${after.ms} ms), then works without it, from an empty model`);
  const after2 = await timed("get_model");
  check(after2.ms < 1000, `and the next call does not wait (${after2.ms} ms)`);
} finally {
  await client.close();
}
process.exit(done());
