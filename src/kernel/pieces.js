// Small pieces of a big part keep their detail. A part is usually a body with
// small pieces added to it (bolts on a hub, rivets on a skin, a knob on a
// lid). Meshed as one, the cell size suits the body and a 20 mm bolt head on
// a 900 mm hub comes out as a blob. So a part made by adding pieces is split
// back into them; the big ones are meshed together as the body, and each
// small one on its own at a cell size that suits it. Every piece is a closed
// mesh; where a piece sinks into the body their surfaces pass through each
// other, inside the solid, where nobody sees them.
import { compile } from "./sdf.js";
import { meshSDF, meshVolume } from "./mesh.js";

// Transforms that can be applied to each piece of a union separately.
const MAPS = new Set(["move", "rotate", "scale", "mirror", "symmetric"]);

// Nodes whose union is exactly `node`: through sharp unions, cuts (each
// piece is cut by the same tools) and the transforms above.
export function splitPieces(node) {
  if (node.t === "union" && !node.k) return node.c.flatMap(splitPieces);
  if (node.t === "subtract" && !node.k) {
    const parts = splitPieces(node.a);
    return parts.length > 1 ? parts.map((a) => ({ ...node, a })) : [node];
  }
  if (MAPS.has(node.t) && node.c && !Array.isArray(node.c)) {
    const parts = splitPieces(node.c);
    return parts.length > 1 ? parts.map((c) => ({ ...node, c })) : [node];
  }
  return [node];
}

const extent = (b) => Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
const boxVolume = (b) => (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]);
// Long but thin pieces (wire spokes, rods, cables, antennas) are too long to
// count as small, but thinner than the body's cells, so meshed with it they
// come out speckled. A piece counts as thin when no point of a 12 x 12 x 12
// grid over its box is deeper inside it than THIN of the part's size.
const THIN = 1 / 50;
function isThin(p, L) {
  const [x0, y0, z0, x1, y1, z1] = p.box, N = 12;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++)
      for (let k = 0; k < N; k++)
        if (p.f(x0 + ((i + 0.5) * (x1 - x0)) / N, y0 + ((j + 0.5) * (y1 - y0)) / N, z0 + ((k + 0.5) * (z1 - z0)) / N) < -L * THIN) return false;
  return true;
}
const isEmptyBox = (b) => !(b[3] >= b[0] && b[4] >= b[1] && b[5] >= b[2]);
// A piece is small when it is less than this part of the whole part's size.
export const SMALL = 1 / 8;

// Meshes a part: { positions, indices, normals?, cellSize, incomplete, volume }.
// Without small pieces this is exactly meshSDF of the whole part.
export function meshPart(node, { budget, maxCell = Infinity, maxCells, normals = false }) {
  const whole = compile(node);
  const pieces = splitPieces(node);
  if (pieces.length > 1) {
    const compiled = pieces.map((n) => ({ n, ...compile(n) })).filter((p) => !isEmptyBox(p.box));
    const L = extent(whole.box);
    // Small, or thin and taking up little of the part's box (a thin skin
    // over the whole part is the body, not a detail).
    const room = boxVolume(whole.box) / 8;
    const small = compiled.filter((p) => extent(p.box) < L * SMALL || (boxVolume(p.box) < room && isThin(p, L)));
    if (small.length) {
      const big = compiled.filter((p) => !small.includes(p));
      const opts = { maxCells, normals };
      // Meshed in this order: the body (the big pieces together), then each small piece.
      const order = [];
      const meshes = [];
      if (big.length) {
        const body = big.length === 1 ? big[0] : compile({ t: "union", c: big.map((p) => p.n) });
        order.push(body);
        meshes.push(meshSDF(body.f, body.box, { ...opts, budget, maxCell }));
      }
      // The small pieces share about twice the body's budget, each at least
      // as finely as the body.
      const each = Math.round(Math.max(1500, Math.min(budget / 4, (2 * budget) / small.length)));
      for (const p of small) {
        order.push(p);
        meshes.push(meshSDF(p.f, p.box, { ...opts, budget: each, maxCell }));
      }
      const out = concat(meshes);
      out.cellSize = big.length ? meshes[0].cellSize : Math.min(...meshes.map((m) => m.cellSize));
      // Volume: each piece's, less what it shares with the pieces before it.
      let volume = 0;
      meshes.forEach((m, i) => (volume += meshVolume(m) - (i ? shared(order[i], order.slice(0, i)) : 0)));
      out.volume = volume;
      return out;
    }
  }
  const m = meshSDF(whole.f, whole.box, { budget, maxCell, maxCells, normals });
  m.volume = meshVolume(m);
  return m;
}

// Volume (mm3) of piece p inside any of the others, by sampling a grid of
// points in p's box.
function shared(p, others) {
  const near = others.filter((q) => q.box[0] <= p.box[3] && q.box[3] >= p.box[0] && q.box[1] <= p.box[4] && q.box[4] >= p.box[1] && q.box[2] <= p.box[5] && q.box[5] >= p.box[2]);
  if (!near.length) return 0;
  const N = 14;
  const [x0, y0, z0, x1, y1, z1] = p.box;
  const dx = (x1 - x0) / N, dy = (y1 - y0) / N, dz = (z1 - z0) / N;
  let hits = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++)
      for (let k = 0; k < N; k++) {
        const x = x0 + (i + 0.5) * dx, y = y0 + (j + 0.5) * dy, z = z0 + (k + 0.5) * dz;
        if (p.f(x, y, z) < 0 && near.some((q) => q.f(x, y, z) < 0)) hits++;
      }
  return (hits / N ** 3) * (x1 - x0) * (y1 - y0) * (z1 - z0);
}

function concat(meshes) {
  const nv = meshes.reduce((s, m) => s + m.positions.length, 0);
  const ni = meshes.reduce((s, m) => s + m.indices.length, 0);
  const positions = new Float32Array(nv), indices = new Uint32Array(ni);
  const normals = meshes.every((m) => m.normals?.length === m.positions.length) ? new Float32Array(nv) : null;
  let pv = 0, pi = 0;
  for (const m of meshes) {
    positions.set(m.positions, pv);
    if (normals) normals.set(m.normals, pv);
    const base = pv / 3;
    for (let i = 0; i < m.indices.length; i++) indices[pi + i] = m.indices[i] + base;
    pv += m.positions.length;
    pi += m.indices.length;
  }
  const out = { positions, indices, incomplete: meshes.some((m) => m.incomplete) };
  if (normals) out.normals = normals;
  return out;
}
