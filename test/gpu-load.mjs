// Measures what the view really costs this Mac's GPU. Not part of `npm test`:
// it needs Apple silicon, and its numbers depend on the machine.
//
//   node test/gpu-load.mjs                        the rotor head, every case
//   node test/gpu-load.mjs model.js --seconds 12  another script, longer runs
//   node test/gpu-load.mjs --rounds 5             more rounds (3 unless said)
//   node test/gpu-load.mjs --root ../other        the app from another checkout
//   node test/gpu-load.mjs --window               in a real window (the screen must be awake)
//   node test/gpu-load.mjs --json out.json        also save the numbers
//
// It opens the app in Chrome with hardware WebGL (the tests use software GL,
// which cannot say anything about the GPU) and runs each case two ways, in
// several rounds. It prints the middle value of the rounds, and for power
// the lowest and highest too, because other apps share the GPU.
//
// At the screen's pace, as you would use it: the GPU's power in watts, from
// the energy counters macOS keeps (the whole machine's, so the still case is
// the floor to compare against), the frames drawn, and how long the GPU was
// busy for this Chrome per second, which is the figure Activity Monitor
// shows. That last one says little about the work done: a lightly loaded GPU
// slows its clock until it is busy most of the time anyway.
//
// Flat out: frames drawn back to back, which keeps the GPU at full speed.
// Frames per second measured this way is how much work a frame is, the
// page's and Chrome's share included, and is the steadiest figure here. GPU
// time per frame is the GPU's share of it.
import { createServer } from "vite";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GL_COUNTER, sleep } from "./harness.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const valued = new Set(["--seconds", "--rounds", "--json", "--root", "--only", "--size"]);
const modelPath = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1])) ?? new URL("./models/claude-rotor-head.js", import.meta.url).pathname;
const seconds = Number(value("--seconds", 6));
const rounds = Number(value("--rounds", 3));
const root = resolve(value("--root", new URL("..", import.meta.url).pathname));
const only = value("--only", "");
const [W, H] = value("--size", "1512x982").split("x").map(Number);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5183;

// GPU time used so far by a process, in ms, from the GPU driver's own
// per-client accounting.
function gpuMs(pid) {
  const out = execFileSync("ioreg", ["-r", "-c", "IOGPUDeviceUserClient", "-w", "0"], { encoding: "utf8", maxBuffer: 64 << 20 });
  // One block per client of the GPU; its fields come in no fixed order.
  let total = 0;
  for (const block of out.split("+-o ")) {
    if (Number(block.match(/"IOUserClientCreator" = "pid (\d+),/)?.[1]) !== pid) continue;
    for (const m of block.matchAll(/"accumulatedGPUTime"=(\d+)/g)) total += Number(m[1]) / 1e6;
  }
  return total;
}
// The GPU's power in watts while fn runs, from test/gpu-power.c, built on
// first use. NaN where it cannot be built or read.
const powerTool = join(tmpdir(), "draftsman-gpu-power");
let canReadPower = true;
try {
  execFileSync("clang", ["-O1", "-o", powerTool, new URL("./gpu-power.c", import.meta.url).pathname, "-framework", "CoreFoundation"], { stdio: "pipe" });
  execFileSync(powerTool, ["0.05", "1"], { stdio: "pipe" });
} catch {
  canReadPower = false;
}
async function watts(fn) {
  if (!canReadPower) return { result: await fn(), gpuWatts: NaN };
  const reader = spawn(powerTool, ["0.25"], { stdio: ["ignore", "pipe", "ignore"] });
  const lines = [];
  reader.stdout.on("data", (d) => lines.push(...String(d).trim().split("\n")));
  const result = await fn();
  reader.kill();
  const gpu = lines.map((l) => Number(l.split(" ")[0])).filter(Number.isFinite);
  return { result, gpuWatts: gpu.reduce((a, b) => a + b, 0) / Math.max(gpu.length, 1) };
}
const rssMb = (pid) => {
  try { return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024; } catch { return NaN; }
};

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error("This reads GPU time from Apple's GPU driver, so it needs a Mac with Apple silicon.");
  process.exit(2);
}

// A preload script. window.__flatOut(ms, each) takes animation frames off the
// screen's clock for ms and runs them back to back, and returns how many it
// ran. A busy GPU runs at its full clock speed; at 60 frames a second it
// slows its clock and the same frame takes it longer.
const FLAT_OUT = `(() => {
  const real = window.requestAnimationFrame.bind(window);
  let flat = false, queue = [], id = 0, now = 0;
  window.requestAnimationFrame = (cb) => (flat ? (queue.push(cb), ++id) : real(cb));
  window.__flatOut = async (ms, each = () => {}) => {
    const gl = document.querySelector("#viewport canvas").getContext("webgl2"), px = new Uint8Array(4);
    flat = true; now = performance.now();
    const end = now + ms;
    let n = 0, empty = 0;
    while (performance.now() < end && empty < 5) {
      each();
      // A frame asked for before the switch is still on the screen's clock.
      if (!queue.length) { empty++; await new Promise((r) => real(r)); continue; }
      empty = 0;
      now += 1000 / 60;
      const run = queue; queue = [];
      for (const cb of run) cb(now);
      // Wait for the GPU every eighth frame: often enough that frames do not
      // pile up, seldom enough that it always has the next one to draw.
      if (++n % 8 === 0) { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); await new Promise((r) => setTimeout(r, 0)); }
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    window.__flatSeconds = (performance.now() - (end - ms)) / 1000;
    // The frames were told a clock that ran ahead of the real one. Let the
    // real one catch up, or the app would think its last frame is still in
    // the future and draw nothing for a while.
    await new Promise((r) => setTimeout(r, Math.max(0, now - performance.now()) + 50));
    flat = false;
    for (const cb of queue) real(cb);
    queue = [];
    return n;
  };
})()`;

const vite = await createServer({ root, configFile: join(root, "vite.config.js"), server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: "warn" });
await vite.listen();
const profile = mkdtempSync(join(tmpdir(), "draftsman-gpu-"));
const chrome = spawn(
  CHROME,
  [
    ...(flag("--window") ? [] : ["--headless=new"]),
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist",
    // A window nobody is looking at must keep drawing as if they were.
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    `--window-size=${W},${H}`, "--force-device-scale-factor=2", "about:blank",
  ],
  { stdio: "ignore" },
);
const stop = async () => {
  chrome.kill();
  await vite.close();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a leftover temp folder is harmless */ }
};
process.on("exit", () => chrome.kill());

try {
  const portFile = join(profile, "DevToolsActivePort");
  const portLines = () => (existsSync(portFile) ? readFileSync(portFile, "utf8").trim().split("\n") : []);
  for (let i = 0; i < 150 && portLines().length < 2; i++) await sleep(100);
  const [cdpPort, cdpPath] = portLines();
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
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++seq; waiting.set(id, { ok, fail }); cdp.send(JSON.stringify({ id, method, params, sessionId })); });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  // The page's focus is set by this script, so a case does not depend on
  // which window the Mac happens to have in front.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `${FLAT_OUT}; ${GL_COUNTER}; window.__focused = true; document.hasFocus = () => window.__focused;` }, sessionId);
  await send("Page.navigate", { url: `http://localhost:${PORT}/` }, sessionId);
  const page = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 200 && !(await page("Boolean(window.__draftsman)").catch(() => false)); i++) await sleep(100);

  const gpuPid = Number(execFileSync("pgrep", ["-f", `type=gpu-process.*${profile}`], { encoding: "utf8" }).trim().split("\n")[0]);
  // The page's own process is the renderer that has used the most CPU.
  const pagePid = (await send("SystemInfo.getProcessInfo")).processInfo.filter((p) => p.type === "renderer").sort((a, b) => b.cpuTime - a.cpuTime)[0]?.id;

  await page(`window.__draftsman.call("set_model", { script: ${JSON.stringify(readFileSync(modelPath, "utf8"))} }).then(() => true)`);
  await page(`window.__draftsman.call("screenshot", { width: 200, height: 150 }).then(() => true)`); // waits for the fine mesh
  const about = await page(`(() => {
    const c = document.querySelector("#viewport canvas"), gl = c.getContext("webgl2");
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return { gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), canvas: [c.width, c.height], samples: gl.getParameter(gl.SAMPLES), ratio: devicePixelRatio, parts: window.__draftsman.state().parts.length, motion: !document.getElementById("play").hidden };
  })()`);
  if (/swiftshader|llvmpipe|software/i.test(about.gpu)) throw new Error(`Chrome is drawing in software (${about.gpu}), so there is no GPU load to read.`);
  const setPlaying = (on) => page(`(() => { const b = document.getElementById("play"); if ((b.textContent === "Pause") !== ${on}) b.click(); return true; })()`);

  // One case: get into the state and let it settle. Then read the GPU's
  // power, its time for this Chrome and the page's own frame counts across
  // `seconds` of it at the screen's pace, and GPU time and frames across
  // three shorter spans flat out, of which the middle one counts.
  async function run(name, { playing, focused = true, turning = false }) {
    await setPlaying(playing);
    await page(`window.__focused = ${focused}; true`);
    await sleep(1500);
    const span = async (js) => {
      await page("window.__gl.take(); true");
      const g0 = gpuMs(gpuPid), t0 = performance.now();
      const { gpuWatts } = await watts(() => page(`(async () => { ${js} })().then(() => true)`));
      const wall = (performance.now() - t0) / 1000;
      await sleep(150); // the driver books a frame's time when it is done
      const g1 = gpuMs(gpuPid);
      const c = await page("window.__gl.take()");
      return { gpuMs: g1 - g0, wall, gpuWatts, flatSeconds: await page("window.__flatSeconds"), ...c };
    };
    const ms = seconds * 1000;
    const paced = await span(turning ? `${TURN} const until = performance.now() + ${ms}; down(); while (performance.now() < until) { await new Promise((r) => requestAnimationFrame(r)); move(); } up();` : `await new Promise((r) => setTimeout(r, ${ms}));`);
    let flat = paced;
    if (paced.frames) {
      const spans = [];
      for (let i = 0; i < 3; i++) spans.push(await span(turning ? `${TURN} down(); await window.__flatOut(${ms / 3}, move); up();` : `await window.__flatOut(${ms / 3});`));
      flat = spans.sort((a, b) => a.gpuMs / a.frames - b.gpuMs / b.frames)[1];
    }
    const per = (v) => (flat.frames ? v / flat.frames : 0);
    return {
      name,
      // at the screen's pace
      gpuWatts: paced.gpuWatts,
      gpuMsPerSecond: paced.gpuMs / paced.wall,
      framesPerSecond: paced.frames / paced.wall,
      // flat out
      gpuMsPerFrame: per(flat.gpuMs),
      fastestFramesPerSecond: flat === paced ? 0 : flat.frames / flat.flatSeconds,
      passesPerFrame: per(flat.passes),
      megasamplesPerFrame: per(flat.samples) / 1e6,
      trianglesPerFrame: per(flat.triangles ?? 0),
    };
  }
  // Drags across the view, one step a frame, as a hand turning the model does.
  const TURN = `const c = document.querySelector("#viewport canvas");
    const ev = (t, x) => c.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: 300, button: 0, buttons: 1, pointerId: 9, bubbles: true }));
    let x = 300, step = 4;
    const down = () => ev("pointerdown", x), up = () => ev("pointerup", x);
    const move = () => { x += step; if (x > 700 || x < 300) step = -step; ev("pointermove", x); };`;

  const cases = [
    ["still", { playing: false }],
    ["turning the view", { playing: false, turning: true }],
    ...(about.motion ? [
      ["parts moving", { playing: true }],
      ["parts moving, window not in front", { playing: true, focused: false }],
      ["parts moving and turning", { playing: true, turning: true }],
    ] : []),
  ].filter(([name]) => !only || name.includes(only));

  console.log(`${about.gpu}`);
  console.log(`${about.parts} parts, canvas ${about.canvas.join(" x ")} px, ${about.samples}x multisampling, ${flag("--window") ? "in a window" : "headless (60 Hz)"}, ${rounds} rounds of ${seconds} s a case\n`);
  // The cases take turns, round after round, so a busy spell on the machine
  // does not fall on one of them alone.
  const all = cases.map(() => []);
  for (let r = 0; r < rounds; r++) for (const [i, [name, c]] of cases.entries()) all[i].push(await run(name, c));
  const middle = (list) => list.slice().sort((a, b) => a - b)[Math.floor((list.length - 1) / 2)];
  const results = all.map((runs) => {
    const out = { name: runs[0].name, gpuWattsLow: Math.min(...runs.map((x) => x.gpuWatts)), gpuWattsHigh: Math.max(...runs.map((x) => x.gpuWatts)) };
    for (const k of Object.keys(runs[0])) if (k !== "name") out[k] = middle(runs.map((x) => x[k]));
    return out;
  });
  const memory = { gpuProcessMb: rssMb(gpuPid), pageMb: pagePid ? rssMb(pagePid) : NaN };

  const pad = (s, n) => String(s).padEnd(n), num = (v, d = 1, n = 10) => v.toFixed(d).padStart(n);
  console.log(`${pad("", 36)}${pad("  at the screen's pace", 46)}  flat out`);
  console.log(`${pad("case", 36)}${"GPU W".padStart(10)}${"(low-high)".padStart(14)}${"frames/s".padStart(10)}${"busy ms/s".padStart(10)}${"ms/frame".padStart(10)}${"frames/s".padStart(10)}${"passes".padStart(8)}${"Msamples".padStart(10)}${"k tris".padStart(8)}`);
  for (const r of results) console.log(`${pad(r.name, 36)}${num(r.gpuWatts, 2)}${`(${r.gpuWattsLow.toFixed(2)}-${r.gpuWattsHigh.toFixed(2)})`.padStart(14)}${num(r.framesPerSecond)}${num(r.gpuMsPerSecond, 0)}${num(r.gpuMsPerFrame, 2)}${num(r.fastestFramesPerSecond, 0)}${num(r.passesPerFrame, 1, 8)}${num(r.megasamplesPerFrame)}${num(r.trianglesPerFrame / 1000, 0, 8)}`);
  console.log(`\nmemory: GPU process ${memory.gpuProcessMb.toFixed(0)} MB, page ${memory.pageMb.toFixed(0)} MB`);
  if (value("--json")) writeFileSync(value("--json"), JSON.stringify({ about, seconds, rounds, results, memory }, null, 2));
} catch (err) {
  console.error(String(err.message ?? err));
  process.exitCode = 1;
} finally {
  await stop();
}
process.exit(process.exitCode ?? 0);
