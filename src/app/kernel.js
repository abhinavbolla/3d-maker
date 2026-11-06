// Runs model scripts and meshes parts on a pool of workers, with a cache so
// only parts that changed are meshed again.
const SIZE = Math.max(2, Math.min((navigator.hardwareConcurrency || 4) - 1, 8));
const RUN_TIMEOUT_MS = 10000;
const MESH_TIMEOUT_MS = 120000;

function createPool() {
  const workers = [];
  const queue = [];
  const low = []; // background jobs: run only when nothing else waits
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
      if (w.job || !(queue.length || low.length)) continue;
      const job = queue.length ? queue.shift() : low.shift();
      w.job = job;
      job.timer = setTimeout(() => restart(w, new Error(job.timeoutMessage)), job.timeout);
      w.worker.postMessage(job.msg);
    }
  }
  for (let i = 0; i < SIZE; i++) workers.push(spawn());

  const job = (msg, timeout, timeoutMessage, { background = false } = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      (background ? low : queue).push({ id, msg: { ...msg, id }, resolve, reject, timeout, timeoutMessage });
      pump();
    });
  // Drops background jobs that have not started yet.
  job.cancelBackground = () => {
    for (const j of low.splice(0)) j.reject(new Error("cancelled"));
  };
  return job;
}

// Detail per build. budget: surface cells per part, shared out by part count
// (thin parts get up to 6x more automatically). cells: about how many cells
// the whole model's surface gets; no part's cells are bigger than that allows,
// so big parts are as detailed as small ones. partCap: the most cells any one
// part may use, so one big plate cannot take seconds. "fine" runs in the
// background after each change.
export const QUALITY = {
  draft: { budget: (n) => Math.min(8000, Math.max(1500, 120000 / n)), cells: 30000, partCap: 40000 },
  preview: { budget: (n) => Math.min(40000, Math.max(6000, 600000 / n)), cells: 80000, partCap: 150000 },
  fine: { budget: (n) => Math.min(160000, Math.max(24000, 2400000 / n)), cells: 600000, partCap: 1200000 },
};

// Surface area of the boxes around the parts (mm2). Usually more than the
// parts' real surface, so cells sized from it rarely add up to too many.
function boxArea(parts) {
  let a = 0;
  for (const { box } of parts) {
    if (!box || !(box[3] >= box[0])) continue;
    const [x, y, z] = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
    a += 2 * (x * y + y * z + z * x);
  }
  return Number.isFinite(a) ? a : 0;
}

export function createKernel() {
  const job = createPool();
  const cache = new Map(); // quality|budget|maxCell|hash -> mesh
  let fineCache = new Map(); // the latest fine meshes only (they are big)

  const run = (script, values) => job({ type: "run", script, values }, RUN_TIMEOUT_MS, `The script took longer than ${RUN_TIMEOUT_MS / 1000} s to run. Check for a loop that never ends.`);

  async function build(doc, quality = "preview") {
    const t0 = performance.now();
    const r = await run(doc.script, doc.values);
    if (r.error) return { error: r.error, params: r.params, prints: r.prints };
    const detail = detailFor(r.parts, quality);
    const keep = new Set();
    const parts = await Promise.all(
      r.parts.map(async (p) => {
        const key = `${detail.key}|${p.hash}`;
        keep.add(key);
        let mesh = cache.get(key);
        if (!mesh) {
          mesh = await meshPart(p, detail);
          cache.set(key, mesh);
        }
        return { name: p.name, color: p.color, motion: p.motion, follow: p.follow, frames: p.frames, hidden: p.hidden, node: p.node, box: p.box, hash: p.hash, mesh };
      }),
    );
    // Keep this build's meshes and a few recent ones (slider back-and-forth).
    for (const key of cache.keys()) if (!keep.has(key) && cache.size > keep.size + 60) cache.delete(key);
    return { title: r.title, params: r.params, prints: r.prints, warnings: r.warnings, motion: r.motion, parts, ms: Math.round(performance.now() - t0), quality };
  }

  function detailFor(parts, quality) {
    const q = QUALITY[quality];
    // Rounded up to a power of two, so adding a part to a growing model does
    // not change every part's budget and re-mesh them all.
    const n = 2 ** Math.ceil(Math.log2(Math.max(1, parts.length)));
    const budget = Math.round(q.budget(n));
    // Rounded to quarter steps of a power of two, so small changes to the
    // model do not re-mesh every part either.
    const area = boxArea(parts);
    const maxCell = area > 0 ? 2 ** (Math.round(4 * Math.log2(Math.sqrt(area / q.cells))) / 4) : Infinity;
    return { budget, maxCell, maxCells: q.partCap, key: `${quality}|${budget}|${maxCell}` };
  }

  const meshPart = (p, { budget, maxCell, maxCells }, opts) =>
    job({ type: "mesh", node: p.node, budget, maxCell, maxCells }, MESH_TIMEOUT_MS, `Meshing part "${p.name}" took too long.`, opts);

  // The same model at fine detail, meshed in the background. Parts that are
  // already that detailed keep their mesh. Resolves to null if cancelled.
  async function refine(result) {
    const detail = detailFor(result.parts, "fine");
    const next = new Map();
    try {
      const parts = await Promise.all(
        result.parts.map(async (p) => {
          if (p.hidden || !p.mesh.bounds || p.mesh.cellSize <= detail.maxCell * Math.SQRT2 * 1.01) return p;
          const key = `${detail.key}|${p.hash}`;
          let mesh = fineCache.get(key);
          if (!mesh) mesh = await meshPart(p, detail, { background: true });
          next.set(key, mesh);
          return { ...p, mesh };
        }),
      );
      fineCache = next;
      return parts.some((p, i) => p !== result.parts[i]) ? { ...result, parts, quality: "fine" } : null;
    } catch (err) {
      if (err.message === "cancelled") return null;
      throw err;
    }
  }

  // One closed solid of every visible part, at export detail.
  async function exportSTL(parts) {
    const nodes = parts.filter((p) => !p.hidden).map((p) => p.node);
    if (!nodes.length) throw new Error("There is nothing to export.");
    return job({ type: "stl", node: { t: "union", c: nodes }, budget: EXPORT_BUDGET }, MESH_TIMEOUT_MS, "Export took too long.");
  }

  return { build, refine, cancelRefine: () => job.cancelBackground(), exportSTL };
}
