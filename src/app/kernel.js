// Runs model scripts and meshes parts on a pool of workers, with a cache so
// only parts that changed are meshed again.
const SIZE = Math.max(2, Math.min((navigator.hardwareConcurrency || 4) - 1, 8));
const RUN_TIMEOUT_MS = 10000;
const MESH_TIMEOUT_MS = 120000;

function createPool() {
  const workers = [];
  const queue = [];
  let seq = 0;

  function spawn(w = { job: null }) {
    w.worker = new Worker(new URL("../kernel/worker.js", import.meta.url), { type: "module" });
    w.job = null;
    w.worker.onmessage = ({ data }) => {
      const job = w.job;
      if (!job || data.id !== job.id) return;
      clearTimeout(job.timer);
      w.job = null;
      data.ok ? job.resolve(data.result) : job.reject(new Error(data.error));
      pump();
    };
    w.worker.onerror = (e) => {
      e.preventDefault();
      restart(w, new Error(e.message || "The kernel stopped unexpectedly."));
    };
    return w;
  }
  function restart(w, err) {
    const job = w.job;
    w.worker.terminate();
    spawn(w);
    if (job) {
      clearTimeout(job.timer);
      job.reject(err);
    }
    pump();
  }
  function pump() {
    for (const w of workers) {
      if (w.job || !queue.length) continue;
      const job = queue.shift();
      w.job = job;
      job.timer = setTimeout(() => restart(w, new Error(job.timeoutMessage)), job.timeout);
      w.worker.postMessage(job.msg);
    }
  }
  for (let i = 0; i < SIZE; i++) workers.push(spawn());

  return (msg, timeout, timeoutMessage) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      queue.push({ id, msg: { ...msg, id }, resolve, reject, timeout, timeoutMessage });
      pump();
    });
}

export const QUALITY = {
  // Per-part cell budgets. Thin parts get up to 6x more automatically.
  draft: (n) => Math.round(Math.min(8000, Math.max(1500, 120000 / n))),
  preview: (n) => Math.round(Math.min(40000, Math.max(6000, 600000 / n))),
};
const EXPORT_BUDGET = 500000;

export function createKernel() {
  const job = createPool();
  const cache = new Map(); // hash|budget -> mesh

  const run = (script, values) => job({ type: "run", script, values }, RUN_TIMEOUT_MS, `The script took longer than ${RUN_TIMEOUT_MS / 1000} s to run. Check for a loop that never ends.`);

  async function build(doc, quality = "preview") {
    const t0 = performance.now();
    const r = await run(doc.script, doc.values);
    if (r.error) return { error: r.error, params: r.params, prints: r.prints };
    const budget = QUALITY[quality](r.parts.length);
    const keep = new Set();
    const parts = await Promise.all(
      r.parts.map(async (p) => {
        const key = `${budget}|${p.hash}`;
        keep.add(key);
        let mesh = cache.get(key);
        if (!mesh) {
          mesh = await job({ type: "mesh", node: p.node, budget, normals: true }, MESH_TIMEOUT_MS, `Meshing part "${p.name}" took too long.`);
          cache.set(key, mesh);
        }
        return { name: p.name, color: p.color, motion: p.motion, hidden: p.hidden, node: p.node, mesh };
      }),
    );
    // Keep this build's meshes and a few recent ones (slider back-and-forth).
    for (const key of cache.keys()) if (!keep.has(key) && cache.size > keep.size + 60) cache.delete(key);
    return { title: r.title, params: r.params, prints: r.prints, warnings: r.warnings, parts, ms: Math.round(performance.now() - t0), quality };
  }

  // One closed solid of every visible part, at export detail.
  async function exportSTL(parts) {
    const nodes = parts.filter((p) => !p.hidden).map((p) => p.node);
    if (!nodes.length) throw new Error("There is nothing to export.");
    return job({ type: "stl", node: { t: "union", c: nodes }, budget: EXPORT_BUDGET }, MESH_TIMEOUT_MS, "Export took too long.");
  }

  return { build, exportSTL };
}
