#!/usr/bin/env node
// 3D Maker MCP server. Claude Code (started by the app, or your own) or Claude
// Desktop runs this over stdio; it forwards tool calls to the open 3D Maker
// app over a local WebSocket.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { writeFile, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, extname } from "node:path";
import { REFERENCE } from "./reference.mjs";

const PORTS = Array.from({ length: 10 }, (_, i) => 7457 + i);
// Only the app itself may connect: the desktop app, or the dev server in a browser.
const TAURI_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);
const isAppOrigin = (o = "") => TAURI_ORIGINS.has(o) || /^http:\/\/(localhost|127\.0\.0\.1):51[78]\d$/.test(o);
const CALL_TIMEOUT_MS = 120000;
const log = (...a) => console.error("[3d-maker]", ...a);

// ---- bridge to the app ----
// When the app's own prompt box starts Claude, it passes its window id
// (--app <id>) so tool calls go to that window and no other, even with several
// 3D Maker windows or tabs open. Without --app (Claude Desktop, your own
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
  if (!(await waitForApp(8000))) throw new Error(APP_ID ? "The 3D Maker window that asked is no longer connected. Ask the user to try again." : "The 3D Maker app is not open. Ask the user to start it, then try again.");
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`3D Maker did not answer "${method}" within ${timeoutMs / 1000} s.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    app.send(JSON.stringify({ id, method, params }));
  });
}

// ---- the modelling language, as Claude sees it ----
// Claude Code cuts server instructions off at 4096 characters, so these are
// short and point to the reference tool (mcp/reference.mjs) for the rest.
const INSTRUCTIONS = `3D Maker turns a short JavaScript model script into solid 3D parts the user sees live in the app.

Before you write or change a script, call the reference tool once (unless you already have its text in this conversation): it is the whole modelling language (shapes, profiles, sweep and loft, holes and fasteners, parts, sliders, motion and joints) with examples, and how to work. Use only the functions it lists; do not guess names.

In short: units are millimetres, +Z is up, the ground is z = 0. Write the whole script with set_model, change part of it with edit_model, and look at it with screenshot. Big or mechanical models are planned with set_plan, built step by step with append_to_model, and each step is checked with finish_step. check_fit finds parts passing into each other, at rest and during the motion. For a picture or a film the user asks for, set_camera places the camera, save_picture saves a studio picture, and record_video records a video of planned shots (try them first with preview_shots). When done, answer in one or two short sentences; do not paste the script.`;

const server = new McpServer({ name: "3d-maker", version: "0.6.0" }, { instructions: INSTRUCTIONS });

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

tool("reference", "The full 3D Maker modelling language (every shape, profile, fastener, motion and joint function, with examples) and how to work. Call it once before writing your first script.", {}, async () => ({ content: [{ type: "text", text: REFERENCE }] }));

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
    const { png } = await call("screenshot", a);
    return { content: [{ type: "image", data: png, mimeType: "image/png" }] };
  },
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

// ---- the camera, pictures and video ----
const xyz = z.array(z.number()).length(3);
const CAMERA = z
  .union([
    z.string(),
    z.object({
      view: z.string().optional().describe('Start from this: a saved view\'s name, a standard view (iso, low, top, bottom, front, back, right, left) or "current".'),
      azimuth: z.number().optional().describe("Degrees round the model to look from: 0 front (from -Y), 90 right (+X), 180 back, 270 left."),
      elevation: z.number().optional().describe("Degrees above the ground to look from: 0 level, 20-35 a usual product shot, 90 straight down. Negative looks up from below."),
      from: xyz.optional().describe("The direction to look from, [x, y, z], instead of azimuth and elevation."),
      parts: z.array(z.string()).optional().describe("Frame these parts (default: the whole model)."),
      position: xyz.optional().describe("Where the camera stands, mm. With target, places it exactly."),
      target: xyz.optional().describe("The point it looks at, mm."),
      lens_mm: z.number().optional().describe("Focal length of a 35 mm camera: 24 wide, 35-50 normal, 85-135 a close, flat-looking hero shot."),
      distance: z.number().optional().describe("Times as far as the framing gives: 0.6 is closer (parts run off the edges), 1.5 leaves room."),
      fill: z.number().optional().describe("How much of the picture the framed parts fill, 0.2-1; default 0.9."),
    }),
  ])
  .describe('A camera: a saved view\'s name, a standard view\'s name, "current", or { view, azimuth, elevation, parts, lens_mm, distance, ... }. With azimuth/elevation/from/parts it is framed on the parts (or the whole model) from that direction.');

const images = (list) => list.map((jpeg) => ({ type: "image", data: jpeg, mimeType: "image/jpeg" }));

tool(
  "set_camera",
  "Place the user's view: it moves there smoothly. Returns where the camera ended up (position, target, lens, azimuth, elevation) and a picture from it. save_as keeps it as a named view with the model (saved in its file), for save_picture, preview_shots and record_video; forget removes a saved view. width and height: frame for a picture of that shape (default the window's). Use it for \"show me the swashplate from below\" or to set up a view the user wants to keep.",
  {
    view: z.string().optional(),
    azimuth: z.number().optional(),
    elevation: z.number().optional(),
    from: xyz.optional(),
    parts: z.array(z.string()).optional(),
    position: xyz.optional(),
    target: xyz.optional(),
    lens_mm: z.number().optional(),
    distance: z.number().optional(),
    fill: z.number().optional(),
    save_as: z.string().optional().describe("Keep this camera as a named view."),
    forget: z.string().optional().describe("Remove this saved view."),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
  },
  async (a) => {
    const { jpeg, ...rest } = await call("set_camera", a);
    return { content: [{ type: "text", text: JSON.stringify(rest, null, 1) }, ...(jpeg ? images([jpeg]) : [])] };
  },
);

tool(
  "save_picture",
  "Save a studio picture (PNG, light backdrop, shadows and the floor's reflection, no grid) from a camera, at a chosen size. For \"give me a hero shot of the rotor head\": a low camera (elevation 10-20), a longer lens (70-100 mm), framed on the parts that matter, a little off the side (azimuth 30-60). Look at the returned preview and try again if the framing is wrong. at: pose moving parts at that many seconds into the motion (default: as the view shows them now). path defaults to ~/Downloads/<title>.png. Only do this when the user asks for a picture.",
  {
    camera: CAMERA.optional(),
    width: z.number().int().min(64).max(8192).optional().describe("Default 1920."),
    height: z.number().int().min(64).max(8192).optional().describe("Default 1080."),
    at: z.number().min(0).optional(),
    path: z.string().optional().describe("Absolute path, or relative to the home folder."),
  },
  async ({ path, ...a }) => {
    const { jpeg, ...r } = await call("save_picture", a);
    const saved = await save(r, path, "png");
    return { content: [...saved.content, ...images([jpeg])] };
  },
);

const SHOTS = z
  .array(
    z.object({
      seconds: z.number().positive().describe("How long the shot lasts."),
      move: z.enum(["hold", "turntable", "orbit", "move", "follow"]).optional().describe("hold: still camera. turntable: one whole turn round the target (degrees 360), steady pace. orbit: turn by degrees (default 90), raising by rise. move: from camera to `to`. follow: keep `part` in frame as it moves. Default: move if `to` is given, follow if `part` is, else hold."),
      camera: CAMERA.optional().describe("Where the shot starts. Default: where the previous shot ended (the first shot: the user's current view)."),
      to: CAMERA.optional().describe('For move: where it ends. "current" here means the shot\'s start.'),
      degrees: z.number().optional().describe("For turntable and orbit: how far round, + anticlockwise seen from above."),
      rise: z.number().optional().describe("For orbit: degrees to raise (or, negative, lower) the camera over the shot."),
      part: z.string().optional().describe("For follow: the part to follow."),
      ride: z.boolean().optional().describe("For follow: also turn with the part about the upright (ride along with a rotor blade), instead of only keeping it in view."),
      ease: z.enum(["linear", "in", "out", "in-out"]).optional().describe("How the move speeds up and slows down. Default in-out for move and orbit, linear for turntable and follow."),
      motion: z.boolean().optional().describe("Whether the model's motion plays in this shot; default yes when it has motion."),
      speed: z.number().optional().describe("Motion speed, 1 = real time, 0.25 slow motion."),
    }),
  )
  .min(1)
  .max(50);

const SHOT_GUIDE =
  "Plan a film as a few shots, each one idea, 2 to 6 s long: an establishing shot of the whole model (a slow orbit, elevation 15-30), then moves in to the parts that matter (move, to: { parts: [...], lens_mm: 70 }), then a shot that shows the motion (follow a moving part, or hold while it plays). A shot starts where the last one ended unless it names a camera, so moves join up smoothly; ease in-out between holds, linear for turns. Slow motion (speed 0.25-0.5) makes fast rotors readable. Frame on part names from get_model. Motion time runs on from shot to shot (start_at sets where it starts).";

tool(
  "preview_shots",
  `Try a planned film without recording it: returns small pictures of the first, middle and last frame of each shot (at most 24), with the time in the film and in the motion. Use it before record_video and fix shots that frame badly. ${SHOT_GUIDE}`,
  {
    shots: SHOTS,
    width: z.number().int().optional().describe("The film's size, for its shape; default 1920."),
    height: z.number().int().optional().describe("Default 1080."),
    start_at: z.number().min(0).optional(),
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
  `Record a video of the model from planned shots, frame by frame, so it plays smoothly however long each frame takes, and save it. MP4 (H.264) where the app can encode it, else WebM (VP9 or VP8): the result says which (format), and so should your reply. The user sees a progress line and can cancel; then nothing is saved. Default 1920 x 1080 at 30 frames a second. Recording takes a while (about a second for each second of film, longer for big models), so keep films short unless asked. path defaults to ~/Downloads/<title>.mp4. Only do this when the user asks for a video. Returns the path, format, frames, seconds and pictures of the first, middle and last frame: check them. ${SHOT_GUIDE}`,
  {
    shots: SHOTS,
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
