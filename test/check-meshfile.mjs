// Validates a glTF binary (.glb), OBJ (with its MTL), binary PLY or
// self-contained HTML file,
// reading it with code of its own, not the writers'. For every part: its
// name, triangles, bounds in our millimetres with Z up, and that its mesh is
// closed (every edge, by vertex position, met once each way). For a GLB
// also the chunks, accessors, materials and animation; for an OBJ its MTL;
// for a PLY each vertex's colour; for an HTML file that nothing in it reaches
// outside the file, and its packed meshes, looks and motion.
// Usage: node test/check-meshfile.mjs model.glb|model.obj|model.ply|model.html
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

// Closed by position: each edge is met as often one way as the other, so
// there is no hole. Where closed shells touch along an edge (a part made of
// pieces), that edge is met twice each way: closed, but not manifold, and
// counted as shared.
function openEdgesByPosition(pos, tris) {
  const ids = new Map();
  const id = (v) => {
    const k = `${pos[v * 3].toFixed(3)},${pos[v * 3 + 1].toFixed(3)},${pos[v * 3 + 2].toFixed(3)}`;
    if (!ids.has(k)) ids.set(k, ids.size);
    return ids.get(k);
  };
  const edges = new Map();
  let degenerate = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [id(tris[t]), id(tris[t + 1]), id(tris[t + 2])];
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    for (const [u, v] of [[a, b], [b, c], [c, a]]) edges.set(`${u},${v}`, (edges.get(`${u},${v}`) ?? 0) + 1);
  }
  let open = 0, shared = 0;
  for (const [k, n] of edges) {
    const [u, v] = k.split(",");
    if (n !== (edges.get(`${v},${u}`) ?? 0)) open++;
    else if (n > 1) shared++;
  }
  return { open, shared, degenerate };
}

function boundsOf(pos) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k], pos[i + k]);
      b[k + 3] = Math.max(b[k + 3], pos[i + k]);
    }
  return b;
}

function checkPart(name, pos, tris, problems) {
  const bad = tris.some((v) => v < 0 || v >= pos.length / 3);
  if (bad) problems.push(`${name}: a triangle points past the vertices`);
  const { open, shared, degenerate } = bad ? { open: -1, shared: 0, degenerate: 0 } : openEdgesByPosition(pos, tris);
  if (open || !tris.length) problems.push(`${name}: not a closed mesh (${open} open edges)`);
  return { name, triangles: tris.length / 3, vertices: pos.length / 3, bounds: boundsOf(pos), closed: !open && tris.length > 0, shared, degenerate };
}

// ---- GLB ----
const COMPONENTS = { 5120: [1, "getInt8"], 5121: [1, "getUint8"], 5122: [2, "getInt16"], 5123: [2, "getUint16"], 5125: [4, "getUint32"], 5126: [4, "getFloat32"] };
const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function checkGLB(buf) {
  const problems = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB (no glTF magic)");
  if (dv.getUint32(4, true) !== 2) problems.push(`GLB version ${dv.getUint32(4, true)}`);
  if (dv.getUint32(8, true) !== buf.length) problems.push(`header says ${dv.getUint32(8, true)} bytes, file has ${buf.length}`);
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) problems.push("first chunk is not JSON");
  if (jsonLen % 4) problems.push("JSON chunk is not 4-byte aligned");
  const gltf = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)));
  const binAt = 20 + jsonLen;
  const binLen = dv.getUint32(binAt, true);
  if (dv.getUint32(binAt + 4, true) !== 0x004e4942) problems.push("second chunk is not BIN");
  if (binAt + 8 + binLen !== buf.length) problems.push("BIN chunk does not end the file");
  const bin = new DataView(buf.buffer, buf.byteOffset + binAt + 8, binLen);
  if (gltf.asset?.version !== "2.0") problems.push(`asset.version ${gltf.asset?.version}`);
  if (gltf.buffers?.[0]?.byteLength > binLen) problems.push("buffer is longer than the BIN chunk");

  const read = (index) => {
    const a = gltf.accessors[index];
    const view = gltf.bufferViews[a.bufferView];
    const [bytes, get] = COMPONENTS[a.componentType];
    const size = SIZES[a.type];
    const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const stride = view.byteStride ?? bytes * size;
    if (start % bytes) problems.push(`accessor ${index} is not aligned`);
    if (start + stride * (a.count - 1) + bytes * size > (view.byteOffset ?? 0) + view.byteLength) problems.push(`accessor ${index} runs past its buffer view`);
    if (view.byteOffset + view.byteLength > binLen) problems.push(`buffer view ${a.bufferView} runs past the buffer`);
    const out = new Float64Array(a.count * size);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < size; k++) out[i * size + k] = bin[get](start + i * stride + k * bytes, true);
    if (a.min && a.max) {
      for (let k = 0; k < size; k++) {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < a.count; i++) (lo = Math.min(lo, out[i * size + k])), (hi = Math.max(hi, out[i * size + k]));
        if (Math.abs(lo - a.min[k]) > 1e-6 || Math.abs(hi - a.max[k]) > 1e-6) problems.push(`accessor ${index} min/max do not match its data`);
      }
    }
    return out;
  };

  const parts = [];
  const nodes = gltf.nodes ?? [];
  for (const [n, node] of nodes.entries()) {
    if (node.mesh === undefined) continue;
    const mesh = gltf.meshes[node.mesh];
    for (const prim of mesh.primitives) {
      if ((prim.mode ?? 4) !== 4) problems.push(`${node.name}: not triangles`);
      if (gltf.accessors[prim.attributes.POSITION].min === undefined) problems.push(`${node.name}: POSITION has no min/max`);
      const P = read(prim.attributes.POSITION);
      const I = read(prim.indices);
      // Back to our millimetres, Z up: (X, Y, Z) -> (X, -Z, Y) * 1000.
      const ours = new Float64Array(P.length);
      for (let i = 0; i < P.length; i += 3) (ours[i] = P[i] * 1000), (ours[i + 1] = -P[i + 2] * 1000), (ours[i + 2] = P[i + 1] * 1000);
      const part = checkPart(node.name, ours, I, problems);
      if (prim.attributes.NORMAL !== undefined) {
        const N = read(prim.attributes.NORMAL);
        let off = 0;
        for (let i = 0; i < N.length; i += 3) if (Math.abs(Math.hypot(N[i], N[i + 1], N[i + 2]) - 1) > 1e-3) off++;
        if (off) problems.push(`${node.name}: ${off} normals are not unit length`);
        // Normals point out: on average along the face normals of their triangles.
        let agree = 0, total = 0;
        for (let t = 0; t < I.length; t += 3) {
          const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
          const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
          const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          for (const x of [a, b, c]) (total += 1), (agree += f[0] * N[x] + f[1] * N[x + 1] + f[2] * N[x + 2] > 0 ? 1 : 0);
        }
        part.normalsAgree = agree / total;
        if (agree / total < 0.99) problems.push(`${node.name}: normals disagree with the triangles' winding`);
      } else problems.push(`${node.name}: no normals`);
      const m = gltf.materials?.[prim.material];
      if (!m) problems.push(`${node.name}: no material`);
      else part.material = { name: m.name, color: m.pbrMetallicRoughness?.baseColorFactor, metallic: m.pbrMetallicRoughness?.metallicFactor, roughness: m.pbrMetallicRoughness?.roughnessFactor, alphaMode: m.alphaMode ?? "OPAQUE" };
      part.node = n;
      parts.push(part);
    }
  }
  const sceneNodes = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? [];
  if (sceneNodes.length !== nodes.length) problems.push(`${nodes.length} nodes, ${sceneNodes.length} in the scene`);

  // Animations: times rising from 0, outputs one per time, rotations unit.
  const animations = (gltf.animations ?? []).map((a) => {
    let duration = 0;
    for (const s of a.samplers) {
      const t = read(s.input);
      const out = read(s.output);
      for (let i = 1; i < t.length; i++) if (!(t[i] > t[i - 1])) problems.push(`${a.name}: key times do not rise`);
      const size = SIZES[gltf.accessors[s.output].type];
      if (out.length / size !== t.length) problems.push(`${a.name}: ${out.length / size} keys for ${t.length} times`);
      if (size === 4) for (let i = 0; i < out.length; i += 4) if (Math.abs(Math.hypot(out[i], out[i + 1], out[i + 2], out[i + 3]) - 1) > 1e-4) problems.push(`${a.name}: a rotation is not a unit quaternion`);
      duration = Math.max(duration, t[t.length - 1]);
    }
    const targets = new Set(a.channels.map((c) => nodes[c.target.node]?.name));
    return { name: a.name, duration, channels: a.channels.length, parts: targets.size };
  });
  return { format: "glb", parts, animations, extensions: gltf.extensionsUsed ?? [], problems };
}

// ---- OBJ ----
export function checkOBJ(text, mtlText) {
  const problems = [];
  const v = [], vn = [];
  const objects = [];
  let cur = null, mtllib = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === "v") v.push(+rest[0], +rest[1], +rest[2]);
    else if (key === "vn") vn.push(+rest[0], +rest[1], +rest[2]);
    else if (key === "o") objects.push((cur = { name: line.slice(2).trim(), faces: [], normals: 0, material: null }));
    else if (key === "usemtl") cur.material = rest.join(" ");
    else if (key === "mtllib") mtllib = rest.join(" ");
    else if (key === "f") {
      if (rest.length !== 3) problems.push(`${cur?.name}: a face with ${rest.length} corners`);
      for (const c of rest) {
        const [vi, , ni] = c.split("/");
        cur.faces.push(+vi - 1);
        if (ni) {
          cur.normals++;
          if (+ni - 1 >= vn.length / 3) problems.push(`${cur.name}: a normal index past the normals`);
        }
      }
    }
  }
  if (!mtllib) problems.push("no mtllib line");
  const materials = new Map();
  if (mtlText !== undefined) {
    let m = null;
    for (const raw of mtlText.split("\n")) {
      const [key, ...rest] = raw.trim().split(/\s+/);
      if (key === "newmtl") materials.set(rest.join(" "), (m = {}));
      else if (m && key) m[key] = rest.map(Number);
    }
  }
  // Each object's own vertices, in our millimetres with Z up: (x, y, z) -> (x, -z, y).
  const parts = objects.map((o) => {
    const used = [...new Set(o.faces)].sort((a, b) => a - b);
    const local = new Map(used.map((g, i) => [g, i]));
    const pos = new Float64Array(used.length * 3);
    used.forEach((g, i) => ((pos[i * 3] = v[g * 3]), (pos[i * 3 + 1] = -v[g * 3 + 2]), (pos[i * 3 + 2] = v[g * 3 + 1])));
    const tris = o.faces.map((g) => (g >= 0 && g < v.length / 3 ? local.get(g) : -1));
    const part = checkPart(o.name, pos, tris, problems);
    if (o.normals !== o.faces.length) problems.push(`${o.name}: ${o.faces.length - o.normals} corners without a normal`);
    const mat = materials.get(o.material);
    if (mtlText !== undefined && !mat) problems.push(`${o.name}: material "${o.material}" is not in the MTL`);
    part.material = mat ? { name: o.material, Kd: mat.Kd, Pr: mat.Pr?.[0], Pm: mat.Pm?.[0], d: mat.d?.[0] ?? 1 } : null;
    return part;
  });
  if (!parts.length) problems.push("no objects");
  return { format: "obj", mtllib, parts, problems };
}

// ---- PLY ----
const PLY_TYPES = { char: [1, "getInt8"], uchar: [1, "getUint8"], short: [2, "getInt16"], ushort: [2, "getUint16"], int: [4, "getInt32"], uint: [4, "getUint32"], float: [4, "getFloat32"], double: [8, "getFloat64"] };

export function checkPLY(buf) {
  const problems = [];
  const end = buf.indexOf("end_header\n");
  if (buf.subarray(0, 4).toString() !== "ply\n" || end < 0) throw new Error("not a PLY file");
  const header = buf.subarray(0, end).toString("latin1").split("\n");
  if (!header.includes("format binary_little_endian 1.0")) problems.push("not binary little-endian");
  const elements = [];
  const ranges = [];
  for (const line of header) {
    const w = line.split(" ");
    if (w[0] === "element") elements.push({ name: w[1], count: +w[2], props: [] });
    else if (w[0] === "property") elements.at(-1).props.push(w[1] === "list" ? { name: w[4], list: [w[2], w[3]] } : { name: w[2], type: w[1] });
    else if (w[0] === "comment" && w[1] === "part") {
      const [v0, v1] = w[3].split("-").map(Number), [f0, f1] = w[5].split("-").map(Number);
      ranges.push({ name: w.slice(6).join(" "), v0, v1, f0, f1 });
    }
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = end + "end_header\n".length;
  const data = {};
  for (const el of elements) {
    const rows = [];
    for (let i = 0; i < el.count; i++) {
      const row = {};
      for (const p of el.props) {
        if (p.list) {
          const [cb, cg] = PLY_TYPES[p.list[0]], [ib, ig] = PLY_TYPES[p.list[1]];
          const n = dv[cg](o, true);
          o += cb;
          row[p.name] = [];
          for (let k = 0; k < n; k++) row[p.name].push(dv[ig](o, true)), (o += ib);
        } else {
          const [b, g] = PLY_TYPES[p.type];
          row[p.name] = dv[g](o, true);
          o += b;
        }
      }
      rows.push(row);
    }
    data[el.name] = rows;
  }
  if (o !== buf.length) problems.push(`${buf.length - o} bytes after the data`);
  const V = data.vertex ?? [], F = data.face ?? [];
  if (!["red", "green", "blue"].every((c) => elements.find((e) => e.name === "vertex")?.props.some((p) => p.name === c))) problems.push("vertices have no colour");
  if (!ranges.length) ranges.push({ name: "mesh", v0: 0, v1: V.length - 1, f0: 0, f1: F.length - 1 });
  const parts = ranges.map((r) => {
    const pos = new Float64Array((r.v1 - r.v0 + 1) * 3);
    for (let i = r.v0; i <= r.v1; i++) (pos[(i - r.v0) * 3] = V[i].x), (pos[(i - r.v0) * 3 + 1] = V[i].y), (pos[(i - r.v0) * 3 + 2] = V[i].z);
    const tris = [];
    for (let f = r.f0; f <= r.f1; f++) {
      if (F[f].vertex_indices.length !== 3) problems.push(`${r.name}: a face with ${F[f].vertex_indices.length} corners`);
      for (const x of F[f].vertex_indices) tris.push(x - r.v0);
    }
    const part = checkPart(r.name, pos, tris, problems);
    const colors = new Set();
    for (let i = r.v0; i <= r.v1; i++) colors.add(`#${[V[i].red, V[i].green, V[i].blue].map((c) => c.toString(16).padStart(2, "0")).join("")}`);
    part.colors = [...colors];
    return part;
  });
  return { format: "ply", vertices: V.length, faces: F.length, parts, problems };
}

// ---- HTML ----
// What a browser could fetch: a URL with a scheme or protocol-relative, an
// attribute that loads something, CSS that does, or a script that asks.
const REACHES_OUT = /https?:|\/\/|\bsrc\s*=|\bhref\s*=|url\(|@import|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\s*\(|<link|<iframe|<img|<object|<embed/i;

export function checkHTML(text) {
  const problems = [];
  if (!/^<!doctype html>/i.test(text) || !/<\/html>\s*$/.test(text)) problems.push("not a whole HTML document");
  if (!/<meta http-equiv="Content-Security-Policy" content="default-src 'none';/.test(text)) problems.push("no content security policy that blocks the network");
  const data = /<script type="application\/json" id="model">([\s\S]*?)<\/script>/.exec(text);
  if (!data) throw new Error("no model data in the HTML file");
  // The page without its data (base64 has slashes of its own).
  const page = text.slice(0, data.index) + text.slice(data.index + data[0].length);
  const out = REACHES_OUT.exec(page);
  if (out) problems.push(`the page reaches outside the file: "${page.slice(Math.max(0, out.index - 30), out.index + 30)}"`);
  const scripts = [...page.matchAll(/<script\b([^>]*)>/g)];
  if (scripts.length !== 1 || scripts[0][1].trim()) problems.push(`${scripts.length} scripts besides the data; expected one, inline`);
  const model = JSON.parse(data[1]);
  const typed = (s, T) => {
    const b = Buffer.from(s, "base64");
    if (b.length % T.BYTES_PER_ELEMENT) problems.push("packed data of a broken length");
    const copy = new Uint8Array(b.length - (b.length % T.BYTES_PER_ELEMENT));
    copy.set(b.subarray(0, copy.length));
    return new T(copy.buffer);
  };
  let frameCount = null;
  const parts = model.parts.map((p) => {
    // A part's pieces, joined into one mesh.
    const qs = [], ns = [], ts = [];
    let base = 0;
    for (const m of p.meshes) {
      const q = typed(m.pos, Uint16Array), nb = typed(m.nrm, Int8Array), t = typed(m.idx, Uint16Array);
      if (q.length % 3 || nb.length !== q.length) problems.push(`${p.name}: positions and normals do not match`);
      if (t.length % 3) problems.push(`${p.name}: indices are not whole triangles`);
      if (t.some((v) => v >= q.length / 3)) problems.push(`${p.name}: a triangle points past its piece's vertices`);
      for (let i = 0; i < q.length; i++) qs.push(q[i]), ns.push(nb[i]);
      for (const v of t) ts.push(v + base);
      base += q.length / 3;
    }
    const q = qs, nb = ns, tris = ts;
    const pos = new Float64Array(q.length), normals = new Float64Array(q.length);
    for (let i = 0; i < q.length; i++) pos[i] = model.lo[i % 3] + q[i] * model.step[i % 3];
    for (let i = 0; i < q.length; i += 3) {
      const l = Math.hypot(nb[i], nb[i + 1], nb[i + 2]);
      if (l < 100) problems.push(`${p.name}: a normal of length ${(l / 127).toFixed(2)}`);
      for (let k = 0; k < 3; k++) normals[i + k] = nb[i + k] / (l || 1);
    }
    const part = checkPart(p.name, pos, Array.from(tris), problems);
    let volume = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t] * 3, tris[t + 1] * 3, tris[t + 2] * 3];
      volume += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6;
    }
    if (!(p.color?.length === 3 && p.color.every((c) => c >= 0 && c <= 1))) problems.push(`${p.name}: no colour`);
    if (![p.metal, p.rough, p.alpha].every((v) => v >= 0 && v <= 1)) problems.push(`${p.name}: no look`);
    let frames = null;
    if (p.frames) {
      frames = typed(p.frames, Float32Array);
      if (frames.length % 12) problems.push(`${p.name}: poses are not whole`);
      if (frameCount !== null && frames.length / 12 !== frameCount) problems.push(`${p.name}: ${frames.length / 12} poses, others ${frameCount}`);
      frameCount = frames.length / 12;
    }
    return { ...part, pieces: p.meshes.length, volume, look: p.look, color: p.color, alpha: p.alpha, positions: pos, normals, indices: tris, frames };
  });
  if (frameCount && !(model.loop > 0)) problems.push("poses without a loop time");
  return { format: "html", title: model.title, size: model.size, step: model.step, loop: model.loop, frames: frameCount ?? 0, parts, problems };
}

export function checkFile(file) {
  const ext = extname(file).toLowerCase();
  if (ext === ".glb") return checkGLB(readFileSync(file));
  if (ext === ".ply") return checkPLY(readFileSync(file));
  if (ext === ".html") return checkHTML(readFileSync(file, "utf8"));
  if (ext === ".obj") {
    const text = readFileSync(file, "utf8");
    const lib = /^mtllib (.+)$/m.exec(text)?.[1];
    const mtl = lib && existsSync(join(dirname(file), lib)) ? readFileSync(join(dirname(file), lib), "utf8") : undefined;
    const r = checkOBJ(text, mtl);
    if (mtl === undefined) r.problems.push(`the MTL file ${lib ?? ""} is not beside the OBJ`);
    return r;
  }
  throw new Error(`unknown file type ${ext}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node test/check-meshfile.mjs model.glb|model.obj|model.ply|model.html");
    process.exit(2);
  }
  const r = checkFile(file);
  const mm = (b) => [0, 1, 2].map((k) => Math.round(b[k + 3] - b[k])).join(" x ");
  console.log(file);
  for (const p of r.parts) console.log(`  ${p.name}: ${p.triangles} triangles, ${mm(p.bounds)} mm${p.closed ? "" : ", NOT closed"}${p.shared ? `, ${p.shared} edges where closed shells touch` : ""}`);
  for (const a of r.animations ?? []) console.log(`  animation ${a.name}: ${a.duration.toFixed(3)} s, ${a.parts} parts move`);
  console.log(r.problems.length ? `  INVALID: ${[...new Set(r.problems)].slice(0, 20).join("; ")}` : "  valid, every part closed");
  process.exit(r.problems.length ? 1 : 0);
}
