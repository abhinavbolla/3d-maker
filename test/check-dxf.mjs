// Reads an ASCII DXF on its own (none of the app's code), checks it is well
// formed, and says what is in it. Usage: node test/check-dxf.mjs file.dxf
// Exits 1 if the file is broken.
//
// readDXF(text) returns { version, units, layers: { name: { colour, ltype } },
// ltypes: { name: [pattern] }, entities: [{ type, layer, ltype, ... }],
// counts: { TYPE: n }, byLayer: { layer: n }, bounds: [x0, y0, x1, y1],
// problems: [text] }. Polylines come back with pts [x, y, ...] and closed.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function readDXF(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const problems = [];
  if (lines.length % 2) problems.push("odd number of lines: a group code has no value");
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) problems.push(`line ${i + 1}: "${lines[i]}" is not a group code`);
    pairs.push([code, lines[i + 1]]);
  }
  const out = { version: null, units: null, layers: {}, ltypes: {}, entities: [], counts: {}, byLayer: {}, bounds: [Infinity, Infinity, -Infinity, -Infinity], problems };
  let k = 0;
  const at = () => pairs[k];
  // The group codes of one record: from the 0 that starts it to the next 0.
  const record = () => {
    const [, type] = pairs[k++];
    const g = [];
    while (k < pairs.length && pairs[k][0] !== 0) g.push(pairs[k++]);
    return { type, g };
  };
  const first = (g, c) => g.find(([code]) => code === c)?.[1];
  const all = (g, c) => g.filter(([code]) => code === c).map(([, v]) => v);
  const num = (v, what) => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) problems.push(`${what}: "${v}" is not a number`);
    return n;
  };
  const grow = (x, y) => {
    const b = out.bounds;
    (b[0] = Math.min(b[0], x)), (b[1] = Math.min(b[1], y)), (b[2] = Math.max(b[2], x)), (b[3] = Math.max(b[3], y));
  };
  let sawEOF = false;
  while (k < pairs.length) {
    if (at()[0] !== 0) {
      problems.push(`group ${at()[0]} outside a record`);
      k++;
      continue;
    }
    const kind = at()[1];
    if (kind === "EOF") {
      sawEOF = true;
      break;
    }
    if (kind !== "SECTION") {
      problems.push(`"${kind}" where a SECTION should start`);
      record();
      continue;
    }
    // A section's start runs on to its first 0: in the header, that is
    // every variable (a 9 with its name, then its values).
    const head = record().g;
    const name = first(head, 2);
    if (name === "HEADER")
      head.forEach(([code, v], i) => {
        if (code === 9 && v === "$ACADVER") out.version = head[i + 1][1];
        if (code === 9 && v === "$INSUNITS") out.units = Number(head[i + 1][1]);
      });
    while (k < pairs.length && at()[1] !== "ENDSEC") {
      const r = record();
      if (name === "TABLES") {
        if (r.type === "LAYER") out.layers[first(r.g, 2)] = { colour: Number(first(r.g, 62)), ltype: first(r.g, 6) };
        if (r.type === "LTYPE") {
          const pattern = all(r.g, 49).map(Number);
          if (pattern.length !== Number(first(r.g, 73))) problems.push(`line type ${first(r.g, 2)} says ${first(r.g, 73)} elements and has ${pattern.length}`);
          const total = pattern.reduce((s, v) => s + Math.abs(v), 0);
          if (pattern.length && Math.abs(total - Number(first(r.g, 40))) > 1e-6) problems.push(`line type ${first(r.g, 2)}: its length is not the sum of its dashes`);
          out.ltypes[first(r.g, 2)] = pattern;
        }
      } else if (name === "ENTITIES") {
        const e = { type: r.type, layer: first(r.g, 8), ltype: first(r.g, 6) };
        if (e.layer === undefined) problems.push(`${r.type} has no layer`);
        if (r.type === "LINE") {
          e.pts = [num(first(r.g, 10), "LINE x"), num(first(r.g, 20), "LINE y"), num(first(r.g, 11), "LINE x1"), num(first(r.g, 21), "LINE y1")];
        } else if (r.type === "CIRCLE" || r.type === "ARC") {
          Object.assign(e, { cx: num(first(r.g, 10), "centre x"), cy: num(first(r.g, 20), "centre y"), r: num(first(r.g, 40), "radius") });
          if (!(e.r > 0)) problems.push(`${r.type} with radius ${e.r}`);
          grow(e.cx - e.r, e.cy - e.r), grow(e.cx + e.r, e.cy + e.r);
        } else if (r.type === "POLYLINE") {
          e.closed = (Number(first(r.g, 70) ?? 0) & 1) === 1;
          if (first(r.g, 66) !== undefined && Number(first(r.g, 66)) !== 1) problems.push("POLYLINE whose vertices-follow flag is not 1");
          e.pts = [];
          e.bulges = [];
          while (k < pairs.length && at()[1] === "VERTEX") {
            const v = record();
            if (first(v.g, 8) !== e.layer) problems.push("a VERTEX on another layer than its POLYLINE");
            e.pts.push(num(first(v.g, 10), "VERTEX x"), num(first(v.g, 20), "VERTEX y"));
            e.bulges.push(Number(first(v.g, 42) ?? 0));
          }
          if (at()?.[1] !== "SEQEND") problems.push("POLYLINE without SEQEND");
          else record();
          if (e.pts.length < 4) problems.push(`POLYLINE with ${e.pts.length / 2} vertices`);
        } else if (r.type === "TEXT") {
          Object.assign(e, { x: num(first(r.g, 10), "TEXT x"), y: num(first(r.g, 20), "TEXT y"), height: num(first(r.g, 40), "TEXT height"), text: first(r.g, 1), angle: Number(first(r.g, 50) ?? 0), align: Number(first(r.g, 72) ?? 0) });
          if (e.align) Object.assign(e, { x: num(first(r.g, 11), "TEXT align x"), y: num(first(r.g, 21), "TEXT align y") });
          grow(e.x, e.y);
        } else if (r.type === "SOLID") {
          e.pts = [10, 11, 12, 13].flatMap((c) => [num(first(r.g, c), "SOLID x"), num(first(r.g, c + 10), "SOLID y")]);
        } else if (r.type === "VERTEX" || r.type === "SEQEND") problems.push(`${r.type} outside a POLYLINE`);
        for (let i = 0; i < (e.pts?.length ?? 0); i += 2) grow(e.pts[i], e.pts[i + 1]);
        out.entities.push(e);
        out.counts[e.type] = (out.counts[e.type] ?? 0) + 1;
        out.byLayer[e.layer] = (out.byLayer[e.layer] ?? 0) + 1;
      }
    }
    if (k >= pairs.length) problems.push(`section ${name} has no ENDSEC`);
    else k++;
  }
  if (!sawEOF) problems.push("no EOF");
  for (const e of out.entities) {
    if (e.layer !== undefined && !out.layers[e.layer]) problems.push(`layer "${e.layer}" is used but not in the LAYER table`);
    if (e.ltype && !out.ltypes[e.ltype]) problems.push(`line type "${e.ltype}" is used but not in the LTYPE table`);
  }
  for (const [n, l] of Object.entries(out.layers)) if (l.ltype && !out.ltypes[l.ltype]) problems.push(`layer ${n} uses line type ${l.ltype}, which is not defined`);
  out.problems = [...new Set(problems)];
  return out;
}

// What a DXF reader would show, as SVG, to look at: entities drawn from
// what readDXF read, layers by colour, dashed where their line type is.
export function dxfPicture(d) {
  const [x0, y0, x1, y1] = d.bounds;
  const pad = (x1 - x0) * 0.02 + 1;
  const W = x1 - x0 + 2 * pad, H = y1 - y0 + 2 * pad;
  const X = (x) => +(x - x0 + pad).toFixed(3), Y = (y) => +(y1 + pad - y).toFixed(3);
  const ACI = { 1: "#d00", 3: "#080", 4: "#08a", 8: "#888" };
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/>`];
  for (const e of d.entities) {
    const layer = d.layers[e.layer] ?? {};
    const lt = d.ltypes[e.ltype ?? layer.ltype] ?? [];
    const st = `fill="none" stroke="${ACI[layer.colour] ?? "#000"}" stroke-width="${e.layer === "VISIBLE" || e.layer === "SECTION" ? 0.35 : 0.18}"${lt.length ? ` stroke-dasharray="${lt.map((v) => Math.abs(v) || 0.3).join(" ")}"` : ""}`;
    if (e.type === "LINE" || e.type === "POLYLINE") {
      const p = [];
      for (let i = 0; i < e.pts.length; i += 2) p.push(`${i ? "L" : "M"}${X(e.pts[i])} ${Y(e.pts[i + 1])}`);
      out.push(`<path d="${p.join("")}${e.closed ? "Z" : ""}" ${st}/>`);
    } else if (e.type === "CIRCLE") out.push(`<circle cx="${X(e.cx)}" cy="${Y(e.cy)}" r="${e.r}" ${st}/>`);
    else if (e.type === "SOLID") out.push(`<path d="M${X(e.pts[0])} ${Y(e.pts[1])}L${X(e.pts[2])} ${Y(e.pts[3])}L${X(e.pts[6])} ${Y(e.pts[7])}L${X(e.pts[4])} ${Y(e.pts[5])}Z" fill="#000"/>`);
    else if (e.type === "TEXT") {
      const anchor = ["start", "middle", "end"][e.align] ?? "start";
      const t = e.text.replace(/%%c/g, "Ø").replace(/\\U\+([0-9A-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
      out.push(`<text x="${X(e.x)}" y="${Y(e.y)}" font-size="${(e.height / 0.718).toFixed(3)}" font-family="Helvetica" fill="${ACI[layer.colour] ?? "#000"}" text-anchor="${anchor}"${e.angle ? ` transform="rotate(${-e.angle} ${X(e.x)} ${Y(e.y)})"` : ""}>${t}</text>`);
    }
  }
  out.push("</svg>");
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, picture] = process.argv.slice(2);
  if (!file) {
    console.error("Usage: node test/check-dxf.mjs file.dxf [picture.svg]");
    process.exit(2);
  }
  const d = readDXF(readFileSync(file, "utf8"));
  if (picture) writeFileSync(picture, dxfPicture(d));
  const b = d.bounds.map((v) => Math.round(v * 100) / 100);
  console.log(`${file}: ${d.version}, units ${d.units}, ${d.entities.length} entities ${JSON.stringify(d.counts)}`);
  console.log(`layers ${JSON.stringify(d.byLayer)}; bounds ${b[0]}, ${b[1]} to ${b[2]}, ${b[3]} (${Math.round((b[2] - b[0]) * 100) / 100} x ${Math.round((b[3] - b[1]) * 100) / 100} mm)`);
  console.log(`closed polylines ${d.entities.filter((e) => e.type === "POLYLINE" && e.closed).length}`);
  if (d.problems.length) {
    console.log(`PROBLEMS:\n  ${d.problems.slice(0, 20).join("\n  ")}`);
    process.exit(1);
  }
  console.log("ok");
}
