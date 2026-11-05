// What Claude can do in the app, called through the MCP bridge.
const r1 = (v) => Math.round(v * 10) / 10;

export function summarize(state) {
  const res = state.result;
  const out = { title: res?.title || "", parts: [], params: [] };
  if (!res) return out;
  let all = null;
  for (const p of res.parts) {
    const b = p.mesh.bounds;
    const entry = { name: p.name, color: p.color };
    if (!b) entry.empty = "This part has no surface. It was cut away completely, or is thinner than the mesh detail.";
    else {
      entry.min = b.slice(0, 3).map(r1);
      entry.max = b.slice(3).map(r1);
      entry.size = [0, 1, 2].map((i) => r1(b[i + 3] - b[i]));
      entry.volume_cm3 = r1(p.mesh.volume / 1000);
      entry.detail_mm = r1(p.mesh.cellSize);
      all = all ? all.map((v, i) => (i < 3 ? Math.min(v, b[i]) : Math.max(v, b[i]))) : [...b];
    }
    if (p.motion.length) entry.motion = p.motion;
    if (p.hidden) entry.hidden = true;
    out.parts.push(entry);
  }
  if (all) out.overall = { min: all.slice(0, 3).map(r1), max: all.slice(3).map(r1), size: [0, 1, 2].map((i) => r1(all[i + 3] - all[i])) };
  out.params = res.params.map(({ key, value, min, max }) => ({ key, value, min, max }));
  if (res.warnings?.length) out.warnings = res.warnings;
  if (res.prints?.length) out.printed = res.prints;
  if (state.selected) out.selected_by_user = state.selected;
  return out;
}

export function createCommands({ store, viewport, kernel }) {
  const setScript = async (script) => {
    if (typeof script !== "string" || !script.trim()) throw new Error("script is empty");
    try {
      await store.commit({ ...store.state.doc, script });
    } catch (err) {
      throw new Error(`${err.message}\nThe model was not changed.`);
    }
    viewport.fitIfNew();
    return summarize(store.state);
  };

  return {
    get_model: async () => ({ script: store.state.doc.script, values: store.state.doc.values, ...summarize(store.state) }),
    set_model: ({ script }) => setScript(script),
    edit_model: ({ old_text, new_text }) => {
      const s = store.state.doc.script;
      const at = s.indexOf(old_text);
      if (!old_text || at < 0) throw new Error("old_text was not found in the script. Call get_model to see the current script.");
      if (s.indexOf(old_text, at + 1) >= 0) throw new Error("old_text appears more than once; include more surrounding text.");
      return setScript(s.slice(0, at) + new_text + s.slice(at + old_text.length));
    },
    screenshot: async ({ view, width, height, part } = {}) => ({ png: viewport.screenshot({ view, width, height, part }) }),
    export_stl: async () => {
      const r = await kernel.exportSTL(store.state.result?.parts ?? []);
      let bin = "";
      for (let i = 0; i < r.bytes.length; i += 0x8000) bin += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000));
      return { name: store.state.result?.title || "model", base64: btoa(bin), triangles: r.triangles, bytes: r.bytes.length };
    },
  };
}
