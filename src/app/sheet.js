// What goes in a drawing's title block, and where each value comes from:
// what the user said (Claude passes it to export_drawing), else what was
// remembered, else a default. Nothing about the user is guessed: the app
// cannot know a person's name or employer, and a login name is not one, so
// a name nobody gave stays an empty line to fill in by hand.
//
// Remembered for the user, in this app's own storage and never in model
// files (which get shared): who draws, the legal owner, and first or third
// angle. Remembered for the model, in the model document (saved with it):
// the drawing number, revision, supplementary title, approver and general
// tolerances.
import { splitTitle, today } from "../kernel/drawing.js";

const KEY = "3d-maker:drawing";
// The values export_drawing takes, and how much of each fits on the sheet.
const USER = { drawn_by: 80, owner: 80, projection: 5 };
const MODEL = { number: 16, revision: 4, subtitle: 120, approved_by: 80, tolerances: 60 };

export const readUser = () => {
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
    // Not remembered; this drawing still gets the value.
  }
};

// Third angle where it is the custom (the US and Canada), first angle
// (ISO) everywhere else, going by the system's language and region.
export function regionProjection(tag = globalThis.navigator?.language) {
  try {
    const region = new Intl.Locale(tag).maximize().region;
    return region === "US" || region === "CA" ? "third" : "first";
  } catch {
    return "first";
  }
}

// A drawing number made up once for a model: easy to read out, with no I,
// L, O or U to mistake for 1, 0 or V.
export function newNumber() {
  const letters = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const r = crypto.getRandomValues(new Uint8Array(6));
  return `3DM-${Array.from(r, (b) => letters[b & 31]).join("")}`;
}

// The given values, checked. A value of "" clears what was remembered.
function given(args) {
  const out = {};
  for (const [k, limit] of Object.entries({ ...USER, ...MODEL })) {
    if (args[k] === undefined || args[k] === null) continue;
    const v = String(args[k]).replace(/\s+/g, " ").trim();
    if (k === "projection" && v && v !== "first" && v !== "third") throw new Error('projection is "first" or "third".');
    if (k === "number" && v.length > limit) throw new Error(`A drawing number has at most ${limit} characters (ISO 7200); "${v}" has ${v.length}.`);
    if (v.length > limit) throw new Error(`${k} is at most ${limit} characters.`);
    out[k] = v;
  }
  return out;
}

const merge = (old, add, keys) => {
  const next = { ...old };
  for (const k of keys) if (k in add) add[k] ? (next[k] = add[k]) : delete next[k];
  return next;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Makes the drawing of the current model. args: what the user said, as
// export_drawing takes it (see mcp/server.mjs), plus axis and offset for
// the section. Remembers what was given, and gives the model a number if
// it has none. Returns the kernel's export, with sheet (what went in the
// title block) and line (one sentence that says so, and how to change it).
export async function makeDrawing({ store, kernel }, args = {}) {
  const res = store.state.result;
  const parts = res?.parts ?? [];
  const add = given(args);
  const user = merge(readUser(), add, Object.keys(USER));
  if (!same(user, readUser())) writeUser(user);
  const old = store.state.doc.drawing ?? {};
  const model = merge(old, add, Object.keys(MODEL));
  if (!model.number) model.number = newNumber();
  if (!same(model, old)) store.setDrawing(model);

  const projection = user.projection || regionProjection();
  const { title, subtitle } = splitTitle(res?.title || "Untitled", model.subtitle);
  const info = { title, subtitle, number: model.number, revision: model.revision ?? "", date: today(), createdBy: user.drawn_by ?? "", approvedBy: model.approved_by ?? "", owner: user.owner ?? "", tolerances: model.tolerances ?? "" };
  const r = await kernel.exportDrawing(parts, { info, projection, section: { axis: args.axis, offset: args.offset } });
  const sheet = {
    title,
    subtitle,
    identification_number: info.number,
    revision: info.revision,
    date_of_issue: info.date,
    created_by: info.createdBy,
    approved_by: info.approvedBy,
    legal_owner: info.owner,
    projection: `${projection} angle${user.projection ? "" : " (from your region)"}`,
    scale: r.scale,
    general_tolerances: info.tolerances,
  };
  return { ...r, sheet, line: sheetLine(info, projection, r.scale) };
}

// One sentence on what went on the sheet and how to change it, for the
// status line after Export > Drawing, and for Claude to pass on.
export function sheetLine(info, projection, scale) {
  const facts = [`Drawing ${info.number}${info.revision ? ` rev. ${info.revision}` : ""}`, `${projection} angle`, scale].join(", ");
  const blank = [
    ["Created by", info.createdBy, "drawn by …"],
    ["Legal owner", info.owner, "owner …"],
    ["Approved by", info.approvedBy, "approved by …"],
  ].filter(([, v]) => !v);
  if (!blank.length) return `${facts}. To change any of it, say so in the prompt box, e.g. "revision B".`;
  const names = blank.map(([n]) => n);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `${facts}. ${list} ${names.length > 1 ? "are" : "is"} left blank: say "${blank.map(([, , say]) => say).join(", ")}" in the prompt box to fill ${names.length > 1 ? "them" : "it"} in.`;
}
