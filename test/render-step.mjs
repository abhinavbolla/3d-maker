// Draws a STEP file as a PNG from the file's own faces: check-step.mjs reads
// the file (no code shared with the writer), each face is filled in from its
// surface and its loops as read, and its edges are drawn on top. So the
// picture shows the shape the file describes, not the mesh it was made from.
// Usage: node test/render-step.mjs model.step out.png [width]
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { checkStep } from "./check-step.mjs";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

// Even-odd point in polygons (each a list of [x, y]).
function inside(polys, x, y) {
  let s = false;
  for (const p of polys)
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i], [xj, yj] = p[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) s = !s;
    }
  return s;
}

// Ear clipping of one simple polygon (indices into pts); counterclockwise or not.
function earClip(pts) {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
  const idx = Array.from({ length: n }, (_, i) => i);
  if (area < 0) idx.reverse();
  const out = [];
  const cr = (a, b, c) => (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]);
  const inTri = (p, a, b, c) => cr(a, b, p) >= 0 && cr(b, c, p) >= 0 && cr(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (cr(a, b, c) <= 0) continue;
      if (idx.some((p) => p !== a && p !== b && p !== c && inTri(p, a, b, c))) continue;
      out.push([a, b, c]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) return null;
  }
  if (idx.length === 3) out.push(idx);
  return out;
}

// Triangles [[p, q, r], ...] covering one face as read.
export function faceTriangles(face, cellSize) {
  const { surf, loops, uv } = face;
  const tris = [];
  if (surf.type === "plane") {
    const { o, x, y } = surf.f;
    const to2 = (p) => [dot(sub(p, o), x), dot(sub(p, o), y)];
    const polys = loops.map((l) => l.map(to2));
    if (loops.length === 1) {
      const t = earClip(polys[0]);
      if (t) return t.map((tri) => tri.map((i) => loops[0][i]));
    }
    // Holes (or a polygon ear clipping cannot do): filled on a grid.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [a, b] of polys.flat()) (x0 = Math.min(x0, a)), (x1 = Math.max(x1, a)), (y0 = Math.min(y0, b)), (y1 = Math.max(y1, b));
    const nx = Math.min(400, Math.max(4, Math.ceil((x1 - x0) / cellSize))), ny = Math.min(400, Math.max(4, Math.ceil((y1 - y0) / cellSize)));
    const at = (a, b) => [o[0] + x[0] * a + y[0] * b, o[1] + x[1] * a + y[1] * b, o[2] + x[2] * a + y[2] * b];
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        const a0 = x0 + ((x1 - x0) * i) / nx, a1 = x0 + ((x1 - x0) * (i + 1)) / nx, b0 = y0 + ((y1 - y0) * j) / ny, b1 = y0 + ((y1 - y0) * (j + 1)) / ny;
        if (!inside(polys, (a0 + a1) / 2, (b0 + b1) / 2)) continue;
        tris.push([at(a0, b0), at(a1, b0), at(a1, b1)], [at(a0, b0), at(a1, b1), at(a0, b1)]);
      }
    return tris;
  }
  // Curved: a grid over the face's (u, v) range, kept inside its loops.
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [u, v] of uv.flat()) (u0 = Math.min(u0, u)), (u1 = Math.max(u1, u)), (v0 = Math.min(v0, v)), (v1 = Math.max(v1, v));
  // Cells about cellSize across on the surface.
  const mid = surf.at((u0 + u1) / 2, (v0 + v1) / 2);
  const du = Math.hypot(...sub(surf.at((u0 + u1) / 2 + 1e-3, (v0 + v1) / 2), mid)) / 1e-3 || 1;
  const dv = Math.hypot(...sub(surf.at((u0 + u1) / 2, (v0 + v1) / 2 + 1e-3), mid)) / 1e-3 || 1;
  const nu = Math.min(400, Math.max(8, Math.ceil(((u1 - u0) * du) / cellSize))), nv = Math.min(400, Math.max(4, Math.ceil(((v1 - v0) * dv) / cellSize)));
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const a0 = u0 + ((u1 - u0) * i) / nu, a1 = u0 + ((u1 - u0) * (i + 1)) / nu, b0 = v0 + ((v1 - v0) * j) / nv, b1 = v0 + ((v1 - v0) * (j + 1)) / nv;
      if (!inside(uv, (a0 + a1) / 2, (b0 + b1) / 2)) continue;
      const p = [surf.at(a0, b0), surf.at(a1, b0), surf.at(a1, b1), surf.at(a0, b1)];
      tris.push([p[0], p[1], p[2]], [p[0], p[2], p[3]]);
    }
  return tris;
}

export function renderStep(text, { width = 1000, height = Math.round(width * 0.72), view = [1, -1.4, 0.9] } = {}) {
  const r = checkStep(text);
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of r.parts) for (let k = 0; k < 3; k++) (box[k] = Math.min(box[k], p.bounds[k])), (box[k + 3] = Math.max(box[k + 3], p.bounds[k + 3]));
  const c = [0, 1, 2].map((k) => (box[k] + box[k + 3]) / 2);
  const size = Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) || 1;
  const fwd = unit(view.map((v) => -v)), right = unit(cross(fwd, [0, 0, 1])), up = cross(right, fwd);
  // Fitted to the box's corners as seen.
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => sub([i & 1 ? box[3] : box[0], i & 2 ? box[4] : box[1], i & 4 ? box[5] : box[2]], c));
  const spanX = 2 * Math.max(...corners.map((p) => Math.abs(dot(p, right)))), spanY = 2 * Math.max(...corners.map((p) => Math.abs(dot(p, up))));
  const scale = 0.92 * Math.min(width / spanX, height / spanY);
  const proj = (p) => {
    const d = sub(p, c);
    return [width / 2 + dot(d, right) * scale, height / 2 - dot(d, up) * scale, dot(d, fwd)];
  };
  const img = new Uint8Array(width * height * 3).fill(246);
  const zb = new Float32Array(width * height).fill(Infinity);
  const light = unit([-fwd[0] + 0.4 * up[0] + 0.3 * right[0], -fwd[1] + 0.4 * up[1] + 0.3 * right[1], -fwd[2] + 0.4 * up[2] + 0.3 * right[2]]);
  const cell = size / 300;
  let triangles = 0;
  for (const part of r.parts) {
    const col = (part.colour ?? [0.6, 0.64, 0.68]).map((x) => x * 255);
    for (const solid of part.solids)
      for (const face of solid.faceData) {
        for (const [a, b, q] of faceTriangles(face, cell)) {
          triangles++;
          const n = unit(cross(sub(b, a), sub(q, a)));
          if (!Number.isFinite(n[0])) continue;
          const shade = 0.3 + 0.7 * Math.abs(dot(n, light));
          const [A, B, C] = [a, b, q].map(proj);
          const minX = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), maxX = Math.min(width - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
          const minY = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), maxY = Math.min(height - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
          const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
          if (!den) continue;
          for (let y = minY; y <= maxY; y++)
            for (let x = minX; x <= maxX; x++) {
              const px = x + 0.5, py = y + 0.5;
              const w0 = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / den;
              const w1 = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / den;
              const w2 = 1 - w0 - w1;
              if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
              const z = w0 * A[2] + w1 * B[2] + w2 * C[2];
              const k = y * width + x;
              if (z >= zb[k]) continue;
              zb[k] = z;
              for (let ch = 0; ch < 3; ch++) img[k * 3 + ch] = Math.min(255, col[ch] * shade + 20);
            }
        }
      }
  }
  // Edges: the loops as read, dark, where not hidden; left out round small
  // flat faces (the facets of a faceted part would turn it black).
  const bias = size * 2e-3;
  const small = (size * 0.03) ** 2;
  for (const part of r.parts)
    for (const solid of part.solids)
      for (const face of solid.faceData)
        for (const loop of face.surf.type !== "plane" || area(face.loops[0]) > small ? face.loops : [])
          for (let i = 0; i < loop.length; i++) {
            const A = proj(loop[i]), B = proj(loop[(i + 1) % loop.length]);
            const steps = Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1])) + 1;
            for (let s = 0; s <= steps; s++) {
              const t = s / steps, x = Math.round(A[0] + (B[0] - A[0]) * t - 0.5), y = Math.round(A[1] + (B[1] - A[1]) * t - 0.5);
              if (x < 0 || y < 0 || x >= width || y >= height) continue;
              const k = y * width + x;
              if (A[2] + (B[2] - A[2]) * t > zb[k] + bias) continue;
              img[k * 3] = img[k * 3 + 1] = img[k * 3 + 2] = 40;
            }
          }
  return { png: png(img, width, height), check: r, triangles };
}

// Area of a flat loop of 3D points.
function area(loop) {
  let s = [0, 0, 0];
  for (let i = 0; i < loop.length; i++) {
    const c = cross(loop[i], loop[(i + 1) % loop.length]);
    s = [s[0] + c[0], s[1] + c[1], s[2] + c[2]];
  }
  return Math.hypot(...s) / 2;
}

function png(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, out = "step.png", width] = process.argv.slice(2);
  if (!file) {
    console.error("Usage: node test/render-step.mjs model.step out.png [width]");
    process.exit(2);
  }
  const { png: bytes, check, triangles } = renderStep(readFileSync(file, "latin1"), { width: Number(width) || 1000 });
  writeFileSync(out, bytes);
  console.log(`${file}: ${check.parts.length} parts drawn from ${triangles} triangles of the file's faces -> ${out}${check.problems.length ? `; ${check.problems.length} problems: ${check.problems.slice(0, 5).join("; ")}` : ""}`);
}
