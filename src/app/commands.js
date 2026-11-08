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
  if (res.motion) out.motion = { loop_seconds: res.motion.loop, joints: res.motion.joints, links: res.motion.links };
  if (res.warnings?.length) out.warnings = res.warnings;
  if (res.prints?.length) out.printed = res.prints;
  if (state.selected) out.selected_by_user = state.selected;
  if (state.doc.plan) out.plan = planProgress(state.doc.plan);
  return out;
}

export function planProgress(plan) {
  const done = plan.steps.filter((s) => s.done).length;
  const next = plan.steps.find((s) => !s.done);
  return { done, total: plan.steps.length, next: next?.name ?? null, steps: plan.steps.map((s) => ({ name: s.name, parts: s.parts, done: s.done })) };
}

const MAX_STEPS = 40;
const OVERLAP_NOTE = "These parts pass into each other by overlap_mm, volume_cm3 in all (at at_seconds into the motion, for moving parts); where is the box around the overlap. Solid parts should touch, not overlap: where one part fits into another (a shaft into a hub, a blade root into a grip, a bolt into a plate), cut a hole for it; otherwise move or resize them. Overlap around a joint() is left out. Threads count as fitting when they mate. Fix every one before you finish.";
// Added when an overlap is between parts that share joints.
const JOINT_NOTE = "joints: how many joint()s the two parts share. The overlap close around each joint is left out, so what is listed is somewhere else. One joint() covers one connection: where a part is several copies (radial, array), each copy has its own connection, and copies that move on their own (pitch links, blade grips, wheels on their own axles) must be separate parts, each with its own joint().";
const overlapsNote = (overlaps) => (overlaps.some((o) => o.joints) ? `${OVERLAP_NOTE} ${JOINT_NOTE}` : OVERLAP_NOTE);

export function createCommands({ store, viewport, kernel }) {
  // An exported file, as the MCP server takes it back.
  const exported = (r) => {
    let bin = "";
    for (let i = 0; i < r.bytes.length; i += 0x8000) bin += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000));
    return { name: store.state.result?.title || "model", base64: btoa(bin), triangles: r.triangles, bytes: r.bytes.length };
  };
  const partsByName = () => new Map((store.state.result?.parts ?? []).map((p) => [p.name, p]));
  // Pictures for Claude show the fine detail: wait for the background pass
  // (at most 15 s; after that the preview is shown).
  const fineDetail = () => store.state.refining && Promise.race([store.state.refining, new Promise((r) => setTimeout(r, 15000))]);

  // Overlaps (and for two parts, the gap) from the last good build.
  const checkFit = async (names) => {
    const res = store.state.result;
    if (!res?.parts.length) return { overlaps: [], pairs: 0 };
    const { pairs, results } = await kernel.checkFit(res, { names });
    return { pairs, overlaps: results.filter((r) => r.overlap_mm), gaps: results.filter((r) => r.gap_mm !== undefined) };
  };

  const setScript = async (script) => {
    if (typeof script !== "string" || !script.trim()) throw new Error("script is empty");
    try {
      await store.commit({ ...store.state.doc, script });
    } catch (err) {
      throw new Error(`${err.message}\nThe model was not changed.`);
    }
    viewport.fitIfNew();
    // A plan for a different model (none of its parts are here) is stale.
    const plan = store.state.doc.plan;
    if (plan && !plan.steps.some((s) => s.parts.some((p) => partsByName().has(p)))) store.setPlan(null);
    return summarize(store.state);
  };

  return {
    set_plan: ({ steps }) => {
      if (!Array.isArray(steps) || steps.length < 2) throw new Error("A plan needs at least 2 steps.");
      if (steps.length > MAX_STEPS) throw new Error(`A plan can have at most ${MAX_STEPS} steps; group smaller pieces into one step.`);
      const old = new Map((store.state.doc.plan?.steps ?? []).map((s) => [s.name, s]));
      const names = new Set();
      const owner = new Map();
      const plan = {
        steps: steps.map((s, i) => {
          const name = String(s?.name ?? "").trim();
          if (!name) throw new Error(`Step ${i + 1} has no name.`);
          if (names.has(name)) throw new Error(`Two steps are named "${name}".`);
          names.add(name);
          const parts = [...new Set((s.parts ?? []).map((p) => String(p).trim()).filter(Boolean))];
          if (!parts.length) throw new Error(`Step "${name}" lists no parts. Name the parts it will create, exactly as you will pass them to part().`);
          for (const p of parts) {
            if (owner.has(p)) throw new Error(`Part "${p}" is in two steps ("${owner.get(p)}" and "${name}"). Each part belongs to one step.`);
            owner.set(p, name);
          }
          const prev = old.get(name);
          const same = prev && prev.parts.length === parts.length && prev.parts.every((p) => parts.includes(p));
          return { name, parts, done: Boolean(same && prev.done) };
        }),
      };
      store.setPlan(plan);
      return planProgress(plan);
    },
    finish_step: async ({ step }) => {
      const plan = store.state.doc.plan;
      if (!plan) throw new Error("There is no plan. Call set_plan first.");
      const s = plan.steps.find((x) => x.name === step);
      if (!s) throw new Error(`There is no step named "${step}". Steps: ${plan.steps.map((x) => x.name).join(", ")}.`);
      const have = partsByName();
      const missing = s.parts.filter((p) => !have.has(p));
      const empty = s.parts.filter((p) => have.has(p) && !have.get(p).mesh.bounds);
      if (missing.length || empty.length) {
        const why = [missing.length && `missing: ${missing.join(", ")}`, empty.length && `empty (no surface): ${empty.join(", ")}`].filter(Boolean).join("; ");
        throw new Error(`Step "${step}" is not finished. Its parts are ${why}. Add or fix them, then call finish_step again. Part names must match the plan exactly.`);
      }
      const [fit] = await Promise.all([checkFit(s.parts), fineDetail()]);
      const updated = { steps: plan.steps.map((x) => (x === s ? { ...x, done: true } : x)) };
      store.setPlan(updated);
      const summary = summarize(store.state);
      return {
        step: s.name,
        parts: summary.parts.filter((p) => s.parts.includes(p.name)),
        ...(fit.overlaps.length ? { overlaps: fit.overlaps, overlaps_note: overlapsNote(fit.overlaps) } : {}),
        plan: planProgress(updated),
        png: viewport.screenshot({ view: "iso", parts: s.parts, ghost: true, width: 900, height: 700 }),
      };
    },
    append_to_model: ({ code }) => {
      if (typeof code !== "string" || !code.trim()) throw new Error("code is empty");
      const s = store.state.doc.script;
      return setScript(s ? `${s.replace(/\s*$/, "")}\n\n${code.trim()}\n` : code);
    },
    get_model: async () => ({ script: store.state.doc.script, values: store.state.doc.values, ...summarize(store.state) }),
    set_model: ({ script }) => setScript(script),
    edit_model: ({ old_text, new_text }) => {
      const s = store.state.doc.script;
      const at = s.indexOf(old_text);
      if (!old_text || at < 0) throw new Error("old_text was not found in the script. Call get_model to see the current script.");
      if (s.indexOf(old_text, at + 1) >= 0) throw new Error("old_text appears more than once; include more surrounding text.");
      return setScript(s.slice(0, at) + new_text + s.slice(at + old_text.length));
    },
    check_fit: async ({ parts } = {}) => {
      if (parts !== undefined && (!Array.isArray(parts) || !parts.length)) throw new Error("parts must be a list of part names, or left out to check every part.");
      const { pairs, overlaps, gaps } = await checkFit(parts);
      const out = { checked_pairs: pairs, overlaps };
      if (parts?.length === 2) out.gap_mm = overlaps.length ? 0 : gaps[0]?.gap_mm ?? null;
      if (overlaps.length) out.overlaps_note = overlapsNote(overlaps);
      else out.note = store.state.result?.motion ? "No parts pass into each other, at rest or during the motion." : "No parts pass into each other.";
      return out;
    },
    screenshot: async ({ view, width, height, part, parts, at } = {}) => (await fineDetail(), { png: viewport.screenshot({ view, width, height, at, parts: parts ?? (part ? [part] : undefined), ghost: Boolean(parts) }) }),
    export_stl: async ({ solid = false } = {}) => exported(await kernel.exportSTL(store.state.result?.parts ?? [], { solid: Boolean(solid) })),
    export_3mf: async () => exported(await kernel.export3MF(store.state.result?.parts ?? [], store.state.result?.title ?? "")),
  };
}
