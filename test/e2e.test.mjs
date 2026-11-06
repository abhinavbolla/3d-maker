// End to end through the real prompt box, with your real Claude Code.
// Starts the app's dev server on its own port, opens two windows in headless
// Chrome, types two prompts into the first window, and checks what actually
// happened instead of trusting Claude's reply:
//   - the model in the window that asked has the part it asked for, at the
//     size it asked for (measured from the mesh), with the hole (from volume)
//   - the follow-up with a part selected changed that part, in the same chat
//   - the exported STL is a closed mesh
//   - the other window was not touched
// Uses your Claude plan (two short prompts, usually 1-3 minutes).
// Usage: npm run test:e2e   (needs Google Chrome; stop nothing, it uses port 5178)
import { createServer } from "vite";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const PORT = 5178;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_TIMEOUT_MS = 6 * 60 * 1000;
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- dev server and Chrome ----
const vite = await createServer({ root, configFile: join(root, "vite.config.js"), server: { port: PORT, strictPort: true }, logLevel: "warn" });
await vite.listen();
const profile = mkdtempSync(join(tmpdir(), "3d-maker-e2e-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([exited, sleep(5000)]);
  await vite.close();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A leftover temp folder is not a test failure.
  }
}
process.on("exit", () => chrome.kill());

const portFile = join(profile, "DevToolsActivePort");
for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
const [cdpPort, cdpPath] = readFileSync(portFile, "utf8").trim().split("\n");
const cdp = new WebSocket(`ws://127.0.0.1:${cdpPort}${cdpPath}`);
await new Promise((ok, fail) => ((cdp.onopen = ok), (cdp.onerror = fail)));
let seq = 0;
const waiting = new Map();
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  m.error ? w.fail(new Error(m.error.message)) : w.ok(m.result);
};
const send = (method, params = {}, sessionId) =>
  new Promise((ok, fail) => {
    const id = ++seq;
    waiting.set(id, { ok, fail });
    cdp.send(JSON.stringify({ id, method, params, sessionId }));
  });

async function openWindow() {
  const { targetId } = await send("Target.createTarget", { url: `http://localhost:${PORT}/` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 200; i++) {
    if (await evaluate("Boolean(window.__3dmaker)").catch(() => false)) return evaluate;
    await sleep(100);
  }
  throw new Error("The app did not start in Chrome.");
}

async function prompt(win, text) {
  await win(`document.getElementById("input").value = ${JSON.stringify(text)}; document.getElementById("prompt").requestSubmit(); true`);
  const end = Date.now() + RUN_TIMEOUT_MS;
  await sleep(500);
  while (await win("window.__3dmaker.busy()")) {
    if (Date.now() > end) throw new Error(`Claude did not finish within ${RUN_TIMEOUT_MS / 60000} minutes.`);
    await sleep(1000);
  }
  return win("window.__3dmaker.reply()");
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const failures = [];
const check = (ok, what) => {
  log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

try {
  const a = await openWindow();
  const b = await openWindow();
  const bBefore = await b("window.__3dmaker.state().script");

  // ---- 1: make something with a known size and volume ----
  log("prompt 1 (window A)…");
  const t1 = Date.now();
  const r1 = await prompt(a, 'Make one part named "Block": a 30 mm cube sitting on the ground, with a 10 mm diameter hole straight through it from top to bottom. Nothing else.');
  log(`  Claude (${Math.round((Date.now() - t1) / 1000)} s): ${r1.text}`);
  log(`  receipt: ${JSON.stringify(r1.receipt)}`);
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

  // ---- 2: follow-up with the part selected ----
  const session = await a("window.__3dmaker.state().session");
  check(Boolean(session), "the model remembers its Claude chat, so follow-ups continue it");
  log("prompt 2 (window A, Block selected)…");
  await a('window.__3dmaker.select("Block")');
  const t2 = Date.now();
  const r2 = await prompt(a, "Make this 50 mm wide along X. Keep the height, depth and the hole.");
  log(`  Claude (${Math.round((Date.now() - t2) / 1000)} s): ${r2.text}`);
  log(`  receipt: ${JSON.stringify(r2.receipt)}`);
  check(r2.receipt?.changed === true, "the follow-up changed the model");
  s = await a("window.__3dmaker.summary()");
  block = s.parts.find((p) => p.name === "Block");
  if (block?.size) {
    check(near(block.size[0], 50, 1) && near(block.size[1], 30, 1) && near(block.size[2], 30, 1), `Block is now 50 x 30 x 30 mm (got ${block.size.join(" x ")})`);
    const expected = 45 - (Math.PI * 25 * 30) / 1000;
    check(near(block.volume_cm3, expected, expected * 0.04), `the hole is still there: ${block.volume_cm3} cm3, expected ${expected.toFixed(1)}`);
  } else check(false, 'part "Block" still exists');

  // ---- 3: export ----
  const stl = await a("window.__3dmaker.exportSTL()");
  const stlPath = join(profile, "e2e.stl");
  writeFileSync(stlPath, Buffer.from(stl.base64, "base64"));
  let closed = true;
  try {
    execFileSync(process.execPath, [join(root, "test/check-stl.mjs"), stlPath], { stdio: "pipe" });
  } catch {
    closed = false;
  }
  check(closed, `exported STL is a closed mesh (${stl.triangles} triangles)`);

  // ---- 4: the other window ----
  check((await b("window.__3dmaker.state().script")) === bBefore, "window B, open the whole time, was not changed");
} catch (err) {
  failures.push(String(err.message ?? err));
  console.error(err);
} finally {
  await cleanup();
}
log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
