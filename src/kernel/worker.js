// Runs OpenCascade off the main thread so the UI never freezes during a rebuild.
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { initKernel, buildScene, buildNode, exportScene } from "./kernel.js";
import { findNode } from "../model/ops.js";

const ready = opencascade({ locateFile: () => wasmUrl, print: () => {}, printErr: () => {} }).then(initKernel);

function meshExtra(doc, id) {
  // Mesh a nested node on its own (used to show a boolean input as a ghost).
  const found = id && findNode(doc, id);
  if (!found || !found.parent) return null;
  const shape = buildNode(found.node);
  try {
    const m = shape.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
    return { id, vertices: new Float32Array(m.vertices), triangles: new Uint32Array(m.triangles), normals: new Float32Array(m.normals) };
  } finally {
    shape.delete();
  }
}

self.onmessage = async ({ data }) => {
  const { reqId, type } = data;
  try {
    await ready;
    if (type === "build") {
      const results = buildScene(data.doc);
      let ghost = null;
      try {
        ghost = meshExtra(data.doc, data.ghostId);
      } catch {
        ghost = null;
      }
      const transfer = [];
      for (const r of results) if (!r.error) transfer.push(r.vertices.buffer, r.normals.buffer, r.triangles.buffer, r.lines.buffer);
      self.postMessage({ reqId, ok: true, results, ghost }, transfer);
    } else if (type === "export") {
      const blob = exportScene(data.doc, data.format, data.ids);
      const bytes = await blob.arrayBuffer();
      self.postMessage({ reqId, ok: true, bytes }, [bytes]);
    } else if (type === "ping") {
      self.postMessage({ reqId, ok: true });
    }
  } catch (err) {
    self.postMessage({ reqId, ok: false, error: String(err?.message ?? err) });
  }
};
