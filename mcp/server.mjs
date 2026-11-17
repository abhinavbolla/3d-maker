#!/usr/bin/env node
// Draftsman MCP server. Claude Code (started by the app, or your own) or Claude
// Desktop runs this over stdio; it forwards tool calls to the open Draftsman
// app over a local WebSocket.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, extname, basename, join } from "node:path";
import { REFERENCE } from "./reference.mjs";

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

async function call(method, params = {}) {
  if (!(await waitForApp(8000))) throw new Error(APP_ID ? "The Draftsman window that asked is no longer connected. Ask the user to try again." : "The Draftsman app is not open. Ask the user to start it, then try again.");
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Draftsman did not answer "${method}" within ${CALL_TIMEOUT_MS / 1000} s.`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    app.send(JSON.stringify({ id, method, params }));
  });
}

// ---- the modelling language, as Claude sees it ----
// Claude Code cuts server instructions off at 4096 characters, so these are
// short and point to the reference tool (mcp/reference.mjs) for the rest.
const INSTRUCTIONS = `Draftsman turns a short JavaScript model script into solid 3D parts the user sees live in the app.

Before you write or change a script, call the reference tool once (unless you already have its text in this conversation): it is the whole modelling language (shapes, profiles, sweep and loft, holes and fasteners, parts, sliders, motion and joints) with examples, and how to work. Use only the functions it lists; do not guess names.

In short: units are millimetres, +Z is up, the ground is z = 0. Write the whole script with set_model, change part of it with edit_model, and look at it with screenshot. Big or mechanical models are planned with set_plan, built step by step with append_to_model, and each step is checked with finish_step. check_fit finds parts passing into each other, at rest and during the motion. When done, answer in one or two short sentences; do not paste the script.`;

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

tool("reference", "The full Draftsman modelling language (every shape, profile, fastener, motion and joint function, with examples) and how to work. Call it once before writing your first script.", {}, async () => ({ content: [{ type: "text", text: REFERENCE }] }));

tool("get_model", "Return the current model script, slider values, each part's size, bounds, volume and motion, the sliders, and which part the user has selected.", {}, async () => json(await call("get_model")));

tool(
  "set_model",
  "Replace the whole model script and rebuild. Returns each part's bounds, size and volume, or the script error (with a line number) if it failed, in which case the model is left unchanged.",
  { script: z.string().describe("The complete model script, in the language described in the server instructions.") },
  async (a) => json(await call("set_model", a)),
);

tool(
  "edit_model",
  "Replace one exact piece of the current script (old_text must appear exactly once) and rebuild. Use this for small changes.",
  { old_text: z.string(), new_text: z.string() },
  async (a) => json(await call("edit_model", a)),
);

tool(
  "set_plan",
  "Plan a big model as build steps before writing it. Each step is a sub-assembly and lists the exact part names it will create. The user sees the steps and your progress. Calling it again replaces the plan; steps with the same name and parts keep their done state.",
  {
    steps: z
      .array(z.object({ name: z.string().describe("Short name of the sub-assembly, e.g. \"Stationary swashplate\""), parts: z.array(z.string()).min(1).describe("Part names this step creates, exactly as passed to part()") }))
      .min(2)
      .max(40),
  },
  async (a) => json(await call("set_plan", a)),
);

tool(
  "append_to_model",
  "Add code to the end of the current script and rebuild: use it to add a plan step's parts. Constants and functions defined earlier in the script can be used. Returns the model summary, or the script error (the model is then left unchanged).",
  { code: z.string() },
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
  "Render the model and return a PNG so you can see it. at: pose moving parts at that many seconds into the motion. view: iso (in perspective), or top, bottom, front, back, left or right (flat and true to scale, like a drawing, filling the picture); omit it to use the user's current camera. part: frame just that part. parts: frame these parts and show the rest faintly.",
  {
    view: z.enum(["iso", "top", "bottom", "front", "back", "left", "right"]).optional(),
    part: z.string().optional(),
    parts: z.array(z.string()).optional(),
    at: z.number().min(0).optional().describe("Seconds into the motion loop to pose the model at; default 0 (rest)."),
    width: z.number().int().min(256).max(2048).optional(),
    height: z.number().int().min(256).max(2048).optional(),
  },
  async (a) => {
    const { png, view } = await call("screenshot", a);
    return { content: [{ type: "image", data: png, mimeType: "image/png" }, ...(view ? [{ type: "text", text: view }] : [])] };
  },
);

tool(
  "set_look",
  "Change how the view draws the model. edges: true for the \"shaded with edges\" look, where sharp edges and outlines are drawn as thin dark lines, as in engineering views; false for the plain shaded look (the default). The app remembers the choice. Pictures and screenshots use it too. Use it when the user asks to see edges or outlines, or to turn them off.",
  { edges: z.boolean().describe("Draw sharp edges and outlines as thin dark lines.") },
  async (a) => json(await call("set_look", a)),
);

// ---- looking inside and checking: view state, and measuring ----
const VIEW_NOTE = "This changes only the view and its pictures, not the model: exports, drawings, check_fit and measure are unaffected, and it is not in undo. The user sees one line by the prompt box saying what is in force, and can clear it with a click or Esc. Returns what the view now shows.";

tool(
  "hide_parts",
  `Hide parts in the view, or show them again, so you (and the user) can see what is behind or inside them. Hidden parts are not drawn, cast no shadow, cannot be clicked and are left out of screenshots, except parts a screenshot names in part or parts. hide: parts to hide. show: hidden parts to show again. only: show just these and hide all the others (isolate). all: true shows every part. ${VIEW_NOTE}`,
  {
    hide: z.array(z.string()).optional(),
    show: z.array(z.string()).optional(),
    only: z.array(z.string()).min(1).optional(),
    all: z.boolean().optional(),
  },
  async (a) => json(await call("hide_parts", a)),
);

tool(
  "section_view",
  `Cut the model open with a plane to look inside it: the part of the model on one side is taken away and the cut faces are filled, so solids look solid and hollows, holes and parts inside show. Use it to check an assembly's insides (a gearbox in its housing, a shaft through its bearings, wall thickness), then take a screenshot. Give axis (x, y or z: the plane stands square across it) and offset (mm along it; default the model's middle), and remove, the side taken away ("+" or "-"; default the side the iso view looks from, so an iso screenshot looks into the cut). Or give point and normal for a plane at any angle; normal points to the side taken away. uncut: parts left whole. off: true removes the section. Returns the parts cut and, for an axis, the view that looks straight into the cut. Moving parts move through the plane. ${VIEW_NOTE}`,
  {
    axis: z.enum(["x", "y", "z"]).optional(),
    offset: z.number().optional().describe("mm along axis"),
    remove: z.enum(["+", "-"]).optional().describe("The side of the plane taken away, along axis"),
    point: z.array(z.number()).length(3).optional().describe("A point on the plane, mm"),
    normal: z.array(z.number()).length(3).optional().describe("Square to the plane, pointing to the side taken away"),
    uncut: z.array(z.string()).optional().describe("Parts left whole"),
    off: z.boolean().optional(),
  },
  async (a) => json(await call("section_view", a)),
);

tool(
  "explode_view",
  `Move the parts apart in the view (an exploded view), to show how an assembly goes together or to see parts hidden by others. factor: 0 is assembled, 1 fully apart (each group moves away from the model's middle by as far again as it is from there). axis: move only along x, y or z (a stack such as a rotor head along its mast). together: "steps" keeps each plan step's parts together as a sub-assembly (the default when there is a plan), "parts" moves every part on its own. Parts are lifted so none goes below the floor. Works with hide_parts and section_view (each part keeps its cut). ${VIEW_NOTE}`,
  {
    factor: z.number().min(0).max(1).optional().describe("0 assembled to 1 fully apart; default 1"),
    axis: z.enum(["x", "y", "z"]).optional(),
    together: z.enum(["steps", "parts"]).optional(),
  },
  async (a) => json(await call("explode_view", a)),
);

tool("clear_view", "Show the whole model again: every part shown, no section, assembled. Use it when you have finished looking inside, unless the user asked for the view to stay that way.", {}, async () => json(await call("clear_view")));

tool(
  "measure",
  "Measure the model in numbers, from its exact shapes as the script places them (not moved by motion or the exploded view). part or parts: each one's size, bounds, volume, surface area and centre of mass, and with material (aluminium, steel, stainless steel, titanium, brass, copper, PLA, ABS, PETG, nylon, carbon fibre, oak and more) or density_g_cm3 its mass in grams; with several parts also their total and combined centre of mass. between: two part names, for the shortest distance between them and the nearest point on each (0 and overlap_mm if they pass into each other). points: two points [x, y, z] in mm, for the distance between them. Any of these can be asked together. Volume and centre of mass are good to about 0.1%, surface area to about 1%. Use it to answer questions about sizes, clearances and weight instead of judging from a picture.",
  {
    part: z.string().optional(),
    parts: z.array(z.string()).min(1).optional(),
    material: z.string().optional(),
    density_g_cm3: z.number().positive().optional(),
    between: z.array(z.string()).length(2).optional(),
    points: z.array(z.array(z.number()).length(3)).length(2).optional(),
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
  "Export all visible parts as a STEP file (AP214) for other CAD programs: an assembly of named, coloured solids in mm. Parts that are a box, cylinder, cone, sphere, torus, capsule, or an extrude or revolve of an outline of lines and arcs (holes in the outline included), moved, turned or mirrored, or several of these that do not touch, come out with exact surfaces; any part with a cut, join, smooth blend or other shape comes out as flat faces from its mesh. path defaults to ~/Downloads/<title>.step. Only do this when the user asks. Returns the path, exact_parts, faceted_parts and left_out (part names; left_out: too thin to mesh) and line; tell the user which parts are faceted or left out.",
  { path: z.string().optional().describe("Absolute path, or relative to the home folder.") },
  async ({ path }) => save(await call("export_step"), path, "step"),
);

tool(
  "export_drawing",
  "Export a 2D drawing of all visible parts as an SVG: an A3 sheet (ISO 5457) with the front, top and side views (hidden edges left out), an isometric view where there is room, a section A-A with its cut faces hatched, the overall width, depth and height in mm, and an ISO 7200 title block. The title is the model's title() (change that to change it); a long one continues in the supplementary title, and one too long for the block is shortened on the sheet with …. The app fills in the date of issue, the scale, the document type and a drawing number made once per model. The fields below are what the user tells you: pass only what they said in this conversation, never a name or company you guessed, and leave the rest out. The app remembers each value it is given (who draws, the owner and the projection for this user; the number, revision, supplementary title and tolerances with the model, saved in its file) and uses it on later drawings, except approved_by, which is never remembered. \"\" forgets a remembered value; for number, the app then makes a new one. A value longer than its limit is refused with a message; nothing is cut short. The section plane stands square across axis at offset mm along it; by default it cuts across the model's longest axis at its middle. Parts are drawn as the script places them, not posed by their motion. path defaults to ~/Downloads/<title>.svg. Only do this when the user asks. Returns the path, the scale, isometric_view (whether there was room for it), the section, sheet (each title block field: names that were remembered rather than given now show only as filled in) and line: one sentence on what went on the sheet and how to change it. Reply with the path and that line, nothing more.",
  {
    path: z.string().optional().describe("Absolute path, or relative to the home folder."),
    axis: z.enum(["x", "y", "z"]).optional().describe("The axis the section plane stands square across; default the model's longest."),
    offset: z.number().optional().describe("Where along that axis the plane cuts, in mm; default the middle of the model."),
    drawn_by: z.string().optional().describe('Created by, at most 20 characters: the person who drew it, as the user wrote it ("drawn by …", "my name is …").'),
    owner: z.string().optional().describe("Legal owner, at most 40 characters: the company or person who owns the drawing."),
    approved_by: z.string().optional().describe("Approved by, at most 20 characters: pass it only when the user names the approver for this drawing. It goes on this sheet only and is not remembered; without it the field is an empty line to sign."),
    number: z.string().optional().describe('Identification (drawing) number, at most 16 characters. Replaces the one the app made; "" goes back to a new one made by the app.'),
    revision: z.string().optional().describe("Revision index, at most 2 characters: A, B, C ... (I and O are not used)."),
    subtitle: z.string().optional().describe("Supplementary title, at most 50 characters: a line under the title."),
    tolerances: z.string().optional().describe('General tolerances note, at most 30 characters, such as "ISO 2768-m". Shown only when given.'),
    projection: z.enum(["first", "third", ""]).optional().describe('"first" (ISO, Europe and most of the world) or "third" angle (US, Canada, Japan). Default: from the region the user\'s system names, else first.'),
  },
  async ({ path, ...args }) => save(await call("export_drawing", args), path, "svg"),
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

await listen();
await server.connect(new StdioServerTransport());
log("ready");
