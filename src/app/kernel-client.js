// Promise wrapper around the geometry worker.
export function createKernelClient() {
  const worker = new Worker(new URL("../kernel/worker.js", import.meta.url), { type: "module" });
  const pending = new Map();
  let seq = 0;
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.reqId);
    if (!p) return;
    pending.delete(data.reqId);
    data.ok ? p.resolve(data) : p.reject(new Error(data.error));
  };
  const call = (msg) =>
    new Promise((resolve, reject) => {
      const reqId = ++seq;
      pending.set(reqId, { resolve, reject });
      worker.postMessage({ ...msg, reqId });
    });
  return {
    ready: () => call({ type: "ping" }),
    build: (doc, ghostId) => call({ type: "build", doc, ghostId }),
    export: (doc, format, ids) => call({ type: "export", doc, format, ids }).then((r) => r.bytes),
  };
}
