// Pure edit operations on a scene document. Each returns a new document
// (the old one is untouched, which is what makes undo cheap and safe).
import { KINDS, BOOLEAN_OPS, DEFAULT_COLOR, validateNode } from "./schema.js";

const clone = (v) => structuredClone(v);

function nextId(doc) {
  let max = 0;
  walk(doc.nodes, (n) => {
    const m = /^n(\d+)$/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return `n${max + 1}`;
}

export function walk(nodes, fn, parent = null) {
  for (const n of nodes) {
    fn(n, parent);
    if (n.children) walk(n.children, fn, n);
  }
}

export function findNode(doc, id) {
  let found = null;
  walk(doc.nodes, (n, parent) => {
    if (n.id === id) found = { node: n, parent };
  });
  return found;
}

function mustFind(doc, id) {
  const f = findNode(doc, id);
  if (!f) throw new Error(`No object with id "${id}". Call get_scene to see the current ids.`);
  return f;
}

function defaultName(doc, kind) {
  const base = kind[0].toUpperCase() + kind.slice(1);
  let i = 1;
  const names = new Set();
  walk(doc.nodes, (n) => names.add(n.name));
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

export function addShape(doc, { kind, params, position, rotation, scale, color, name, features }) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unknown kind "${kind}". Use one of: ${Object.keys(KINDS).join(", ")}`);
  const next = clone(doc);
  const node = {
    id: nextId(doc),
    name: name || defaultName(doc, kind),
    kind,
    params: { ...clone(spec.params), ...(params ?? {}) },
    position: position ?? [0, 0, 0],
    rotation: rotation ?? [0, 0, 0],
    scale: scale ?? 1,
    color: color ?? DEFAULT_COLOR,
    visible: true,
    features: features ?? [],
  };
  validateNode(node);
  next.nodes.push(node);
  return { doc: next, id: node.id };
}

const EDITABLE = ["name", "position", "rotation", "scale", "color", "visible", "features", "op"];

export function updateShape(doc, id, patch) {
  const next = clone(doc);
  const { node } = mustFind(next, id);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "params") node.params = { ...node.params, ...v };
    else if (EDITABLE.includes(k)) node[k] = clone(v);
    else throw new Error(`Cannot change "${k}". Editable: params, ${EDITABLE.join(", ")}`);
  }
  if (node.kind === "boolean" && !BOOLEAN_OPS.includes(node.op)) throw new Error(`op must be one of ${BOOLEAN_OPS.join(", ")}`);
  validateNode(node);
  return { doc: next, id };
}

export function deleteShape(doc, id) {
  const next = clone(doc);
  const { parent } = mustFind(next, id);
  if (!parent) {
    next.nodes = next.nodes.filter((n) => n.id !== id);
  } else {
    if (parent.children.length <= 2)
      throw new Error(`"${id}" is one of only two inputs of boolean "${parent.id}". Delete or split the boolean instead.`);
    parent.children = parent.children.filter((n) => n.id !== id);
  }
  return { doc: next, id };
}

// ids[0] is the target; the rest are tools (subtracted from, or combined with, the target).
export function makeBoolean(doc, op, ids, name) {
  if (!BOOLEAN_OPS.includes(op)) throw new Error(`op must be one of ${BOOLEAN_OPS.join(", ")}`);
  if (!Array.isArray(ids) || ids.length < 2) throw new Error("A boolean needs at least two object ids.");
  if (new Set(ids).size !== ids.length) throw new Error("Object ids must be different.");
  const next = clone(doc);
  const children = ids.map((id) => {
    const f = mustFind(next, id);
    if (f.parent) throw new Error(`"${id}" is already inside "${f.parent.id}". Use top-level objects only.`);
    return f.node;
  });
  next.nodes = next.nodes.filter((n) => !ids.includes(n.id));
  const label = { union: "Union", subtract: "Subtract", intersect: "Intersect" }[op];
  const node = {
    id: nextId(doc),
    name: name || `${label} ${children[0].name}`,
    kind: "boolean",
    op,
    children: children.map((c) => ({ ...c, visible: true })),
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: 1,
    color: children[0].color,
    visible: true,
    features: [],
  };
  // Insert where the target was so the list order stays familiar.
  const at = Math.min(doc.nodes.findIndex((n) => n.id === ids[0]), next.nodes.length);
  next.nodes.splice(at < 0 ? next.nodes.length : at, 0, node);
  return { doc: next, id: node.id };
}

// Undo a boolean structurally: put its inputs back at the top level.
export function splitBoolean(doc, id) {
  const next = clone(doc);
  const { node, parent } = mustFind(next, id);
  if (node.kind !== "boolean") throw new Error(`"${id}" is not a boolean.`);
  if (parent) throw new Error(`"${id}" is nested; split its parent first.`);
  const at = next.nodes.findIndex((n) => n.id === id);
  next.nodes.splice(at, 1, ...node.children);
  return { doc: next, id: node.children[0].id };
}

export function addFeature(doc, id, feature) {
  const next = clone(doc);
  const { node } = mustFind(next, id);
  node.features = [...(node.features ?? []), clone(feature)];
  validateNode(node);
  return { doc: next, id };
}

export function duplicate(doc, id, offset = [0, 0, 0]) {
  const next = clone(doc);
  const { node, parent } = mustFind(next, id);
  if (parent) throw new Error("Only top-level objects can be duplicated.");
  const copy = clone(node);
  let counter = Number(nextId(doc).slice(1));
  walk([copy], (n) => (n.id = `n${counter++}`));
  copy.name = `${node.name} copy`;
  copy.position = node.position.map((v, i) => v + (offset[i] ?? 0));
  next.nodes.push(copy);
  return { doc: next, id: copy.id };
}
