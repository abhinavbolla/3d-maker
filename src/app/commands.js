// The command set Claude can call (through the MCP bridge). Each command
// edits the document through the store, waits for the rebuild and returns
// a compact JSON result that tells Claude what happened.
import * as ops from "../model/ops.js";
import { emptyDoc } from "../model/schema.js";

const round = (v) => Math.round(v * 100) / 100;

export function summarize(doc, build) {
  const node = (n, top) => {
    const out = { id: n.id, name: n.name, kind: n.kind };
    if (n.kind === "boolean") out.op = n.op;
    else out.params = n.params;
    if (n.position?.some(Boolean)) out.position = n.position;
    if (n.rotation?.some(Boolean)) out.rotation = n.rotation;
    if ((n.scale ?? 1) !== 1) out.scale = n.scale;
    if (top) out.color = n.color;
    if (n.visible === false) out.visible = false;
    if (n.features?.length) out.features = n.features;
    if (top) {
      const r = build.get(n.id);
      if (r?.error) out.error = r.error;
      else if (r) {
        out.bounds = { min: r.bounds[0].map(round), max: r.bounds[1].map(round) };
        out.size = r.bounds[1].map((v, i) => round(v - r.bounds[0][i]));
        if (r.volume != null) out.volume_mm3 = Math.round(r.volume);
      }
    }
    if (n.children) out.children = n.children.map((c) => node(c, false));
    return out;
  };
  return { units: "mm", up: "+Z", objects: doc.nodes.map((n) => node(n, true)) };
}

export function createCommands({ store, viewport, kernel }) {
  const s = store.state;
  const scene = () => summarize(s.doc, s.build);

  async function edit(result, select = true) {
    await store.commit(result.doc, select ? { selection: result.id } : {});
    return { id: result.id, scene: scene() };
  }

  return {
    get_scene: async () => scene(),

    add_shape: (p) => edit(ops.addShape(s.doc, p)),

    update_shape: ({ id, ...patch }) => edit(ops.updateShape(s.doc, id, patch)),

    delete_shape: async ({ id }) => {
      await store.commit(ops.deleteShape(s.doc, id).doc);
      return { deleted: id, scene: scene() };
    },

    boolean: ({ op, ids, name }) => edit(ops.makeBoolean(s.doc, op, ids, name)),

    split_boolean: ({ id }) => edit(ops.splitBoolean(s.doc, id)),

    add_feature: ({ id, feature }) => edit(ops.addFeature(s.doc, id, feature)),

    duplicate: ({ id, offset }) => edit(ops.duplicate(s.doc, id, offset)),

    undo: async () => ({ undone: await store.undo(), scene: scene() }),

    redo: async () => ({ redone: await store.redo(), scene: scene() }),

    new_scene: async () => {
      await store.load(emptyDoc(), "Untitled");
      return { scene: scene() };
    },

    set_scene: async ({ doc }) => {
      await store.load(doc);
      return { scene: scene() };
    },

    screenshot: async ({ view, width, height }) => ({
      png: viewport.screenshot({ view, width: width ?? 1024, height: height ?? 768 }),
    }),

    export_model: async ({ format = "stl", ids }) => {
      const bytes = await kernel.export(s.doc, format, ids);
      let binary = "";
      const view = new Uint8Array(bytes);
      for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
      return { format, base64: btoa(binary), bytes: view.length, name: s.fileName };
    },
  };
}
