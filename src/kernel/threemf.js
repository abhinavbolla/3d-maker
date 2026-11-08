// 3MF export: one named, coloured object per part, in millimetres. A 3MF
// file is a zip of three XML files; the zip is written here too (deflated
// with the platform's CompressionStream where it has one, else stored).

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

// "#8d939a" -> "#8D939AFF"; anything else -> null (no colour).
function displayColor(c) {
  let m = /^#?([0-9a-f]{6})$/i.exec(String(c ?? ""));
  if (m) return `#${m[1].toUpperCase()}FF`;
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(String(c ?? ""));
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}FF`.toUpperCase() : null;
}

// Numbers to 4 decimals (0.1 micrometre), without trailing zeros.
const num = (v) => String(Math.round(v * 1e4) / 1e4);

// objects: [{ name, color, positions, indices }] with shared vertices.
export function modelXML(objects, { title = "" } = {}) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
  if (title) out.push(` <metadata name="Title">${xml(title)}</metadata>\n`);
  out.push(' <metadata name="Application">3D Maker</metadata>\n <resources>\n');
  const colors = objects.map((o) => displayColor(o.color));
  const used = colors.some(Boolean);
  if (used) {
    out.push('  <basematerials id="1">\n');
    objects.forEach((o, i) => out.push(`   <base name="${xml(o.name)}" displaycolor="${colors[i] ?? "#9AA3ADFF"}"/>\n`));
    out.push("  </basematerials>\n");
  }
  objects.forEach((o, i) => {
    const id = i + 2;
    out.push(`  <object id="${id}" type="model" name="${xml(o.name)}"${used ? ` pid="1" pindex="${i}"` : ""}>\n   <mesh>\n    <vertices>\n`);
    const P = o.positions;
    const lines = [];
    for (let v = 0; v < P.length; v += 3) lines.push(`     <vertex x="${num(P[v])}" y="${num(P[v + 1])}" z="${num(P[v + 2])}"/>\n`);
    out.push(lines.join(""), "    </vertices>\n    <triangles>\n");
    const T = o.indices;
    const tris = [];
    for (let t = 0; t < T.length; t += 3) tris.push(`     <triangle v1="${T[t]}" v2="${T[t + 1]}" v3="${T[t + 2]}"/>\n`);
    out.push(tris.join(""), "    </triangles>\n   </mesh>\n  </object>\n");
  });
  out.push(" </resources>\n <build>\n");
  objects.forEach((_, i) => out.push(`  <item objectid="${i + 2}"/>\n`));
  out.push(" </build>\n</model>\n");
  return out.join("");
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n';
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n';

export async function to3MF(objects, opts = {}) {
  const enc = new TextEncoder();
  return zip([
    ["[Content_Types].xml", enc.encode(CONTENT_TYPES)],
    ["_rels/.rels", enc.encode(RELS)],
    ["3D/3dmodel.model", enc.encode(modelXML(objects, opts))],
  ]);
}

// ---- zip ----
const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes) {
  if (typeof CompressionStream !== "function") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

// files: [[name, bytes]] -> one zip. Each file is deflated if that makes it smaller.
export async function zip(files) {
  const enc = new TextEncoder();
  const entries = [];
  for (const [name, data] of files) {
    const packed = await deflate(data);
    const method = packed && packed.length < data.length ? 8 : 0;
    entries.push({ name: enc.encode(name), data: method ? packed : data, size: data.length, crc: crc32(data), method });
  }
  const total = entries.reduce((s, e) => s + 30 + e.name.length + e.data.length + 46 + e.name.length, 22);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const e of entries) {
    e.offset = o;
    dv.setUint32(o, 0x04034b50, true);
    dv.setUint16(o + 4, 20, true); // version needed
    dv.setUint16(o + 6, 0x0800, true); // UTF-8 names
    dv.setUint16(o + 8, e.method, true);
    dv.setUint16(o + 10, 0, true); // time
    dv.setUint16(o + 12, 0x21, true); // date: 1980-01-01
    dv.setUint32(o + 14, e.crc, true);
    dv.setUint32(o + 18, e.data.length, true);
    dv.setUint32(o + 22, e.size, true);
    dv.setUint16(o + 26, e.name.length, true);
    dv.setUint16(o + 28, 0, true);
    out.set(e.name, o + 30);
    out.set(e.data, o + 30 + e.name.length);
    o += 30 + e.name.length + e.data.length;
  }
  const dir = o;
  for (const e of entries) {
    dv.setUint32(o, 0x02014b50, true);
    dv.setUint16(o + 4, 20, true); // made by
    dv.setUint16(o + 6, 20, true); // needed
    dv.setUint16(o + 8, 0x0800, true);
    dv.setUint16(o + 10, e.method, true);
    dv.setUint16(o + 12, 0, true);
    dv.setUint16(o + 14, 0x21, true);
    dv.setUint32(o + 16, e.crc, true);
    dv.setUint32(o + 20, e.data.length, true);
    dv.setUint32(o + 24, e.size, true);
    dv.setUint16(o + 28, e.name.length, true);
    // extra, comment, disk, internal attrs: 0
    dv.setUint32(o + 38, 0, true); // external attrs
    dv.setUint32(o + 42, e.offset, true);
    out.set(e.name, o + 46);
    o += 46 + e.name.length;
  }
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 8, entries.length, true);
  dv.setUint16(o + 10, entries.length, true);
  dv.setUint32(o + 12, o - dir, true);
  dv.setUint32(o + 16, dir, true);
  return out;
}
