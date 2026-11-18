// One kernel worker (src/kernel/worker.js) as a process of its own, for the
// MCP server's model when no app window is open. mcp/headless.mjs starts it
// inside the boundary described there: Node's permission model (no file
// writes, reads only of the kernel's own code, no processes, threads or
// add-ons) and, where Node's own model does not cover the network, the
// operating system's sandbox. This file gives the worker the web worker's
// self.onmessage and self.postMessage over the process's IPC channel.
export const KERNEL_FLAG = "--draftsman-kernel";

async function kernelProcess() {
  const proc = process;
  // Signals to other processes (and so opening another Node process's
  // inspector) are outside Node's permission model: take them away here.
  for (const name of ["kill", "_kill", "_debugProcess", "binding", "_linkedBinding", "dlopen"]) {
    try {
      delete proc[name];
    } catch {
      proc[name] = undefined;
    }
  }
  globalThis.self = {
    postMessage: (data) => proc.send(data),
    set onmessage(fn) {
      proc.on("message", (data) => fn({ data }));
    },
  };
  // A script's own callbacks that fail later do not stop the kernel, as in
  // a web worker, where they are only logged.
  proc.on("uncaughtException", () => {});
  proc.on("unhandledRejection", () => {});
  // The server went away: so does this.
  proc.on("disconnect", () => proc.exit(0));
  await import("../src/kernel/worker.js");
}

if (process.argv.includes(KERNEL_FLAG)) await kernelProcess();
