// What goes in a drawing's title block, and where each value comes from:
// what the user said (Claude passes it to export_drawing), else what was
// remembered, else a default. Nothing about the user is guessed: the app
// cannot know a person's name or employer, and a login name is not one, so
// a name nobody gave stays an empty line to fill in by hand.
//
// What is remembered, and where:
// - Who draws, the legal owner and first or third angle are the user's, kept
//   in this app's own storage, never in a model file.
// - The number, revision, supplementary title and general tolerances belong
//   to the document and are saved with it. No name is.
// - An approval is not remembered at all: it is an act on one issue of a
//   drawing, so approved_by goes on the sheet it is given with, and the
//   next sheet has an empty line to sign.
import { LIMITS, today, dimensionText } from "../kernel/drawing.js";
import { sheetPDF } from "../kernel/pdf.js";
import { sheetDXF, outlineDXF, outlineSVG } from "../kernel/dxf.js";

const KEY = "draftsman:drawing";
// export_drawing's names for the fields the user can set, and the title
// block's (see LIMITS in kernel/drawing.js).
const FIELDS = { drawn_by: "createdBy", owner: "owner", approved_by: "approvedBy", number: "number", revision: "revision", subtitle: "subtitle", tolerances: "tolerances" };
const USER = ["drawn_by", "owner", "projection"];
const MODEL = ["number", "revision", "subtitle", "tolerances"];
const LABELS = { drawn_by: "created by", owner: "legal owner", approved_by: "approved by", revision: "revision", subtitle: "supplementary title", tolerances: "general tolerances" };
// Where third angle is the custom: the US (ASME Y14.3 makes it the
// default), Canada, and Japan (JIS B 0001 makes it the default). Others
// often named (Korea, Taiwan, Australia) are left out until confirmed.
const THIRD = new Set(["US", "CA", "JP"]);
// Languages spoken almost only in one country, which a system often names
// without a region (a Japanese Mac reports plain "ja").
const HOME = { ja: "JP" };

const readUser = () => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
const writeUser = (v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // Not remembered; the drawing still got the value.
  }
};

// First or third angle from the first of the system's languages that names
// a region ("en-CA" does, "en" does not; "ja" counts as Japan). With none,
// first angle: the sheet is an ISO sheet. { projection, region }.
function regionProjection() {
  let region = null;
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    try {
      const l = new Intl.Locale(tag);
      region = l.region ?? HOME[l.language] ?? null;
    } catch {
      // An odd language tag: try the next.
    }
    if (region) break;
  }
  return { projection: region && THIRD.has(region) ? "third" : "first", region };
}

// A drawing number made up once for a document: easy to read out, with no
// I, L, O or U to mistake for 1, 0 or V.
function newNumber() {
  const letters = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return `DFT-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => letters[b & 31]).join("")}`;
}

// The given values, checked. "" means: forget what was remembered.
function given(args) {
  const out = {};
  for (const k of [...Object.keys(FIELDS), "projection"]) {
    if (args[k] === undefined || args[k] === null) continue;
    const v = String(args[k]).replace(/\s+/g, " ").trim();
    if (k === "projection") {
      if (v && v !== "first" && v !== "third") throw new Error('projection is "first" or "third".');
    } else if ([...v].length > LIMITS[FIELDS[k]]) {
      throw new Error(`${cap(LABELS[k] ?? "the drawing number")} holds at most ${LIMITS[FIELDS[k]]} characters (ISO 7200${k === "owner" || k === "tolerances" ? " leaves it open; this is what its cell holds" : ""}); "${v}" has ${[...v].length}. Shorten it and try again.`);
    }
    out[k] = v;
  }
  return out;
}

const list = (a) => (a.length > 1 ? `${a.slice(0, -1).join(", ")} and ${a.at(-1)}` : a[0]);
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// The file formats a drawing comes in, and what an outline can be of.
const FORMATS = ["svg", "pdf", "dxf"];
const OUTLINES = ["section", "front", "back", "left", "right", "top", "bottom"];
function formatOf(args) {
  const f = args.format || "svg";
  if (!FORMATS.includes(f)) throw new Error(`format is "svg", "pdf" or "dxf", not ${JSON.stringify(f)}.`);
  return f;
}

// One outline alone at true size (1:1, mm, no sheet), for a laser or
// water-jet cutter: a section's cut faces, or one view's visible lines.
// Loops that are circles go out as true circles.
async function makeOutline({ store, kernel }, args) {
  const format = formatOf(args);
  if (format === "pdf") throw new Error('An outline is exported as "svg" or "dxf", at true size. PDF is for the drawing sheet.');
  if (!OUTLINES.includes(args.outline)) throw new Error(`outline is one of ${OUTLINES.join(", ")}, not ${JSON.stringify(args.outline)}.`);
  const view = args.outline === "section" ? null : args.outline;
  const title = store.state.result?.title || "model";
  const o = await kernel.exportOutline(store.state.result?.parts ?? [], { view, section: { axis: args.axis, offset: args.offset } });
  const made = (format === "dxf" ? outlineDXF : outlineSVG)(o, { title });
  const size = [made.box[2] - made.box[0], made.box[3] - made.box[1]].map((v) => Math.round(v * 100) / 100);
  const what = view ? `The ${view} view's visible lines` : `Section across ${o.section.axis} at ${dimensionText(o.section.offset_mm)} mm`;
  const pieces = [made.loops && `${made.loops} closed outline${made.loops > 1 ? "s" : ""}`, made.circles && `${made.circles} circle${made.circles > 1 ? "s" : ""}`, made.lines && `${made.lines} open line${made.lines > 1 ? "s" : ""}`].filter(Boolean);
  const line = `${what}, at true size (1:1, mm): ${dimensionText(size[0])} x ${dimensionText(size[1])} mm, ${pieces.join(", ") || "nothing"}.${view ? " A view's lines come from the mesh, so its curves are as fine as the mesh." : ""}`;
  return {
    name: `${title} ${args.outline}`,
    bytes: new TextEncoder().encode(made.text),
    format,
    outline: args.outline,
    size_mm: size,
    closed_outlines: made.loops,
    circles: made.circles,
    open_lines: made.lines,
    ...(o.section ? { section: o.section } : {}),
    line,
  };
}

// Makes the drawing of the current document. args: what the user said, as
// export_drawing takes it (see mcp/server.mjs), plus axis and offset for
// the section, format ("svg", "pdf" or "dxf") and outline (a section or a
// view alone at 1:1 instead of the sheet; see makeOutline).
// Returns { result, keep }: result is the kernel's export with
// sheet (what went in the title block, except names that were remembered,
// which it only says are filled) and line (one sentence that says the same
// and how to change it). Nothing is remembered and no number is kept until
// keep() is called, once the file is saved.
export async function makeDrawing({ store, kernel }, args = {}) {
  if (args.outline) return { result: await makeOutline({ store, kernel }, args), keep: () => {} };
  const format = formatOf(args);
  const record = store.state.doc.drawing;
  const add = given(args);
  const pick = (keys, from) => {
    const next = { ...from };
    for (const k of keys) if (k in add) add[k] ? (next[k] = add[k]) : delete next[k];
    return next;
  };
  const user = pick(USER, readUser());
  // Only these fields: anything else a record holds (an approval saved by an
  // earlier version of the app) is dropped when it is next kept.
  const model = pick(MODEL, Object.fromEntries(MODEL.filter((k) => record[k]).map((k) => [k, record[k]])));
  if (!model.number) model.number = newNumber();
  const region = regionProjection();
  const projection = user.projection || region.projection;
  const info = { title: store.state.result?.title, subtitle: model.subtitle ?? "", number: model.number, revision: model.revision ?? "", date: today(), createdBy: user.drawn_by ?? "", approvedBy: add.approved_by ?? "", owner: user.owner ?? "", tolerances: model.tolerances ?? "" };
  const { titles, marks, ...r } = await kernel.exportDrawing(store.state.result?.parts ?? [], { info, projection, section: { axis: args.axis, offset: args.offset }, hidden: Boolean(args.hidden_edges), size: args.sheet || "A3", detail: args.detail || null });

  // The same sheet as PDF or DXF, written from its SVG.
  if (format !== "svg") {
    const svg = new TextDecoder().decode(r.bytes);
    r.bytes = format === "pdf" ? await sheetPDF(svg, { title: [titles.title, titles.subtitle].filter(Boolean).join(" – "), date: info.date }) : new TextEncoder().encode(sheetDXF(svg));
  }
  r.format = format;

  // How each field the user fills in came to be on the sheet.
  const values = { drawn_by: user.drawn_by, owner: user.owner, approved_by: add.approved_by, revision: model.revision, subtitle: model.subtitle, tolerances: model.tolerances };
  const how = (k) => (!values[k] ? "blank" : k in add ? "given" : "remembered");
  const fromRegion = !user.projection && region.region;
  const sheet = {
    title: titles.title,
    supplementary_title: titles.subtitle,
    identification_number: info.number,
    revision: info.revision,
    date_of_issue: info.date,
    // A remembered name is on the sheet; it is not sent back to Claude.
    created_by: how("drawn_by") === "remembered" ? "(filled in, as remembered)" : values.drawn_by ?? "",
    legal_owner: how("owner") === "remembered" ? "(filled in, as remembered)" : values.owner ?? "",
    approved_by: values.approved_by ?? "",
    projection: `${projection} angle${fromRegion ? ` (from your region, ${region.region})` : user.projection ? "" : " (ISO's default: your system names no region)"}`,
    scale: r.scale,
    general_tolerances: info.tolerances,
  };
  const order = ["drawn_by", "owner", "approved_by", "revision", "subtitle", "tolerances"];
  const said = order.filter((k) => how(k) === "given").map((k) => LABELS[k]);
  const kept = order.filter((k) => how(k) === "remembered").map((k) => LABELS[k]);
  // Only the mandatory fields count as missing: revision and the rest are optional.
  const blank = ["drawn_by", "owner", "approved_by"].filter((k) => how(k) === "blank").map((k) => LABELS[k]);
  const parts = [`Drawing ${info.number}${info.revision ? ` rev. ${info.revision}` : ""}, ${projection} angle${fromRegion ? " (from your region)" : ""}, ${r.scale}${r.sheet_size && r.sheet_size !== "A3" ? ` on ${r.sheet_size}` : ""}.`];
  if (r.detail_view) parts.push(`Detail view ${r.detail_view.letter} of the ${r.detail_view.view} view at ${r.detail_view.scale}.`);
  if (titles.shortened) parts.push("The model's title was too long for the title block and is shortened on the sheet.");
  if (r.section_note) parts.push(r.section_note);
  parts.push(...marksLines(marks));
  if (said.length) parts.push(`${cap(list(said))} as given.`);
  if (kept.length) parts.push(`${cap(list(kept))} as remembered.`);
  if (blank.length) parts.push(`${cap(list(blank))} left blank.`);
  const example = { drawn_by: "drawn by …", owner: "owner …", approved_by: "approved by …" };
  const asks = ["drawn_by", "owner", "approved_by"].filter((k) => how(k) === "blank").map((k) => example[k]);
  parts.push(`To fill in or change a field, tell Claude, e.g. "${(asks.length ? asks : ["revision B"]).slice(0, 2).join(", ")}".`);
  const keep = () => {
    writeUser(user);
    store.setDrawing(record, model);
  };
  return { result: { ...r, holes: marks, sheet, line: parts.join(" ") }, keep };
}

// What the sheet says about holes, in a sentence or two: the centre lines,
// the sizes called out and where they came from, how close a fitted circle
// is, and what was left out.
function marksLines(m) {
  if (!m) return [];
  const out = [];
  const sizes = m.holes.map((h) => h.text);
  if (m.centre_lines) out.push(`Centre lines on ${m.centre_lines} hole${m.centre_lines > 1 ? "s" : ""} and turned part${m.centre_lines > 1 ? "s" : ""}.`);
  if (sizes.length) {
    const fromScript = m.holes.every((h) => h.from === "the script");
    out.push(`Holes ${list(sizes)}${m.positions ? `, with ${m.positions} position${m.positions > 1 ? "s" : ""}` : ""}, sized ${fromScript ? "from the script's own values" : "from the script and from circles fitted to the views"}.`);
  }
  if (m.sizes) out.push(`Section A–A gives ${m.sizes} step height${m.sizes > 1 ? "s" : ""} and wall thickness${m.sizes > 1 ? "es" : ""}.`);
  if (m.on_centre) out.push("A hole on the cutting line, in the middle of the part, is placed by the line.");
  for (const f of m.fitted) out.push(`⌀${f.diameter} is a circle fitted to the view, within ${f.within_mm} mm.`);
  if (m.left_out.length) out.push(`Left out: ${list(m.left_out)}.`);
  return out;
}
