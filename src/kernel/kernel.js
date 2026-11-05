// Geometry kernel: turns a scene document into OpenCascade solids.
// Pure module with no DOM access, so it runs in the web worker and in Node tests.
import {
  setOC,
  makeBaseBox,
  makeCylinder,
  makeSphere,
  makePolygon,
  makeCircle,
  assembleWire,
  makeFace,
  revolution,
  draw,
  makeCompound,
  measureVolume,
} from "replicad";
import { validateNode } from "../model/schema.js";

export function initKernel(oc) {
  setOC(oc);
}

const cache = new Map(); // stable JSON of a node -> Shape3D
let touched = new Set();

function key(node) {
  // Name, color and visibility do not change geometry.
  const { name, color, visible, ...geom } = node;
  if (geom.children) geom.children = geom.children.map((c) => JSON.parse(key(c)));
  return JSON.stringify(geom);
}

function revolveProfile(points, angle = 360) {
  // points are [radius, z] pairs in the XZ plane, revolved about +Z.
  const face = makePolygon(points.map(([r, z]) => [r, 0, z]));
  return revolution(face, [0, 0, 0], [0, 0, 1], angle);
}

function buildPrimitive(node) {
  const p = node.params;
  switch (node.kind) {
    case "box":
      return makeBaseBox(p.width, p.depth, p.height);
    case "cylinder":
      return makeCylinder(p.radius, p.height, [0, 0, 0], [0, 0, 1]);
    case "sphere":
      return makeSphere(p.radius);
    case "cone": {
      const pts = [[0, 0], [p.radius1, 0]];
      if (p.radius2 > 0) pts.push([p.radius2, p.height]);
      pts.push([0, p.height]);
      return revolveProfile(pts);
    }
    case "torus": {
      const circle = makeCircle(p.minorRadius, [p.majorRadius, 0, 0], [0, 1, 0]);
      const face = makeFace(assembleWire([circle]));
      return revolution(face, [0, 0, 0], [0, 0, 1], 360);
    }
    case "extrude": {
      const [first, ...rest] = p.points;
      let pen = draw(first);
      for (const pt of rest) pen = pen.lineTo(pt);
      return pen.close().sketchOnPlane("XY").extrude(p.height);
    }
    case "revolve":
      return revolveProfile(p.points, p.angle ?? 360);
    default:
      throw new Error(`Unknown kind "${node.kind}"`);
  }
}

function buildBoolean(node) {
  const [first, ...rest] = node.children.map((c) => buildNode(c));
  let shape = first;
  for (const tool of rest) {
    if (node.op === "union") shape = shape.fuse(tool);
    else if (node.op === "subtract") shape = shape.cut(tool);
    else if (node.op === "intersect") shape = shape.intersect(tool);
    else throw new Error(`Unknown boolean op "${node.op}"`);
  }
  return shape;
}

// OpenCascade throws raw WebAssembly exceptions with no message; explain the usual cause.
function describe(err, f) {
  if (err instanceof Error && err.message) return err.message;
  const hint = {
    fillet: "the radius is probably too large for the selected edges",
    chamfer: "the distance is probably too large for the selected edges",
    shell: "the wall is probably too thick, or thicker than a fillet radius on this shape (fillet radius must be larger than shell thickness)",
  }[f?.type];
  return `the geometry kernel could not compute it; ${hint ?? "check the values"}.`;
}

function bounds(shape) {
  return shape.boundingBox.bounds; // [[minX,minY,minZ],[maxX,maxY,maxZ]]
}

function edgeFilter(which, shape) {
  if (!which || which === "all") return undefined;
  const [[, , zmin], [, , zmax]] = bounds(shape);
  if (which === "top") return (e) => e.inPlane("XY", zmax);
  if (which === "bottom") return (e) => e.inPlane("XY", zmin);
  if (which === "vertical") return (e) => e.inDirection("Z");
  throw new Error(`Unknown edge selection "${which}" (use all, top, bottom or vertical)`);
}

function applyFeature(shape, f) {
  if (f.type === "fillet") {
    const filter = edgeFilter(f.edges, shape);
    return filter ? shape.fillet(f.radius, filter) : shape.fillet(f.radius);
  }
  if (f.type === "chamfer") {
    const filter = edgeFilter(f.edges, shape);
    return filter ? shape.chamfer(f.distance, filter) : shape.chamfer(f.distance);
  }
  if (f.type === "shell") {
    const [[, , zmin], [, , zmax]] = bounds(shape);
    const open = f.open ?? "top";
    const z = open === "bottom" ? zmin : zmax;
    // Positive thickness hollows inward, so the outside size stays the same.
    return shape.shell(Math.abs(f.thickness), (faces) => faces.inPlane("XY", z));
  }
  throw new Error(`Unknown feature "${f.type}"`);
}

function transform(shape, node) {
  let s = shape;
  const scale = node.scale ?? 1;
  if (scale !== 1) s = s.scale(scale, [0, 0, 0]);
  const [rx, ry, rz] = node.rotation ?? [0, 0, 0];
  if (rx) s = s.rotate(rx, [0, 0, 0], [1, 0, 0]);
  if (ry) s = s.rotate(ry, [0, 0, 0], [0, 1, 0]);
  if (rz) s = s.rotate(rz, [0, 0, 0], [0, 0, 1]);
  const [x, y, z] = node.position ?? [0, 0, 0];
  if (x || y || z) s = s.translate(x, y, z);
  return s;
}

// Returns a fresh shape (a clone of the cached one) that the caller owns.
export function buildNode(node) {
  const k = key(node);
  touched.add(k);
  let shape = cache.get(k);
  if (!shape) {
    validateNode(node);
    try {
      shape = node.kind === "boolean" ? buildBoolean(node) : buildPrimitive(node);
    } catch (err) {
      throw new Error(`could not build "${node.name ?? node.id}": ${describe(err)}`);
    }
    for (const f of node.features ?? []) {
      try {
        shape = applyFeature(shape, f);
      } catch (err) {
        throw new Error(`${f.type} failed on "${node.name ?? node.id}": ${describe(err, f)}`);
      }
    }
    shape = transform(shape, node);
    cache.set(k, shape);
  }
  return shape.clone();
}

function sweepCache() {
  for (const [k, shape] of cache) {
    if (!touched.has(k)) {
      shape.delete();
      cache.delete(k);
    }
  }
  touched = new Set();
}

function meshQuality(shape) {
  const [[a, b, c], [d, e, f]] = bounds(shape);
  const diag = Math.hypot(d - a, e - b, f - c) || 1;
  return { tolerance: Math.max(0.005, diag * 0.0008), angularTolerance: 0.2 };
}

// Builds every top-level node. One bad node does not stop the others.
export function buildScene(doc) {
  const results = [];
  for (const node of doc.nodes) {
    try {
      const shape = buildNode(node);
      const q = meshQuality(shape);
      const mesh = shape.mesh(q);
      const edges = shape.meshEdges(q);
      results.push({
        id: node.id,
        vertices: new Float32Array(mesh.vertices),
        normals: new Float32Array(mesh.normals),
        triangles: new Uint32Array(mesh.triangles),
        lines: new Float32Array(edges.lines),
        bounds: bounds(shape),
        volume: safeVolume(shape),
      });
      shape.delete();
    } catch (err) {
      results.push({ id: node.id, error: String(err?.message ?? err) });
    }
  }
  sweepCache();
  return results;
}

function safeVolume(shape) {
  try {
    return measureVolume(shape);
  } catch {
    return null;
  }
}

// format: "stl" | "step". Returns a Blob of the visible top-level nodes.
export function exportScene(doc, format, ids) {
  const nodes = doc.nodes.filter((n) => (ids ? ids.includes(n.id) : n.visible !== false));
  if (!nodes.length) throw new Error("Nothing to export: the scene has no visible objects.");
  const shapes = nodes.map((n) => buildNode(n));
  const shape = shapes.length === 1 ? shapes[0] : makeCompound(shapes);
  try {
    if (format === "step") return shape.blobSTEP();
    return shape.blobSTL({ ...meshQuality(shape), binary: true });
  } finally {
    shape.delete();
  }
}
