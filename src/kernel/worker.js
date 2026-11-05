// Kernel worker: runs model scripts and meshes parts. Several of these run in
// parallel; each job is independent.
import { runScript } from "./script.js";
import { compile } from "./sdf.js";
import { meshSDF, meshVolume, meshBounds, toSTL } from "./mesh.js";

self.onmessage = ({ data: job }) => {
  try {
    if (job.type === "run") {
      const r = runScript(job.script, job.values);
      // Shape trees go back as data so any worker can mesh them.
      self.postMessage({ id: job.id, ok: true, result: r });
    } else if (job.type === "mesh") {
      const { f, box } = compile(job.node);
      const m = meshSDF(f, box, { budget: job.budget, normals: job.normals });
      const result = { ...m, volume: meshVolume(m), bounds: m.indices.length ? meshBounds(m) : null };
      const transfer = [m.positions.buffer, m.indices.buffer];
      if (m.normals) transfer.push(m.normals.buffer);
      self.postMessage({ id: job.id, ok: true, result }, transfer);
    } else if (job.type === "stl") {
      const { f, box } = compile(job.node);
      const m = meshSDF(f, box, { budget: job.budget });
      const bytes = toSTL([m]);
      self.postMessage({ id: job.id, ok: true, result: { bytes, triangles: m.indices.length / 3, bounds: meshBounds(m), volume: meshVolume(m), cellSize: m.cellSize } }, [bytes.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: String(err?.message ?? err) });
  }
};
