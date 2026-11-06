#!/usr/bin/env node
// 3D Maker MCP server. Claude Code (started by the app, or your own) or Claude
// Desktop runs this over stdio; it forwards tool calls to the open 3D Maker
// app over a local WebSocket.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, extname } from "node:path";

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

async function call(method, params = {}) {
  if (!(await waitForApp(8000))) throw new Error(APP_ID ? "The 3D Maker window that asked is no longer connected. Ask the user to try again." : "The 3D Maker app is not open. Ask the user to start it, then try again.");
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`3D Maker did not answer "${method}" within ${CALL_TIMEOUT_MS / 1000} s.`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    app.send(JSON.stringify({ id, method, params }));
  });
}

// ---- the modelling language, as Claude sees it ----
const INSTRUCTIONS = `3D Maker turns a short JavaScript model script into solid 3D parts the user sees live. You write the whole script with set_model (or change part of it with edit_model), then look at it with screenshot and fix what looks wrong.

Units are millimetres, +Z is up, the ground is z = 0, angles are degrees. Model real objects at real size (a mug is about 95 mm tall, a car about 4500 mm long). Every shape is a solid; joins, cuts and blends never fail.

PRIMITIVES (all centred on the origin)
  box(x, y, z, round?)            round = edge radius, at most half the smallest side
  sphere(r)
  ellipsoid(rx, ry, rz)           good for bodies, fuselages, heads, pebbles
  cylinder(r, h, round?)          along Z
  cone(r1, r2, h)                 along Z; r1 at the bottom, r2 at the top; either may be 0
  torus(R, r)                     ring in the XY plane
  capsule([x,y,z], [x,y,z], r1, r2?)   rounded rod between two points, optionally tapered. Great for struts, limbs, booms, handles, legs
  tube([[x,y,z,r], ...], smooth?) rounded rods through several points with a radius at each point: pipes, cables, tails, skids
  extrude([[x,y], ...], h)        polygon in XY, extruded along Z (centred: from -h/2 to h/2)
  revolve([[r,z], ...])           closed profile of [radius, height] points spun around Z: vases, bottles, wheels, nose cones

COMBINING (smooth is an optional blend radius in mm; leave it out for a sharp join)
  union(a, b, ..., smooth?)       also a.add(b, ..., smooth?)
  subtract(a, b, ..., smooth?)    cut b, c, ... out of a; also a.cut(b, ...)
  intersect(a, b, ..., smooth?)   keep only the overlap; also a.common(b, ...)
  Arrays of shapes work anywhere a list of shapes is expected.

METHODS (each returns a new shape; chain them)
  .move(x, y, z)  .at(x, y, z)
  .rotate(rx, ry, rz)             about world X, then Y, then Z, through the origin, so rotate before you move
  .rotateX(d) .rotateY(d) .rotateZ(d)
  .scale(s) or .scale(sx, sy, sz)
  .offset(d)                      grow (d > 0) or shrink (d < 0) the surface by d
  .shell(t)                       hollow it, keeping a wall of thickness t inside the surface; cut an opening to see in
  .mirror("x")                    reflect across the plane x = 0 (or "y", "z")
  .symmetric("y")                 make it symmetric across y = 0, keeping the y >= 0 side. Model one side, then mirror it
  .radial(n, "z")                 n copies spaced evenly around the axis through the origin: blades, spokes, bolts
  .array(n, dx, dy, dz)           n copies, each moved one step further

PARTS, VALUES, MOTION
  part(name, shape, { color: "#rrggbb", spin: { axis, center, rpm }, swing: { axis, center, angle, seconds }, hidden })
    Every visible piece must be a part with a unique, plain name ("Main rotor", "Left door"). The user clicks parts to select and tweak them.
    spin rotates the part forever around the line through center along axis (rotors, wheels, fans). swing rocks it back and forth by ±angle (doors, pendulums, wings). Motion is only shown in the app, not exported.
  param(label, value, { min, max, step, part })
    Returns the number to use, and gives the user a slider. Always set part to the part it mainly affects, so the slider appears when they click that part. Add 1 to 3 sliders per important part for its main dimensions (length, width, count, angle). Keep labels short ("Length", "Blades").
  title("Name")                   names the model (used for the exported file)
  print(...values)                values to see in the tool result, for checking measurements

You can use normal JavaScript: const, functions, loops, Math. There is no import, file access or network.

EXAMPLE
  title("Desk lamp");
  const armLen = param("Arm length", 320, { min: 150, max: 500, part: "Arm" });
  const tilt = param("Tilt", 35, { min: 0, max: 80, part: "Arm" });
  part("Base", cylinder(80, 16, 6).at(0, 0, 8), { color: "#2f3338" });
  const top = [Math.sin(tilt * Math.PI / 180) * armLen, 0, 16 + Math.cos(tilt * Math.PI / 180) * armLen];
  part("Arm", capsule([0, 0, 16], top, 9), { color: "#9aa3ad" });
  const shade = cone(70, 25, 90).shell(2).cut(cylinder(68, 20).at(0, 0, -45)).rotateY(110).at(top[0] + 40, 0, top[2] - 20);
  part("Shade", shade, { color: "#b8483e" });

HOW TO WORK
- Small things (up to about 5 parts: a mug, a bracket, a lamp): write the whole script with one set_model call, then screenshot and fix.
- Anything bigger or mechanical (vehicles, machines, mechanisms, robots, a rotor head, an engine): build it with a plan, the way an engineer builds an assembly.
  1. Work out the real object first: its sub-assemblies, the real pieces in each (bolts, links, bearings, clamps, brackets) and their real dimensions.
  2. Call set_plan with 6 to 30 steps in build order, from the core outwards. Each step is one sub-assembly and lists the part names it will create, exactly as you will pass them to part(). Every part belongs to one step.
  3. Step 1: set_model with title(), the shared dimensions as constants at the top (and sliders for the main ones), and the first step's parts. Later steps: append_to_model with that step's code, reusing the constants so pieces line up.
  4. After each step call finish_step. It checks the step's parts exist and are solid and shows you just those parts against the rest. Look hard: fix anything floating, intersecting wrongly, mis-sized or crude with edit_model, then move on. Never skip finish_step, and finish every step.
  5. When all steps are done, screenshot the whole model from two or three views and fix what is still wrong.
- Model real pieces as separate named parts, not one blob: a hub, each clamp, each link, each damper. Detail is what makes it look real: bolts, fillets, lightening holes, chamfers, bearing races.
- For changes to an existing model, prefer edit_model. If the model has an unfinished plan (get_model shows plan), continue it.
- Build recognisable silhouettes from smooth blends of ellipsoids, capsules, tubes and revolves; add detail (windows, panels, bolts) with subtract and small shapes; use symmetric() for anything with left and right sides.
- After every change, call screenshot (try "iso", then "front", "top" or "right" as needed) and fix anything that looks wrong: parts floating apart, poking through each other, wrong proportions, missing pieces. A part listed as empty, or one much thinner than its detail_mm, needs to be thicker.
- If the user has selected a part, "this" and "it" mean that part.
- When done, answer in one or two short sentences: what you made or changed. Do not paste the script.`;

const server = new McpServer({ name: "3d-maker", version: "0.3.0" }, { instructions: INSTRUCTIONS });

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
  "Mark a plan step done after building it. Checks every part the step lists exists and has a surface (if not, it says what is missing and the step stays open), then returns those parts' sizes, the plan's progress and a picture of the step's parts with the rest of the model shown faintly. Look at the picture and fix problems before the next step.",
  { step: z.string().describe("The step's name, exactly as in set_plan") },
  async (a) => {
    const { png, ...rest } = await call("finish_step", a);
    return { content: [{ type: "text", text: JSON.stringify(rest, null, 1) }, { type: "image", data: png, mimeType: "image/png" }] };
  },
);

tool(
  "screenshot",
  "Render the model and return a PNG so you can see it. view: iso, top, bottom, front, back, left or right; omit it to use the user's current camera. part: frame just that part. parts: frame these parts and show the rest faintly.",
  {
    view: z.enum(["iso", "top", "bottom", "front", "back", "left", "right"]).optional(),
    part: z.string().optional(),
    parts: z.array(z.string()).optional(),
    width: z.number().int().min(256).max(2048).optional(),
    height: z.number().int().min(256).max(2048).optional(),
  },
  async (a) => {
    const { png } = await call("screenshot", a);
    return { content: [{ type: "image", data: png, mimeType: "image/png" }] };
  },
);

tool(
  "export_stl",
  "Export all visible parts as one closed STL mesh for 3D printing. path defaults to ~/Downloads/<title>.stl. Only do this when the user asks.",
  { path: z.string().optional().describe("Absolute path, or relative to the home folder.") },
  async ({ path }) => {
    const r = await call("export_stl");
    const base = (r.name || "model").replace(/[^\w.-]+/g, "-");
    let out = path ? resolve(homedir(), path.replace(/^~(?=\/|$)/, homedir())) : resolve(homedir(), "Downloads", `${base}.stl`);
    if (!extname(out)) out += ".stl";
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, Buffer.from(r.base64, "base64"));
    return json({ path: out, triangles: r.triangles, bytes: r.bytes });
  },
);

await listen();
await server.connect(new StdioServerTransport());
log("ready");
