// Kernel worker: runs model scripts and meshes parts. Several of these run in
// parallel; each job is independent.
import { runScript } from "./script.js";
import { compile } from "./sdf.js";
import { meshSDF, meshBounds, meshArea, displayMesh } from "./mesh.js";
import { meshPart } from "./pieces.js";
import { checkPairs } from "./fit.js";

self.onmessage = ({ data: job }) => {
  try {
    if (job.type === "run") {
      const r = runScript(job.script, job.values);
      // Each part's bounding box, so the app can size detail to the whole model.
      for (const p of r.parts ?? []) p.box = compile(p.node).box;
      // Shape trees go back as data so any worker can mesh them.
      self.postMessage({ id: job.id, ok: true, result: r });
    } else if (job.type === "mesh") {
      const m = meshPart(job.node, { budget: job.budget, maxCell: job.maxCell, maxCells: job.maxCells, normals: true });
      // Volume and size from the closed mesh; the copy for drawing has
      // vertices split along sharp edges.
      const d = displayMesh(m);
      const result = { ...d, cellSize: m.cellSize, volume: m.volume, area: meshArea(m), bounds: m.indices.length ? meshBounds(m) : null };
      self.postMessage({ id: job.id, ok: true, result }, [d.positions.buffer, d.indices.buffer, d.normals.buffer]);
    } else if (job.type === "fit") {
      self.postMessage({ id: job.id, ok: true, result: checkPairs(job.parts, job.pairs, job) });
    } else if (job.type === "export") {
      // Never export a mesh with holes: if the detail is more than the mesher
      // can close, try again coarser. Small pieces of a part keep their own
      // detail, except when everything is joined into one solid.
      let m;
      for (let budget = job.budget, maxCell = job.maxCell ?? Infinity; ; budget = Math.floor(budget / 2), maxCell *= 2) {
        if (job.solid) {
          const { f, box } = compile(job.node);
          m = meshSDF(f, box, { budget, maxCell });
        } else m = meshPart(job.node, { budget, maxCell });
        if (!m.incomplete && m.indices.length) break;
        if (budget < 1000) throw new Error(m.indices.length ? `${job.what} is too large to export as a closed mesh.` : "There is nothing to export.");
      }
      const { positions, indices } = m;
      self.postMessage({ id: job.id, ok: true, result: { positions, indices, cellSize: m.cellSize } }, [positions.buffer, indices.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: String(err?.message ?? err) });
  }
};
