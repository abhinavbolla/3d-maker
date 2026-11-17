// Reads a drawing sheet's own SVG (as sheetSVG in drawing.js writes it) back
// as a flat list of marks on paper, so the PDF and DXF writers draw exactly
// what the SVG shows. It reads only the small part of SVG the sheet uses:
// groups, path (M, L, H, V and Z, absolute), rect, circle and text, with
// stroke-width, stroke-dasharray, stroke-linecap, fill, stroke, font-size,
// text-anchor, a rotate() on text, and data-layer, which says what a mark is
// (visible edge, hidden edge, hatching, dimension, frame and so on).
//
// Units are the sheet's millimetres, y down. Each mark is one of:
//   { kind: "line", pts: [x, y, ...], closed, width, dash, cap, color, layer }
//   { kind: "fill", pts, color, layer }            a filled polygon (arrowheads)
//   { kind: "circle", cx, cy, r, width, dash, color, layer }
//   { kind: "text", x, y, size, anchor, angle, str, color, layer }
// dash: [on, off, ...] in mm, or null. angle: degrees, as SVG's rotate()
// (clockwise on paper). color: [r, g, b] from 0 to 1.

const ATTR = /([\w:-]+)="([^"]*)"/g;
const unxml = (s) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, n, d, h) => (d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[n]));
const INHERITED = ["stroke-width", "stroke-dasharray", "stroke-linecap", "fill", "stroke", "font-size", "text-anchor", "data-layer"];

function color(s) {
  if (!s || s === "none") return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return [0, 0, 0];
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

// Path data as polylines: [{ pts, closed }].
function pathLines(d) {
  const out = [];
  let cur = null, x = 0, y = 0;
  const re = /([MLHVZ])([^MLHVZ]*)/gi;
  let m;
  while ((m = re.exec(d))) {
    const cmd = m[1];
    const n = m[2].trim() ? m[2].trim().split(/[\s,]+/).map(Number) : [];
    if (cmd !== cmd.toUpperCase()) throw new Error(`The sheet reader takes absolute path commands only, not "${cmd}".`);
    if (cmd === "M") {
      for (let i = 0; i < n.length; i += 2) {
        (x = n[i]), (y = n[i + 1]);
        if (i === 0) out.push((cur = { pts: [x, y], closed: false }));
        else cur.pts.push(x, y);
      }
    } else if (cmd === "L") for (let i = 0; i < n.length; i += 2) cur.pts.push((x = n[i]), (y = n[i + 1]));
    else if (cmd === "H") for (const v of n) cur.pts.push((x = v), y);
    else if (cmd === "V") for (const v of n) cur.pts.push(x, (y = v));
    else if (cmd === "Z" && cur) {
      cur.closed = true;
      (x = cur.pts[0]), (y = cur.pts[1]);
    }
  }
  return out.filter((l) => l.pts.length >= 4);
}

// The sheet's size in mm ({ w, h }, from its viewBox) and its marks.
export function readSheet(svg) {
  const vb = /viewBox="([^"]*)"/.exec(svg);
  if (!vb) throw new Error("This SVG has no viewBox.");
  const [, , w, h] = vb[1].trim().split(/[\s,]+/).map(Number);
  const marks = [];
  const stack = [{ fill: "#000", stroke: "none" }];
  const tag = /<(\/?)([\w:]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;
  let skip = 0, m, openText = null;
  while ((m = tag.exec(svg))) {
    if (!m[2]) continue;
    const [, close, name, attrText, self] = m;
    if (name === "title" || name === "metadata") {
      if (!close && !self) skip++;
      else if (close) skip--;
      continue;
    }
    if (skip) continue;
    if (close) {
      if (name === "g" || name === "svg") stack.pop();
      if (name === "text" && openText) {
        const { a, from } = openText;
        const str = unxml(svg.slice(from, m.index));
        openText = null;
        const size = +a["font-size"] || 3.5;
        let x = +a.x || 0, y = +a.y || 0, angle = 0;
        const rot = /rotate\(\s*([-\d.]+)(?:[\s,]+([-\d.]+)[\s,]+([-\d.]+))?\s*\)/.exec(a.transform ?? "");
        if (rot) {
          angle = +rot[1];
          const cx = +(rot[2] ?? 0), cy = +(rot[3] ?? 0), t = (angle * Math.PI) / 180;
          const dx = x - cx, dy = y - cy;
          (x = cx + dx * Math.cos(t) - dy * Math.sin(t)), (y = cy + dx * Math.sin(t) + dy * Math.cos(t));
        }
        if (str.trim()) marks.push({ kind: "text", x, y, size, anchor: a["text-anchor"] ?? "start", angle, str, color: color(a.fill) ?? [0, 0, 0], layer: a["data-layer"] ?? "0" });
      }
      continue;
    }
    const own = {};
    for (const [, k, v] of attrText.matchAll(ATTR)) own[k] = v;
    const a = { ...stack.at(-1) };
    for (const k of INHERITED) if (own[k] !== undefined) a[k] = own[k];
    for (const k of ["x", "y", "width", "height", "cx", "cy", "r", "d", "transform"]) if (own[k] !== undefined) a[k] = own[k];
    if (name === "g" || name === "svg") {
      if (!self) stack.push(a);
      continue;
    }
    if (name === "text") {
      if (!self) openText = { a, from: m.index + m[0].length };
      continue;
    }
    const width = +(a["stroke-width"] ?? 1);
    const dash = a["stroke-dasharray"] && a["stroke-dasharray"] !== "none" ? a["stroke-dasharray"].trim().split(/[\s,]+/).map(Number) : null;
    const stroke = color(a.stroke), fill = color(a.fill);
    const layer = a["data-layer"] ?? "0";
    const cap = a["stroke-linecap"] ?? "butt";
    const white = (c) => c && c.every((v) => v > 0.99);
    let lines = [];
    if (name === "path") lines = pathLines(a.d ?? "");
    else if (name === "rect") {
      const x = +(a.x ?? 0), y = +(a.y ?? 0), rw = +a.width, rh = +a.height;
      lines = [{ pts: [x, y, x + rw, y, x + rw, y + rh, x, y + rh], closed: true }];
    } else if (name === "circle") {
      const c = { cx: +a.cx, cy: +a.cy, r: +a.r };
      if (fill && !white(fill)) marks.push({ kind: "disc", ...c, color: fill, layer });
      if (stroke) marks.push({ kind: "circle", ...c, width, dash, color: stroke, layer });
      continue;
    } else continue;
    for (const l of lines) {
      // A white fill is the paper itself.
      if (fill && !white(fill)) marks.push({ kind: "fill", pts: l.pts, color: fill, layer });
      if (stroke) marks.push({ kind: "line", pts: l.pts, closed: l.closed, width, dash, cap, color: stroke, layer });
    }
  }
  return { w, h, marks };
}
