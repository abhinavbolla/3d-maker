// A drawing sheet as a vector PDF (PDF 1.4), written from the sheet's own SVG
// (see svgread.js) so the two always show the same thing. One page, the
// sheet's real size; lines keep their widths, dashes and ends; text is set
// in Helvetica, one of the fonts every PDF reader has, so nothing is
// embedded and the file stays small. The page's content is deflated with
// the platform's CompressionStream where it has one. No dependencies.
import { readSheet } from "./svgread.js";
import { textWidth } from "./drawing.js";

const PT = 72 / 25.4; // points per mm

// Unicode to the font's WinAnsi bytes. Characters it lacks become "?"; the
// diameter sign ⌀ is set as Ø, as is usual where a font has no ⌀.
const WIN = { "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, Š: 0x8a, "‹": 0x8b, Œ: 0x8c, Ž: 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, š: 0x9a, "›": 0x9b, œ: 0x9c, ž: 0x9e, Ÿ: 0x9f, "⌀": 0xd8 };
function winAnsi(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    out.push(WIN[ch] ?? ((c >= 32 && c < 127) || (c >= 160 && c < 256) ? c : 63));
  }
  return out;
}
// A PDF string literal of WinAnsi bytes.
const literal = (bytes) => `(${bytes.map((b) => (b === 40 || b === 41 || b === 92 ? `\\${String.fromCharCode(b)}` : b < 32 || b > 126 ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b))).join("")})`;
// Text for the document's information, which may hold any character: UTF-16 with a byte order mark.
const infoText = (s) => `<FEFF${[...String(s)].map((ch) => { const c = ch.codePointAt(0); if (c < 0x10000) return c.toString(16).padStart(4, "0"); const v = c - 0x10000; return ((0xd800 + (v >> 10)).toString(16) + (0xdc00 + (v & 0x3ff)).toString(16)); }).join("").toUpperCase()}>`;

// Numbers to 0.001 (mm in the page's content), without trailing zeros.
const n = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

// The page's drawing operators, in sheet millimetres with y down (the page's
// matrix turns them into points with y up).
function content({ w, h, marks }) {
  const ops = [`q ${n(PT)} 0 0 ${n(-PT)} 0 ${n(h * PT)} cm 1 j`];
  let width = null, dash = null, cap = null, stroke = null, fill = null;
  const rgb = (c) => c.map(n).join(" ");
  const setStroke = (m) => {
    if (m.width !== width) ops.push(`${n((width = m.width))} w`);
    const d = m.dash ? `[${m.dash.map(n).join(" ")}] 0 d` : "[] 0 d";
    if (d !== dash) ops.push((dash = d));
    const c = m.cap === "round" ? "1 J" : m.cap === "square" ? "2 J" : "0 J";
    if (c !== cap) ops.push((cap = c));
    const s = `${rgb(m.color)} RG`;
    if (s !== stroke) ops.push((stroke = s));
  };
  const setFill = (c) => {
    const f = `${rgb(c)} rg`;
    if (f !== fill) ops.push((fill = f));
  };
  const poly = (pts, closed) => {
    const p = [`${n(pts[0])} ${n(pts[1])} m`];
    for (let i = 2; i < pts.length; i += 2) p.push(`${n(pts[i])} ${n(pts[i + 1])} l`);
    if (closed) p.push("h");
    return p.join(" ");
  };
  // A circle as four Bézier quarters.
  const circle = (cx, cy, r) => {
    const k = 0.5522847498 * r;
    return `${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c h`;
  };
  for (const m of marks) {
    if (m.kind === "line") {
      setStroke(m);
      ops.push(`${poly(m.pts, m.closed)} S`);
    } else if (m.kind === "fill") {
      setFill(m.color);
      ops.push(`${poly(m.pts, true)} f`);
    } else if (m.kind === "circle") {
      setStroke({ ...m, cap: "butt" });
      ops.push(`${circle(m.cx, m.cy, m.r)} S`);
    } else if (m.kind === "disc") {
      setFill(m.color);
      ops.push(`${circle(m.cx, m.cy, m.r)} f`);
    } else if (m.kind === "text") {
      setFill(m.color);
      // Along the text, and down the page from it; the text matrix sets
      // glyphs upright on a page whose y runs down.
      const t = (m.angle * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
      const shift = m.anchor === "middle" ? textWidth(m.str, m.size) / 2 : m.anchor === "end" ? textWidth(m.str, m.size) : 0;
      const x = m.x - c * shift, y = m.y - s * shift;
      ops.push(`BT /F1 ${n(m.size)} Tf ${n(c)} ${n(s)} ${n(s)} ${n(-c)} ${n(x)} ${n(y)} Tm ${literal(winAnsi(m.str))} Tj ET`);
    }
  }
  ops.push("Q");
  return ops.join("\n");
}

async function deflate(bytes) {
  if (typeof CompressionStream !== "function") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

const latin1 = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);

// The sheet's SVG as PDF bytes. info: { title, subject, date } for the
// document's information; date as 2026-01-31.
export async function sheetPDF(svg, { title = "", subject = "", date = "" } = {}) {
  const sheet = readSheet(svg);
  const raw = latin1(content(sheet));
  const packed = await deflate(raw);
  const stream = packed && packed.length < raw.length ? packed : raw;
  const W = n(sheet.w * PT), H = n(sheet.h * PT);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const info = [`/Producer ${infoText("Draftsman")}`, `/Creator ${infoText("Draftsman")}`];
  if (title) info.push(`/Title ${infoText(title)}`);
  if (subject) info.push(`/Subject ${infoText(subject)}`);
  if (d) info.push(`/CreationDate (D:${d[1]}${d[2]}${d[3]})`);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    [`<< /Length ${stream.length}${stream === packed ? " /Filter /FlateDecode" : ""} >>\nstream\n`, stream, "\nendstream"],
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< ${info.join(" ")} >>`,
  ];
  const chunks = [latin1("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  let at = chunks[0].length;
  const offsets = [];
  const put = (x) => {
    const b = typeof x === "string" ? latin1(x) : x;
    chunks.push(b);
    at += b.length;
  };
  objects.forEach((o, i) => {
    offsets.push(at);
    put(`${i + 1} 0 obj\n`);
    for (const p of [o].flat()) put(p);
    put("\nendobj\n");
  });
  const xref = at;
  put(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  put(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(at);
  let k = 0;
  for (const c of chunks) out.set(c, k), (k += c.length);
  return out;
}
