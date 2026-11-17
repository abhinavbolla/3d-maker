// Kernel worker: runs model scripts and meshes parts. Several of these run in
// parallel; each job is independent.
import { runScript } from "./script.js";
import { compile } from "./sdf.js";
import { meshSDF, meshBounds, meshArea, displayMesh, lightMesh } from "./mesh.js";
import { meshPart } from "./pieces.js";
import { checkPairs } from "./fit.js";
import { viewOutline, sectionView } from "./drawing.js";
import { measureJob } from "./measure.js";

// A part with at least this many triangles gets a lighter copy, its vertices
// merged over this many of its cells: about a ninth of the triangles.
const LIGHT_FROM = 4000;
const LIGHT_CELLS = 3;

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
      // vertices split along sharp edges, found and shaded from the part's
      // distance function.
      const d = displayMesh(m, undefined, compile(job.node).f);
      const result = { ...d, cellSize: m.cellSize, volume: m.volume, area: meshArea(m), bounds: m.indices.length ? meshBounds(m) : null };
      const buffers = [d.positions.buffer, d.indices.buffer, d.normals.buffer];
      // A lighter copy for the view's shadow and reflection, where a mesh is
      // big enough for it to save anything.
      if (d.indices.length >= LIGHT_FROM * 3) {
        result.light = lightMesh(d, m.cellSize * LIGHT_CELLS);
        buffers.push(result.light.positions.buffer, result.light.indices.buffer, result.light.normals.buffer);
      }
      self.postMessage({ id: job.id, ok: true, result }, buffers);
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
        } else m = meshPart(job.node, { budget, maxCell, normals: Boolean(job.normals) });
        if (!m.incomplete && m.indices.length) break;
        if (budget < 1000) throw new Error(m.indices.length ? `${job.what} is too large to export as a closed mesh.` : "There is nothing to export.");
      }
      // With normals (glTF, OBJ): vertices split along sharp edges, as drawn in the view.
      if (job.normals && !job.solid) {
        const d = displayMesh(m);
        self.postMessage({ id: job.id, ok: true, result: { ...d, cellSize: m.cellSize } }, [d.positions.buffer, d.indices.buffer, d.normals.buffer]);
        return;
      }
      const { positions, indices } = m;
      self.postMessage({ id: job.id, ok: true, result: { positions, indices, cellSize: m.cellSize } }, [positions.buffer, indices.buffer]);
    } else if (job.type === "measure") {
      self.postMessage({ id: job.id, ok: true, result: measureJob(job) });
    } else if (job.type === "drawing") {
      // One view of a drawing, or its section: the parts' export meshes, with
      // their distance functions compiled here.
      const parts = job.parts.map((p) => ({ ...p, ...compile(p.node) }));
      self.postMessage({ id: job.id, ok: true, result: job.section ? sectionView(parts, job.section) : viewOutline(parts, job.view) });
    }
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: String(err?.message ?? err) });
  }
};
