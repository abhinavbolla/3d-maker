// PLY export: binary (little-endian), all parts in one mesh, each vertex
// with its part's colour. Millimetres, Z up, as the model is (like STL).
// PLY has no parts, so each part's name and its vertex and face ranges go in
// comment lines in the header.
import { srgb } from "./gltf.js";

// parts: [{ name, color, positions, indices }]. Returns the file's bytes.
export function toPLY(parts, { title = "" } = {}) {
  const nv = parts.reduce((s, p) => s + p.positions.length / 3, 0);
  const nf = parts.reduce((s, p) => s + p.indices.length / 3, 0);
  const line = (s) => String(s).replace(/[\r\n]+/g, " ");
  const head = ["ply", "format binary_little_endian 1.0", "comment 3D Maker", ...(title ? [`comment title ${line(title)}`] : []), "comment units millimetres, Z up"];
  let v0 = 0, f0 = 0;
  for (const p of parts) {
    const v = p.positions.length / 3, f = p.indices.length / 3;
    head.push(`comment part vertices ${v0}-${v0 + v - 1} faces ${f0}-${f0 + f - 1} ${line(p.name)}`);
    v0 += v;
    f0 += f;
  }
  head.push(`element vertex ${nv}`, "property float x", "property float y", "property float z", "property uchar red", "property uchar green", "property uchar blue", `element face ${nf}`, "property list uchar int vertex_indices", "end_header", "");
  const header = new TextEncoder().encode(head.join("\n"));
  const out = new Uint8Array(header.length + nv * 15 + nf * 13);
  out.set(header);
  const dv = new DataView(out.buffer);
  let o = header.length;
  for (const p of parts) {
    const [r, g, b] = srgb(p.color).map((c) => Math.round(c * 255));
    const P = p.positions;
    for (let i = 0; i < P.length; i += 3) {
      dv.setFloat32(o, P[i], true);
      dv.setFloat32(o + 4, P[i + 1], true);
      dv.setFloat32(o + 8, P[i + 2], true);
      out[o + 12] = r;
      out[o + 13] = g;
      out[o + 14] = b;
      o += 15;
    }
  }
  let base = 0;
  for (const p of parts) {
    const I = p.indices;
    for (let t = 0; t < I.length; t += 3) {
      out[o] = 3;
      dv.setInt32(o + 1, I[t] + base, true);
      dv.setInt32(o + 5, I[t + 1] + base, true);
      dv.setInt32(o + 9, I[t + 2] + base, true);
      o += 13;
    }
    base += p.positions.length / 3;
  }
  return out;
}
