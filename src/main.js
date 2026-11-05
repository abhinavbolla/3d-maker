import { createKernelClient } from "./app/kernel-client.js";
import { createStore } from "./app/store.js";
import { createViewport } from "./app/viewport.js";
import { createCommands } from "./app/commands.js";
import { startBridge } from "./app/bridge.js";
import { saveBytes, openText } from "./app/files.js";
import { loadAutosave } from "./app/autosave.js";
import * as ops from "./model/ops.js";
import { KINDS, emptyDoc, EDGE_SETS } from "./model/schema.js";

const $ = (sel) => document.querySelector(sel);
const kernel = createKernelClient();
const store = createStore(kernel, await loadAutosave());
const s = store.state;

// Objects picked for a boolean, in click order. ids[0] is the target.
let picked = [];

const PALETTE = ["#9aa3ad", "#d9d4c7", "#c8553d", "#e0a33b", "#5f8d4e", "#3f7cac", "#6c5b7b", "#2b2f33"];
const LABELS = { box: "Box", cylinder: "Cylinder", cone: "Cone", sphere: "Sphere", torus: "Torus", extrude: "Extrude", revolve: "Revolve" };

// ---------- helpers ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let messageTimer = 0;
function message(text, kind = "info") {
  const el = $("#message");
  el.textContent = text;
  el.className = kind === "error" ? "error" : "";
  clearTimeout(messageTimer);
  if (kind !== "error") messageTimer = setTimeout(() => (el.textContent = ""), 4000);
}

async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    message(String(err?.message ?? err), "error");
  }
}

const edit = (result, select = true) => run(() => store.commit(result.doc, select ? { selection: result.id } : {}));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const fmt = (v) => (Math.round(v * 100) / 100).toString();

// ---------- viewport ----------
const viewport = createViewport($("#viewport"), {
  onSelect: (id, e) => {
    if (id && (e.shiftKey || e.metaKey)) togglePick(id);
    else {
      picked = id ? [id] : [];
      store.select(id);
    }
    renderTree();
  },
  onTransform: (id, t) => edit(ops.updateShape(s.doc, id, t)),
});

$("#modes").addEventListener("click", (e) => {
  const mode = e.target.dataset.mode;
  if (mode) setMode(mode);
});
function setMode(mode) {
  viewport.setMode(mode);
  for (const b of $("#modes").children) b.classList.toggle("on", b.dataset.mode === mode);
}
$("#views").addEventListener("click", (e) => e.target.dataset.view && viewport.setView(e.target.dataset.view));
$("#snap").addEventListener("click", () => {
  viewport.setSnap(!viewport.getSnap());
  $("#snap").classList.toggle("on", viewport.getSnap());
});

// ---------- add panel ----------
for (const kind of Object.keys(KINDS)) {
  $("#add-grid").append(
    h("button", { title: KINDS[kind].about, onclick: () => addKind(kind) }, LABELS[kind]),
  );
}

// Half-width and lift so a new default shape sits on the ground beside the others.
const PLACEMENT = { box: [10, 0], cylinder: [10, 0], cone: [10, 0], sphere: [10, 10], torus: [19, 4], extrude: [10, 0], revolve: [10, 0] };

function addKind(kind) {
  const [half, lift] = PLACEMENT[kind];
  let maxX = null;
  for (const r of s.build.values()) if (!r.error) maxX = Math.max(maxX ?? -Infinity, r.bounds[1][0]);
  const x = maxX === null ? 0 : Math.ceil(maxX + 15 + half);
  const result = ops.addShape(s.doc, { kind, position: [x, 0, lift] });
  picked = [result.id];
  edit(result);
}

// ---------- object tree ----------
function togglePick(id) {
  const top = s.doc.nodes.some((n) => n.id === id);
  if (!top) return message("Only top-level objects can be combined.", "error");
  picked = picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id];
  store.select(picked.at(-1) ?? null);
}

function renderTree() {
  const tree = $("#tree");
  tree.replaceChildren();
  const row = (node, depth) => {
    const r = s.build.get(node.id);
    const isPicked = picked.includes(node.id) && picked.length > 1;
    const li = h(
      "li",
      {},
      h(
        "div",
        {
          class: ["row", s.selection === node.id && "selected", r?.error && "error", node.visible === false && "hidden"].filter(Boolean).join(" "),
          title: r?.error ?? "",
          onclick: (e) => {
            if (e.shiftKey || e.metaKey) togglePick(node.id);
            else {
              picked = [node.id];
              store.select(node.id);
            }
            renderTree();
          },
        },
        h("span", { class: "swatch", style: `background:${node.color}` }),
        h("span", { class: "name" }, node.name),
        isPicked ? h("span", { class: `tag ${picked[0] === node.id ? "target" : ""}` }, picked[0] === node.id ? "target" : `tool ${picked.indexOf(node.id)}`) : null,
        node.kind === "boolean" ? h("span", { class: "tag" }, node.op) : null,
        depth === 0
          ? h(
              "button",
              {
                class: "eye",
                title: node.visible === false ? "Show" : "Hide",
                onclick: (e) => {
                  e.stopPropagation();
                  edit(ops.updateShape(s.doc, node.id, { visible: node.visible === false }), false);
                },
              },
              node.visible === false ? "show" : "hide",
            )
          : null,
      ),
    );
    if (node.children) li.append(h("ul", {}, node.children.map((c) => row(c, depth + 1))));
    return li;
  };
  s.doc.nodes.forEach((n) => tree.append(row(n, 0)));
  $("#tree-hint").hidden = s.doc.nodes.length > 0;
  const canCombine = picked.length >= 2 && picked.every((id) => s.doc.nodes.some((n) => n.id === id));
  for (const op of ["union", "subtract", "intersect"]) document.querySelector(`[data-action="${op}"]`).disabled = !canCombine;
}

// ---------- properties ----------
let propsPending = false;
const propsEl = $("#props");
propsEl.addEventListener("focusout", () => {
  if (propsPending) setTimeout(() => !propsEl.contains(document.activeElement) && renderProps(), 0);
});

function numberInput(value, onCommit, attrs = {}) {
  return h("input", {
    type: "number",
    step: "any",
    value: fmt(value),
    ...attrs,
    onchange: (e) => {
      const v = num(e.target.value);
      if (v === null) return message("Enter a number.", "error");
      onCommit(v);
    },
    onkeydown: (e) => e.key === "Enter" && e.target.blur(),
  });
}

function field(label, control) {
  return h("div", { class: "field" }, h("label", {}, label), control);
}

function vecField(label, values, onCommit) {
  return field(
    label,
    h(
      "div",
      { class: "vec" },
      values.map((v, i) =>
        numberInput(v, (nv) => {
          const next = [...values];
          next[i] = nv;
          onCommit(next);
        }, { title: "XYZ"[i] }),
      ),
    ),
  );
}

function featureEditor(node, f, index) {
  const update = (patch) => {
    const features = node.features.map((g, i) => (i === index ? { ...g, ...patch } : g));
    edit(ops.updateShape(s.doc, node.id, { features }));
  };
  const remove = () => edit(ops.updateShape(s.doc, node.id, { features: node.features.filter((_, i) => i !== index) }));
  const rows = [];
  if (f.type === "fillet") rows.push(field("Radius", numberInput(f.radius, (v) => update({ radius: v }), { min: 0 })));
  if (f.type === "chamfer") rows.push(field("Distance", numberInput(f.distance, (v) => update({ distance: v }), { min: 0 })));
  if (f.type === "fillet" || f.type === "chamfer")
    rows.push(field("Edges", h("select", { onchange: (e) => update({ edges: e.target.value }) }, EDGE_SETS.map((v) => h("option", { value: v, selected: (f.edges ?? "all") === v }, v)))));
  if (f.type === "shell") {
    rows.push(field("Wall", numberInput(f.thickness, (v) => update({ thickness: v }), { min: 0 })));
    rows.push(field("Open face", h("select", { onchange: (e) => update({ open: e.target.value }) }, ["top", "bottom"].map((v) => h("option", { value: v, selected: (f.open ?? "top") === v }, v)))));
  }
  const title = { fillet: "Fillet", chamfer: "Chamfer", shell: "Shell" }[f.type];
  return h("div", { class: "feature" }, h("div", { class: "feature-head" }, title, h("button", { onclick: remove, title: "Remove" }, "Remove")), rows);
}

function renderProps() {
  if (propsEl.contains(document.activeElement) && document.activeElement !== document.body) {
    propsPending = true;
    return;
  }
  propsPending = false;
  propsEl.replaceChildren();
  const found = s.selection && ops.findNode(s.doc, s.selection);
  if (!found) {
    propsEl.append(h("div", { class: "props-empty" }, "Select an object to edit it. Drag to orbit, right-drag to pan, scroll to zoom."));
    return;
  }
  const { node, parent } = found;
  const set = (patch) => edit(ops.updateShape(s.doc, node.id, patch));
  const top = !parent;
  const r = top ? s.build.get(node.id) : null;

  const main = h("section", {}, h("h2", {}, node.kind === "boolean" ? `Boolean · ${node.op}` : LABELS[node.kind]));
  if (parent) main.append(h("p", { class: "hint" }, `Input of “${parent.name}”. Highlighted in blue.`));
  if (r?.error) main.append(h("div", { class: "error-box" }, r.error));
  main.append(field("Name", h("input", { value: node.name, onchange: (e) => set({ name: e.target.value || node.name }) })));
  if (top) {
    main.append(
      field(
        "Color",
        h(
          "div",
          { class: "swatches" },
          PALETTE.map((c) => h("button", { class: node.color === c ? "on" : "", style: `background:${c}`, title: c, onclick: () => set({ color: c }) })),
          h("input", { type: "color", value: node.color, onchange: (e) => set({ color: e.target.value }) }),
        ),
      ),
    );
  }
  if (node.kind === "boolean") {
    main.append(field("Operation", h("select", { onchange: (e) => set({ op: e.target.value }) }, ["union", "subtract", "intersect"].map((v) => h("option", { value: v, selected: node.op === v }, v)))));
  }
  propsEl.append(main);

  if (node.kind !== "boolean") {
    const params = h("section", {}, h("h2", {}, "Size"));
    for (const [k, v] of Object.entries(node.params)) {
      if (Array.isArray(v)) {
        params.append(
          field(
            k === "points" && node.kind === "revolve" ? "Profile [r, z]" : "Points [x, y]",
            h("textarea", {
              spellcheck: "false",
              onchange: (e) => {
                try {
                  set({ params: { [k]: JSON.parse(e.target.value) } });
                } catch {
                  message("Points must be JSON, like [[0,0],[10,0],[10,10]].", "error");
                }
              },
            }, JSON.stringify(v)),
          ),
        );
      } else {
        params.append(field(k, numberInput(v, (nv) => set({ params: { [k]: nv } }), { min: 0 })));
      }
    }
    propsEl.append(params);
  }

  const tf = h("section", {}, h("h2", {}, "Transform"));
  tf.append(vecField("Position", node.position ?? [0, 0, 0], (v) => set({ position: v })));
  tf.append(vecField("Rotation°", node.rotation ?? [0, 0, 0], (v) => set({ rotation: v })));
  tf.append(field("Scale", numberInput(node.scale ?? 1, (v) => set({ scale: v }), { min: 0 })));
  propsEl.append(tf);

  const feats = h("section", {}, h("h2", {}, "Features"));
  (node.features ?? []).forEach((f, i) => feats.append(featureEditor(node, f, i)));
  const defaults = { fillet: { type: "fillet", radius: 1, edges: "all" }, chamfer: { type: "chamfer", distance: 1, edges: "all" }, shell: { type: "shell", thickness: 2, open: "top" } };
  feats.append(
    h("div", { class: "row-buttons" }, Object.keys(defaults).map((t) => h("button", { onclick: () => edit(ops.addFeature(s.doc, node.id, defaults[t])) }, `+ ${t[0].toUpperCase()}${t.slice(1)}`))),
  );
  propsEl.append(feats);

  if (r && !r.error) {
    const [mn, mx] = r.bounds;
    const size = mx.map((v, i) => fmt(v - mn[i])).join(" × ");
    propsEl.append(
      h(
        "section",
        {},
        h("h2", {}, "Measure"),
        h("div", { class: "measure" }, h("span", {}, "Size"), h("span", {}, `${size} mm`), h("span", {}, "Volume"), h("span", {}, r.volume != null ? `${(r.volume / 1000).toFixed(2)} cm³` : "–")),
      ),
    );
  }

  const actions = h("section", {}, h("div", { class: "row-buttons" },
    top ? h("button", { onclick: () => edit(ops.duplicate(s.doc, node.id, [10, 10, 0])) }, "Duplicate") : null,
    node.kind === "boolean" && top ? h("button", { onclick: () => edit(ops.splitBoolean(s.doc, node.id)) }, "Split") : null,
    h("button", { onclick: () => deleteSelected() }, "Delete"),
  ));
  propsEl.append(actions);
}

// ---------- actions ----------
function deleteSelected() {
  if (!s.selection) return;
  picked = [];
  edit(ops.deleteShape(s.doc, s.selection), false);
}

function combine(op) {
  const result = ops.makeBoolean(s.doc, op, picked);
  picked = [result.id];
  edit(result);
}

function exportName(ext) {
  return `${s.fileName.replace(/\.3dm\.json$|\.json$/i, "") || "model"}.${ext}`;
}

const actions = {
  new: () => {
    const had = s.doc.nodes.length > 0;
    picked = [];
    run(async () => {
      await store.load(emptyDoc(), "Untitled");
      if (had) message("New scene. Undo brings the previous one back.");
    });
  },
  open: () =>
    run(async () => {
      const file = await openText();
      if (!file) return;
      const doc = JSON.parse(file.text);
      if (doc?.version !== 1 || !Array.isArray(doc.nodes)) throw new Error("This is not a 3D Maker scene file.");
      picked = [];
      await store.load(doc, file.name);
      viewport.setView("iso");
      message(`Opened ${file.name}`);
    }),
  save: () =>
    run(async () => {
      const name = s.fileName.endsWith(".json") ? s.fileName : `${s.fileName}.3dm.json`;
      const path = await saveBytes(new TextEncoder().encode(JSON.stringify(s.doc, null, 2)), name, "json");
      if (path) {
        s.fileName = path.split("/").pop();
        s.dirty = false;
        renderTitle();
        message(`Saved ${s.fileName}`);
      }
    }),
  undo: () => run(() => store.undo()),
  redo: () => run(() => store.redo()),
  "export-stl": () => run(() => exportAs("stl")),
  "export-step": () => run(() => exportAs("step")),
  union: () => run(() => combine("union")),
  subtract: () => run(() => combine("subtract")),
  intersect: () => run(() => combine("intersect")),
  connect: () => openConnect(),
};

async function exportAs(format) {
  const bytes = await kernel.export(s.doc, format);
  const path = await saveBytes(new Uint8Array(bytes), exportName(format), format);
  if (path) message(`Exported ${path.split("/").pop()} (${Math.round(bytes.byteLength / 1024)} KB)`);
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (btn && actions[btn.dataset.action]) actions[btn.dataset.action]();
});

document.addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "");
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") {
    if (typing) return;
    e.preventDefault();
    e.shiftKey ? actions.redo() : actions.undo();
  } else if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    actions.save();
  } else if (mod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    actions.open();
  } else if (mod && e.key.toLowerCase() === "d" && s.selection && !typing) {
    e.preventDefault();
    run(() => edit(ops.duplicate(s.doc, s.selection, [10, 10, 0])));
  } else if (typing || mod) {
    return;
  } else if (e.key === "Delete" || e.key === "Backspace") {
    deleteSelected();
  } else if (e.key === "Escape") {
    picked = [];
    store.select(null);
    renderTree();
  } else if (e.key === "w") setMode("translate");
  else if (e.key === "e") setMode("rotate");
  else if (e.key === "r") setMode("scale");
  else if (e.key === "f") viewport.setView("iso");
});

// ---------- connect dialog ----------
const serverPath = __MCP_SERVER_PATH__;
const nodePath = __NODE_PATH__;
$("#cmd-code").textContent = `claude mcp add --scope user 3d-maker -- "${nodePath}" "${serverPath}"`;
$("#cmd-desktop").textContent = JSON.stringify({ mcpServers: { "3d-maker": { command: nodePath, args: [serverPath] } } }, null, 2);
$("#connect").addEventListener("click", async (e) => {
  const id = e.target.dataset?.copy;
  if (!id) return;
  try {
    await navigator.clipboard.writeText($(`#${id}`).textContent);
    e.target.textContent = "Copied";
    setTimeout(() => (e.target.textContent = "Copy"), 1500);
  } catch {
    message("Could not copy. Select the text and copy it by hand.", "error");
  }
});
function openConnect() {
  $("#connect").showModal();
}

let claudeCount = 0;
function renderClaude() {
  const el = $("#claude-status");
  el.classList.toggle("on", claudeCount > 0);
  el.querySelector(".label").textContent = claudeCount ? (claudeCount > 1 ? `Claude connected (${claudeCount})` : "Claude connected") : "Claude not connected";
  $("#connect-state").textContent = claudeCount ? "Status: Claude is connected." : "Status: waiting for Claude. The MCP server starts when Claude Code or Claude Desktop starts.";
}

// ---------- render loop ----------
function renderTitle() {
  $("#file-name").textContent = s.fileName + (s.dirty ? " •" : "");
}

store.subscribe((state, what) => {
  if (what === "building") return;
  if (what === "build" || what === "doc") {
    viewport.setScene(state.doc.nodes, state.build, state.ghost);
  }
  picked = picked.filter((id) => ops.findNode(state.doc, id));
  viewport.select(state.selection && state.doc.nodes.some((n) => n.id === state.selection) ? state.selection : null);
  renderTree();
  renderProps();
  renderTitle();
  $("[data-action=undo]").disabled = !state.past.length;
  $("[data-action=redo]").disabled = !state.future.length;
});

const commands = createCommands({ store, viewport, kernel });
let activityTimer = 0;
startBridge(commands, {
  onStatus: (n) => {
    claudeCount = n;
    renderClaude();
  },
  onActivity: (method, phase, err) => {
    const el = $("#activity");
    clearTimeout(activityTimer);
    if (phase === "start") el.textContent = `Claude: ${method.replace(/_/g, " ")}…`;
    else {
      el.textContent = phase === "error" ? `Claude: ${method.replace(/_/g, " ")} failed` : `Claude: ${method.replace(/_/g, " ")}`;
      activityTimer = setTimeout(() => (el.textContent = ""), 3000);
    }
  },
});

kernel
  .ready()
  .then(() => store.rebuild())
  .then(() => {
    $("#loading").hidden = true;
    viewport.setView("iso");
  })
  .catch((err) => {
    $("#loading").textContent = `The geometry kernel failed to load: ${err.message}`;
  });

renderClaude();
renderTree();
renderProps();
