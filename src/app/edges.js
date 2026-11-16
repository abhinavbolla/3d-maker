// The sharp edges of a part as thin dark lines, for the "shaded with edges"
// look. They are worked out once per mesh and drawn as line geometry, so a
// moving frame only draws a few more lines (no extra pass). Outlines, which
// depend on where the camera is, are added when the view comes to rest (see
// creases.js).
//
// The view's meshes already carry the answer: the kernel gives each smooth
// patch around a vertex its own copy of the vertex (displayMesh in
// src/kernel/mesh.js), so where two triangles share an edge's two positions
// but not its two vertices, the surface folds there by more than the crease
// angle. Those edges, and any open edge, are the lines.
import * as THREE from "three";

const lines = new WeakMap(); // mesh -> Float32Array of segment ends

// An open-addressing table from the bits of a position to one id per place.
function weld(P) {
  const nv = P.length / 3;
  const bits = new Uint32Array(P.buffer, P.byteOffset, P.length);
  let size = 1;
  while (size < nv * 2) size *= 2;
  const slot = new Int32Array(size).fill(-1);
  const id = new Int32Array(nv);
  for (let v = 0; v < nv; v++) {
    const a = bits[v * 3], b = bits[v * 3 + 1], c = bits[v * 3 + 2];
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) >>> 0;
    for (;;) {
      h &= size - 1;
      const u = slot[h];
      if (u < 0) {
        slot[h] = v;
        id[v] = v;
        break;
      }
      if (bits[u * 3] === a && bits[u * 3 + 1] === b && bits[u * 3 + 2] === c) {
        id[v] = u;
        break;
      }
      h++;
    }
  }
  return id;
}

export function sharpEdges(mesh) {
  const hit = lines.get(mesh);
  if (hit) return hit;
  const { positions: P, indices: I } = mesh;
  const id = weld(P);
  const ne = I.length;
  let size = 1;
  while (size < ne * 2) size *= 2;
  // Per slot: the edge's welded ends (lower first) and its first vertex pair.
  const keyA = new Int32Array(size).fill(-1), keyB = new Int32Array(size);
  const firstA = new Int32Array(size), firstB = new Int32Array(size);
  const paired = new Uint8Array(size);
  const out = [];
  const segment = (u, v) => out.push(P[u * 3], P[u * 3 + 1], P[u * 3 + 2], P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
  for (let n = 0; n < ne; n++) {
    const t = n - (n % 3);
    const u = I[n], v = I[t + ((n % 3) + 1) % 3];
    let a = id[u], b = id[v];
    if (a === b) continue;
    if (a > b) [a, b] = [b, a];
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77)) >>> 0;
    for (;;) {
      h &= size - 1;
      if (keyA[h] < 0) {
        keyA[h] = a;
        keyB[h] = b;
        firstA[h] = u;
        firstB[h] = v;
        break;
      }
      if (keyA[h] === a && keyB[h] === b) {
        // The second triangle on this edge: the same two vertices (in either
        // order) means one smooth patch; other copies mean a fold.
        const same = (firstA[h] === u && firstB[h] === v) || (firstA[h] === v && firstB[h] === u);
        if (!same && !paired[h]) segment(u, v);
        paired[h] = 1;
        break;
      }
      h++;
    }
  }
  for (let h = 0; h < size; h++) if (keyA[h] >= 0 && !paired[h]) segment(firstA[h], firstB[h]);
  const result = Float32Array.from(out);
  lines.set(mesh, result);
  return result;
}

const ink = new THREE.LineBasicMaterial({ color: 0x15181c, transparent: true, opacity: 0.78, toneMapped: false });

// The line object for a part's mesh, to add beside the part's own mesh.
export function edgeLines(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(sharpEdges(mesh), 3));
  const l = new THREE.LineSegments(g, ink);
  l.raycast = () => {};
  l.userData.edges = true;
  return l;
}

// The look, remembered for this user: { edges: boolean }.
const KEY = "3d-maker:look";
export function loadLook() {
  try {
    return { edges: false, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { edges: false };
  }
}
export function saveLook(look) {
  try {
    localStorage.setItem(KEY, JSON.stringify(look));
  } catch {
    // Not remembered; the look still changes now.
  }
}
