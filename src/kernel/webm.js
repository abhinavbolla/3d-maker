// WebM files with one VP9 or VP8 video track, for browsers whose video
// encoder has no H.264. Written from the Matroska specification (RFC 9559)
// and the WebM container guidelines: an EBML header, then one Segment with
// Info, Tracks, Cues (where each cluster starts, for seeking) and the
// clusters. A cluster starts at every key frame, so each one can be decoded
// on its own.

const enc = new TextEncoder();

// An element's size as a variable-length integer, in as few bytes as fit,
// or in exactly `width` bytes.
function vint(n, width) {
  let len = width ?? 1;
  if (!width) while (n >= 2 ** (7 * len) - 1) len++;
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}
const idBytes = (id) => {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return Uint8Array.from(out);
};
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const el = (id, payload) => concat([idBytes(id), vint(payload.length), payload]);
const master = (id, children) => el(id, concat(children));
// An unsigned integer, in `width` bytes or as few as fit.
function uint(id, v, width) {
  let len = width ?? 1;
  if (!width) while (v >= 2 ** (8 * len)) len++;
  const b = new Uint8Array(len);
  for (let i = len - 1, x = v; i >= 0; i--, x = Math.floor(x / 256)) b[i] = x % 256;
  return el(id, b);
}
const float = (id, v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return el(id, b);
};
const str = (id, s) => el(id, enc.encode(s));

// frames: [{ data, timestamp: µs, key }] in decode order (VP8 and VP9 as
// browsers encode them are shown in that order). codec: "vp9" or "vp8".
export function writeWebM({ frames, codec, width, height, fps }) {
  if (!frames.length) throw new Error("A film needs at least one frame.");
  const ms = (us) => Math.round(us / 1000);
  const header = master(0x1a45dfa3, [uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, "webm"), uint(0x4287, 4), uint(0x4285, 2)]);
  const durationMs = (frames.length * 1000) / fps;
  const info = master(0x1549a966, [uint(0x2ad7b1, 1000000), float(0x4489, durationMs), str(0x4d80, "Draftsman"), str(0x5741, "Draftsman")]);
  const tracks = master(0x1654ae6b, [
    master(0xae, [uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), str(0x86, codec === "vp8" ? "V_VP8" : "V_VP9"), uint(0x23e383, Math.round(1e9 / fps)), master(0xe0, [uint(0xb0, width), uint(0xba, height)])]),
  ]);
  // Clusters: one per key frame, and a new one before a block's time would
  // be too far from its cluster's to write (16 bits of milliseconds).
  const clusters = [];
  let current = null;
  for (const f of frames) {
    const t = ms(f.timestamp);
    if (!current || f.key || t - current.time > 30000) clusters.push((current = { time: t, blocks: [] }));
    const head = new Uint8Array(4);
    head[0] = 0x81; // track 1
    new DataView(head.buffer).setInt16(1, t - current.time);
    head[3] = f.key ? 0x80 : 0;
    current.blocks.push(el(0xa3, concat([head, f.data])));
  }
  const clusterBytes = clusters.map((c) => master(0x1f43b675, [uint(0xe7, c.time), ...c.blocks]));
  // Cues point at clusters by their place in the segment, which comes after
  // the cues; the positions are written in 8 bytes so the cues' own size is
  // known before the positions are.
  const cuesWith = (positions) => master(0x1c53bb6b, clusters.map((c, i) => master(0xbb, [uint(0xb3, c.time), master(0xb7, [uint(0xf7, 1), uint(0xf1, positions[i], 8)])])));
  const before = info.length + tracks.length + cuesWith(clusters.map(() => 0)).length;
  const positions = [];
  let at = before;
  for (const c of clusterBytes) (positions.push(at), (at += c.length));
  const body = concat([info, tracks, cuesWith(positions), ...clusterBytes]);
  return concat([header, idBytes(0x18538067), vint(body.length, 8), body]);
}
