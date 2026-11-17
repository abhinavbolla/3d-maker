// A floor plan on an A3 sheet, as SVG: the building cut horizontally at the
// plan's cut height (1200 mm above the floor unless house({ cut }) says
// otherwise), drawn the way an architect draws one.
//
// The cut walls are contoured straight from the walls' distance functions on
// the cutting plane, as the mechanical sheet's section is, so they are the
// true outlines, openings and all; they are drawn heavy with a dark fill.
// Doors, windows, room names and dimensions are symbols, placed from what
// the script said about them (see building.js): a door is drawn open with
// its swing, a window as its frame and glass in the opening.
//
// Same frame and title block as the mechanical sheet (drawing.js), and the
// same structure: groups with ids, data-layer naming what each holds.
import { compile } from "./sdf.js";
import { contour, loopsArea, SCALES, scaleText, textWidth, titleLines, sheetFrame, sheetTitleBlock, SHEET, TITLE } from "./drawing.js";
import { squareLoop, polygonArea } from "./building.js";

const { abs, min, max, hypot, floor, ceil, round, cos, sin, atan2, PI } = Math;
const FONT = 'font-family="Helvetica, Arial, sans-serif"';
const INK = 'fill="#000" stroke="none"';
const c2 = (v) => {
  const r = round(v * 100) / 100;
  return r === 0 ? "0" : String(r);
};
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const text = (x, y, size, str, attrs = "") => `<text x="${c2(x)}" y="${c2(y)}" font-size="${c2(size)}" ${attrs}>${xml(str)}</text>`;
const seg = (a, b) => `M${c2(a[0])} ${c2(a[1])}L${c2(b[0])} ${c2(b[1])}`;
const loopPath = (pts) => `M${pts.map((p) => `${c2(p[0])} ${c2(p[1])}`).join("L")}Z`;

// Paper sizes, in mm on the sheet.
const DIM = { first: 9, step: 7, text: 2.5, tick: 1.4, gap: 1.5, over: 1.5 };
const LABEL = { name: 3.5, area: 2.5, line: 1.6 };
// Room on the sheet for the plan's name, the scale bar and the north arrow,
// and what is kept clear round the edge of the frame.
const LEGEND = { w: 200, h: 40 };
const EDGE = 6;

// ---- rectangles on paper, for keeping things apart ----
const rect = (x0, y0, x1, y1) => [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)];
const grow = (r, d) => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
const hits = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const inside = (r, R) => r[0] >= R[0] && r[1] >= R[1] && r[2] <= R[2] && r[3] <= R[3];
// The box round a text on paper, rotated by deg (0 or -90) about (x, y),
// anchored at its middle.
function textBox(x, y, size, str, deg = 0) {
  const w = textWidth(str, size), h = size;
  return deg ? rect(x - h, y - w / 2, x + 0.25 * h, y + w / 2) : rect(x - w / 2, y - h, x + w / 2, y + 0.25 * h);
}
function inPoly(x, y, P) {
  let s = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) if (P[i][1] > y !== P[j][1] > y && x < ((P[j][0] - P[i][0]) * (y - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) s = !s;
  return s;
}
const boxInPoly = (r, P) => [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]], [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]].every(([x, y]) => inPoly(x, y, P)) && !P.some((p) => p[0] > r[0] && p[0] < r[2] && p[1] > r[1] && p[1] < r[3]);
// Where the line through p along d enters and leaves polygon P: the
// stretch [t0, t1] that holds p.
function span(p, d, P) {
  const ts = [];
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[j], b = P[i], e = [b[0] - a[0], b[1] - a[1]];
    const den = d[0] * e[1] - d[1] * e[0];
    if (abs(den) < 1e-12) continue;
    const w = [a[0] - p[0], a[1] - p[1]];
    const t = (w[0] * e[1] - w[1] * e[0]) / den, u = (w[0] * d[1] - w[1] * d[0]) / den;
    if (u >= 0 && u < 1) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  for (let i = 0; i + 1 < ts.length; i += 2) if (ts[i] <= 0 && ts[i + 1] >= 0) return [ts[i], ts[i + 1]];
  return null;
}

// The cut through the walls at height z: loops of [x, y] points, made exact
// (the walls are straight). parts: [{ name, node }] of the wall parts.
export function cutWalls(parts, z, cell = 5) {
  const fs = parts.map((p) => compile(p.node));
  const box = fs.reduce((b, q) => [min(b[0], q.box[0]), min(b[1], q.box[1]), max(b[2], q.box[3]), max(b[3], q.box[4])], [Infinity, Infinity, -Infinity, -Infinity]);
  const g = (x, y) => fs.reduce((d, q) => min(d, q.f(x, y, z)), Infinity);
  const loops = contour(g, box, cell);
  return { loops: loops.map((L) => squareLoop(L, cell)), area: loopsArea(loops) };
}

// The cut through any other part at height z, as it is (not squared).
function cutPart(node, z, cell) {
  const { f, box } = compile(node);
  if (!(box[2] <= z && box[5] >= z)) return [];
  const loops = contour((x, y) => f(x, y, z), [box[0], box[1], box[3], box[4]], cell);
  return loops.filter((L) => abs(loopsArea([L])) > cell * cell * 4).map((L) => Array.from({ length: L.length / 2 }, (_, i) => [L[2 * i], L[2 * i + 1]]));
}

// The floor plan sheet. building: the result's building facts; parts: every
// visible part as { name, node }; info: the title block's fields (see
// sheetSVG in drawing.js). Returns { svg, scale, facts }.
export function floorPlanSVG({ building: B, parts, info = {} }) {
  if (!B) throw new Error("This model has no building to draw a plan of. Floor plans are made from outerWalls(), wall(), door(), window() and room() in the script.");
  const zc = B.cut_z;
  const pieces = new Set(["Floor slab", "Outer walls", "Inner walls", ...B.openings.flatMap((o) => o.parts), ...B.stairs.map((s) => s.name)]);
  const roofName = parts.find((p) => !pieces.has(p.name) && B.roof && p.name === (B.roof.name ?? "Roof"))?.name ?? "Roof";
  const wallParts = parts.filter((p) => p.name === "Outer walls" || p.name === "Inner walls");
  if (!wallParts.length) throw new Error("The walls are hidden, so there is no plan to draw.");
  const cut = cutWalls(wallParts, zc);
  // Anything else the plane passes through (a column, a chimney): its cut, drawn thinner.
  const others = parts.filter((p) => !pieces.has(p.name) && p.name !== roofName).map((p) => ({ name: p.name, loops: cutPart(p.node, zc, 5) })).filter((p) => p.loops.length);

  // What the plan covers, in model mm: the outline, and the roof's eaves above it.
  const P = B.outline;
  let ext = P.reduce((b, [x, y]) => [min(b[0], x), min(b[1], y), max(b[2], x), max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  const eaves = B.roof ? offsetOutline(P, B.roof.overhang) : null;
  const drawn = eaves ? eaves.reduce((b, [x, y]) => [min(b[0], x), min(b[1], y), max(b[2], x), max(b[3], y)], ext) : ext;
  // Which sides carry dimension chains: each outer wall, on its outside.
  const sides = B.walls.filter((w) => w.kind === "outer");
  const chains = sides.map((w) => ({ w, n: B.openings.some((o) => o.wall === w.name) ? 2 : 1 }));

  // ---- scale and place ----
  // Room for the chains on each side of the plan, beyond what is drawn.
  const roomFor = (s) => {
    const m = [0, 0, 0, 0]; // left, bottom (model -y), right, top, in paper mm
    for (const { w, n } of chains) {
      const o = w.out;
      const swingOut = max(0, ...B.openings.filter((o) => o.wall === w.name && o.kind === "door" && o.opens < 0).map((o) => o.leaf.width * s + 1));
      const reachOut = max(B.roof ? B.roof.overhang * s : 0, swingOut) + DIM.first - 3 + (n - 1) * DIM.step + DIM.text + 2;
      const k = abs(o[0]) > abs(o[1]) ? (o[0] < 0 ? 0 : 2) : o[1] < 0 ? 1 : 3;
      m[k] = max(m[k], reachOut);
    }
    return m.map((v) => v + 2);
  };
  const frameBox = [SHEET.left + EDGE, SHEET.top + EDGE, SHEET.right - EDGE, SHEET.bottom - EDGE];
  const titleBox = [SHEET.right - TITLE.w - 4, SHEET.bottom - TITLE.h - 9 - 4, SHEET.right, SHEET.bottom];
  let place = null;
  for (const s of SCALES) {
    if (s > 1 / 20 + 1e-12) continue; // a plan is drawn at 1:20 or smaller
    const m = roomFor(s);
    const w = (drawn[2] - drawn[0]) * s + m[0] + m[2], h = (drawn[3] - drawn[1]) * s + m[1] + m[3];
    // The plan with its chains, then the legend: under it, beside it, or in
    // the corner left of the title block.
    const areas = [
      [frameBox[0], frameBox[1], frameBox[2], titleBox[1]],
      [frameBox[0], frameBox[1], titleBox[0], frameBox[3]],
    ];
    for (const A of areas) {
      if (w > A[2] - A[0] || h > A[3] - A[1]) continue;
      const x = A[0] + (A[2] - A[0] - w) / 2, y = A[1] + (A[3] - A[1] - h) / 2;
      const planBox = [x, y, x + w, y + h];
      const legendSpots = [
        [frameBox[0], titleBox[1] + 2, frameBox[0] + LEGEND.w, titleBox[1] + 2 + LEGEND.h],
        [frameBox[0], frameBox[3] - LEGEND.h, frameBox[0] + LEGEND.w, frameBox[3]],
        [frameBox[2] - LEGEND.w, frameBox[1], frameBox[2], frameBox[1] + LEGEND.h],
        [frameBox[0], frameBox[1], frameBox[0] + LEGEND.w, frameBox[1] + LEGEND.h],
      ];
      const legend = legendSpots.find((L) => !hits(L, planBox) && !hits(L, titleBox) && inside(L, frameBox));
      if (!legend) continue;
      place = { s, planBox, legend, m };
      break;
    }
    if (place) break;
  }
  if (!place) throw new Error("The building is too large for a plan on an A3 sheet.");
  const { s, planBox, legend, m } = place;
  // Model to paper (paper's y runs down).
  const ox = planBox[0] + m[0] - drawn[0] * s, oy = planBox[1] + m[3] + drawn[3] * s;
  const X = (x) => ox + x * s, Y = (y) => oy - y * s;
  const pp = (p) => [X(p[0]), Y(p[1])];
  const pdir = (d) => [d[0], -d[1]];
  // Line widths (ISO 128 groups) by scale: cut walls wide, the rest narrow or finer.
  const big = s >= 1 / 50 - 1e-12;
  const W = { cut: big ? 0.5 : 0.35, mid: big ? 0.35 : 0.25, thin: big ? 0.18 : 0.13, fine: 0.13 };

  const out = [];
  const facts = { scale: scaleText(s), cut_height_mm: B.cut_z - B.floor_z, rooms: [], openings: [], dimensions: [] };
  const occupied = []; // paper boxes text must stay clear of
  const dimLines = []; // inside dimension lines: they may cross each other, not text

  // ---- walls ----
  out.push(`<g id="walls" data-layer="walls">\n`);
  out.push(`<path class="cut-walls" fill="#4d4d4d" fill-rule="evenodd" stroke-width="${W.cut}" d="${cut.loops.map((L) => loopPath(L.map(pp))).join("")}"/>\n`);
  for (const o of others) out.push(`<path class="cut" data-part="${xml(o.name)}" fill="#bdbdbd" fill-rule="evenodd" stroke-width="${W.mid}" d="${o.loops.map((L) => loopPath(L.map(pp))).join("")}"/>\n`);
  out.push("</g>\n");
  facts.wall_cut_area_m2 = round(cut.area / 1e4) / 100;

  // ---- doors and windows ----
  const doors = [], windows = [];
  for (const o of B.openings) {
    const d = o.dir, a = o.across, mid = o.center, t = o.thickness;
    // A point `along` the wall from the opening's centre and `acr` across
    // from the wall's middle (towards the inside, or the right of an inner wall).
    const at = (along, acr) => pp([mid[0] + d[0] * along + a[0] * acr, mid[1] + d[1] * along + a[1] * acr]);
    const hw = o.width / 2;
    const cutThrough = o.sill < B.cut_z - B.floor_z && o.sill + o.height > B.cut_z - B.floor_z;
    facts.openings.push({ name: o.name, kind: o.kind, wall: o.wall, at: o.at, width: o.width, cut: cutThrough });
    if (o.kind === "window") {
      const f = o.frame, dash = cutThrough ? "" : ' stroke-dasharray="1.5 0.8"';
      const p = [];
      // The wall's faces carried across the opening (the sill below and the reveal), thin.
      p.push(seg(at(-hw, -t / 2), at(hw, -t / 2)), seg(at(-hw, t / 2), at(hw, t / 2)));
      // The frame, and the glass along its middle.
      const f0 = f.depth - f.frameDepth / 2, f1 = f.depth + f.frameDepth / 2;
      p.push(`${seg(at(-hw, f0), at(hw, f0))}${seg(at(hw, f0), at(hw, f1))}${seg(at(hw, f1), at(-hw, f1))}${seg(at(-hw, f1), at(-hw, f0))}`);
      const glass = seg(at(-hw + f.frameWidth, f.depth), at(hw - f.frameWidth, f.depth));
      // Mullions between panes.
      const cw = (o.width - 2 * f.frameWidth - (f.panes - 1) * f.frameWidth) / f.panes;
      for (let i = 1; i < f.panes; i++) {
        const x = -hw + f.frameWidth + i * cw + (i - 0.5) * f.frameWidth;
        p.push(seg(at(x, f0), at(x, f1)));
      }
      // The outside sill, standing out past the face.
      if (o.wall_kind === "outer") p.push(seg(at(-hw, -t / 2), at(-hw, -t / 2 - 40)), seg(at(-hw, -t / 2 - 40), at(hw, -t / 2 - 40)), seg(at(hw, -t / 2 - 40), at(hw, -t / 2)));
      windows.push(`<g class="window" data-part="${xml(o.name)}"><path stroke-width="${W.thin}"${dash} d="${p.join("")}"/><path stroke-width="${W.mid}"${dash} d="${glass}"/></g>\n`);
    } else {
      const side = o.opens, lw = o.leaf.width, cw = o.leaf.clear;
      const hs = o.hinge === "start" ? -1 : 1;
      // Lining at the jambs, cut.
      const jam = (sgn) => {
        const x0 = sgn * hw, x1 = sgn * (hw - 50);
        return `${seg(at(x0, -t / 2), at(x1, -t / 2))}${seg(at(x1, -t / 2), at(x1, t / 2))}${seg(at(x1, t / 2), at(x0, t / 2))}`;
      };
      // The leaf open square to the wall from the hinge, on the side it opens to, and its swing.
      const hx = hs * (cw / 2), face = side * (t / 2);
      const leaf = [at(hx, face), at(hx - hs * 40, face), at(hx - hs * 40, face + side * lw), at(hx, face + side * lw)];
      const tip = at(hx, face + side * lw), shut = at(hx - hs * lw, face);
      const r = lw * s;
      // Sweep direction on paper: from the open tip round to the shut position.
      const c = at(hx, face);
      const cr = (tip[0] - c[0]) * (shut[1] - c[1]) - (tip[1] - c[1]) * (shut[0] - c[0]);
      const arc = `M${c2(tip[0])} ${c2(tip[1])}A${c2(r)} ${c2(r)} 0 0 ${cr > 0 ? 1 : 0} ${c2(shut[0])} ${c2(shut[1])}`;
      const thr = o.wall_kind === "outer" ? seg(at(-hw + 50, -t / 2), at(hw - 50, -t / 2)) : "";
      doors.push(`<g class="door" data-part="${xml(o.name)}"><path stroke-width="${W.thin}" d="${jam(-1)}${jam(1)}${thr}"/><path stroke-width="${W.mid}" d="${loopPath(leaf)}"/><path class="swing" stroke-width="${W.fine}" d="${arc}"/></g>\n`);
      const swingBox = rect(...c, ...tip);
      const b = [swingBox, rect(...c, ...shut)].reduce((q, r) => [min(q[0], r[0]), min(q[1], r[1]), max(q[2], r[2]), max(q[3], r[3])]);
      occupied.push(grow([min(b[0], tip[0], shut[0]), min(b[1], tip[1], shut[1]), max(b[2], tip[0], shut[0]), max(b[3], tip[1], shut[1])], 0.8));
    }
  }
  out.push(`<g id="windows" data-layer="windows">\n${windows.join("")}</g>\n`);
  out.push(`<g id="doors" data-layer="doors">\n${doors.join("")}</g>\n`);

  // ---- stairs: treads up to the cut, a break line, the rest dashed, and the way up ----
  if (B.stairs.length) {
    out.push(`<g id="stairs" data-layer="stairs">\n`);
    for (const st of B.stairs) {
      const d = st.dir, n = [-d[1], d[0]], hw = st.width / 2;
      const at = (along, acr) => pp([st.at[0] + d[0] * along + n[0] * acr, st.at[1] + d[1] * along + n[1] * acr]);
      const below = Math.min(st.steps, floor((B.cut_z - B.floor_z) / st.rise));
      const solid = [], dashed = [];
      solid.push(seg(at(0, -hw), at(st.run, -hw)), seg(at(0, hw), at(st.run, hw)));
      for (let i = 0; i <= st.steps; i++) (i <= below ? solid : dashed).push(seg(at(i * st.going, -hw), at(i * st.going, hw)));
      const brk = below * st.going + st.going / 2;
      out.push(`<g class="stair" data-part="${xml(st.name)}"><path stroke-width="${W.thin}" d="${solid.join("")}"/><path stroke-width="${W.thin}" stroke-dasharray="1.5 0.8" d="${dashed.join("")}"/>`);
      out.push(`<path stroke-width="${W.thin}" d="${seg(at(brk - 150, -hw), at(brk + 150, hw))}"/>`);
      const a0 = at(st.going / 2, 0), a1 = at(min(brk, st.run - st.going / 2), 0);
      out.push(`<path stroke-width="${W.thin}" d="${seg(a0, a1)}"/>${arrowHead(a1, [a1[0] - a0[0], a1[1] - a0[1]], 2.2, 0.7)}`);
      out.push(text(a0[0] + n[0] * 0 - 0, a0[1] + 3.2, 2.5, "UP", `text-anchor="middle" ${INK}`), "</g>\n");
      const bx = [at(0, -hw), at(st.run, hw), at(0, hw), at(st.run, -hw)];
      occupied.push(grow([min(...bx.map((p) => p[0])), min(...bx.map((p) => p[1])), max(...bx.map((p) => p[0])), max(...bx.map((p) => p[1]))], 0.8));
    }
    out.push("</g>\n");
  }

  // ---- the roof above, dashed ----
  if (eaves) out.push(`<g id="roof-outline" data-layer="above"><path stroke-width="${W.thin}" stroke-dasharray="3 1.2" d="${loopPath(eaves.map(pp))}"/></g>\n`);

  // ---- rooms: name and area in the middle, the inside sizes where they fit ----
  const labels = [], inner = [];
  for (const r of B.rooms) {
    if (r.shared) continue;
    const poly = r.outline.map(pp);
    const sharers = B.rooms.filter((q) => q.shared === r.name).map((q) => q.name);
    const name = [r.name, ...sharers].join(" / ");
    const area = `${r.area_m2.toFixed(2)} m²`;
    const pb = poly.reduce((b, [x, y]) => [min(b[0], x), min(b[1], y), max(b[2], x), max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
    const cx = (pb[0] + pb[2]) / 2, cy = (pb[1] + pb[3]) / 2;
    // The label as near the middle of the room as it can be, clear of doors
    // and stairs; in smaller letters (down to 2 mm) in a small room.
    let best = null;
    for (const k of [1, 0.8, 0.65]) {
      const sn = LABEL.name * k, sa = max(2, LABEL.area * k);
      const lw = max(textWidth(name, sn), textWidth(area, sa)), lh = sn + LABEL.line * k + sa;
      for (let i = 0; i < 2000 && !best; i++) {
        // Points round the middle, spiralling out.
        const ring = floor(Math.sqrt(i)), ang = i * 2.39996;
        const x = cx + cos(ang) * ring * 1.2, y = cy + sin(ang) * ring * 1.2;
        const b = rect(x - lw / 2, y - lh / 2, x + lw / 2, y + lh / 2);
        if (boxInPoly(grow(b, 1.2 * k), poly) && !occupied.some((o) => hits(o, b))) best = { x, y, b, sn, sa, lh };
      }
      if (best) break;
    }
    facts.rooms.push({ name, area_m2: r.area_m2, labelled: Boolean(best) });
    if (!best) continue;
    occupied.push(best.b);
    labels.push(`<g class="room" data-room="${xml(name)}" data-area="${r.area_m2.toFixed(2)}">${text(best.x, best.y - best.lh / 2 + best.sn * 0.9, best.sn, name, `text-anchor="middle" ${INK}`)}${text(best.x, best.y + best.lh / 2 - 0.1, best.sa, area, `class="area" text-anchor="middle" ${INK}`)}</g>\n`);
    // Inside sizes: wall to wall across the room, along x and along y (in
    // the plan's own axes), on lines clear of the label, the doors and each
    // other. The room's main size is wanted, so of the lines that fit, the
    // longest wins (an L-shaped room is sized across its larger part), and
    // of those, the one nearest a fifth of the way in. A line where the
    // room's size changes (along a wall's free end) is passed over.
    for (const [axis, d] of [["width", [1, 0]], ["length", [0, 1]]]) {
      const across = [d[1], d[0]];
      const size = [pb[2] - pb[0], pb[3] - pb[1]][axis === "width" ? 1 : 0];
      const lo = axis === "width" ? pb[1] : pb[0];
      const at = (o) => (axis === "width" ? [best.x, o] : [o, best.y]);
      const length = (o) => {
        const q = span(at(o), d, poly);
        return q ? q[1] - q[0] : null;
      };
      let pick = null;
      for (let f = 0.1; f <= 0.9001; f += 0.02) {
        const o = lo + size * f, p = at(o);
        const sp = span(p, d, poly);
        if (!sp) continue;
        const L = sp[1] - sp[0];
        if ([-2, 2].some((e) => length(o + e) === null || abs(length(o + e) - L) > 1e-6)) continue;
        const a = [p[0] + d[0] * sp[0], p[1] + d[1] * sp[0]], b = [p[0] + d[0] * sp[1], p[1] + d[1] * sp[1]];
        const value = round(L / s);
        const label = String(value);
        if (textWidth(label, DIM.text) + 6 > L) continue;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const deg = axis === "width" ? 0 : -90;
        const tx = mx - (deg ? 1.0 : 0), ty = my - (deg ? 0 : 1.0);
        const tb = textBox(tx, ty, DIM.text, label, deg);
        const lineBox = grow(rect(a[0], a[1], b[0], b[1]), 0.8);
        if (!boxInPoly(grow(tb, 0.8), poly)) continue;
        if (occupied.some((q) => hits(q, lineBox) || hits(q, grow(tb, 0.6))) || dimLines.some((q) => hits(q, grow(tb, 0.6)))) continue;
        const score = [-round(value / 10), abs(f - 0.2)];
        if (!pick || score[0] < pick.score[0] || (score[0] === pick.score[0] && score[1] < pick.score[1])) pick = { score, a, b, value, label, tx, ty, tb, lineBox, deg };
      }
      if (!pick) {
        facts.dimensions.push({ room: name, axis, value: null });
        continue;
      }
      const { a, b, value, label, tx, ty, tb, lineBox, deg } = pick;
      occupied.push(grow(tb, 0.6));
      dimLines.push(lineBox);
      inner.push(`<g class="dimension inside" data-dimension="${axis}" data-room="${xml(name)}" data-value="${value}">${dimLine(a, b, across, W)}${text(tx, ty, DIM.text, label, `text-anchor="middle" ${INK}${deg ? ` transform="rotate(-90 ${c2(tx)} ${c2(ty)})"` : ""}`)}</g>\n`);
      facts.dimensions.push({ room: name, axis, value });
    }
  }
  out.push(`<g id="rooms" data-layer="text">\n${labels.join("")}</g>\n`);

  // ---- outside dimension chains ----
  const chainOut = [];
  for (const { w, n } of chains) {
    const a = w.from, b = w.to, L = w.length, dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const on = (t) => [a[0] + dir[0] * t, a[1] + dir[1] * t];
    const outP = pdir(w.out);
    // Clear of the roof's edge, and of doors that open outwards.
    const swingOut = max(0, ...B.openings.filter((o) => o.wall === w.name && o.kind === "door" && o.opens < 0).map((o) => o.leaf.width * s + 1));
    const base = max((B.roof ? B.roof.overhang * s : 0), swingOut) + DIM.first - 3;
    const rows = [];
    const ops = B.openings.filter((o) => o.wall === w.name).sort((p, q) => p.at - q.at);
    if (ops.length) rows.push([0, ...ops.flatMap((o) => [o.at - o.width / 2, o.at + o.width / 2]), L]);
    rows.push([0, L]);
    rows.forEach((ts, k) => {
      const off = base + k * DIM.step;
      const P0 = (t) => {
        const q = pp(on(t));
        return [q[0] + outP[0] * off, q[1] + outP[1] * off];
      };
      const parts2 = [];
      // Extension lines from just off the wall's face to just past the line.
      const ext = ts.map((t) => {
        const q = pp(on(t));
        return seg([q[0] + outP[0] * DIM.gap, q[1] + outP[1] * DIM.gap], [q[0] + outP[0] * (off + DIM.over), q[1] + outP[1] * (off + DIM.over)]);
      });
      parts2.push(`<path stroke-width="${W.thin}" d="${ext.join("")}${seg(P0(ts[0]), P0(ts.at(-1)))}"/>`);
      parts2.push(`<path stroke-width="${W.mid}" d="${ts.map((t) => tick(P0(t), pdir(dir))).join("")}"/>`);
      // The numbers: above the line, read from below or from the right;
      // a number too long for its gap moves up a row, clear of its neighbours.
      const pd = pdir(dir);
      let deg = (atan2(pd[1], pd[0]) * 180) / PI;
      // Upright, or turned to read from the right (-90), never from the left.
      if (deg > 89.999) deg -= 180;
      if (deg <= -90.001) deg += 180;
      const up = [Math.sin((deg * PI) / 180), -Math.cos((deg * PI) / 180)];
      const placedTexts = [];
      for (let i = 0; i + 1 < ts.length; i++) {
        const v = round(ts[i + 1] - ts[i]);
        const label = String(v);
        const pa = P0(ts[i]), pb2 = P0(ts[i + 1]);
        const gap = hypot(pb2[0] - pa[0], pb2[1] - pa[1]);
        let mx = (pa[0] + pb2[0]) / 2, my = (pa[1] + pb2[1]) / 2;
        let lift = 1.0;
        const tw = textWidth(label, DIM.text);
        const box = (l) => {
          const x = mx + up[0] * l, y = my + up[1] * l;
          const vertical = abs(deg) > 45;
          return { x, y, b: vertical ? rect(x - DIM.text, y - tw / 2, x + 0.3, y + tw / 2) : rect(x - tw / 2, y - DIM.text, x + tw / 2, y + 0.3) };
        };
        let bx = box(lift);
        if (tw + 1.5 > gap) {
          // Too long for its gap: beside it, outside the end with more room.
          lift = 1.0;
          const shift = gap / 2 + tw / 2 + 1.2;
          const sgn = i === 0 ? -1 : 1;
          mx += (pd[0] * shift * sgn);
          my += (pd[1] * shift * sgn);
          bx = box(lift);
        }
        let tries = 0;
        while (placedTexts.some((q) => hits(q, bx.b)) && tries++ < 3) bx = box((lift += DIM.text + 0.8));
        placedTexts.push(bx.b);
        parts2.push(text(bx.x, bx.y, DIM.text, label, `text-anchor="middle" ${INK}${abs(deg) > 0.01 ? ` transform="rotate(${c2(deg)} ${c2(bx.x)} ${c2(bx.y)})"` : ""}`));
        facts.dimensions.push({ wall: w.name, row: k ? "overall" : "openings", value: v });
      }
      chainOut.push(`<g class="dimension chain" data-wall="${xml(w.name)}" data-row="${k === rows.length - 1 ? "overall" : "openings"}">${parts2.join("")}</g>\n`);
    });
  }
  out.push(`<g id="dimensions" data-layer="dimensions">\n${chainOut.join("")}${inner.join("")}</g>\n`);

  // ---- legend: the plan's name and scale, a scale bar and the north arrow ----
  {
    const [lx, ly] = legend;
    const g = [];
    g.push(text(lx + 2, ly + 7, 5, "Ground floor plan", `id="plan-name" ${INK}`));
    g.push(text(lx + 2 + textWidth("Ground floor plan", 5) + 4, ly + 7, 3.5, scaleText(s), `id="plan-scale" ${INK}`));
    g.push(text(lx + 2, ly + 12, 2.5, `Cut at ${B.cut_z - B.floor_z} mm above the floor. Sizes in mm, areas in m².`, INK));
    // Scale bar: whole metres, about 80 to 110 mm long.
    const metres = [5, 10, 20, 50, 100].find((mm) => mm * 1000 * s >= 70) ?? 100;
    const stepM = metres <= 10 ? 1 : metres <= 20 ? 2 : metres <= 50 ? 5 : 10;
    const bx0 = lx + 2, by0 = ly + 20, unitW = 1000 * s;
    for (let i = 0; i < metres; i++) g.push(`<rect x="${c2(bx0 + i * unitW)}" y="${c2(by0)}" width="${c2(unitW)}" height="1.6" stroke-width="${W.thin}" fill="${i % 2 ? "#fff" : "#000"}"/>`);
    for (let i = 0; i <= metres; i += stepM) g.push(text(bx0 + i * unitW, by0 + 5, 2.5, String(i), `text-anchor="middle" ${INK}`));
    g.push(text(bx0 + metres * unitW + 3, by0 + 1.9, 2.5, "m", INK));
    // North arrow, to the right.
    const nx = lx + LEGEND.w - 14, ny = ly + 20, R = 7;
    const th = ((B.north ?? 0) * PI) / 180;
    const nd = [-sin(th), -cos(th)]; // north on paper
    const nl = [-nd[1], nd[0]];
    const tipN = [nx + nd[0] * R, ny + nd[1] * R], tail = [nx - nd[0] * R * 0.75, ny - nd[1] * R * 0.75];
    g.push(`<g id="north-arrow"><circle cx="${c2(nx)}" cy="${c2(ny)}" r="${R}" stroke-width="${W.thin}"/>`);
    g.push(`<path stroke-width="${W.thin}" fill="#000" d="M${c2(tipN[0])} ${c2(tipN[1])}L${c2(tail[0] + nl[0] * 2.6)} ${c2(tail[1] + nl[1] * 2.6)}L${c2(nx)} ${c2(ny)}Z"/>`);
    g.push(`<path stroke-width="${W.thin}" fill="#fff" d="M${c2(tipN[0])} ${c2(tipN[1])}L${c2(tail[0] - nl[0] * 2.6)} ${c2(tail[1] - nl[1] * 2.6)}L${c2(nx)} ${c2(ny)}Z"/>`);
    g.push(text(nx + nd[0] * (R + 3.2), ny + nd[1] * (R + 3.2) + 1.6, 4, "N", `text-anchor="middle" ${INK}`), "</g>");
    out.push(`<g id="legend" data-layer="text">\n${g.join("")}\n</g>\n`);
  }

  // ---- the sheet ----
  const titles = titleLines(info.title, info.subtitle);
  const f = { title: titles.title, subtitle: titles.subtitle, number: info.number ?? "", revision: info.revision ?? "", date: info.date ?? "", createdBy: info.createdBy ?? "", approvedBy: info.approvedBy ?? "", owner: info.owner ?? "", type: info.type ?? "Floor plan", tolerances: "" };
  // The mechanical sheet's block says which angle the views are projected
  // in; a plan has no projection, so that cell says where the plan is cut.
  let block = sheetTitleBlock(f, scaleText(s), true);
  block = block.replace(/<g id="projection-symbol"[\s\S]*?<\/g>/, "").replace(/(<text [^>]*id="projection"[^>]*>)[^<]*(<\/text>)/, `$1Plan cut at ${B.cut_z - B.floor_z} mm$2`);
  const head = [];
  head.push(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- Made with Draftsman -->\n<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET.w}mm" height="${SHEET.h}mm" viewBox="0 0 ${SHEET.w} ${SHEET.h}" data-scale="${scaleText(s)}" data-kind="floor-plan">\n`);
  head.push(`<title>${xml(f.title)} – floor plan</title>\n`);
  head.push(`<rect width="${SHEET.w}" height="${SHEET.h}" fill="#fff"/>\n`);
  head.push(`<g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round" ${FONT}>\n`);
  head.push(`<g data-layer="frame">\n${sheetFrame()}</g>\n`);
  head.push(`<g id="plan" class="view" data-view="plan" data-cut-z="${B.cut_z}">\n`);
  const tail = ["</g>\n", `<g data-layer="title-block">\n${block}</g>\n`, text(10, SHEET.bottom, 1.8, "Made with Draftsman", `id="credit" fill="#777" stroke="none" transform="rotate(-90 10 ${SHEET.bottom})"`), "\n</g>\n</svg>\n"];
  return { svg: [...head, ...out, ...tail].join(""), scale: scaleText(s), facts, titles };
}

// The outline moved out by d (mitred), for the eaves.
function offsetOutline(P, d) {
  const n = P.length, out = [];
  const ccw = polygonArea(P) > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n];
    const r = [b[0] - a[0], b[1] - a[1]], q = [c[0] - b[0], c[1] - b[1]];
    const lr = hypot(...r), lq = hypot(...q);
    const nr = [(r[1] / lr) * ccw, (-r[0] / lr) * ccw], nq = [(q[1] / lq) * ccw, (-q[0] / lq) * ccw];
    const p1 = [a[0] + nr[0] * d, a[1] + nr[1] * d], p2 = [b[0] + nq[0] * d, b[1] + nq[1] * d];
    const den = r[0] * q[1] - r[1] * q[0];
    if (abs(den) < 1e-12) out.push([b[0] + nq[0] * d, b[1] + nq[1] * d]);
    else {
      const t = ((p2[0] - p1[0]) * q[1] - (p2[1] - p1[1]) * q[0]) / den;
      out.push([p1[0] + r[0] * t, p1[1] + r[1] * t]);
    }
  }
  return out;
}

// An architect's tick: a short oblique stroke across the dimension line.
function tick(p, d) {
  const k = DIM.tick, c = Math.SQRT1_2;
  const v = [(d[0] - d[1]) * c, (d[1] + d[0]) * c];
  return seg([p[0] - v[0] * k, p[1] - v[1] * k], [p[0] + v[0] * k, p[1] + v[1] * k]);
}
// A dimension line inside a room, from wall face a to wall face b, with ticks.
function dimLine(a, b, _across, W) {
  const L = hypot(b[0] - a[0], b[1] - a[1]), d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  return `<path stroke-width="${W.thin}" d="${seg(a, b)}"/><path stroke-width="${W.mid}" d="${tick(a, d)}${tick(b, d)}"/>`;
}
function arrowHead(p, d, len, half) {
  const l = hypot(d[0], d[1]) || 1, u = [d[0] / l, d[1] / l];
  const b = [p[0] - u[0] * len, p[1] - u[1] * len];
  return `<path d="M${c2(p[0])} ${c2(p[1])}L${c2(b[0] - u[1] * half)} ${c2(b[1] + u[0] * half)}L${c2(b[0] + u[1] * half)} ${c2(b[1] - u[0] * half)}Z" fill="#000" stroke="none"/>`;
}
