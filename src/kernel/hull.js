// 3D convex hull of points, built one point at a time: each new point that
// lies outside the hull so far removes the faces it can see and is joined
// to the edge of that hole. Returns the hull's face planes [nx, ny, nz, d]
// (n · p <= d inside), with coplanar faces merged.
//
// The faces a point sees are found by walking from the face it is furthest
// above to neighbouring faces, so they always form one patch with a single
// edge loop around it, even when many points lie in one plane (flat sides
// of boxes and cylinders), where testing every face on its own can pick a
// ragged set and leave the hull's faces tangled.
export function convexHullPlanes(points) {
  // Drop repeats.
  const seen = new Set();
  const P = [];
  for (const p of points) {
    const k = p.map((v) => v.toFixed(6)).join();
    if (!seen.has(k)) (seen.add(k), P.push(p));
  }
  if (P.length < 4) throw new Error("hull needs shapes with some volume");
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let size = 0;
  for (const p of P) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const eps = 1e-7 * Math.max(size, 1);

  // A first tetrahedron from points far apart.
  const ext = (f) => P.reduce((best, p) => (f(p) > f(best) ? p : best), P[0]);
  const a = ext((p) => p[0]);
  const b = ext((p) => Math.hypot(...sub(p, a)));
  const ab = sub(b, a);
  const c = ext((p) => Math.hypot(...cross(ab, sub(p, a))));
  const nabc = cross(ab, sub(c, a));
  const d = ext((p) => Math.abs(dot(nabc, sub(p, a))));
  if (Math.abs(dot(nabc, sub(d, a))) <= eps * Math.max(1, Math.hypot(...nabc))) throw new Error("hull needs shapes that are not flat");

  const pts = [a, b, c, d];
  const M = P.length + 4; // vertex index bound, for edge keys
  const faces = []; // { v: [i, j, k] (outward winding), n, off, area, dead }
  const edgeFace = new Map(); // directed edge u * M + w -> face, for each live face's edges
  const addFace = (i, j, k) => {
    let n = cross(sub(pts[j], pts[i]), sub(pts[k], pts[i]));
    const area = Math.hypot(...n);
    n = n.map((v) => v / (area || 1));
    const f = { v: [i, j, k], n, off: dot(n, pts[i]), area, dead: false };
    faces.push(f);
    edgeFace.set(i * M + j, f);
    edgeFace.set(j * M + k, f);
    edgeFace.set(k * M + i, f);
    return f;
  };
  // Outward winding for the tetrahedron: the fourth point is behind each face.
  const tet = [[0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 3, 1], [1, 2, 3, 0]];
  for (const [i, j, k, o] of tet) {
    const n = cross(sub(pts[j], pts[i]), sub(pts[k], pts[i]));
    if (dot(n, sub(pts[o], pts[i])) > 0) addFace(i, k, j);
    else addFace(i, j, k);
  }

  // Points in a shuffled order (seeded, so the result is repeatable): in the
  // order they come, each new point would see much of the hull.
  let seed = 12345;
  const order = P.filter((p) => p !== a && p !== b && p !== c && p !== d);
  for (let i = order.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }

  let dead = 0;
  for (const p of order) {
    // The face p is furthest above.
    let best = null, bestD = eps;
    for (const f of faces) {
      if (f.dead) continue;
      const h = dot(f.n, p) - f.off;
      if (h > bestD) (bestD = h), (best = f);
    }
    if (!best) continue;
    // Walk to the neighbours p also sees; the edges where the walk stops are
    // the loop the new faces hang from.
    const visible = new Set([best]);
    const stack = [best];
    const horizon = [];
    while (stack.length) {
      const f = stack.pop();
      for (let e = 0; e < 3; e++) {
        const u = f.v[e], w = f.v[(e + 1) % 3];
        const g = edgeFace.get(w * M + u);
        if (!g || visible.has(g)) continue;
        if (dot(g.n, p) - g.off > eps) (visible.add(g), stack.push(g));
        else horizon.push([u, w]);
      }
    }
    dead += visible.size;
    for (const f of visible) {
      f.dead = true;
      const [i, j, k] = f.v;
      for (const key of [i * M + j, j * M + k, k * M + i]) if (edgeFace.get(key) === f) edgeFace.delete(key);
    }
    const pi = pts.length;
    pts.push(p);
    for (const [u, w] of horizon) addFace(u, w, pi);
    // Drop dead faces now and then.
    if (dead > faces.length / 2) {
      const keep = faces.filter((f) => !f.dead);
      faces.length = 0;
      faces.push(...keep);
      dead = 0;
    }
  }

  // Merge faces that lie in the same plane. Slivers too thin to have a
  // reliable normal are skipped, and so is any face with points outside it
  // (that only makes the hull a hair larger).
  const tol = 1e-6 * Math.max(size, 1);
  const planes = [];
  for (const f of faces) {
    if (f.dead || f.area <= 1e-12 * Math.max(size * size, 1)) continue;
    if (pts.some((p) => dot(f.n, p) - f.off > tol)) continue;
    if (planes.some((q) => dot(q, f.n) > 1 - 1e-9 && Math.abs(q[3] - f.off) < 1e-6 * Math.max(size, 1))) continue;
    planes.push([...f.n, f.off]);
  }
  return planes;
}
