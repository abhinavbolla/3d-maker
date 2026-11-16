// glTF 2.0 export as one binary file (.glb): a node per part with its name,
// its mesh (positions, normals, indices) and a PBR material, and the model's
// motion as an animation that loops.
//
// Our models are in millimetres with Z up and the front facing -Y. glTF is
// in metres with Y up and the front facing +Z, so a point (x, y, z) here is
// (x, z, -y) / 1000 there. That is a turn about X, not a mirror, so
// triangles keep their winding.

// Material looks, as the view draws them (src/app/viewport.js).
export const LOOKS = {
  metal: { metallic: 0.92, roughness: 0.36 },
  paint: { metallic: 0, roughness: 0.46, clearcoat: 0.55 },
  plastic: { metallic: 0, roughness: 0.52 },
  rubber: { metallic: 0, roughness: 0.93 },
  glass: { metallic: 0, roughness: 0.05, alpha: 0.36 },
};

// "#8d939a" or "#89a" -> [r, g, b] in 0..1, as written (sRGB).
export function srgb(color) {
  let h = String(color ?? "").replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, "$&$&");
  if (!/^[0-9a-f]{6}$/i.test(h)) h = "9aa3ad";
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
export const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// The look a part is drawn with: its material, or without one, from its
// colour (grey is metal, near black is rubber, coloured is paint). Saturation
// and lightness are taken from the linear colour, as the view does.
export function lookOf({ material, color }) {
  if (LOOKS[material]) return material;
  const [r, g, b] = srgb(color).map(toLinear);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : l <= 0.5 ? (max - min) / (max + min) : (max - min) / (2 - max - min);
  return s >= 0.16 ? "paint" : l < 0.16 ? "rubber" : "metal";
}

// Rotation part of a pose (3x4, row-major, ours) turned into glTF axes, as a
// unit quaternion [x, y, z, w]; and its translation in metres.
function poseToGLTF(f, o) {
  // C = [[1,0,0],[0,0,1],[0,-1,0]] maps ours to glTF; R' = C R C^T.
  const r00 = f[o], r01 = f[o + 1], r02 = f[o + 2];
  const r10 = f[o + 4], r11 = f[o + 5], r12 = f[o + 6];
  const r20 = f[o + 8], r21 = f[o + 9], r22 = f[o + 10];
  const m00 = r00, m01 = r02, m02 = -r01;
  const m10 = r20, m11 = r22, m12 = -r21;
  const m20 = -r10, m21 = -r12, m22 = r11;
  let x, y, z, w;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 2 * Math.sqrt(tr + 1);
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return { q: [x / n, y / n, z / n, w / n], t: [f[o + 3] / 1000, f[o + 11] / 1000, -f[o + 7] / 1000] };
}

// A buffer built up of 4-byte aligned views.
function binary() {
  const chunks = [];
  let length = 0;
  const views = [];
  const accessors = [];
  const add = (typed, target) => {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target ? { target } : {}) });
    chunks.push(bytes);
    if (pad) chunks.push(new Uint8Array(pad));
    length += bytes.length + pad;
    return views.length - 1;
  };
  // A float accessor over its own view, with its min and max.
  const floats = (array, type, size, { target, bounds = false } = {}) => {
    const a = { bufferView: add(array, target), componentType: 5126, count: array.length / size, type };
    if (bounds) {
      const min = new Array(size).fill(Infinity), max = new Array(size).fill(-Infinity);
      for (let i = 0; i < array.length; i++) {
        const k = i % size;
        if (array[i] < min[k]) min[k] = array[i];
        if (array[i] > max[k]) max[k] = array[i];
      }
      Object.assign(a, { min, max });
    }
    accessors.push(a);
    return accessors.length - 1;
  };
  const uints = (array) => {
    accessors.push({ bufferView: add(array, 34963), componentType: 5125, count: array.length, type: "SCALAR" });
    return accessors.length - 1;
  };
  const bytes = () => {
    const out = new Uint8Array(length);
    let o = 0;
    for (const c of chunks) out.set(c, o), (o += c.length);
    return out;
  };
  return { floats, uints, views, accessors, bytes };
}

// parts: [{ name, color, material, positions, normals, indices, frames }] in
// our millimetres; frames: the motion's poses, frameCount x 12 (or null for
// a part that does not move). motion: { loop } seconds, or null.
// Returns the .glb file's bytes.
export function toGLB(parts, { title = "", motion = null } = {}) {
  const bin = binary();
  const nodes = [], meshes = [], materials = [];
  parts.forEach((p, i) => {
    const P = p.positions, N = p.normals;
    const pos = new Float32Array(P.length);
    const nrm = new Float32Array(P.length);
    for (let v = 0; v < P.length; v += 3) {
      pos[v] = P[v] / 1000; pos[v + 1] = P[v + 2] / 1000; pos[v + 2] = -P[v + 1] / 1000;
      if (N) (nrm[v] = N[v]), (nrm[v + 1] = N[v + 2]), (nrm[v + 2] = -N[v + 1]);
    }
    const look = lookOf(p);
    const L = LOOKS[look];
    const [r, g, b] = srgb(p.color).map(toLinear);
    const mat = { name: `${p.name} (${look})`, pbrMetallicRoughness: { baseColorFactor: [r, g, b, L.alpha ?? 1], metallicFactor: L.metallic, roughnessFactor: L.roughness } };
    if (L.alpha !== undefined) mat.alphaMode = "BLEND";
    if (L.clearcoat) mat.extensions = { KHR_materials_clearcoat: { clearcoatFactor: L.clearcoat, clearcoatRoughnessFactor: 0.1 } };
    materials.push(mat);
    const attributes = { POSITION: bin.floats(pos, "VEC3", 3, { target: 34962, bounds: true }) };
    if (N) attributes.NORMAL = bin.floats(nrm, "VEC3", 3, { target: 34962 });
    meshes.push({ name: p.name, primitives: [{ attributes, indices: bin.uints(Uint32Array.from(p.indices)), material: i, mode: 4 }] });
    nodes.push({ name: p.name, mesh: i });
  });

  // Motion: every sampled pose as a key, and the first again at the end of
  // the loop, so it plays round without a jump. A part's turning and its
  // moving are separate channels; one that never changes is left out.
  const animations = [];
  const moving = parts.map((p, i) => [p, i]).filter(([p]) => p.frames?.length);
  if (motion?.loop > 0 && moving.length) {
    const count = moving[0][0].frames.length / 12;
    const times = new Float32Array(count + 1);
    for (let k = 0; k <= count; k++) times[k] = (k / count) * motion.loop;
    const input = bin.floats(times, "SCALAR", 1, { bounds: true });
    const samplers = [], channels = [];
    for (const [p, i] of moving) {
      const rot = new Float32Array((count + 1) * 4), mov = new Float32Array((count + 1) * 3);
      let prev = null, turns = false, moves = false;
      for (let k = 0; k <= count; k++) {
        const { q, t } = poseToGLTF(p.frames, (k % count) * 12);
        // Neighbouring keys on the same side, so each step turns the short way.
        if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) for (let c = 0; c < 4; c++) q[c] = -q[c];
        prev = q;
        rot.set(q, k * 4);
        mov.set(t, k * 3);
        if (Math.abs(q[3]) < 1 - 1e-7) turns = true;
        if (Math.hypot(...t) > 1e-7) moves = true;
      }
      if (turns) {
        samplers.push({ input, output: bin.floats(rot, "VEC4", 4), interpolation: "LINEAR" });
        channels.push({ sampler: samplers.length - 1, target: { node: i, path: "rotation" } });
      }
      if (moves) {
        samplers.push({ input, output: bin.floats(mov, "VEC3", 3), interpolation: "LINEAR" });
        channels.push({ sampler: samplers.length - 1, target: { node: i, path: "translation" } });
      }
    }
    if (channels.length) animations.push({ name: "Motion", samplers, channels });
  }

  const data = bin.bytes();
  const gltf = {
    asset: { version: "2.0", generator: "3D Maker" },
    ...(materials.some((m) => m.extensions) ? { extensionsUsed: ["KHR_materials_clearcoat"] } : {}),
    scene: 0,
    scenes: [{ name: title || "Model", nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    ...(animations.length ? { animations } : {}),
    accessors: bin.accessors,
    bufferViews: bin.views,
    buffers: [{ byteLength: data.length }],
  };
  if (title) gltf.asset.extras = { title };

  // GLB: a 12-byte header, the JSON chunk padded with spaces, the binary
  // chunk padded with zeros.
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLen = Math.ceil(json.length / 4) * 4;
  const binLen = data.length;
  const out = new Uint8Array(12 + 8 + jsonLen + 8 + binLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + jsonLen);
  dv.setUint32(20 + jsonLen, binLen, true);
  dv.setUint32(24 + jsonLen, 0x004e4942, true); // "BIN\0"
  out.set(data, 28 + jsonLen);
  return out;
}
