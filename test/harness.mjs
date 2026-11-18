// Runs the app's dev server on its own port and opens app windows in headless
// Chrome, driven over the DevTools protocol. Used by the app and e2e tests.
import { createServer } from "vite";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const root = new URL("..", import.meta.url).pathname;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Tests draw in software, the same on every machine. HARNESS_GL=metal draws
// on the Mac's GPU instead, for full-size pictures and videos made by hand.
const GL = process.env.HARNESS_GL === "metal" ? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

// Live reload is off, so editing the app's code while a test runs cannot
// reload a window and lose a Claude run.
export async function startHarness({ port = 5178 } = {}) {
  port = Number(process.env.TEST_PORT) || port;
  const vite = await createServer({ root, configFile: join(root, "vite.config.js"), server: { port, strictPort: true, hmr: false, watch: null }, logLevel: "warn" });
  await vite.listen();
  const profile = mkdtempSync(join(tmpdir(), "draftsman-test-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", ...GL, "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  process.on("exit", () => chrome.kill());

  const portFile = join(profile, "DevToolsActivePort");
  // Chrome creates the file before it writes it, so wait for both lines.
  const portLines = () => (existsSync(portFile) ? readFileSync(portFile, "utf8").trim().split("\n") : []);
  const ready = () => { const [port, path] = portLines(); return /^\d+$/.test(port ?? "") && /^\/devtools\/browser\/\S+$/.test(path ?? ""); };
  for (let i = 0; i < 150 && !ready(); i++) await sleep(100);
  if (!ready()) throw new Error(`Chrome did not start: ${JSON.stringify(portLines())}`);
  const [cdpPort, cdpPath] = portLines();
  const cdp = new WebSocket(`ws://127.0.0.1:${cdpPort}${cdpPath}`);
  await new Promise((ok, fail) => ((cdp.onopen = ok), (cdp.onerror = fail)));
  let seq = 0;
  const waiting = new Map();
  const listeners = new Map(); // sessionId -> (method, params) => void
  cdp.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method) return listeners.get(m.sessionId)?.(m.method, m.params);
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

  // Opens a fresh app window; returns evaluate(expression) for it.
  // scale: device pixels per CSS pixel, 2 for a Retina screen. preload: a
  // script run in the page before the app's own.
  async function openWindow({ scale, preload } = {}) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    if (scale) await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: scale, mobile: false }, sessionId);
    if (preload) {
      await send("Page.enable", {}, sessionId);
      await send("Page.addScriptToEvaluateOnNewDocument", { source: preload }, sessionId);
    }
    await send("Page.navigate", { url: `http://localhost:${port}/` }, sessionId);
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    for (let i = 0; i < 200; i++) {
      if (await evaluate("Boolean(window.__draftsman)").catch(() => false)) return evaluate;
      await sleep(100);
    }
    throw new Error("The app did not start in Chrome.");
  }

  // Opens any page (a file:// one, say) in a window of its own, watching it:
  // requests holds every URL it asked for, errors every console error and
  // uncaught exception. dark: prefer the dark colour scheme.
  async function openPage(url, { width = 960, height = 640, dark = false } = {}) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const requests = [], errors = [];
    listeners.set(sessionId, (method, p) => {
      if (method === "Network.requestWillBeSent") requests.push(p.request.url);
      else if (method === "Runtime.consoleAPICalled" && p.type === "error") errors.push(p.args.map((a) => a.value ?? a.description).join(" "));
      else if (method === "Runtime.exceptionThrown") errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
      else if (method === "Log.entryAdded" && p.entry.level === "error") errors.push(p.entry.text);
    });
    for (const domain of ["Network", "Runtime", "Log", "Page"]) await send(domain + ".enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] }, sessionId);
    await send("Page.navigate", { url }, sessionId);
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, ...extra }, sessionId);
    return {
      evaluate,
      requests,
      errors,
      // A PNG of the page, in base64.
      screenshot: async () => (await send("Page.captureScreenshot", { format: "png" }, sessionId)).data,
      // Presses a mouse button at from, moves to to in steps, and lets go.
      async drag(from, to, { button = "left", steps = 12 } = {}) {
        const buttons = { left: 1, right: 2, middle: 4 }[button];
        await mouse("mouseMoved", ...from);
        await mouse("mousePressed", ...from, { button, buttons, clickCount: 1 });
        for (let i = 1; i <= steps; i++) await mouse("mouseMoved", from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, { button, buttons });
        await mouse("mouseReleased", ...to, { button, buttons: 0, clickCount: 1 });
      },
      wheel: (x, y, deltaY) => mouse("mouseWheel", x, y, { deltaX: 0, deltaY }),
      close: () => (listeners.delete(sessionId), send("Target.closeTarget", { targetId })),
    };
  }

  // Types a prompt into a window's prompt box and waits for Claude to finish.
  async function prompt(win, text, { timeoutMs = 6 * 60 * 1000, onTick } = {}) {
    await win(`document.getElementById("input").value = ${JSON.stringify(text)}; document.getElementById("prompt").requestSubmit(); true`);
    const end = Date.now() + timeoutMs;
    await sleep(500);
    while (await win("window.__draftsman.busy()")) {
      if (Date.now() > end) throw new Error(`Claude did not finish within ${Math.round(timeoutMs / 60000)} minutes.`);
      await onTick?.();
      await sleep(1000);
    }
    return win("window.__draftsman.reply()");
  }

  // Calls an app command in a window, as the MCP server would. Returns
  // { result } or { error }.
  const command = (win, name, args = {}) =>
    win(`Promise.resolve().then(() => window.__draftsman.call(${JSON.stringify(name)}, ${JSON.stringify(args)})).then((result) => ({ result }), (e) => ({ error: String(e.message ?? e) }))`);

  // Writes the window's STL and returns whether test/check-stl.mjs calls it closed.
  async function stlIsClosed(win) {
    const stl = await win("window.__draftsman.exportSTL()");
    const path = join(profile, `check-${Date.now()}.stl`);
    writeFileSync(path, Buffer.from(stl.base64, "base64"));
    try {
      execFileSync(process.execPath, [join(root, "test/check-stl.mjs"), path], { stdio: "pipe" });
      return { closed: true, triangles: stl.triangles };
    } catch {
      return { closed: false, triangles: stl.triangles };
    }
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
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

  return { openWindow, openPage, prompt, command, stlIsClosed, close };
}

// Collects named checks and prints them as they run.
export function checks() {
  const failures = [];
  return {
    check(ok, what) {
      console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
      if (!ok) failures.push(what);
    },
    fail: (what) => failures.push(what),
    done() {
      console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
      return failures.length ? 1 : 0;
    },
  };
}

// A preload script for openWindow that counts what the page asks WebGL to
// draw, below three.js, so it sees every pass however the view makes it.
// window.__gl.take() returns the counts since the last take: frames (frames
// that drew anything), passes (clears of a target: the frame itself, the
// floor's mirror, the shadow map), draws, and pixels and samples (each
// pass's size, and that times its multisampling) and triangles.
export const GL_COUNTER = `(() => {
  const fbSamples = new Map(), rbSamples = new Map();
  let drawFb = null, rb = null, vw = 0, vh = 0, defaultSamples = null;
  const none = () => ({ frames: 0, passes: 0, draws: 0, pixels: 0, samples: 0, triangles: 0 });
  let c = none();
  let drewThisFrame = false;
  for (const P of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    const wrap = (name, f) => { const o = P[name]; if (o) P[name] = function (...a) { f.call(this, ...a); return o.apply(this, a); }; };
    wrap("bindFramebuffer", function (t, fb) { if (t !== this.READ_FRAMEBUFFER) drawFb = fb; });
    wrap("bindRenderbuffer", (t, r) => (rb = r));
    wrap("renderbufferStorageMultisample", (t, s) => rbSamples.set(rb, s));
    wrap("framebufferRenderbuffer", function (t, att, rt, r) { if (t !== this.READ_FRAMEBUFFER) fbSamples.set(drawFb, rbSamples.get(r) ?? 1); });
    wrap("viewport", (x, y, w, h) => ((vw = w), (vh = h)));
    wrap("clear", function (bits) {
      if (!(bits & (this.COLOR_BUFFER_BIT | this.DEPTH_BUFFER_BIT))) return;
      if (!drawFb && defaultSamples === null) defaultSamples = Math.max(1, this.getParameter(this.SAMPLES));
      const s = drawFb ? (fbSamples.get(drawFb) || 1) : defaultSamples;
      c.passes++; c.pixels += vw * vh; c.samples += vw * vh * s;
    });
    // count: which argument holds the number of vertices drawn.
    const draw = (count) => function (mode, ...a) { c.draws++; drewThisFrame = true; if (mode === this.TRIANGLES) c.triangles += a[count] / 3; };
    for (const [n, count] of [["drawArrays", 1], ["drawElements", 0], ["drawArraysInstanced", 1], ["drawElementsInstanced", 0], ["drawRangeElements", 2]]) wrap(n, draw(count));
  }
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => {
    drewThisFrame = false;
    cb(t);
    if (drewThisFrame) c.frames++;
  });
  window.__gl = { take() { const r = c; c = none(); drewThisFrame = false; return r; } };
})();`;

// A preload script that takes animation frames off the screen's clock: they
// run only when window.__frames.step(n, hz) runs n of them, 1/hz s apart. Put
// it before GL_COUNTER. Frames are slow in software GL, so this is how a test
// sees what a second of a 60 or 120 Hz screen would draw.
export const STEPPED_FRAMES = `(() => {
  let queue = [], now = performance.now(), id = 0;
  window.requestAnimationFrame = (cb) => (queue.push({ cb, id: ++id }), id);
  window.cancelAnimationFrame = (n) => (queue = queue.filter((q) => q.id !== n));
  window.__frames = {
    step(n = 1, hz = 60) {
      for (let i = 0; i < n; i++) {
        now += 1000 / hz;
        const run = queue;
        queue = [];
        for (const q of run) q.cb(now);
      }
    },
  };
})();`;
