// Runs model scripts and meshes parts on a pool of workers, with a cache so
// only parts that changed are meshed again.
import { worldBox, boxesMeet } from "../kernel/fit.js";
import { toSTL } from "../kernel/mesh.js";
import { to3MF } from "../kernel/threemf.js";

const SIZE = Math.max(2, Math.min((navigator.hardwareConcurrency || 4) - 1, 8));
const RUN_TIMEOUT_MS = 30000;
const MESH_TIMEOUT_MS = 120000;
const SOLID_TIMEOUT_MS = 300000;
const FIT_TIMEOUT_MS = 60000;
// Moments of the motion loop checked for parts hitting each other.
const FIT_FRAMES = 120;

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

// Export detail: about this many surface cells over the whole model.
const EXPORT_BUDGET = 250000;

// One cell size for the whole export, so every part is as detailed as every
// other, sized from the meshes already on screen: a part meshed at cell s
// with T triangles has about T/2 surface cells, and (s/c)^2 times as many at
// cell c. Each part's budget is its share at that cell size, so thin parts
// still get their extra cells.
function visible(parts) {
  const shown = parts.filter((p) => !p.hidden && p.mesh?.indices.length);
  if (!shown.length) throw new Error("There is nothing to export.");
  return shown;
}

export function exportDetail(parts, budget = EXPORT_BUDGET) {
  const est = parts.map((p) => (p.mesh.indices.length / 6) * p.mesh.cellSize ** 2);
  const cell = Math.sqrt(est.reduce((a, b) => a + b, 0) / budget);
  return { cell, budgets: est.map((e) => Math.max(2000, Math.round(e / cell ** 2))) };
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
    return { title: r.title, params: r.params, prints: r.prints, warnings: r.warnings, motion: r.motion, joints: r.joints, parts, ms: Math.round(performance.now() - t0), quality };
  }

  function detailFor(parts, quality) {
    const q = QUALITY[quality];
    // Rounded up to a power of two, so adding a part to a growing model does
    // not change every part's budget and re-mesh them all.
    const n = 2 ** Math.ceil(Math.log2(Math.max(1, parts.length)));
    const budget = Math.round(q.budget(n));
    // Rounded to quarter steps of a power of two, so small changes to the
    // model do not re-mesh every part either.
    // The fine pass knows each part's real surface from its preview mesh;
    // boxes overstate it, most of all for spread-out parts like a rotor.
    const area = parts.every((p) => p.mesh?.area >= 0) ? parts.reduce((a, p) => a + (p.hidden ? 0 : p.mesh.area), 0) : boxArea(parts);
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

  // Closed meshes of every visible part, meshed in parallel at one cell size
  // for the whole model (see exportDetail): [{ name, color, positions, indices }].
  async function exportMeshes(parts) {
    const shown = visible(parts);
    const { cell, budgets } = exportDetail(shown);
    return Promise.all(
      shown.map(async (p, i) => ({
        name: p.name,
        color: p.color,
        ...(await job({ type: "export", node: p.node, budget: budgets[i], maxCell: cell, what: `Part "${p.name}"` }, MESH_TIMEOUT_MS, `Exporting part "${p.name}" took too long.`)),
      })),
    );
  }

  // STL of every visible part, each its own closed shell; with solid, all of
  // them joined into one closed solid (slower: one worker meshes it all).
  async function exportSTL(parts, { solid = false } = {}) {
    if (!solid) {
      const meshes = await exportMeshes(parts);
      return { bytes: toSTL(meshes), triangles: meshes.reduce((s, m) => s + m.indices.length / 3, 0) };
    }
    const shown = visible(parts);
    const { cell } = exportDetail(shown);
    const m = await job(
      { type: "export", solid: true, node: { t: "union", c: shown.map((p) => p.node) }, budget: EXPORT_BUDGET, maxCell: cell, what: "The model" },
      SOLID_TIMEOUT_MS,
      "Joining the parts into one solid took too long. Export them as separate parts instead.",
    );
    return { bytes: toSTL([m]), triangles: m.indices.length / 3 };
  }

  // 3MF: one named, coloured object per visible part.
  async function export3MF(parts, title) {
    const meshes = await exportMeshes(parts);
    return { bytes: await to3MF(meshes, { title }), triangles: meshes.reduce((s, m) => s + m.indices.length / 3, 0) };
  }

  // Which parts pass into each other, at rest and over the motion loop. With
  // names, only pairs that include one of them; with exactly two names, also
  // how close those two come. Pairs are shared out over the workers.
  async function checkFit(result, { names = null } = {}) {
    const all = result.parts.filter((p) => !p.hidden && p.mesh.bounds);
    const known = new Set(all.map((p) => p.name));
    for (const n of names ?? []) if (!known.has(n)) throw new Error(`There is no visible part named "${n}".`);
    const gap = names?.length === 2;
    const count = result.motion?.frames ?? 0;
    const step = Math.max(1, Math.ceil(count / FIT_FRAMES));
    const frames = count ? Array.from({ length: Math.ceil(count / step) }, (_, k) => k * step) : [0];
    // Each part's box over the whole loop.
    const swept = all.map((p) => {
      if (!p.frames || !count) return p.box;
      let b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const f of frames) {
        const w = worldBox(p.box, Array.from(p.frames.subarray(f * 12, f * 12 + 12)));
        b = b.map((v, i) => (i < 3 ? Math.min(v, w[i]) : Math.max(v, w[i])));
      }
      return b;
    });
    const pairs = [];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const [a, b] = [all[i].name, all[j].name];
        if (gap ? !(names.includes(a) && names.includes(b)) : names && !names.includes(a) && !names.includes(b)) continue;
        if (gap || boxesMeet(swept[i], swept[j])) pairs.push([i, j]);
      }
    const chunks = Array.from({ length: Math.min(SIZE, pairs.length) }, () => []);
    pairs.forEach((p, k) => chunks[k % chunks.length].push(p));
    const joints = result.joints ?? result.motion?.joints ?? [];
    const found = await Promise.all(
      chunks.map((chunk) => {
        const used = [...new Set(chunk.flat())];
        const at = new Map(used.map((i, k) => [i, k]));
        const parts = used.map((i) => ({ name: all[i].name, node: all[i].node, box: all[i].box, frames: all[i].frames }));
        return job({ type: "fit", parts, pairs: chunk.map(([i, j]) => [at.get(i), at.get(j)]), frames, frameCount: count, loop: result.motion?.loop ?? 0, gap, joints }, FIT_TIMEOUT_MS, "Checking how the parts fit took too long.");
      }),
    );
    return { pairs: pairs.length, results: found.flat().sort((a, b) => (b.volume_cm3 ?? 0) - (a.volume_cm3 ?? 0)) };
  }

  return { build, refine, cancelRefine: () => job.cancelBackground(), exportSTL, export3MF, checkFit };
}
