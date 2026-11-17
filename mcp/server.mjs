#!/usr/bin/env node
// Draftsman MCP server. Claude Code (started by the app, or your own) or Claude
// Desktop runs this over stdio; it forwards tool calls to the open Draftsman
// app over a local WebSocket.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { writeFile, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, extname, basename, join } from "node:path";
import { REFERENCE } from "./reference.mjs";
import { DENSITIES } from "../src/app/inspect-tools.js";

// The materials measure knows a density for, so a name it would refuse cannot be sent.
const MATERIALS = Object.keys(DENSITIES);

const PORTS = Array.from({ length: 10 }, (_, i) => 7457 + i);
// Only the app itself may connect: the desktop app, or the dev server in a browser.
const TAURI_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);
const isAppOrigin = (o = "") => TAURI_ORIGINS.has(o) || /^http:\/\/(localhost|127\.0\.0\.1):51[78]\d$/.test(o);
const CALL_TIMEOUT_MS = 120000;
const log = (...a) => console.error("[draftsman]", ...a);

// ---- bridge to the app ----
// When the app's own prompt box starts Claude, it passes its window id
// (--app <id>) so tool calls go to that window and no other, even with several
// Draftsman windows or tabs open. Without --app (Claude Desktop, your own
// Claude Code), calls go to the window that connected most recently.
const argAt = process.argv.indexOf("--app");
const APP_ID = argAt > 0 ? process.argv[argAt + 1] : null;
let app = null; // the app socket tool calls go to
const pending = new Map();
let seq = 0;

async function listen() {
  for (const port of PORTS) {
    try {
      await new Promise((ok, fail) => {
        const wss = new WebSocketServer({ host: "127.0.0.1", port, verifyClient: ({ origin }) => isAppOrigin(origin) });
        wss.once("listening", () => ok(wss));
        wss.once("error", fail);
        wss.on("connection", (ws) => {
          ws.on("message", (raw) => {
            let msg;
            try {
              msg = JSON.parse(raw);
            } catch {
              return;
            }
            if (msg?.type === "hello") {
              if (APP_ID && msg.window !== APP_ID) return ws.close(4001, "Not the window that started this Claude run");
              app = ws;
              return log(`app window ${msg.window ?? "?"} connected on port ${port}`);
            }
            if (ws !== app) return;
            const p = pending.get(msg.id);
            if (!p) return;
            pending.delete(msg.id);
            clearTimeout(p.timer);
            msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
          });
          ws.on("close", () => {
            if (app === ws) app = null;
          });
        });
      });
      log(`bridge listening on 127.0.0.1:${port}${APP_ID ? ` for window ${APP_ID}` : ""}`);
      return port;
    } catch {
      // Port taken (another Claude client runs its own copy); try the next one.
    }
  }
  throw new Error(`No free port in ${PORTS[0]}-${PORTS.at(-1)}`);
}

async function waitForApp(ms) {
  const end = Date.now() + ms;
  while (!app && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return app;
}

async function call(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
  if (!(await waitForApp(8000))) throw new Error(APP_ID ? "The Draftsman window that asked is no longer connected. Ask the user to try again." : "The Draftsman app is not open. Ask the user to start it, then try again.");
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Draftsman did not answer "${method}" within ${timeoutMs / 1000} s.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    app.send(JSON.stringify({ id, method, params }));
  });
}

// ---- the modelling language, as Claude sees it ----
// Claude Code cuts server instructions off at 4096 characters, so these are
// short and point to the reference tool (mcp/reference.mjs) for the rest.
const INSTRUCTIONS = `Draftsman turns a short JavaScript model script into solid 3D parts the user sees live in the app.

Before you write or change a script, call the reference tool once (unless you already have its text in this conversation): it is the whole modelling language (shapes, profiles, sweep and loft, holes and fasteners, parts, sliders, motion and joints) with examples, and how to work. Use only the functions it lists; do not guess names.

In short: units are millimetres, +Z is up, the ground is z = 0. Write the whole script with set_model, change part of it with edit_model, and look at it with screenshot. Big or mechanical models are planned with set_plan, built step by step with append_to_model, and each step is checked with finish_step. check_fit finds parts passing into each other, at rest and during the motion. For a picture or a film the user asks for, set_camera places the camera, save_picture saves a studio picture, and record_video records a video of planned shots (try them first with preview_shots). When done, answer in one or two short sentences; do not paste the script.`;

const server = new McpServer({ name: "draftsman", version: "0.6.0" }, { instructions: INSTRUCTIONS });

const json = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 1) }] });
const fail = (err) => ({ isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] });
const tool = (name, description, inputSchema, handler) =>
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return await handler(args ?? {});
    } catch (err) {
      return fail(err);
    }
  });

tool("reference", "Return the Draftsman modelling language: every shape, profile, fastener, building, motion and joint function, with examples, and how to work, take pictures and films, and make drawings. Call it once before writing your first script.", {}, async () => ({ content: [{ type: "text", text: REFERENCE }] }));

tool("get_model", "Return the current model script, slider values, each part's size, bounds, volume and motion, the sliders, and which part the user has selected.", {}, async () => json(await call("get_model")));

tool(
  "set_model",
  "Replace the whole model script and rebuild. Returns each part's bounds, size and volume, or the script error (with a line number) if it failed, in which case the model is left unchanged.",
  { script: z.string().describe("The complete model script, in the language the reference tool returns.") },
  async (a) => json(await call("set_model", a)),
);

tool(
  "edit_model",
  "Replace one exact piece of the current script (old_text must appear exactly once) and rebuild. Use this for small changes.",
  { old_text: z.string().describe("The piece of the script to replace, exactly as it is there."), new_text: z.string().describe("What to put in its place.") },
  async (a) => json(await call("edit_model", a)),
);

tool(
  "set_plan",
  "Plan a big model as build steps before writing it. Each step is a sub-assembly and lists the exact part names it will create. The user sees the steps and your progress. Calling it again replaces the plan; steps with the same name and parts keep their done state.",
  {
    steps: z
      .array(z.object({ name: z.string().describe("Short name of the sub-assembly, e.g. \"Stationary swashplate\""), parts: z.array(z.string()).min(1).describe("Part names this step creates, exactly as passed to part()") }))
      .min(2)
      .max(40)
      .describe("The build steps in order, from the core outwards."),
  },
  async (a) => json(await call("set_plan", a)),
);

tool(
  "append_to_model",
  "Add code to the end of the current script and rebuild: use it to add a plan step's parts. Constants and functions defined earlier in the script can be used. Returns the model summary, or the script error (the model is then left unchanged).",
  { code: z.string().describe("Script code to add at the end, such as one plan step's parts.") },
  async (a) => json(await call("append_to_model", a)),
);

tool(
  "finish_step",
  "Mark a plan step done after building it. Checks every part the step lists exists and has a surface (if not, it says what is missing and the step stays open), then returns those parts' sizes, any overlaps with other parts, the plan's progress and a picture of the step's parts with the rest of the model shown faintly. Look at the picture and fix problems before the next step.",
  { step: z.string().describe("The step's name, exactly as in set_plan") },
  async (a) => {
    const { png, ...rest } = await call("finish_step", a);
    return { content: [{ type: "text", text: JSON.stringify(rest, null, 1) }, { type: "image", data: png, mimeType: "image/png" }] };
  },
);

tool(
  "check_fit",
  "Find parts that pass into each other, at rest and over the whole motion loop (moving parts hitting other parts). Each overlap gives overlap_mm (how far they pass into each other), volume_cm3, where (the box around it) and, for moving parts, at_seconds. parts: only check pairs that include one of these. With exactly two parts it also gives gap_mm, how close they come (clearance between a blade and the body, a wheel and its arch).",
  { parts: z.array(z.string()).min(1).optional().describe("Part names; leave out to check every pair") },
  async (a) => json(await call("check_fit", a)),
);

tool(
  "screenshot",
  "Render the model and return a PNG so you can see it.",
  {
    view: z.enum(["iso", "top", "bottom", "front", "back", "left", "right"]).optional().describe("iso is in perspective; the others are flat and true to scale, like a drawing, filling the picture. Default: the user's current camera."),
    part: z.string().optional().describe("Frame just this part."),
    parts: z.array(z.string()).optional().describe("Frame these parts and show the rest faintly."),
    at: z.number().min(0).optional().describe("Seconds into the motion loop to pose the model at; default 0 (rest)."),
    width: z.number().int().min(256).max(2048).optional().describe("Pixels; default 1024."),
    height: z.number().int().min(256).max(2048).optional().describe("Pixels; default 768."),
  },
  async (a) => {
    const { png, view } = await call("screenshot", a);
    return { content: [{ type: "image", data: png, mimeType: "image/png" }, ...(view ? [{ type: "text", text: view }] : [])] };
  },
);

tool(
  "set_look",
  "Change how the view draws the model: the plain shaded look (the default), or shaded with edges, where sharp edges and outlines are thin dark lines as in engineering views. The app remembers the choice, and pictures, screenshots and films use it. Use it when the user asks to see edges or outlines, or to turn them off.",
  { edges: z.boolean().describe("true: draw sharp edges and outlines as thin dark lines; false: the plain shaded look.") },
  async (a) => json(await call("set_look", a)),
);

// ---- looking inside and checking: view state, and measuring ----
const VIEW_NOTE = "It changes only the view and its pictures, not the model, its exports, drawings, check_fit, measure or undo; a line by the prompt box tells the user, who can clear it with Esc. Returns what the view now shows.";

tool(
  "hide_parts",
  `Hide parts in the view, or show them again, to see what is behind or inside them. Hidden parts are not drawn, cast no shadow, cannot be clicked and are left out of screenshots, except parts a screenshot names in part or parts. ${VIEW_NOTE}`,
  {
    hide: z.array(z.string()).optional().describe("Parts to hide."),
    show: z.array(z.string()).optional().describe("Hidden parts to show again."),
    only: z.array(z.string()).min(1).optional().describe("Show just these and hide all the others."),
    all: z.boolean().optional().describe("true shows every part."),
  },
  async (a) => json(await call("hide_parts", a)),
);

tool(
  "section_view",
  `Cut the model open with a plane to look inside it: one side is taken away and the cut faces are filled and hatched, so hollows, holes and parts inside show. Use it to check an assembly's insides (a shaft through its bearings, wall thickness), then take a screenshot. Give axis and offset, or point and normal for a plane at any angle. Returns the parts cut and, for an axis, look_into_it_from: the screenshot view that looks straight into the cut. Moving parts move through the plane. ${VIEW_NOTE}`,
  {
    axis: z.enum(["x", "y", "z"]).optional().describe("The plane stands square across this axis."),
    offset: z.number().optional().describe("mm along axis; default the model's middle."),
    remove: z.enum(["+", "-"]).optional().describe("The side of the plane taken away, along axis; default the side the iso view looks from, so an iso screenshot looks into the cut."),
    point: z.array(z.number()).length(3).optional().describe("A point on the plane, mm"),
    normal: z.array(z.number()).length(3).optional().describe("Square to the plane, pointing to the side taken away"),
    uncut: z.array(z.string()).optional().describe("Parts left whole"),
    off: z.boolean().optional().describe("true removes the section."),
  },
  async (a) => json(await call("section_view", a)),
);

tool(
  "explode_view",
  `Move the parts apart in the view (an exploded view), to show how an assembly goes together or to see parts hidden by others. Parts are lifted so none goes below the floor. Works with hide_parts and section_view (each part keeps its cut). ${VIEW_NOTE}`,
  {
    factor: z.number().min(0).max(1).optional().describe("0 assembled to 1 fully apart (each group moves away from the model's middle by as far again as it is from there); default 1."),
    axis: z.enum(["x", "y", "z"]).optional().describe("Move only along this axis, as for a stack along a mast."),
    together: z.enum(["steps", "parts"]).optional().describe("steps keeps each plan step's parts together (the default when there is a plan); parts moves every part on its own."),
  },
  async (a) => json(await call("explode_view", a)),
);

tool("clear_view", "Show the whole model again: every part shown, no section, assembled. Use it when you have finished looking inside, unless the user asked for the view to stay that way.", {}, async () => json(await call("clear_view")));

tool(
  "measure",
  "Measure the model in numbers, from its exact shapes as the script places them (not moved by motion or the exploded view). Any of the arguments can be asked together. Volume and centre of mass are good to about 0.1%, surface area to about 1%. Use it to answer questions about sizes, clearances and weight instead of judging from a picture.",
  {
    part: z.string().optional().describe("A part: its size, bounds, volume, surface area and centre of mass, and its mass with material or density_g_cm3."),
    parts: z.array(z.string()).min(1).optional().describe("Several parts: each one's figures, and their total and combined centre of mass."),
    material: z.enum(MATERIALS).optional().describe("For the mass in grams."),
    density_g_cm3: z.number().positive().optional().describe("For the mass of a material not in the list."),
    between: z.array(z.string()).length(2).optional().describe("Two part names: the shortest distance between them and the nearest point on each (0 and overlap_mm if they pass into each other)."),
    points: z.array(z.array(z.number()).length(3)).length(2).optional().describe("Two points [x, y, z] in mm: the distance between them."),
  },
  async (a) => json(await call("measure", a)),
);

// Writes an exported file; path defaults to ~/Downloads/<title>.<ext>.
async function save(r, path, ext) {
  const base = (r.name || "model").replace(/[^\w.-]+/g, "-");
  let out = path ? resolve(homedir(), path.replace(/^~(?=\/|$)/, homedir())) : resolve(homedir(), "Downloads", `${base}.${ext}`);
  if (!extname(out)) out += `.${ext}`;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(r.base64, "base64"));
  const { name, base64, ...facts } = r;
  return json({ path: out, ...facts });
}

tool(
  "export_stl",
  "Export all visible parts as an STL for 3D printing, each part its own closed shell; with solid: true, all parts joined into one closed solid (slower). path defaults to ~/Downloads/<title>.stl. Only do this when the user asks.",
  {
    path: z.string().optional().describe("Absolute path, or relative to the home folder."),
    solid: z.boolean().optional().describe("Join every part into one solid, to print in one piece."),
  },
  async ({ path, solid }) => save(await call("export_stl", { solid: Boolean(solid) }), path, "stl"),
);

tool(
  "export_3mf",
  "Export all visible parts as a 3MF file: one named, coloured object per part, for slicers and other CAD tools. path defaults to ~/Downloads/<title>.3mf. Only do this when the user asks.",
  { path: z.string().optional().describe("Absolute path, or relative to the home folder.") },
  async ({ path }) => save(await call("export_3mf"), path, "3mf"),
);

tool(
  "export_step",
  "Export all visible parts as a STEP file (AP214) for other CAD programs: an assembly of named, coloured solids in mm. Simple parts (primitives, and extrudes or revolves of outlines of lines and arcs) come out with exact surfaces, the rest as flat faces from the mesh; the reference says which is which. path defaults to ~/Downloads/<title>.step. Only do this when the user asks. Returns the path, exact_parts, faceted_parts, left_out (too thin to mesh) and line; tell the user which parts are faceted or left out.",
  { path: z.string().optional().describe("Absolute path, or relative to the home folder.") },
  async ({ path }) => save(await call("export_step"), path, "step"),
);

tool(
  "export_drawing",
  "Export a 2D drawing of all visible parts as an SVG, PDF or DXF: an ISO sheet with the front, top and side views, an isometric view where there is room, a hatched section A-A, the overall sizes, centre lines, on a drawing of up to 3 parts the sizes needed to make it, and an ISO 7200 title block. The reference's drawings note says what goes on it and where the section cuts. The title is the model's title(); the app fills in the date, scale, document type and a drawing number. Title block fields (drawn_by to tolerances): pass only what the user said in this conversation, never a name or company you guessed. The app remembers them for later drawings, except approved_by; \"\" forgets one (for number, a new one is made). A value over its limit is refused, never cut short. With outline, the file is instead one outline alone at 1:1 for laser and water-jet cutters. path defaults to ~/Downloads/<title>.<format>. Only do this when the user asks. Returns the path, the scale, isometric_view, the section, sheet (the title block's fields) and line, one sentence on what went on the sheet: reply with the path and that line, nothing more.",
  {
    path: z.string().optional().describe("Absolute path, or relative to the home folder."),
    axis: z.enum(["x", "y", "z"]).optional().describe("The section plane stands square across this axis."),
    offset: z.number().optional().describe("Where along axis the plane cuts, mm; default the middle."),
    drawn_by: z.string().optional().describe("Created by, at most 20 characters, as the user wrote it."),
    owner: z.string().optional().describe("Legal owner, at most 40 characters."),
    approved_by: z.string().optional().describe("Approved by, at most 20 characters, only when the user names the approver; this sheet only."),
    number: z.string().optional().describe("Drawing number, at most 16 characters, replacing the one the app made."),
    revision: z.string().optional().describe("Revision index, at most 2 characters: A, B, C (no I or O)."),
    subtitle: z.string().optional().describe("Supplementary title, at most 50 characters."),
    tolerances: z.string().optional().describe('General tolerances note, at most 30 characters, such as "ISO 2768-m".'),
    format: z.enum(["svg", "pdf", "dxf"]).optional().describe("svg (default), pdf (the same sheet, to print or send) or dxf (for 2D CAD, on layers)."),
    sheet: z.enum(["A4", "A3", "A2", "A1", "A0"]).optional().describe("A4 upright, A3 (default) to A0 across; a bigger sheet gives a larger scale."),
    detail: z.union([z.boolean(), z.object({ view: z.enum(["front", "top", "side"]).describe("The view to take it from."), at: z.array(z.number()).length(3).describe("The middle of the detail, [x, y, z] in mm."), radius: z.number().optional().describe("Radius of the detail circle, mm.") })]).optional().describe("A detail view B at a larger scale: true picks the most crowded place, or say where. When the user asks, or a view is too crowded to read."),
    hidden_edges: z.boolean().optional().describe("Draw hidden edges dashed on the front, top and side views, when the user asks for hidden lines."),
    outline: z.enum(["section", "front", "back", "left", "right", "top", "bottom"]).optional().describe("Only this outline, at 1:1, as svg or dxf, when the user asks for an outline or a file to cut."),
    projection: z.enum(["first", "third", ""]).optional().describe("first (ISO) or third angle (US, Canada, Japan); default from the user's region, else first."),
  },
  async ({ path, ...args }) => {
    const r = await call("export_drawing", args);
    return save(r, path, r.format ?? "svg");
  },
);

tool(
  "export_floor_plan",
  "Export the floor plan of a building (a model made with outerWalls, wall, door, window and room) as an SVG, PDF or DXF: an A3 sheet at 1:50 or 1:100 with the walls cut 1200 mm above the floor, doors with their swing, windows, each room's name and area, dimension chains, a north arrow, a scale bar and export_drawing's title block, filled in and remembered the same way. Pass only title block fields the user gave. path defaults to ~/Downloads/<title>.<format>. Only do this when the user asks. Returns the path, the scale, the rooms with their areas, and line: reply with the path and that line.",
  {
    path: z.string().optional().describe("Absolute path, or relative to the home folder."),
    drawn_by: z.string().optional().describe("As for export_drawing."),
    owner: z.string().optional().describe("As for export_drawing."),
    approved_by: z.string().optional().describe("As for export_drawing."),
    number: z.string().optional().describe("As for export_drawing."),
    revision: z.string().optional().describe("As for export_drawing."),
    subtitle: z.string().optional().describe("As for export_drawing."),
    format: z.enum(["svg", "pdf", "dxf"]).optional().describe("svg (default), pdf (the same sheet, to print or send) or dxf (for 2D CAD, on layers)."),
  },
  async ({ path, ...args }) => {
    const r = await call("export_floor_plan", args);
    return save(r, path, r.format ?? "svg");
  },
);

tool(
  "export_glb",
  "Export all visible parts as a glTF binary file (.glb) for Blender, game engines and web viewers: one named node per part with its colour and material (metal, paint, plastic, rubber, glass), in metres with Y up as glTF requires, and the model's motion as an animation that loops. path defaults to ~/Downloads/<title>.glb. Only do this when the user asks.",
  { path: z.string().optional().describe("Absolute path, or relative to the home folder.") },
  async ({ path }) => save(await call("export_glb"), path, "glb"),
);

tool(
  "export_obj",
  "Export all visible parts as an OBJ file, one object per part with normals, in millimetres with Y up, and its colours and materials in an MTL file of the same name beside it. Parts are at rest, without motion. path defaults to ~/Downloads/<title>.obj. Only do this when the user asks.",
  { path: z.string().optional().describe("Absolute path, or relative to the home folder.") },
  async ({ path }) => {
    const r = await call("export_obj", { mtl: path ? basename(path) : "" });
    const { mtl_name, mtl_base64, ...rest } = r;
    const out = JSON.parse((await save(rest, path, "obj")).content[0].text);
    const mtlPath = join(dirname(out.path), mtl_name);
    await writeFile(mtlPath, Buffer.from(mtl_base64, "base64"));
    return json({ ...out, mtl_path: mtlPath });
  },
);

tool(
  "export_ply",
  "Export all visible parts as a binary PLY file: one mesh, each vertex coloured with its part's colour, in millimetres with Z up. Parts are at rest. path defaults to ~/Downloads/<title>.ply. Only do this when the user asks.",
  { path: z.string().optional().describe("Absolute path, or relative to the home folder.") },
  async ({ path }) => save(await call("export_ply"), path, "ply"),
);

// ---- the camera, pictures and video ----
const xyz = z.array(z.number()).length(3);
// A camera's fields, typed and described once, as set_camera's own arguments.
// Elsewhere a camera is a name or an object of these, which the app checks
// field by field (src/app/camera.js) and names the fields it takes when one
// is wrong; the tool list does not carry them five times over.
const CAMERA_FIELDS = {
  view: [z.string(), "Start from this: a saved view's name, a standard view (iso, low, top, bottom, front, back, right, left) or \"current\"."],
  azimuth: [z.number(), "Degrees round the model to look from: 0 front (from -Y), 90 right (+X), 180 back, 270 left."],
  elevation: [z.number(), "Degrees above the ground to look from: 0 level, 20-35 a usual product shot, 90 straight down; negative looks up from below."],
  from: [xyz, "The direction to look from, [x, y, z], instead of azimuth and elevation."],
  parts: [z.array(z.string()), "Frame these parts (default: the whole model)."],
  position: [xyz, "Where the camera stands, mm. With target, places it exactly."],
  target: [xyz, "The point it looks at, mm."],
  lens_mm: [z.number(), "Focal length of a 35 mm camera: 24 wide, 35-50 normal, 85-135 a close, flat-looking hero shot."],
  distance: [z.number(), "Times as far as the framing gives: 0.6 is closer (parts run off the edges), 1.5 leaves room."],
  fill: [z.number(), "How much of the picture the framed parts fill, 0.2-1; default 0.9."],
};
const CAMERA = z
  .union([z.string(), z.looseObject({})])
  .describe('A camera: a view\'s name (saved or standard) or "current", or an object of set_camera\'s arguments (view, from, azimuth, elevation, position, target, parts, lens_mm, distance, fill; no others).');

const images = (list) => list.map((jpeg) => ({ type: "image", data: jpeg, mimeType: "image/jpeg" }));

tool(
  "set_camera",
  "Place the user's view: it moves there smoothly. Returns where the camera ended up (position, target, lens, azimuth, elevation) and a picture from it. Use it for \"show me the swashplate from below\" or to set up a view the user wants to keep.",
  {
    ...Object.fromEntries(Object.entries(CAMERA_FIELDS).map(([k, [type, text]]) => [k, type.describe(text).optional()])),
    save_as: z.string().optional().describe("Keep this camera as a named view with the model (saved in its file), for save_picture, preview_shots and record_video."),
    forget: z.string().optional().describe("Remove this saved view."),
    width: z.number().int().optional().describe("Frame for a picture this wide, pixels (default the window's shape)."),
    height: z.number().int().optional().describe("Frame for a picture this tall, pixels."),
  },
  async (a) => {
    const { jpeg, ...rest } = await call("set_camera", a);
    return { content: [{ type: "text", text: JSON.stringify(rest, null, 1) }, ...(jpeg ? images([jpeg]) : [])] };
  },
);

tool(
  "save_picture",
  "Save a studio picture (PNG, light backdrop, shadows and the floor's reflection, no grid) from a camera, at a chosen size. It shows the model as the view does (hidden parts, a section, an exploded view, the crease shading). Look at the returned preview and try again if the framing is wrong; the reference has a recipe for a hero shot. path defaults to ~/Downloads/<title>.png. Only do this when the user asks for a picture.",
  {
    camera: CAMERA.optional(),
    width: z.number().int().min(64).max(8192).optional().describe("Default 1920."),
    height: z.number().int().min(64).max(8192).optional().describe("Default 1080."),
    at: z.number().min(0).optional().describe("Seconds into the motion to pose moving parts at; default as the view shows them now."),
    path: z.string().optional().describe("Absolute path, or relative to the home folder."),
  },
  async ({ path, ...a }) => {
    const { jpeg, ...r } = await call("save_picture", a);
    const saved = await save(r, path, "png");
    return { content: [...saved.content, ...images([jpeg])] };
  },
);

// A film's shots. preview_shots describes their fields; record_video takes the
// same shots and refers back to it.
const SHOT_FIELDS = {
  seconds: "How long the shot lasts.",
  move: "hold: still camera. turntable: one whole turn round the target (degrees 360), steady pace. orbit: turn by degrees (default 90), raising by rise. move: from camera to `to`. follow: keep `part` in frame as it moves. Default: move if `to` is given, follow if `part` is, else hold.",
  camera: "Where the shot starts: a camera, as save_picture takes (a view's name, or set_camera's arguments). Default: where the previous shot ended (the first shot: the user's current view).",
  to: 'For move: where it ends, a camera like camera (a view\'s name or set_camera\'s arguments); "current" here means the shot\'s start.',
  degrees: "For turntable and orbit: how far round, + anticlockwise seen from above.",
  rise: "For orbit: degrees to raise (or, negative, lower) the camera over the shot.",
  part: "For follow: the part to follow.",
  ride: "For follow: also turn with the part about the upright (ride along with a rotor blade), instead of only keeping it in view.",
  ease: "How the move speeds up and slows down. Default in-out for move and orbit, linear for turntable and follow.",
  motion: "Whether the model's motion plays in this shot; default yes when it has motion.",
  speed: "Motion speed, 1 = real time, 0.25 slow motion (for fast rotors).",
};
const shots = (described) => {
  const types = {
    seconds: z.number().positive(),
    move: z.enum(["hold", "turntable", "orbit", "move", "follow"]).optional(),
    camera: CAMERA.optional(),
    to: CAMERA.optional(),
    degrees: z.number().optional(),
    rise: z.number().optional(),
    part: z.string().optional(),
    ride: z.boolean().optional(),
    ease: z.enum(["linear", "in", "out", "in-out"]).optional(),
    motion: z.boolean().optional(),
    speed: z.number().optional(),
  };
  const fields = Object.fromEntries(Object.entries(types).map(([k, t]) => [k, described ? t.describe(SHOT_FIELDS[k]) : t]));
  return z
    .array(z.object(fields))
    .min(1)
    .max(50)
    .describe(described ? "The film's shots in order. A shot starts where the last one ended unless it names a camera, so moves join up smoothly." : "The film's shots, as for preview_shots.");
};

tool(
  "preview_shots",
  "Try a planned film without recording it: returns small pictures of the first, middle and last frame of each shot (at most 24), with the time in the film and in the motion. Use it before record_video and fix shots that frame badly. Plan a few shots of 2 to 6 s each, framed on part names from get_model; the reference says how to plan a film.",
  {
    shots: shots(true),
    width: z.number().int().optional().describe("The film's size, for its shape; default 1920."),
    height: z.number().int().optional().describe("Default 1080."),
    start_at: z.number().min(0).optional().describe("Seconds into the motion where the film starts; default 0. Motion time runs on from shot to shot."),
  },
  async (a) => {
    const { frames, ...rest } = await call("preview_shots", a, 10 * 60 * 1000);
    const content = [{ type: "text", text: JSON.stringify({ ...rest, frames: frames.map(({ jpeg, ...f }) => f) }, null, 1) }];
    for (const f of frames) content.push({ type: "text", text: `Shot ${f.shot}, ${f.at_seconds} s into the film:` }, ...images([f.jpeg]));
    return { content };
  },
);

tool(
  "record_video",
  "Record a video of the model from planned shots (try them first with preview_shots), frame by frame so it plays smoothly, and save it. MP4 (H.264) where the app can encode it, else WebM: the result's format says which, and so should your reply. The film shows the model as the view does (hidden parts, a section, an exploded view, edges), so call clear_view first for the whole model. The user sees a progress line and can cancel; then nothing is saved. Recording takes about a second per second of film, longer for big models, so keep films short unless asked. path defaults to ~/Downloads/<title>.mp4. Only do this when the user asks for a video. Returns the path, format, frames, seconds and pictures of the first, middle and last frame: check them.",
  {
    shots: shots(false),
    width: z.number().int().min(64).max(3840).optional().describe("Even number; default 1920."),
    height: z.number().int().min(64).max(3840).optional().describe("Even number; default 1080."),
    fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).optional().describe("Default 30."),
    format: z.enum(["mp4", "webm"]).optional().describe("Default mp4; webm only if the user asks."),
    start_at: z.number().min(0).optional().describe("Seconds into the motion where the film starts; default 0."),
    path: z.string().optional().describe("Absolute path, or relative to the home folder."),
  },
  async ({ path, ...a }) => {
    const r = await call("record_video", a, 60 * 60 * 1000);
    const ext = r.container;
    const base = (r.name || "model").replace(/[^\w.-]+/g, "-");
    let out = path ? resolve(homedir(), path.replace(/^~(?=\/|$)/, homedir())) : resolve(homedir(), "Downloads", `${base}.${ext}`);
    // The file is named for what it is, whatever extension was asked for.
    out = extname(out) ? out.slice(0, -extname(out).length) + `.${ext}` : `${out}.${ext}`;
    await mkdir(dirname(out), { recursive: true });
    // Written beside the real name first, so a failed save leaves no half file under it.
    const part = `${out}.part`;
    try {
      const pieces = [];
      for (let i = 0; i < r.pieces; i++) pieces.push(Buffer.from((await call("video_part", { id: r.id, index: i })).base64, "base64"));
      await writeFile(part, Buffer.concat(pieces));
      await rename(part, out);
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
    const { stills, id, pieces, name, ...facts } = r;
    const content = [{ type: "text", text: JSON.stringify({ path: out, ...facts }, null, 1) }];
    for (const s of stills) content.push({ type: "text", text: `Frame ${s.frame} (${s.at_seconds} s):` }, ...images([s.jpeg]));
    return { content };
  },
);

await listen();
await server.connect(new StdioServerTransport());
log("ready");
