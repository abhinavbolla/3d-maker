// Drawings as ASCII DXF, the 2D CAD exchange format, and outlines at true
// size (1:1, in mm, no sheet) as DXF and SVG, for laser and water-jet
// cutters. No dependencies.
//
// The DXF is release 12 (AC1009), which every 2D CAD program and cutter
// reads: LINE, POLYLINE, CIRCLE, ARC, SOLID and TEXT entities, on named
// layers with their own line types. Release 12 has no line weights, so the
// layers carry them: VISIBLE and SECTION are the wide lines, the rest narrow.
//
// The drawing sheet is written from its own SVG (see svgread.js), so the
// DXF holds exactly what the SVG shows, at paper size in mm with y up.
import { readSheet } from "./svgread.js";

const { abs, min, max, hypot, atan2, sqrt, round, PI } = Math;

// Layers: name, AutoCAD colour number, line type. A layer that is not here
// gets colour 7 and continuous lines.
const LAYERS = {
  VISIBLE: [7, "CONTINUOUS"],
  HIDDEN: [4, "HIDDEN"],
  CENTRE: [1, "CENTRE"],
  SECTION: [7, "CONTINUOUS"],
  HATCH: [8, "CONTINUOUS"],
  DIMENSIONS: [3, "CONTINUOUS"],
  DETAIL: [6, "CONTINUOUS"],
  FRAME: [7, "CONTINUOUS"],
  TITLE: [7, "CONTINUOUS"],
  OUTLINE: [7, "CONTINUOUS"],
};

// A number as DXF takes it: plain decimal, to 0.0001.
const num = (v) => {
  const r = round(v * 10000) / 10000;
  return Object.is(r, -0) ? "0.0" : Number.isInteger(r) ? `${r}.0` : String(r);
};
// Text: ASCII as is; ⌀ (and Ø), ° and ± as AutoCAD's codes; other
// characters as \U+XXXX, which AutoCAD and most readers understand.
const dxfText = (s) =>
  [...String(s)]
    .map((ch) => {
      if (ch === "⌀" || ch === "Ø") return "%%c";
      if (ch === "°") return "%%d";
      if (ch === "±") return "%%p";
      const c = ch.codePointAt(0);
      return c >= 32 && c < 127 ? ch : `\\U+${c.toString(16).toUpperCase().padStart(4, "0")}`;
    })
    .join("");

// A DXF file from entities, each a list of [code, value] pairs (without the
// layer: { layer, ltype, pairs: [...] , type }). ltypes: { NAME: [dash, -gap, ...] }.
function dxfFile(entities, { ltypes = {}, extents, units = true }) {
  const out = [];
  const g = (code, value) => out.push(String(code).padStart(3, " "), String(value));
  const point = (c, x, y) => (g(10 + c, num(x)), g(20 + c, num(y)), g(30 + c, "0.0"));
  g(0, "SECTION"), g(2, "HEADER");
  g(9, "$ACADVER"), g(1, "AC1009");
  g(9, "$INSBASE"), point(0, 0, 0);
  g(9, "$EXTMIN"), point(0, extents[0], extents[1]);
  g(9, "$EXTMAX"), point(0, extents[2], extents[3]);
  g(9, "$LIMMIN"), g(10, num(extents[0])), g(20, num(extents[1]));
  g(9, "$LIMMAX"), g(10, num(extents[2])), g(20, num(extents[3]));
  g(9, "$LTSCALE"), g(40, "1.0");
  // Metric, in millimetres.
  g(9, "$MEASUREMENT"), g(70, 1);
  if (units) g(9, "$INSUNITS"), g(70, 4);
  g(0, "ENDSEC");

  const usedLayers = [...new Set(entities.map((e) => e.layer))];
  const types = { CONTINUOUS: [], ...ltypes };
  for (const l of usedLayers) if (LAYERS[l] && !types[LAYERS[l][1]]) types[LAYERS[l][1]] = l === "HIDDEN" ? [3, -0.75] : [8, -1.5, 0.5, -1.5];
  g(0, "SECTION"), g(2, "TABLES");
  g(0, "TABLE"), g(2, "LTYPE"), g(70, Object.keys(types).length);
  for (const [name, pattern] of Object.entries(types)) {
    g(0, "LTYPE"), g(2, name), g(70, 0), g(3, name === "CONTINUOUS" ? "Solid line" : pattern.map((v) => (v > 0 ? "__" : " ")).join(""));
    g(72, 65), g(73, pattern.length), g(40, num(pattern.reduce((s, v) => s + abs(v), 0)));
    for (const v of pattern) g(49, num(v));
  }
  g(0, "ENDTAB");
  g(0, "TABLE"), g(2, "LAYER"), g(70, usedLayers.length + 1);
  for (const name of ["0", ...usedLayers.filter((l) => l !== "0")]) {
    const [colour, ltype] = LAYERS[name] ?? [7, "CONTINUOUS"];
    g(0, "LAYER"), g(2, name), g(70, 0), g(62, colour), g(6, ltype);
  }
  g(0, "ENDTAB");
  g(0, "TABLE"), g(2, "STYLE"), g(70, 1);
  g(0, "STYLE"), g(2, "STANDARD"), g(70, 0), g(40, "0.0"), g(41, "1.0"), g(50, "0.0"), g(71, 0), g(42, "2.5"), g(3, "txt"), g(4, "");
  g(0, "ENDTAB");
  g(0, "ENDSEC");

  g(0, "SECTION"), g(2, "BLOCKS"), g(0, "ENDSEC");
  g(0, "SECTION"), g(2, "ENTITIES");
  for (const e of entities) {
    g(0, e.type), g(8, e.layer);
    if (e.ltype) g(6, e.ltype);
    for (const [c, v] of e.pairs) g(c, v);
    for (const v of e.vertices ?? []) {
      g(0, "VERTEX"), g(8, e.layer), point(0, v[0], v[1]);
      if (v[2]) g(42, num(v[2]));
    }
    if (e.vertices) g(0, "SEQEND"), g(8, e.layer);
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return `${out.join("\n")}\n`;
}

// ---- entities ----
const P = (c, x, y) => [[10 + c, num(x)], [20 + c, num(y)], [30 + c, "0.0"]];
const lineEntity = (layer, x0, y0, x1, y1, ltype) => ({ type: "LINE", layer, ltype, pairs: [...P(0, x0, y0), ...P(1, x1, y1)] });
// A polyline through [x, y, ...]; bulges: one per vertex (the arc to the next
// vertex, as tan(angle / 4)), or none.
const polyEntity = (layer, pts, closed, ltype, bulges) => ({
  type: "POLYLINE",
  layer,
  ltype,
  pairs: [[66, 1], ...P(0, 0, 0), [70, closed ? 1 : 0]],
  vertices: Array.from({ length: pts.length / 2 }, (_, i) => [pts[i * 2], pts[i * 2 + 1], bulges?.[i] ?? 0]),
});
const circleEntity = (layer, cx, cy, r, ltype) => ({ type: "CIRCLE", layer, ltype, pairs: [...P(0, cx, cy), [40, num(r)]] });
// Corners in order round the shape; a triangle repeats its last corner.
// (A SOLID's third and fourth corners go across, so they are swapped.)
const solidEntity = (layer, pts) => {
  const c = [];
  for (let i = 0; i < 4; i++) c.push(min(i, pts.length / 2 - 1));
  const order = [c[0], c[1], c[3], c[2]];
  return { type: "SOLID", layer, pairs: order.flatMap((k, i) => P(i, pts[k * 2], pts[k * 2 + 1])) };
};
// Text with its baseline's left, middle or right end at (x, y), turned
// `angle` degrees anticlockwise; height is the capitals' height.
function textEntity(layer, x, y, height, str, angle, anchor) {
  const h = anchor === "middle" ? 1 : anchor === "end" ? 2 : 0;
  const pairs = [...P(0, x, y), [40, num(height)], [1, dxfText(str)]];
  if (angle) pairs.push([50, num(angle)]);
  if (h) pairs.push([72, h], ...P(1, x, y));
  return { type: "TEXT", layer, pairs };
}

// Helvetica's capitals are 0.718 of its size: the SVG's font-size is the
// size, a DXF text height is the capitals' height.
const CAP = 0.718;

// The drawing sheet's SVG as DXF text: paper millimetres, y up, the
// sheet's corner at (0, 0).
export function sheetDXF(svg) {
  const { w, h, marks } = readSheet(svg);
  const ltypes = {};
  // Each dash pattern gets a line type: the layer's own name where the
  // layer has one, else DASHn.
  const ltypeOf = (m) => {
    if (!m.dash) return undefined;
    const pattern = m.dash.map((v, i) => (i % 2 ? -v : v));
    const key = pattern.join(",");
    const known = Object.entries(ltypes).find(([, p]) => p.join(",") === key);
    if (known) return known[0];
    const want = LAYERS[m.layer]?.[1];
    const name = want && want !== "CONTINUOUS" && !ltypes[want] ? want : `DASH${Object.keys(ltypes).length + 1}`;
    ltypes[name] = pattern;
    return name;
  };
  const Y = (y) => h - y;
  const entities = [];
  for (const m of marks) {
    const layer = m.layer || "0";
    if (m.kind === "line") {
      const lt = ltypeOf(m);
      const ltype = lt && lt === LAYERS[layer]?.[1] ? undefined : lt;
      const pts = m.pts.map((v, i) => (i % 2 ? Y(v) : v));
      if (pts.length === 4 && !m.closed) entities.push(lineEntity(layer, pts[0], pts[1], pts[2], pts[3], ltype));
      else entities.push(polyEntity(layer, pts, m.closed, ltype));
    } else if (m.kind === "fill") {
      const pts = m.pts.map((v, i) => (i % 2 ? Y(v) : v));
      // A small fill (an arrowhead) is a SOLID, and its outline too: some
      // readers (FreeCAD's) skip SOLIDs, and would lose every arrowhead.
      if (pts.length <= 8) entities.push(solidEntity(layer, pts), polyEntity(layer, pts, true));
      else entities.push(polyEntity(layer, pts, true));
    } else if (m.kind === "circle" || m.kind === "disc") {
      const lt = m.kind === "circle" ? ltypeOf(m) : undefined;
      entities.push(circleEntity(layer, m.cx, Y(m.cy), m.r, lt && lt === LAYERS[layer]?.[1] ? undefined : lt));
    } else if (m.kind === "text") {
      entities.push(textEntity(layer, m.x, Y(m.y), m.size * CAP, m.str, -m.angle, m.anchor));
    }
  }
  return dxfFile(entities, { ltypes, extents: [0, 0, w, h] });
}

// ---- outlines at true size ----
// A circle through a closed loop [x, y, ...] when every point is within tol
// of it: { cx, cy, r, error } (error: the largest distance off it), else null.
// The fit is the least-squares one of Kåsa (1976), then checked.
// whole: false takes an arc too (the points need not go round).
export function fitCircle(pts, tolOf = (r) => max(0.01, r * 0.004), { whole = true } = {}) {
  const n = pts.length / 2;
  if (n < (whole ? 8 : 5)) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) (mx += pts[i * 2]), (my += pts[i * 2 + 1]);
  (mx /= n), (my /= n);
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < n; i++) {
    const u = pts[i * 2] - mx, v = pts[i * 2 + 1] - my;
    (suu += u * u), (svv += v * v), (suv += u * v);
    (suuu += u * u * u), (svvv += v * v * v), (suvv += u * v * v), (svuu += v * u * u);
  }
  const det = suu * svv - suv * suv;
  if (abs(det) < 1e-18) return null;
  const a = (suuu + suvv) / 2, b = (svvv + svuu) / 2;
  const uc = (a * svv - b * suv) / det, vc = (b * suu - a * suv) / det;
  const cx = mx + uc, cy = my + vc, r = sqrt(uc * uc + vc * vc + (suu + svv) / n);
  let error = 0;
  for (let i = 0; i < n; i++) error = max(error, abs(hypot(pts[i * 2] - cx, pts[i * 2 + 1] - cy) - r));
  // The lines between the points must follow it too: a rectangle's four
  // corners lie on a circle, but its sides do not.
  for (let i = 0; i + 1 < n; i++) error = max(error, abs(hypot((pts[i * 2] + pts[i * 2 + 2]) / 2 - cx, (pts[i * 2 + 1] + pts[i * 2 + 3]) / 2 - cy) - r));
  // The points must go all the way round, not bunch on one side.
  let turned = 0;
  for (let i = 0; i < n && whole; i++) {
    const j = (i + 1) % n;
    let d = atan2(pts[j * 2 + 1] - cy, pts[j * 2] - cx) - atan2(pts[i * 2 + 1] - cy, pts[i * 2] - cx);
    if (d > PI) d -= 2 * PI;
    if (d < -PI) d += 2 * PI;
    turned += d;
  }
  if (whole && abs(abs(turned) - 2 * PI) > 0.1) return null;
  return error <= tolOf(r) ? { cx, cy, r, error } : null;
}

// What an outline export holds: closed loops and open lines, in mm, y up.
// Loops that are circles become circles. Returns { loops, lines, circles, box }.
// fromMesh: the lines are a view's, drawn from a mesh: circles are taken to 1.5% of
// their radius, and open specks shorter than 1/50 of the outline are dropped.
function outlineShapes({ loops = [], lines = [], fromMesh = false, closeWithin = 0 }) {
  const circles = [], rest = [];
  // A line that ends where it starts is a loop.
  const open = [];
  for (const L of lines) {
    const n = L.length;
    // Within 1/500 of its own size: a view's lines join to a pixel or so.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i += 2) (x0 = min(x0, L[i])), (x1 = max(x1, L[i])), (y0 = min(y0, L[i + 1])), (y1 = max(y1, L[i + 1]));
    const gap = hypot(L[0] - L[n - 2], L[1] - L[n - 1]);
    if (n >= 8 && gap < max(1e-6 * (1 + abs(L[0]) + abs(L[1])), 0.002 * hypot(x1 - x0, y1 - y0), closeWithin)) loops = [...loops, gap < 1e-9 ? L.slice(0, n - 2) : L];
    else open.push(L);
  }
  lines = open;
  if (fromMesh) {
    let size = 0;
    for (const L of [...loops, ...lines]) for (let i = 2; i < L.length; i += 2) size = max(size, abs(L[i] - L[0]), abs(L[i + 1] - L[1]));
    lines = lines.filter((L) => { let len = 0; for (let i = 2; i < L.length; i += 2) len += hypot(L[i] - L[i - 2], L[i + 1] - L[i - 1]); return len > size / 50; });
  }
  for (const L of loops) {
    const c = fromMesh ? fitCircle(L, (r) => max(0.02, r * 0.015)) : fitCircle(L);
    if (c) circles.push(c);
    else rest.push(L);
  }
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const take = (x, y) => ((box[0] = min(box[0], x)), (box[1] = min(box[1], y)), (box[2] = max(box[2], x)), (box[3] = max(box[3], y)));
  for (const L of [...rest, ...lines]) for (let i = 0; i < L.length; i += 2) take(L[i], L[i + 1]);
  for (const c of circles) take(c.cx - c.r, c.cy - c.r), take(c.cx + c.r, c.cy + c.r);
  if (!(box[2] >= box[0])) throw new Error("There is no outline to export.");
  return { loops: rest, lines, circles, box };
}

// An outline as DXF at 1:1, in the model's millimetres, on layer OUTLINE.
export function outlineDXF(shape) {
  const { loops, lines, circles, box } = outlineShapes(shape);
  const entities = [];
  for (const c of circles) entities.push(circleEntity("OUTLINE", c.cx, c.cy, c.r));
  for (const L of loops) entities.push(polyEntity("OUTLINE", L, true));
  for (const L of lines) entities.push(L.length === 4 ? lineEntity("OUTLINE", L[0], L[1], L[2], L[3]) : polyEntity("OUTLINE", L, false));
  return { text: dxfFile(entities, { extents: box }), circles: circles.length, loops: loops.length, lines: lines.length, box };
}

// The same as an SVG whose width and height are the outline's own size in
// mm, so it opens at true size; lines 0.1 mm wide, nothing filled.
export function outlineSVG(shape, { title = "" } = {}) {
  const { loops, lines, circles, box } = outlineShapes(shape);
  const pad = 1;
  const x0 = box[0] - pad, y1 = box[3] + pad, W = box[2] - box[0] + 2 * pad, H = box[3] - box[1] + 2 * pad;
  const c = (v) => String(round(v * 1000) / 1000);
  // y runs down in SVG.
  const pt = (L, i) => `${c(L[i] - x0)} ${c(y1 - L[i + 1])}`;
  const path = (L, closed) => {
    const d = [`M${pt(L, 0)}`];
    for (let i = 2; i < L.length; i += 2) d.push(`L${pt(L, i)}`);
    return `<path d="${d.join("")}${closed ? "Z" : ""}"/>`;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const out = [`<?xml version="1.0" encoding="UTF-8"?>\n<!-- Made with Draftsman. True size: 1 unit = 1 mm. -->\n<svg xmlns="http://www.w3.org/2000/svg" width="${c(W)}mm" height="${c(H)}mm" viewBox="0 0 ${c(W)} ${c(H)}">\n`];
  if (title) out.push(`<title>${esc(title)}</title>\n`);
  out.push(`<g fill="none" stroke="#000" stroke-width="0.1" stroke-linejoin="round">\n`);
  for (const k of circles) out.push(`<circle cx="${c(k.cx - x0)}" cy="${c(y1 - k.cy)}" r="${c(k.r)}"/>\n`);
  for (const L of loops) out.push(path(L, true), "\n");
  for (const L of lines) out.push(path(L, false), "\n");
  out.push("</g>\n</svg>\n");
  return { text: out.join(""), circles: circles.length, loops: loops.length, lines: lines.length, box };
}
