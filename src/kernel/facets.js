// A closed triangle mesh as a solid of flat faces, for the STEP export of
// parts with no exact form (see brep.js for the solid's layout). Neighbouring
// triangles that lie in one plane, within `tol`, become one face, and a
// straight run of edges between the same two faces becomes one edge, so a
// flat part comes out as a handful of faces. The geometry is the mesh's own:
// only points inside flat faces and on straight edges are left out.

const { abs, hypot, max } = Math;

// A closed mesh as solids, one per connected piece (a part can be several
// pieces that do not touch). Same tol for all.
export function facetedSolids(mesh, tol) {
  const { positions: P, indices: I } = mesh;
  const nt = I.length / 3;
  let big = 0;
  for (let i = 0; i < P.length; i++) big = max(big, abs(P[i]));
  tol ??= 1e-5 + 1e-6 * big;
  // Pieces: triangles joined through shared vertices.
  const up = Int32Array.from({ length: P.length / 3 }, (_, i) => i);
  const find = (v) => {
    while (up[v] !== v) v = up[v] = up[up[v]];
    return v;
  };
  for (let t = 0; t < nt; t++) for (let k = 1; k < 3; k++) up[find(I[t * 3 + k])] = find(I[t * 3]);
  const groups = new Map();
  for (let t = 0; t < nt; t++) {
    const g = find(I[t * 3]);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  if (groups.size === 1) return [facetedSolid(mesh, tol)];
  return [...groups.values()].map((tris) => {
    const map = new Map(), pos = [], idx = new Uint32Array(tris.length * 3);
    tris.forEach((t, j) =>
      [0, 1, 2].forEach((k) => {
        const v = I[t * 3 + k];
        if (!map.has(v)) map.set(v, pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]) / 3 - 1);
        idx[j * 3 + k] = map.get(v);
      }),
    );
    return facetedSolid({ positions: Float64Array.from(pos), indices: idx }, tol);
  });
}

// tol: how far a point may be off its face's plane (mm). By default 1e-5 mm
// plus a millionth of the part's largest coordinate (the mesh is stored in
// 32-bit floats, good to about 6e-8 of a coordinate).
export function facetedSolid({ positions: P, indices: I }, tol) {
  const nt = I.length / 3, nv = P.length / 3;
  if (!nt) throw new Error("empty mesh");
  let big = 0;
  for (let i = 0; i < P.length; i++) big = max(big, abs(P[i]));
  tol ??= 1e-5 + 1e-6 * big;
  const pt = (v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];

  // Each directed edge a -> b to its triangle; every edge must have its twin.
  const half = new Map();
  const key = (a, b) => a * nv + b;
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
      if (a === b) throw new Error("mesh has a degenerate triangle");
      if (half.has(key(a, b))) throw new Error("mesh is not a closed manifold");
      half.set(key(a, b), t);
    }
  for (const k of half.keys()) {
    const a = Math.floor(k / nv), b = k % nv;
    if (!half.has(key(b, a))) throw new Error("mesh is not closed");
  }

  // Triangle planes (Newell normal, scaled by twice the area).
  const tn = new Float64Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [pt(I[t * 3]), pt(I[t * 3 + 1]), pt(I[t * 3 + 2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    tn[t * 3] = u[1] * w[2] - u[2] * w[1];
    tn[t * 3 + 1] = u[2] * w[0] - u[0] * w[2];
    tn[t * 3 + 2] = u[0] * w[1] - u[1] * w[0];
  }
  const unitN = (t) => {
    const l = hypot(tn[t * 3], tn[t * 3 + 1], tn[t * 3 + 2]);
    return l > 0 ? [tn[t * 3] / l, tn[t * 3 + 1] / l, tn[t * 3 + 2] / l] : null;
  };

  // Grow flat regions from seed triangles: a neighbour joins when its three
  // corners lie within tol / 2 of the seed's plane and it faces the same way.
  const region = new Int32Array(nt).fill(-1);
  const regions = [];
  const off = (n, d, v) => abs(n[0] * P[v * 3] + n[1] * P[v * 3 + 1] + n[2] * P[v * 3 + 2] - d);
  for (let s = 0; s < nt; s++) {
    if (region[s] >= 0) continue;
    const n = unitN(s);
    const id = regions.length;
    const tris = [s];
    region[s] = id;
    if (n) {
      const d = n[0] * P[I[s * 3] * 3] + n[1] * P[I[s * 3] * 3 + 1] + n[2] * P[I[s * 3] * 3 + 2];
      for (let q = 0; q < tris.length; q++) {
        const t = tris[q];
        for (let k = 0; k < 3; k++) {
          const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
          const u = half.get(key(b, a));
          if (region[u] >= 0) continue;
          const m = unitN(u);
          if (!m || m[0] * n[0] + m[1] * n[1] + m[2] * n[2] < 0.9) continue;
          if ([0, 1, 2].every((j) => off(n, d, I[u * 3 + j]) <= tol / 2)) {
            region[u] = id;
            tris.push(u);
          }
        }
      }
    }
    regions.push(tris);
  }

  // Each region's boundary as loops of vertices. A region whose boundary
  // meets itself at a point, or that is not flat within tol, goes back to
  // single triangles.
  let faces = [];
  const loopsOf = (tris, id) => {
    const next = new Map();
    for (const t of tris)
      for (let k = 0; k < 3; k++) {
        const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
        if (region[half.get(key(b, a))] === id) continue;
        if (next.has(a)) return null;
        next.set(a, b);
      }
    const loops = [];
    const seen = new Set();
    for (const start of next.keys()) {
      if (seen.has(start)) continue;
      const loop = [];
      for (let v = start; !seen.has(v); v = next.get(v)) {
        seen.add(v);
        loop.push(v);
      }
      loops.push(loop);
    }
    return loops;
  };
  const planeOf = (tris) => {
    let nx = 0, ny = 0, nz = 0;
    for (const t of tris) (nx += tn[t * 3]), (ny += tn[t * 3 + 1]), (nz += tn[t * 3 + 2]);
    const l = hypot(nx, ny, nz);
    return l > 0 ? [nx / l, ny / l, nz / l] : null;
  };
  for (let id = 0; id < regions.length; id++) {
    const tris = regions[id];
    let loops = tris.length > 1 ? loopsOf(tris, id) : null;
    let n = loops && planeOf(tris);
    if (loops && n) {
      const o = loops[0][0], d = n[0] * P[o * 3] + n[1] * P[o * 3 + 1] + n[2] * P[o * 3 + 2];
      if (loops.some((l) => l.some((v) => off(n, d, v) > tol))) loops = null;
    }
    if (!loops || !n) {
      // One face per triangle.
      for (const t of tris) {
        const m = unitN(t);
        if (!m) throw new Error("mesh has a triangle of no area");
        region[t] = -2 - faces.length; // its own face
        faces.push({ n: m, loops: [[I[t * 3], I[t * 3 + 1], I[t * 3 + 2]]] });
      }
      continue;
    }
    for (const t of tris) region[t] = -2 - faces.length;
    // The outer loop first: the one with the largest area round the normal.
    const loopArea = (l) => {
      let s = 0;
      for (let i = 0; i < l.length; i++) {
        const a = pt(l[i]), b = pt(l[(i + 1) % l.length]);
        s += n[0] * (a[1] * b[2] - a[2] * b[1]) + n[1] * (a[2] * b[0] - a[0] * b[2]) + n[2] * (a[0] * b[1] - a[1] * b[0]);
      }
      return s;
    };
    loops.sort((p, q) => loopArea(q) - loopArea(p));
    faces.push({ n, loops });
  }

  // Straight runs: a vertex where only two edges meet (so only two faces),
  // on the line between its neighbours, is left out of both loops.
  const neighbours = new Map(); // vertex -> set of vertices it has edges to
  faces.forEach((f) =>
    f.loops.forEach((l) =>
      l.forEach((v, i) => {
        const w = l[(i + 1) % l.length];
        if (!neighbours.has(v)) neighbours.set(v, new Set());
        if (!neighbours.has(w)) neighbours.set(w, new Set());
        neighbours.get(v).add(w);
        neighbours.get(w).add(v);
      }),
    ),
  );
  const drop = new Set();
  for (const [v, ns] of neighbours) {
    if (ns.size !== 2) continue;
    const [a, b] = [...ns].map(pt), p = pt(v);
    const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = e[0] ** 2 + e[1] ** 2 + e[2] ** 2;
    const s = ((p[0] - a[0]) * e[0] + (p[1] - a[1]) * e[1] + (p[2] - a[2]) * e[2]) / l2;
    if (!(s > 0 && s < 1)) continue;
    if (hypot(a[0] + e[0] * s - p[0], a[1] + e[1] * s - p[1], a[2] + e[2] * s - p[2]) <= tol) drop.add(v);
  }
  // Keep at least three corners in every loop, and never let two edges end
  // up on the same pair of vertices.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    const ends = new Map();
    for (const f of faces)
      for (const l of f.loops) {
        const kept = l.filter((v) => !drop.has(v));
        if (kept.length < 3) {
          for (const v of l) if (drop.delete(v)) changed = true;
          continue;
        }
        for (let i = 0; i < kept.length; i++) {
          const a = kept[i], b = kept[(i + 1) % kept.length], k = key(a, b);
          if (ends.has(k)) for (const v of l) if (drop.delete(v)) changed = true;
          ends.set(k, true);
        }
      }
    if (!changed) break;
    if (pass === 7) drop.clear();
  }

  // The solid.
  const verts = new Map();
  const V = (v) => verts.get(v) ?? (verts.set(v, { p: pt(v) }), verts.get(v));
  const edges = new Map();
  const out = [];
  for (const f of faces) {
    const loops = f.loops.map((l) => {
      const kept = l.filter((v) => !drop.has(v));
      return kept.map((a, i) => {
        const b = kept[(i + 1) % kept.length];
        const e = edges.get(key(b, a));
        if (e) return [e, false];
        const ne = { v0: V(a), v1: V(b), curve: null, via: null };
        edges.set(key(a, b), ne);
        return [ne, true];
      });
    });
    const e0 = loops[0][0][0], d = [e0.v1.p[0] - e0.v0.p[0], e0.v1.p[1] - e0.v0.p[1], e0.v1.p[2] - e0.v0.p[2]];
    const nd = d[0] * f.n[0] + d[1] * f.n[1] + d[2] * f.n[2];
    const x = [d[0] - nd * f.n[0], d[1] - nd * f.n[1], d[2] - nd * f.n[2]], xl = hypot(...x);
    // Placed at a corner of the face (at: that vertex, so its point is shared).
    out.push({ surf: { type: "plane", o: e0.v0.p, at: e0.v0, z: f.n, x: [x[0] / xl, x[1] / xl, x[2] / xl], xEdge: e0 }, same: true, loops });
  }
  return { faces: out, tol, triangles: nt };
}
