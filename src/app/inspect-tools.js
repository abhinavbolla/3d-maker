// Claude's tools for looking inside and checking a model: hide and show
// parts, cut a section, explode the view, and measure. Hiding, the section
// and the exploded view are view state (inspect.js): they change what the
// view and its pictures show, never the model, its exports or its undo
// history. Measurements come from the parts' distance functions
// (kernel/measure.js), as the script places them.

// Densities, g/cm3.
export const DENSITIES = {
  aluminium: 2.7,
  steel: 7.85,
  "stainless steel": 8.0,
  "cast iron": 7.2,
  titanium: 4.43,
  brass: 8.5,
  bronze: 8.8,
  copper: 8.96,
  magnesium: 1.8,
  lead: 11.34,
  gold: 19.3,
  silver: 10.49,
  pla: 1.24,
  abs: 1.04,
  petg: 1.27,
  nylon: 1.14,
  polycarbonate: 1.2,
  acrylic: 1.18,
  "carbon fibre": 1.6,
  "glass fibre": 1.9,
  rubber: 1.2,
  glass: 2.5,
  oak: 0.75,
  pine: 0.5,
  balsa: 0.16,
  concrete: 2.4,
  water: 1.0,
};
const ALIASES = { aluminum: "aluminium", fiberglass: "glass fibre", fibreglass: "glass fibre", "carbon fiber": "carbon fibre", "glass fiber": "glass fibre", stainless: "stainless steel", iron: "cast iron", plexiglass: "acrylic", wood: "oak" };

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const sig = (v, n = 4) => (v === 0 ? 0 : Number(v.toPrecision(n)));
const AXES = { x: 0, y: 1, z: 2 };
// The default view (iso) looks from +x, -y, +z: a cut takes away the side it
// looks from, so the default picture looks into the cut.
const TOWARDS_VIEW = { x: "+", y: "-", z: "+" };
const LOOK_FROM = { "x+": "right", "x-": "left", "y+": "back", "y-": "front", "z+": "top", "z-": "bottom" };

export function densityOf({ material, density_g_cm3 }) {
  if (density_g_cm3 !== undefined) {
    if (!(density_g_cm3 > 0)) throw new Error("density_g_cm3 must be a number above 0.");
    return { density: density_g_cm3, material: material ?? null };
  }
  if (!material) return null;
  const key = String(material).trim().toLowerCase();
  const name = DENSITIES[key] ? key : ALIASES[key];
  if (!name) throw new Error(`No density known for "${material}". Known: ${Object.keys(DENSITIES).join(", ")}. Or give density_g_cm3.`);
  return { density: DENSITIES[name], material: name };
}

export function createInspectCommands({ store, viewport, kernel }) {
  const view = viewport.inspect;
  const result = () => store.state.result;
  // The view's parts: built, with a surface, and not hidden by the script.
  const viewParts = () => (result()?.parts ?? []).filter((p) => !p.hidden && p.mesh.bounds);
  const names = (list, what) => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.some((n) => typeof n !== "string")) throw new Error(`${what} must be a list of part names.`);
    return list;
  };
  const modelBox = (parts = viewParts()) => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const p of parts) for (let i = 0; i < 6; i++) b[i] = i < 3 ? Math.min(b[i], p.mesh.bounds[i]) : Math.max(b[i], p.mesh.bounds[i]);
    return b;
  };
  const done = (extra = {}) => {
    const d = view.describe();
    const { active, line, ...state } = d;
    return { ...extra, view: active ? { ...state, says: line } : "The whole model is shown, uncut and assembled.", note: "This changes only the view and its pictures (screenshot shows it): exports, drawings, check_fit and measure use the whole model as the script places it. clear_view puts the view back." };
  };
  const needModel = () => {
    if (!viewParts().length) throw new Error("There is no model to look at yet.");
  };

  return {
    hide_parts: ({ hide, show, only, all } = {}) => {
      needModel();
      if (only !== undefined && !names(only, "only").length) throw new Error("only must name at least one part.");
      view.setHidden({ hide: names(hide, "hide"), show: names(show, "show"), only: only === undefined ? null : names(only, "only"), all: Boolean(all) });
      const sel = store.state.selected;
      if (sel && view.describe().hidden?.includes(sel)) store.select(null);
      return done();
    },

    section_view: ({ axis, offset, remove, point, normal, uncut, off } = {}) => {
      needModel();
      if (off) {
        view.setSection(null);
        return done();
      }
      let spec;
      const box = modelBox();
      if (point !== undefined || normal !== undefined) {
        if (axis !== undefined) throw new Error("Give either axis (and offset) or point and normal, not both.");
        const vec = (v, what) => {
          if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) throw new Error(`${what} must be [x, y, z].`);
          return v;
        };
        const n = vec(normal ?? [], "normal");
        if (!(Math.hypot(...n) > 0)) throw new Error("normal must not be [0, 0, 0].");
        spec = { point: vec(point ?? [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2], "point"), normal: n };
      } else {
        const a = axis ?? "x";
        if (!(a in AXES)) throw new Error('axis must be "x", "y" or "z".');
        const i = AXES[a];
        const at = offset ?? (box[i] + box[i + 3]) / 2;
        if (!Number.isFinite(at)) throw new Error("offset must be a number of mm.");
        const side = remove ?? TOWARDS_VIEW[a];
        if (side !== "+" && side !== "-") throw new Error('remove must be "+" or "-": the side of the plane that is cut away.');
        const n = [0, 0, 0];
        n[i] = side === "+" ? 1 : -1;
        const p = [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2];
        p[i] = at;
        spec = { point: p, normal: n, axis: a, offset: at };
      }
      const keep = names(uncut, "uncut");
      // Which parts the plane passes through, from their boxes.
      const len = Math.hypot(...spec.normal);
      const through = viewParts().filter((p) => {
        if (keep.includes(p.name)) return false;
        const b = p.mesh.bounds;
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < 8; k++) {
          const c = [k & 1 ? b[3] : b[0], k & 2 ? b[4] : b[1], k & 4 ? b[5] : b[2]];
          const s = ((c[0] - spec.point[0]) * spec.normal[0] + (c[1] - spec.point[1]) * spec.normal[1] + (c[2] - spec.point[2]) * spec.normal[2]) / len;
          lo = Math.min(lo, s);
          hi = Math.max(hi, s);
        }
        return lo < 0 && hi > 0;
      });
      if (!through.length) {
        const range = spec.axis ? ` The model reaches from ${r1(box[AXES[spec.axis]])} to ${r1(box[AXES[spec.axis] + 3])} mm along ${spec.axis}.` : "";
        throw new Error(`That plane misses the model, or only cuts parts left uncut.${range}`);
      }
      view.setSection({ ...spec, uncut: keep });
      const extra = { parts_cut: through.map((p) => p.name) };
      if (spec.axis) extra.look_into_it_from = LOOK_FROM[`${spec.axis}${spec.normal[AXES[spec.axis]] > 0 ? "+" : "-"}`];
      return done(extra);
    },

    explode_view: ({ factor = 1, axis, together } = {}) => {
      needModel();
      if (!(factor >= 0 && factor <= 1)) throw new Error("factor must be from 0 (assembled) to 1 (fully apart).");
      if (axis !== undefined && !(axis in AXES)) throw new Error('axis must be "x", "y" or "z", or left out to move parts away from the middle.');
      const plan = store.state.doc.plan;
      const by = together ?? (plan ? "steps" : "parts");
      if (by !== "steps" && by !== "parts") throw new Error('together must be "steps" or "parts".');
      if (by === "steps" && !plan) throw new Error('There is no plan, so no steps to keep together. Use together: "parts".');
      view.setExplode({ factor, axis: axis ?? null, groups: by === "steps" ? plan.steps.map((s) => s.parts) : [] });
      return done({ together: factor ? by : undefined });
    },

    clear_view: () => {
      view.clear();
      return done();
    },

    // part / parts: size, volume, area, centre of mass and, with a material
    // or density, mass. between: the nearest two points of two parts.
    // points: the distance between two points.
    measure: async ({ part, parts, material, density_g_cm3, between, points } = {}) => {
      const out = {};
      const all = new Map((result()?.parts ?? []).filter((p) => !p.hidden).map((p) => [p.name, p]));
      const find = (n) => {
        const p = all.get(n);
        if (!p) throw new Error(`There is no part named "${n}". Parts: ${[...all.keys()].join(", ")}.`);
        if (!p.mesh.bounds) throw new Error(`Part "${n}" has no surface to measure.`);
        return p;
      };
      const asked = [...(part !== undefined ? [part] : []), ...names(parts, "parts")];
      const dens = densityOf({ material, density_g_cm3 });
      if (!asked.length && !between && !points) throw new Error("Say what to measure: part or parts, between (two part names) or points (two points).");
      if (points !== undefined) {
        if (!Array.isArray(points) || points.length !== 2 || !points.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) throw new Error("points must be two points, [[x, y, z], [x, y, z]], in mm.");
        const [a, b] = points;
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        out.points = { distance_mm: r2(Math.hypot(...d)), dx_mm: r2(d[0]), dy_mm: r2(d[1]), dz_mm: r2(d[2]) };
      }
      const jobs = [];
      if (asked.length) {
        const list = [...new Set(asked)].map(find);
        jobs.push(
          kernel.measureSolids(list).then((solids) => {
            out.parts = list.map((p, i) => {
              const s = solids[i];
              const b = p.mesh.bounds;
              const e = { name: p.name, size_mm: [0, 1, 2].map((k) => r1(b[k + 3] - b[k])), min_mm: b.slice(0, 3).map(r1), max_mm: b.slice(3).map(r1), volume_cm3: sig(s.volume / 1000), surface_area_cm2: sig(p.mesh.area / 100, 3), centre_of_mass_mm: s.centre?.map(r1) ?? null };
              if (dens) e.mass_g = sig((s.volume / 1000) * dens.density);
              return e;
            });
            if (list.length > 1) {
              const v = solids.reduce((t, s) => t + s.volume, 0);
              const com = v > 0 ? [0, 1, 2].map((k) => solids.reduce((t, s) => t + (s.centre ? s.centre[k] * s.volume : 0), 0) / v) : null;
              out.total = { volume_cm3: sig(v / 1000), centre_of_mass_mm: com?.map(r1) ?? null };
              if (dens) out.total.mass_g = sig((v / 1000) * dens.density);
            }
            if (dens) out.density_g_cm3 = dens.density;
            if (dens?.material) out.material = dens.material;
          }),
        );
      }
      if (between !== undefined) {
        const pair = names(between, "between");
        if (pair.length !== 2 || pair[0] === pair[1]) throw new Error("between must name two different parts.");
        const [A, B] = pair.map(find);
        jobs.push(
          kernel.measureGap(A, B).then((g) => {
            if (!g) throw new Error("Could not find how close these parts come.");
            if (g.overlap !== undefined) out.between = { a: A.name, b: B.name, distance_mm: 0, overlap_mm: r2(g.overlap), note: "These parts pass into each other; check_fit says where and how much." };
            else {
              out.between = { a: A.name, b: B.name, distance_mm: r2(g.gap) };
              if (g.a) Object.assign(out.between, { nearest_on_a_mm: g.a.map(r2), nearest_on_b_mm: g.b.map(r2) });
              if (g.gap - g.least > Math.max(0.05, g.cell * 4)) out.between.at_least_mm = r2(g.least);
            }
          }),
        );
      }
      await Promise.all(jobs);
      out.note = "From the exact shapes, as the script places them (not moved by motion or the exploded view). Volume and centre of mass are good to about 0.1%, surface area (from the mesh) to about 1%.";
      return out;
    },
  };
}

// The one line by the prompt box that says what the view leaves out, while
// anything is hidden, cut or exploded. A click on it, or Esc, clears it.
export function mountInspectLine({ viewport, dock, before }) {
  const line = document.createElement("button");
  line.type = "button";
  line.id = "inspect-line";
  line.hidden = true;
  line.title = "Show the whole model again (Esc)";
  const text = document.createElement("span");
  const x = document.createElement("span");
  x.className = "clear";
  x.textContent = "×";
  x.setAttribute("aria-hidden", "true");
  line.append(text, x);
  line.setAttribute("aria-label", "");
  dock.insertBefore(line, before);
  const update = () => {
    const d = viewport.inspect.describe();
    line.hidden = !d.active;
    text.textContent = d.line;
    line.setAttribute("aria-label", d.active ? `${d.line}. Show the whole model again.` : "");
  };
  viewport.inspect.subscribe(update);
  line.addEventListener("click", () => viewport.inspect.clear());
  // Esc: true when there was something to clear.
  return () => {
    if (!viewport.inspect.describe().active) return false;
    viewport.inspect.clear();
    return true;
  };
}
