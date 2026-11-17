// The model kept by the MCP server itself while no app window is open: the
// app's own store, commands and kernel (src/app), with the kernel's workers
// as Node worker threads and no view. Tools that draw (screenshot, pictures,
// films, the view's state) need a window; the server answers those itself.
import { Worker } from "node:worker_threads";
import { createKernel } from "../src/app/kernel.js";
import { createStore } from "../src/app/store.js";
import { createCommands } from "../src/app/commands.js";

// The tools that only change or draw the view, and the film's pieces.
export const VIEW_ONLY = new Set(["screenshot", "set_look", "hide_parts", "section_view", "explode_view", "clear_view", "set_camera", "save_picture", "preview_shots", "record_video", "video_part"]);

// What a kernel thread is started with. The thread runs the server's own file
// (one file once bundled for the desktop app), which sees this and runs
// kernelThread instead of the server.
export const KERNEL_THREAD = "draftsman-kernel";

// A Node worker thread with a web worker's onmessage, onerror, postMessage
// and terminate, as the kernel's pool uses them.
class KernelWorker {
  constructor(entry) {
    this.thread = new Worker(entry, { workerData: KERNEL_THREAD });
    // It does not keep the server running; the bridge and stdio do.
    this.thread.unref();
    this.thread.on("message", (data) => this.onmessage?.({ data }));
    this.thread.on("error", (err) => this.onerror?.({ message: err?.message, preventDefault() {} }));
  }
  postMessage(data, transfer) {
    this.thread.postMessage(data, transfer);
  }
  terminate() {
    this.thread.terminate();
  }
}

// entry: the URL of the server's file (mcp/server.mjs).
export function createHeadless(entry) {
  const kernel = createKernel({ spawn: () => new KernelWorker(entry) });
  // No fine pass in the background: nothing is drawn, and exports and
  // measure work from the shapes themselves at their own detail.
  const store = createStore({ ...kernel, refine: undefined }, undefined, { save: () => {} });
  // No view: the model is never framed, and finish_step has no picture.
  const viewport = { fitIfNew() {}, screenshot: () => null, inspect: null };
  const commands = createCommands({ store, viewport, kernel });
  return {
    has: (method) => Object.hasOwn(commands, method) && !VIEW_ONLY.has(method),
    run: (method, params) => commands[method](params ?? {}),
  };
}

// Inside a kernel thread: the kernel's worker (src/kernel/worker.js), given
// the web worker's self.onmessage and self.postMessage, with what Node has
// that a web worker does not (process, and the file system through it, the
// network) taken away first, so a model script reaches no more here than in
// the app.
export async function kernelThread() {
  const { parentPort: port } = await import("node:worker_threads");
  for (const name of ["process", "Buffer", "global", "require", "module", "fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) {
    try {
      delete globalThis[name];
    } catch {
      // Not there, or cannot be removed: the script's blocked names cover the rest.
    }
  }
  globalThis.self = {
    postMessage: (data, transfer) => port.postMessage(data, transfer),
    set onmessage(fn) {
      port.on("message", (data) => {
        // In Node, import() would reach the file system and the network.
        if (data?.type === "run" && /\bimport\s*\(/.test(data.script)) return port.postMessage({ id: data.id, ok: true, result: { error: "A model script cannot import modules.", params: [], prints: [] } });
        fn({ data });
      });
    },
  };
  await import("../src/kernel/worker.js");
}
