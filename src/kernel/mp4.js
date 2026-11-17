// MP4 files with one H.264 video track, written from encoded frames (what
// the browser's VideoEncoder gives). Written from ISO/IEC 14496-12 (the ISO
// base media file format) and 14496-15 (how H.264 is carried in it).
//
// The whole film is in memory, so the file is laid out for playback that can
// start at once: ftyp, then moov (the index of every frame), then mdat (the
// frames, one chunk). Frames are given in decode order; each has the time it
// is shown at, in microseconds.

const enc = new TextEncoder();

// A growing byte buffer with big-endian writers.
class Out {
  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
    this.at = 0;
  }
  room(n) {
    if (this.at + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.at + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.at));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v) { this.room(1); this.view.setUint8(this.at, v); this.at += 1; return this; }
  u16(v) { this.room(2); this.view.setUint16(this.at, v); this.at += 2; return this; }
  u32(v) { this.room(4); this.view.setUint32(this.at, v >>> 0); this.at += 4; return this; }
  i32(v) { this.room(4); this.view.setInt32(this.at, v); this.at += 4; return this; }
  u64(v) { this.u32(Math.floor(v / 2 ** 32)); return this.u32(v % 2 ** 32); }
  bytes(b) { this.room(b.length); this.buf.set(b, this.at); this.at += b.length; return this; }
  text(s) { return this.bytes(enc.encode(s)); }
  zeros(n) { this.room(n); this.buf.fill(0, this.at, this.at + n); this.at += n; return this; }
  done() { return this.buf.subarray(0, this.at); }
}

// A box: its size, its four-letter type, then what fill() writes. A full box
// (version and flags) when version is given.
function box(type, fill, version, flags = 0) {
  const o = new Out();
  o.u32(0).text(type);
  if (version !== undefined) o.u8(version).u8(flags >> 16).u16(flags & 0xffff);
  fill?.(o);
  const b = o.done();
  new DataView(b.buffer, b.byteOffset).setUint32(0, b.length);
  return b;
}
const join = (...parts) => {
  const o = new Out(parts.reduce((n, p) => n + p.length, 0) || 1);
  for (const p of parts) o.bytes(p);
  return o.done();
};

// The identity transform of mvhd and tkhd, as 16.16 and 2.30 fixed point.
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

// ---- H.264 in Annex B form (start codes) to the form MP4 needs ----
// A browser that gives its frames with start codes and no decoder
// description still gives a usable film: the parameter sets are taken from
// the first key frame and every frame is rewritten with length prefixes.
export function annexBUnits(data) {
  const units = [];
  let i = 0, start = -1;
  const n = data.length;
  while (i + 2 < n) {
    if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && i + 3 < n && data[i + 3] === 1))) {
      const len = data[i + 2] === 1 ? 3 : 4;
      if (start >= 0) units.push(data.subarray(start, i));
      i += len;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < n) units.push(data.subarray(start));
  // A zero byte before the next start code belongs to the code, not the unit.
  return units.map((u) => {
    let e = u.length;
    while (e > 0 && u[e - 1] === 0) e--;
    return u.subarray(0, e);
  }).filter((u) => u.length);
}
export function lengthPrefixed(units) {
  const o = new Out(units.reduce((n, u) => n + u.length + 4, 0) || 1);
  for (const u of units) o.u32(u.length).bytes(u);
  return o.done();
}
// An AVCDecoderConfigurationRecord (14496-15, 5.3.3) from one SPS and PPS.
export function avcConfig(sps, pps) {
  const o = new Out();
  o.u8(1).u8(sps[1]).u8(sps[2]).u8(sps[3]).u8(0xff); // version, profile, compatibility, level, 4-byte lengths
  o.u8(0xe1).u16(sps.length).bytes(sps);
  o.u8(1).u16(pps.length).bytes(pps);
  // High profiles carry the chroma format and bit depths too (4:2:0, 8 bits).
  if (![66, 77, 88].includes(sps[1])) o.u8(0xfd).u8(0xf8).u8(0xf8).u8(0);
  return o.done();
}

// frames: [{ data: Uint8Array, timestamp: µs, key: boolean }] in decode
// order, data length-prefixed (as VideoEncoder gives with avc.format "avc")
// or with start codes when config is null.
// config: the decoder description (avcC payload), or null.
// fps: frames a second; each frame lasts 1/fps.
export function writeMP4({ frames, config, width, height, fps }) {
  if (!frames.length) throw new Error("A film needs at least one frame.");
  let samples = frames;
  if (!config) {
    const units = annexBUnits(frames[0].data);
    const sps = units.find((u) => (u[0] & 0x1f) === 7);
    const pps = units.find((u) => (u[0] & 0x1f) === 8);
    if (!sps || !pps) throw new Error("The video encoder gave no H.264 parameter sets.");
    config = avcConfig(sps, pps);
    samples = frames.map((f) => ({ ...f, data: lengthPrefixed(annexBUnits(f.data).filter((u) => ![7, 8, 9].includes(u[0] & 0x1f))) }));
  }
  // The media clock ticks 1000 times a frame, so every frame time is whole.
  const timescale = Math.round(fps * 1000);
  const tick = (us) => Math.round((us * timescale) / 1e6);
  const delta = 1000;
  const n = samples.length;
  const duration = n * delta;
  const movieDuration = Math.round((n * 1000) / fps); // in ms
  // Decode times are one frame apart; a frame shown later than it is decoded
  // (when the encoder reorders) gets a composition offset.
  const shown = samples.map((s) => tick(s.timestamp));
  const first = Math.min(...shown);
  const offsets = shown.map((t, i) => t - first - i * delta);
  const reordered = offsets.some((v) => v !== 0);

  const mvhd = box("mvhd", (o) => {
    o.u32(0).u32(0).u32(1000).u32(movieDuration);
    o.u32(0x00010000).u16(0x0100).zeros(10);
    for (const m of MATRIX) o.u32(m);
    o.zeros(24).u32(2);
  }, 0);
  const tkhd = box("tkhd", (o) => {
    o.u32(0).u32(0).u32(1).u32(0).u32(movieDuration);
    o.zeros(8).u16(0).u16(0).u16(0).u16(0);
    for (const m of MATRIX) o.u32(m);
    o.u32(width * 0x10000).u32(height * 0x10000);
  }, 0, 3);
  const mdhd = box("mdhd", (o) => o.u32(0).u32(0).u32(timescale).u32(duration).u16(0x55c4).u16(0), 0); // language "und"
  const hdlr = box("hdlr", (o) => o.u32(0).text("vide").zeros(12).text("VideoHandler").u8(0), 0);
  const vmhd = box("vmhd", (o) => o.u16(0).zeros(6), 0, 1);
  const dinf = box("dinf", (o) => o.bytes(box("dref", (d) => d.u32(1).bytes(box("url ", null, 0, 1)), 0)));
  const avc1 = box("avc1", (o) => {
    o.zeros(6).u16(1); // reserved, data reference 1
    o.zeros(16).u16(width).u16(height);
    o.u32(0x00480000).u32(0x00480000).u32(0).u16(1); // 72 dpi, one frame per sample
    const name = enc.encode("Draftsman H.264").subarray(0, 31);
    o.u8(name.length).bytes(name).zeros(31 - name.length);
    o.u16(0x0018).u16(0xffff);
    o.bytes(box("avcC", (c) => c.bytes(config)));
  });
  const stsd = box("stsd", (o) => o.u32(1).bytes(avc1), 0);
  const stts = box("stts", (o) => o.u32(1).u32(n).u32(delta), 0);
  const runs = [];
  for (const v of offsets) {
    if (runs.length && runs.at(-1)[1] === v) runs.at(-1)[0]++;
    else runs.push([1, v]);
  }
  const negative = offsets.some((v) => v < 0);
  const ctts = reordered ? box("ctts", (o) => { o.u32(runs.length); for (const [count, v] of runs) o.u32(count).i32(v); }, negative ? 1 : 0) : new Uint8Array(0);
  const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
  const stss = keys.length === n ? new Uint8Array(0) : box("stss", (o) => { o.u32(keys.length); for (const k of keys) o.u32(k); }, 0);
  const stsc = box("stsc", (o) => o.u32(1).u32(1).u32(n).u32(1), 0);
  const stsz = box("stsz", (o) => { o.u32(0).u32(n); for (const s of samples) o.u32(s.data.length); }, 0);
  const dataSize = samples.reduce((sum, s) => sum + s.data.length, 0);
  if (dataSize > 2 ** 32 - 1024) throw new Error("The film is too big for one file (over 4 GB). Make it shorter or smaller.");

  const ftyp = box("ftyp", (o) => o.text("isom").u32(0x200).text("isom").text("iso2").text("avc1").text("mp41"));
  // moov's size does not depend on where the frames start, so build it with
  // the offset at 0, then again with the real one.
  const moovWith = (offset) => {
    const stco = box("stco", (o) => o.u32(1).u32(offset), 0);
    const stbl = box("stbl", (o) => o.bytes(join(stsd, stts, ctts, stss, stsc, stsz, stco)));
    const minf = box("minf", (o) => o.bytes(join(vmhd, dinf, stbl)));
    const mdia = box("mdia", (o) => o.bytes(join(mdhd, hdlr, minf)));
    const trak = box("trak", (o) => o.bytes(join(tkhd, mdia)));
    return box("moov", (o) => o.bytes(join(mvhd, trak)));
  };
  const moov = moovWith(ftyp.length + moovWith(0).length + 8);
  const file = new Uint8Array(ftyp.length + moov.length + 8 + dataSize);
  file.set(ftyp, 0);
  file.set(moov, ftyp.length);
  let at = ftyp.length + moov.length;
  new DataView(file.buffer).setUint32(at, 8 + dataSize);
  file.set(enc.encode("mdat"), at + 4);
  at += 8;
  for (const s of samples) {
    file.set(s.data, at);
    at += s.data.length;
  }
  return file;
}

// Reads an MP4's boxes back: for tests and checks. Returns the tree as
// [{ type, start, size, children? }] for the container boxes it knows.
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf"]);
export function readBoxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    let head = 8;
    if (size === 1) (size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12)), (head = 16);
    if (size === 0) size = end - at;
    if (size < head || at + size > end) throw new Error(`Box ${type} at ${at} runs past the end.`);
    const b = { type, start: at, head, size };
    if (CONTAINERS.has(type)) b.children = readBoxes(bytes, at + head, at + size);
    out.push(b);
    at += size;
  }
  return out;
}
