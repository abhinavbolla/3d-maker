// The model kept by the MCP server itself while no app window is open: the
// app's own store, commands and kernel pool (src/app), with no view, and
// each kernel worker a separate Node process inside a boundary (below).
// Tools that draw (screenshot, pictures, films, the view's state) need a
// window; the server answers those itself.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel } from "../src/app/kernel.js";
import { createStore } from "../src/app/store.js";
import { createCommands } from "../src/app/commands.js";
import { KERNEL_FLAG } from "./kernel-process.mjs";

// The tools that only change or draw the view, and the film's pieces.
export const VIEW_ONLY = new Set(["screenshot", "set_look", "hide_parts", "section_view", "explode_view", "clear_view", "set_camera", "save_picture", "preview_shots", "record_video", "video_part"]);

// ---- the boundary ----
// A model script is code. In the app it runs in a browser's web worker; here
// it would run as the user, with their files, shell and network, and without
// Claude Code asking first. So each kernel worker is a Node process started
// with Node's permission model:
//   - file reads only of the kernel's own code; no file writes;
//   - no child processes, worker threads, native add-ons, WASI or inspector;
//   - an empty environment (no tokens or keys to read);
//   - process.kill and the internal bindings taken away (kernel-process.mjs),
//     as signals are outside the permission model.
// Node's model covers the network only from Node 25. On macOS the process
// also runs under the system sandbox (sandbox-exec), which denies network,
// file writes, forking and signals to other processes, whatever the Node
// version. Elsewhere, before Node 25, there is no boundary for the network,
// and the server refuses to build without a window rather than run scripts
// unguarded.
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SANDBOX_PROFILE = `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(deny process-fork)
(deny signal (target others))`;
const flag = (name) => process.allowedNodeEnvironmentFlags.has(name);

// How to start a kernel process here: { command, args } or { refused: why }.
// entry: the server's own file (one file once bundled for the desktop app).
export function kernelCommand(entry) {
  const major = Number(process.versions.node.split(".")[0]);
  const permission = flag("--permission") ? "--permission" : flag("--experimental-permission") ? "--experimental-permission" : null;
  if (!permission) return { refused: `Node.js ${process.version} has no permission model to keep model scripts in.` };
  const sandbox = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
  const nodeNet = flag("--allow-net");
  if (!sandbox && !nodeNet) return { refused: `Node.js ${process.version} on ${process.platform} cannot keep a model script off the network (Node's permission model covers it from Node 25).` };
  // What the kernel must read: in a checkout, its own source; bundled, the
  // one file. Real paths, as the permission model checks those.
  const file = fileURLToPath(entry);
  // Bundled, this module is inside the server's file.
  const bundled = import.meta.url === String(entry);
  const real = (p) => realpathSync(p);
  const reads = bundled ? [real(file)] : [real(fileURLToPath(new URL("./kernel-process.mjs", import.meta.url))), real(fileURLToPath(new URL("../src/kernel/", import.meta.url))), real(fileURLToPath(new URL("../package.json", import.meta.url)))];
  const start = bundled ? real(file) : reads[0];
  const readFlags = major >= 22 ? reads.map((p) => `--allow-fs-read=${p}`) : [`--allow-fs-read=${reads.join(",")}`];
  const quiet = ["--no-experimental-sqlite", "--no-experimental-websocket"].filter(flag);
  const node = [permission, ...readFlags, ...quiet, start, KERNEL_FLAG];
  return sandbox ? { command: SANDBOX_EXEC, args: ["-p", SANDBOX_PROFILE, process.execPath, ...node], sandbox: true } : { command: process.execPath, args: node, sandbox: false };
}

// A kernel process with a web worker's onmessage, onerror, postMessage and
// terminate, as the kernel's pool uses them.
class KernelProcess {
  constructor({ command, args }, log) {
    this.child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced", env: {}, cwd: dirname(args.at(-2)) });
    let err = "";
    this.child.stderr.on("data", (d) => {
      if (err.length < 2000) err += d;
    });
    // It does not keep the server running; the bridge and stdio do.
    this.child.unref();
    this.child.channel?.unref();
    this.child.on("message", (data) => this.onmessage?.({ data }));
    this.child.on("exit", (code, signal) => {
      if (this.ended) return;
      this.ended = true;
      if (err.trim()) log?.(`a kernel process stopped: ${err.trim().split("\n").slice(0, 3).join(" ")}`);
      this.onerror?.({ message: `The kernel stopped unexpectedly (${signal ?? `exit ${code}`}).`, preventDefault() {} });
    });
  }
  postMessage(data) {
    if (!this.ended) this.child.send(data);
  }
  terminate() {
    this.ended = true;
    this.child.kill();
  }
}

// entry: the URL of the server's file (mcp/server.mjs). Returns the
// model's commands, or { refused } when there is no boundary to run in.
export function createHeadless(entry, { log } = {}) {
  const how = kernelCommand(entry);
  if (how.refused) return { refused: how.refused };
  const kernel = createKernel({ spawn: () => new KernelProcess(how, log) });
  // No fine pass in the background: nothing is drawn, and exports and
  // measure work from the shapes themselves at their own detail.
  const store = createStore({ ...kernel, refine: undefined }, undefined, { save: () => {} });
  // No view: the model is never framed, and finish_step has no picture.
  const viewport = { fitIfNew() {}, screenshot: () => null, inspect: null };
  const commands = createCommands({ store, viewport, kernel });
  return {
    sandbox: how.sandbox,
    has: (method) => Object.hasOwn(commands, method) && !VIEW_ONLY.has(method),
    run: (method, params) => commands[method](params ?? {}),
  };
}
