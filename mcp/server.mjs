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
// Claude Code cuts server instructions off at 4096 characters, so these are
// short and point to the reference tool (mcp/reference.mjs) for the rest.
const INSTRUCTIONS = `3D Maker turns a short JavaScript model script into solid 3D parts the user sees live in the app.

Before you write or change a script, call the reference tool once (unless you already have its text in this conversation): it is the whole modelling language (shapes, profiles, sweep and loft, holes and fasteners, parts, sliders, motion and joints) with examples, and how to work. Use only the functions it lists; do not guess names.

In short: units are millimetres, +Z is up, the ground is z = 0. Write the whole script with set_model, change part of it with edit_model, and look at it with screenshot. Big or mechanical models are planned with set_plan, built step by step with append_to_model, and each step is checked with finish_step. check_fit finds parts passing into each other, at rest and during the motion. When done, answer in one or two short sentences; do not paste the script.`;

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
  "Export a 2D drawing of all visible parts as an SVG: an A3 sheet with the front, top and side views (first-angle projection, hidden edges left out), a section A-A with its cut faces hatched, the overall width, depth and height in mm, and a title block with the model's title, the scale and the date. The section plane stands square across axis at offset mm along it; by default it cuts across the model's longest axis at its middle. Returns the path, the scale chosen (such as 1:5) and which parts the section cuts. Parts are drawn as the script places them, not posed by their motion. path defaults to ~/Downloads/<title>.svg. Only do this when the user asks.",
  {
    path: z.string().optional().describe("Absolute path, or relative to the home folder."),
    axis: z.enum(["x", "y", "z"]).optional().describe("The axis the section plane stands square across; default the model's longest."),
    offset: z.number().optional().describe("Where along that axis the plane cuts, in mm; default the middle of the model."),
  },
  async ({ path, axis, offset }) => save(await call("export_drawing", { axis, offset }), path, "svg"),
);

await listen();
await server.connect(new StdioServerTransport());
log("ready");
