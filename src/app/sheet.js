// What goes in a drawing's title block, and where each value comes from:
// what the user said (Claude passes it to export_drawing), else what was
// remembered, else a default. Nothing about the user is guessed: the app
// cannot know a person's name or employer, and a login name is not one, so
// a name nobody gave stays an empty line to fill in by hand.
//
// Where names are kept:
// - Who draws, the legal owner and first or third angle are the user's. They
//   are kept in this app's own storage, never in a model file.
// - The number, revision, supplementary title, general tolerances and the
//   approval belong to the document, so they are saved with it, and a model
//   file someone shares carries them, the approver's name included. An
//   approval holds only for the shape it was given for: once the script or
//   a slider changes, it is cleared.
import { LIMITS, splitTitle, today } from "../kernel/drawing.js";

const KEY = "3d-maker:drawing";
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

// First or third angle from the region the system's language names, if it
// names one ("en-CA" does, "en" does not). With no region, first angle:
// the sheet is an ISO sheet. { projection, region } (region null if none).
function regionProjection() {
  let region = null;
  try {
    region = new Intl.Locale(navigator.language).region ?? null;
  } catch {
    // An odd language tag: no region.
  }
  return { projection: region && THIRD.has(region) ? "third" : "first", region };
}

// A drawing number made up once for a document: easy to read out, with no
// I, L, O or U to mistake for 1, 0 or V.
function newNumber() {
  const letters = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return `3DM-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => letters[b & 31]).join("")}`;
}

// The shape a document's script and slider values make, as a short key: an
// approval holds while it stays the same.
function shapeKey(doc) {
  const values = Object.keys(doc.values ?? {})
    .sort()
    .map((k) => `${k}=${doc.values[k]}`)
    .join(",");
  let h = 0x811c9dc5;
  for (const c of `${doc.script}\u0000${values}`) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0;
  return `${doc.script.length}-${h.toString(16)}`;
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

// Makes the drawing of the current document. args: what the user said, as
// export_drawing takes it (see mcp/server.mjs), plus axis and offset for
// the section. Only once the drawing is made does it remember what was
// given, keep a new number, or drop an approval the shape has outgrown.
// Returns the kernel's export with sheet (what went in the title block,
// except names that were remembered, which it only says are filled) and
// line (one sentence that says the same and how to change it).
export async function makeDrawing({ store, kernel }, args = {}) {
  const doc = store.state.doc;
  const record = doc.drawing;
  const add = given(args);
  const pick = (keys, from) => {
    const next = { ...from };
    for (const k of keys) if (k in add) add[k] ? (next[k] = add[k]) : delete next[k];
    return next;
  };
  const user = pick(USER, readUser());
  const model = pick(MODEL, record);
  if (!model.number) model.number = newNumber();
  // The approval: given now for this shape, or kept from before if the shape has not changed since.
  const shape = shapeKey(doc);
  let cleared = false;
  if (add.approved_by) {
    model.approved_by = add.approved_by;
    model.approved_shape = shape;
  } else if ("approved_by" in add || (model.approved_by && model.approved_shape !== shape)) {
    cleared = !("approved_by" in add);
    delete model.approved_by;
    delete model.approved_shape;
  }

  const region = regionProjection();
  const projection = user.projection || region.projection;
  const { title, subtitle } = splitTitle(store.state.result?.title || "Untitled", model.subtitle);
  if ([...subtitle].length > LIMITS.subtitle)
    throw new Error(`The model's title is too long for the sheet: the title holds about 30 characters and the supplementary title ${LIMITS.subtitle}${model.subtitle ? `, and "${model.subtitle}" is already in it` : ""}. Shorten title() in the script${model.subtitle ? " or the supplementary title" : ""}.`);
  const info = { title, subtitle, number: model.number, revision: model.revision ?? "", date: today(), createdBy: user.drawn_by ?? "", approvedBy: model.approved_by ?? "", owner: user.owner ?? "", tolerances: model.tolerances ?? "" };
  const r = await kernel.exportDrawing(store.state.result?.parts ?? [], { info, projection, section: { axis: args.axis, offset: args.offset } });

  writeUser(user);
  store.setDrawing(record, model);

  // How each field the user fills in came to be on the sheet.
  const values = { drawn_by: user.drawn_by, owner: user.owner, approved_by: model.approved_by, revision: model.revision, subtitle: model.subtitle, tolerances: model.tolerances };
  const how = (k) => (!values[k] ? "blank" : k in add ? "given" : "remembered");
  const names = ["drawn_by", "owner", "approved_by"];
  const fromRegion = !user.projection && region.region;
  const sheet = {
    title,
    supplementary_title: subtitle,
    identification_number: info.number,
    revision: info.revision,
    date_of_issue: info.date,
    // A remembered name is on the sheet; it is not sent back to Claude.
    ...Object.fromEntries(names.map((k) => [k === "drawn_by" ? "created_by" : k === "owner" ? "legal_owner" : k, how(k) === "remembered" ? "(filled in, as remembered)" : values[k] ?? ""])),
    projection: `${projection} angle${fromRegion ? ` (from your region, ${region.region})` : user.projection ? "" : " (ISO's default: your system names no region)"}`,
    scale: r.scale,
    general_tolerances: info.tolerances,
  };
  const order = ["drawn_by", "owner", "approved_by", "revision", "subtitle", "tolerances"];
  const said = order.filter((k) => how(k) === "given").map((k) => LABELS[k]);
  const kept = order.filter((k) => how(k) === "remembered").map((k) => LABELS[k]);
  const blank = order.filter((k) => how(k) === "blank" && k !== "subtitle" && k !== "tolerances").map((k) => LABELS[k]);
  const parts = [`Drawing ${info.number}${info.revision ? ` rev. ${info.revision}` : ""}, ${projection} angle${fromRegion ? " (from your region)" : ""}, ${r.scale}.`];
  if (said.length) parts.push(`${cap(list(said))} as you said.`);
  if (kept.length) parts.push(`${cap(list(kept))} as remembered.`);
  if (cleared) parts.push("The approval was cleared: the model has changed since it was given.");
  if (blank.length) parts.push(`${cap(list(blank))} left blank.`);
  const example = { drawn_by: "drawn by …", owner: "owner …", approved_by: "approved by …", revision: "revision A" };
  const asks = order.filter((k) => how(k) === "blank" && example[k]).map((k) => example[k]);
  parts.push(`To fill in or change a field, tell Claude, e.g. "${(asks.length ? asks : ["revision B"]).slice(0, 2).join(", ")}".`);
  return { ...r, sheet, approval_cleared: cleared, line: parts.join(" ") };
}
