// Kernel worker: runs model scripts and meshes parts. Several of these run in
// parallel; each job is independent.
import { runScript } from "./script.js";
import { compile } from "./sdf.js";
import { meshSDF, meshVolume, meshBounds, displayMesh, toSTL } from "./mesh.js";

self.onmessage = ({ data: job }) => {
  try {
    if (job.type === "run") {
      const r = runScript(job.script, job.values);
      // Each part's bounding box, so the app can size detail to the whole model.
      for (const p of r.parts ?? []) p.box = compile(p.node).box;
      // Shape trees go back as data so any worker can mesh them.
      self.postMessage({ id: job.id, ok: true, result: r });
    } else if (job.type === "mesh") {
      const { f, box } = compile(job.node);
      const m = meshSDF(f, box, { budget: job.budget, maxCell: job.maxCell, maxCells: job.maxCells, normals: true });
      // Volume and size from the closed mesh; the copy for drawing has
      // vertices split along sharp edges.
      const d = displayMesh(m);
      const result = { ...d, cellSize: m.cellSize, volume: meshVolume(m), bounds: m.indices.length ? meshBounds(m) : null };
      self.postMessage({ id: job.id, ok: true, result }, [d.positions.buffer, d.indices.buffer, d.normals.buffer]);
    } else if (job.type === "stl") {
      const { f, box } = compile(job.node);
      // Never export a mesh with holes: if the detail is more than the mesher
      // can close, try again coarser.
      let m;
      for (let budget = job.budget; ; budget = Math.floor(budget / 2)) {
        m = meshSDF(f, box, { budget });
        if (!m.incomplete && m.indices.length) break;
        if (budget < 20000) throw new Error(m.indices.length ? "The model is too large to export as a closed mesh." : "There is nothing to export.");
      }
      const bytes = toSTL([m]);
      self.postMessage({ id: job.id, ok: true, result: { bytes, triangles: m.indices.length / 3, bounds: meshBounds(m), volume: meshVolume(m), cellSize: m.cellSize } }, [bytes.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: String(err?.message ?? err) });
  }
};
