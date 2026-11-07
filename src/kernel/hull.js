// 3D convex hull of points, built one point at a time: each new point that
// lies outside the hull so far removes the faces it can see and is joined
// to the edge of that hole. Returns the hull's face planes [nx, ny, nz, d]
// (n · p <= d inside), with coplanar faces merged.
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

  const faces = []; // { v: [i, j, k], n, off, dead }
  const pts = [a, b, c, d];
  const centre = [0, 1, 2].map((k) => (a[k] + b[k] + c[k] + d[k]) / 4);
  const addFace = (i, j, k) => {
    let n = cross(sub(pts[j], pts[i]), sub(pts[k], pts[i]));
    const l = Math.hypot(...n) || 1;
    n = n.map((v) => v / l);
    let off = dot(n, pts[i]);
    let v = [i, j, k];
    // Outward: the centre is on the inside.
    if (dot(n, centre) > off) (n = n.map((x) => -x)), (off = -off), (v = [i, k, j]);
    faces.push({ v, n, off, dead: false });
  };
  addFace(0, 1, 2);
  addFace(0, 1, 3);
  addFace(0, 2, 3);
  addFace(1, 2, 3);

  for (const p of P) {
    if (p === a || p === b || p === c || p === d) continue;
    const visible = faces.filter((f) => !f.dead && dot(f.n, p) - f.off > eps);
    if (!visible.length) continue;
    // Horizon: edges of visible faces whose other side is not visible.
    const edges = new Map();
    for (const f of visible) {
      f.dead = true;
      for (let e = 0; e < 3; e++) {
        const u = f.v[e], w = f.v[(e + 1) % 3];
        const back = `${w},${u}`;
        if (edges.has(back)) edges.delete(back);
        else edges.set(`${u},${w}`, [u, w]);
      }
    }
    const pi = pts.length;
    pts.push(p);
    for (const [u, w] of edges.values()) {
      let n = cross(sub(pts[w], pts[u]), sub(p, pts[u]));
      const l = Math.hypot(...n) || 1;
      n = n.map((x) => x / l);
      faces.push({ v: [u, w, pi], n, off: dot(n, p), dead: false });
    }
    // Compact now and then.
    if (faces.length > 4 * pts.length + 64) {
      const live = faces.filter((f) => !f.dead);
      faces.length = 0;
      faces.push(...live);
    }
  }

  // Merge faces that lie in the same plane. Points packed very close
  // together can leave a sliver face turned the wrong way; a face that has
  // points outside it is dropped (that only makes the hull a hair larger).
  const tol = 1e-6 * Math.max(size, 1);
  const planes = [];
  for (const f of faces) {
    if (f.dead) continue;
    if (pts.some((p) => dot(f.n, p) - f.off > tol)) continue;
    if (planes.some((q) => dot(q, f.n) > 1 - 1e-9 && Math.abs(q[3] - f.off) < 1e-6 * Math.max(size, 1))) continue;
    planes.push([...f.n, f.off]);
  }
  return planes;
}
