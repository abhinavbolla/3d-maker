// Validates a 3MF file: a well-formed zip (checksums included) with the
// three parts a 3MF needs, and in the model one named object per part, each
// a closed mesh (every edge shared by exactly two triangles, in opposite
// directions) whose indices are all in range.
// Usage: node test/check-3mf.mjs model.3mf
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { crc32 } from "../src/kernel/threemf.js";

export function unzip(buf) {
  const files = new Map();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("no zip end record");
  const count = buf.readUInt16LE(end + 10);
  let o = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(o + 10), crc = buf.readUInt32LE(o + 16), packed = buf.readUInt32LE(o + 20), size = buf.readUInt32LE(o + 24);
    const nameLen = buf.readUInt16LE(o + 28), extra = buf.readUInt16LE(o + 30), comment = buf.readUInt16LE(o + 32), at = buf.readUInt32LE(o + 42);
    const name = buf.subarray(o + 46, o + 46 + nameLen).toString("utf8");
    if (buf.readUInt32LE(at) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const raw = buf.subarray(start, start + packed);
    const data = method === 8 ? inflateRawSync(raw) : method === 0 ? raw : null;
    if (!data) throw new Error(`${name}: unknown compression ${method}`);
    if (data.length !== size) throw new Error(`${name}: size ${data.length}, header says ${size}`);
    if (crc32(data) !== crc) throw new Error(`${name}: checksum does not match`);
    files.set(name, data);
    o += 46 + nameLen + extra + comment;
  }
  return files;
}

// Returns { title, objects: [{ name, color, vertices, triangles, closed }], problems }.
export function check3MF(buf) {
  const problems = [];
  const files = unzip(buf);
  for (const need of ["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]) if (!files.has(need)) problems.push(`missing ${need}`);
  const xml = files.get("3D/3dmodel.model")?.toString("utf8") ?? "";
  if (!/<model unit="millimeter"/.test(xml)) problems.push("model is not in millimetres");
  const colors = [...xml.matchAll(/<base name="[^"]*" displaycolor="(#[0-9A-F]{8})"\/>/g)].map((m) => m[1]);
  const objects = [];
  for (const m of xml.matchAll(/<object id="(\d+)" type="model" name="([^"]*)"(?: pid="1" pindex="(\d+)")?>([\s\S]*?)<\/object>/g)) {
    const body = m[4];
    const verts = [...body.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)];
    const tris = [...body.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].map((t) => [+t[1], +t[2], +t[3]]);
    const edges = new Map();
    let bad = 0;
    for (const [a, b, c] of tris) {
      if ([a, b, c].some((v) => v >= verts.length)) bad++;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) edges.set(`${u},${v}`, (edges.get(`${u},${v}`) ?? 0) + 1);
    }
    let open = 0;
    for (const [k, n] of edges) {
      const [u, v] = k.split(",");
      if (n !== 1 || edges.get(`${v},${u}`) !== 1) open++;
    }
    const name = m[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    if (bad) problems.push(`${name}: ${bad} triangles point past the vertices`);
    if (open || !tris.length) problems.push(`${name}: not a closed mesh (${open} open edges)`);
    objects.push({ name, color: m[3] !== undefined ? colors[+m[3]] : null, vertices: verts.length, triangles: tris.length, closed: !open && tris.length > 0 });
  }
  const items = [...xml.matchAll(/<item objectid="(\d+)"\/>/g)].length;
  if (!objects.length) problems.push("no objects");
  if (items !== objects.length) problems.push(`${items} build items for ${objects.length} objects`);
  const title = /<metadata name="Title">([^<]*)<\/metadata>/.exec(xml)?.[1] ?? "";
  return { title, objects, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node test/check-3mf.mjs model.3mf");
    process.exit(2);
  }
  const r = check3MF(readFileSync(file));
  console.log(file);
  for (const o of r.objects) console.log(`  ${o.name}: ${o.triangles} triangles${o.color ? `, ${o.color}` : ""}${o.closed ? "" : ", NOT closed"}`);
  console.log(r.problems.length ? `  INVALID: ${r.problems.join("; ")}` : "  valid, every part closed");
  process.exit(r.problems.length ? 1 : 0);
}
