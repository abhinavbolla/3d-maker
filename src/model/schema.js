// Scene document format. Units are millimetres, Z is up, angles are degrees.
//
// doc  = { version: 1, units: "mm", nodes: Node[] }
// Node = {
//   id, name, kind, params, position: [x,y,z], rotation: [rx,ry,rz], scale,
//   color: "#rrggbb", visible, features: Feature[],
//   op, children   // boolean nodes only
// }
// Feature = { type: "fillet", radius, edges } | { type: "chamfer", distance, edges }
//         | { type: "shell", thickness, open: "top" | "bottom" }
// edges = "all" | "top" | "bottom" | "vertical"

export const KINDS = {
  box: {
    about: "Box centred on X and Y, from z=0 up to height.",
    params: { width: 20, depth: 20, height: 20 },
  },
  cylinder: {
    about: "Cylinder along +Z, base centred at the origin.",
    params: { radius: 10, height: 20 },
  },
  cone: {
    about: "Cone or frustum along +Z, base centred at the origin. radius2 = 0 gives a point.",
    params: { radius1: 10, radius2: 0, height: 20 },
  },
  sphere: {
    about: "Sphere centred at the origin.",
    params: { radius: 10 },
  },
  torus: {
    about: "Torus centred at the origin, lying flat in the XY plane.",
    params: { majorRadius: 15, minorRadius: 4 },
  },
  extrude: {
    about: "Closed polygon in the XY plane ([x, y] points), extruded from z=0 up by height.",
    params: { points: [[-10, -10], [10, -10], [0, 10]], height: 10 },
  },
  revolve: {
    about:
      "Closed profile of [radius, z] points revolved around the Z axis. Good for vases, bottles, knobs. Radius must be >= 0.",
    params: { points: [[0, 0], [10, 0], [8, 20], [0, 20]], angle: 360 },
  },
};

export const BOOLEAN_OPS = ["union", "subtract", "intersect"];
export const EDGE_SETS = ["all", "top", "bottom", "vertical"];
export const FEATURE_TYPES = ["fillet", "chamfer", "shell"];

export const DEFAULT_COLOR = "#9aa3ad";

export function emptyDoc() {
  return { version: 1, units: "mm", nodes: [] };
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);

export function validateNode(node) {
  const where = `"${node.name ?? node.id}"`;
  if (node.kind === "boolean") {
    if (!BOOLEAN_OPS.includes(node.op)) throw new Error(`${where}: op must be one of ${BOOLEAN_OPS.join(", ")}`);
    if (!Array.isArray(node.children) || node.children.length < 2)
      throw new Error(`${where}: a boolean needs at least two children`);
  } else {
    const spec = KINDS[node.kind];
    if (!spec) throw new Error(`${where}: unknown kind "${node.kind}"`);
    const p = node.params ?? {};
    for (const [name, def] of Object.entries(spec.params)) {
      if (name === "angle" && p.angle === undefined) continue;
      if (Array.isArray(def)) {
        if (!Array.isArray(p[name]) || p[name].length < 3 || !p[name].every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every(isNum)))
          throw new Error(`${where}: ${name} must be a list of at least 3 [a, b] number pairs`);
      } else if (!isNum(p[name])) {
        throw new Error(`${where}: param ${name} must be a number`);
      } else if (p[name] < 0 || (p[name] === 0 && name !== "radius2")) {
        throw new Error(`${where}: param ${name} must be positive`);
      }
    }
    if (node.kind === "torus" && p.minorRadius >= p.majorRadius)
      throw new Error(`${where}: minorRadius must be smaller than majorRadius`);
    if (node.kind === "revolve" && p.points.some(([r]) => r < 0))
      throw new Error(`${where}: revolve profile radius values must be >= 0`);
  }
  if (node.position !== undefined && !isVec3(node.position)) throw new Error(`${where}: position must be [x, y, z]`);
  if (node.rotation !== undefined && !isVec3(node.rotation)) throw new Error(`${where}: rotation must be [rx, ry, rz] in degrees`);
  if (node.scale !== undefined && !(isNum(node.scale) && node.scale > 0)) throw new Error(`${where}: scale must be a positive number`);
  for (const f of node.features ?? []) {
    if (!FEATURE_TYPES.includes(f.type)) throw new Error(`${where}: unknown feature "${f.type}"`);
    if (f.type === "fillet" && !(isNum(f.radius) && f.radius > 0)) throw new Error(`${where}: fillet radius must be positive`);
    if (f.type === "chamfer" && !(isNum(f.distance) && f.distance > 0)) throw new Error(`${where}: chamfer distance must be positive`);
    if (f.type === "shell" && !(isNum(f.thickness) && f.thickness > 0)) throw new Error(`${where}: shell thickness must be positive`);
    if (f.edges !== undefined && !EDGE_SETS.includes(f.edges)) throw new Error(`${where}: edges must be one of ${EDGE_SETS.join(", ")}`);
  }
}
