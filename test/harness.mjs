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

export async function startHarness({ port = 5178 } = {}) {
  const vite = await createServer({ root, configFile: join(root, "vite.config.js"), server: { port, strictPort: true }, logLevel: "warn" });
  await vite.listen();
  const profile = mkdtempSync(join(tmpdir(), "3d-maker-test-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
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

  // Opens a fresh app window; returns evaluate(expression) for it.
  async function openWindow() {
    const { targetId } = await send("Target.createTarget", { url: `http://localhost:${port}/` });
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

  // Types a prompt into a window's prompt box and waits for Claude to finish.
  async function prompt(win, text, { timeoutMs = 6 * 60 * 1000, onTick } = {}) {
    await win(`document.getElementById("input").value = ${JSON.stringify(text)}; document.getElementById("prompt").requestSubmit(); true`);
    const end = Date.now() + timeoutMs;
    await sleep(500);
    while (await win("window.__3dmaker.busy()")) {
      if (Date.now() > end) throw new Error(`Claude did not finish within ${Math.round(timeoutMs / 60000)} minutes.`);
      await onTick?.();
      await sleep(1000);
    }
    return win("window.__3dmaker.reply()");
  }

  // Calls an app command in a window, as the MCP server would. Returns
  // { result } or { error }.
  const command = (win, name, args = {}) =>
    win(`Promise.resolve().then(() => window.__3dmaker.call(${JSON.stringify(name)}, ${JSON.stringify(args)})).then((result) => ({ result }), (e) => ({ error: String(e.message ?? e) }))`);

  // Writes the window's STL and returns whether test/check-stl.mjs calls it closed.
  async function stlIsClosed(win) {
    const stl = await win("window.__3dmaker.exportSTL()");
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

  return { openWindow, prompt, command, stlIsClosed, close };
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
