#!/usr/bin/env node
// 3D Maker MCP server. Claude Code or Claude Desktop starts this over stdio;
// it forwards tool calls to the open 3D Maker app over a local WebSocket.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, extname } from "node:path";
import { KINDS } from "../src/model/schema.js";

const PORTS = Array.from({ length: 10 }, (_, i) => 7457 + i);
// Only the app itself may connect: the desktop app, or the dev server in a browser.
const ALLOWED_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:5173", "http://127.0.0.1:5173"]);
const CALL_TIMEOUT_MS = 60000;
const log = (...a) => console.error("[3d-maker]", ...a);

// ---- bridge to the app ----
let app = null; // most recently connected app socket
const pending = new Map();
let seq = 0;

async function listen() {
  for (const port of PORTS) {
    try {
      await new Promise((ok, fail) => {
        const wss = new WebSocketServer({
          host: "127.0.0.1",
          port,
          verifyClient: ({ origin }) => ALLOWED_ORIGINS.has(origin),
        });
        wss.once("listening", () => ok(wss));
        wss.once("error", fail);
        wss.on("connection", (ws) => {
          app = ws;
          log(`app connected on port ${port}`);
          ws.on("message", (raw) => {
            let msg;
            try {
              msg = JSON.parse(raw);
            } catch {
              return;
            }
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
      log(`bridge listening on 127.0.0.1:${port}`);
      return port;
    } catch {
      // Port taken (another Claude client runs its own copy); try the next one.
    }
  }
  throw new Error(`No free port in ${PORTS[0]}-${PORTS.at(-1)}`);
}

async function waitForApp(ms) {
  const end = Date.now() + ms;
  while (!app && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  return app;
}

async function call(method, params = {}) {
  // The app polls every few seconds, so give a freshly opened app a moment to find us.
  if (!(await waitForApp(7000)))
    throw new Error("The 3D Maker app is not open. Ask the user to start it (npm run app, or npm start for the browser version), then try again.");
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

// ---- tools ----
const vec3 = z.array(z.number()).length(3);
const edges = z.enum(["all", "top", "bottom", "vertical"]);
const feature = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fillet"), radius: z.number().positive(), edges: edges.optional() }),
  z.object({ type: z.literal("chamfer"), distance: z.number().positive(), edges: edges.optional() }),
  z.object({ type: z.literal("shell"), thickness: z.number().positive(), open: z.enum(["top", "bottom"]).optional() }),
]);

const kindHelp = Object.entries(KINDS)
  .map(([k, v]) => `- ${k}: ${v.about} params ${JSON.stringify(v.params)}`)
  .join("\n");

const INSTRUCTIONS = `3D Maker is a small CAD modeller with a real B-rep kernel (OpenCascade). You build models by calling these tools while the user watches the 3D view update live.

Conventions: millimetres, +Z is up, the ground plane is z=0, angles in degrees. Rotation [rx, ry, rz] is applied about the world X, then Y, then Z axes through the object's own origin, then the object is moved to position.

Shapes (local origin before position/rotation):
${kindHelp}

Features run on a shape in its local frame, before position/rotation, in list order:
- fillet {radius, edges}, chamfer {distance, edges}; edges = all | top | bottom | vertical (top/bottom = edges lying in the highest/lowest XY plane of the shape).
- shell {thickness, open: top|bottom}: hollows inward, removing the top or bottom face. A fillet before a shell needs a radius larger than the thickness.

Booleans: boolean(op, ids) combines top-level objects into one object; ids[0] is the target and the rest are tools (for subtract, the tools are cut away from the target). The inputs stay editable inside the boolean: update_shape works on any id, including ones nested in a boolean.

Edits that break the geometry are rejected and the scene stays as it was; read the error and adjust. Work in small steps, call screenshot (try views iso, front, top) to check your work, and give objects meaningful names.`;

const server = new McpServer({ name: "3d-maker", version: "0.1.0" }, { instructions: INSTRUCTIONS });

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

tool("get_scene", "Return every object with its id, parameters, transform, features, bounding box (mm) and volume.", {}, async () => json(await call("get_scene")));

tool(
  "add_shape",
  `Add a solid. kind is one of ${Object.keys(KINDS).join(", ")}. Unspecified params use defaults. Returns the new id and the scene.`,
  {
    kind: z.enum(Object.keys(KINDS)),
    params: z.record(z.string(), z.any()).optional().describe("Shape parameters, see the server instructions for each kind."),
    name: z.string().optional(),
    position: vec3.optional(),
    rotation: vec3.optional().describe("Degrees about world X, Y, Z."),
    scale: z.number().positive().optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    features: z.array(feature).optional(),
  },
  async (a) => json(await call("add_shape", a)),
);

tool(
  "update_shape",
  "Change any object, including one nested inside a boolean. params are merged into the existing params; features replaces the whole feature list.",
  {
    id: z.string(),
    params: z.record(z.string(), z.any()).optional(),
    name: z.string().optional(),
    position: vec3.optional(),
    rotation: vec3.optional(),
    scale: z.number().positive().optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    visible: z.boolean().optional(),
    features: z.array(feature).optional(),
    op: z.enum(["union", "subtract", "intersect"]).optional().describe("Booleans only."),
  },
  async (a) => json(await call("update_shape", a)),
);

tool("delete_shape", "Delete an object.", { id: z.string() }, async (a) => json(await call("delete_shape", a)));

tool(
  "boolean",
  "Combine top-level objects into one. ids[0] is the target; for subtract the other objects are cut from it.",
  { op: z.enum(["union", "subtract", "intersect"]), ids: z.array(z.string()).min(2), name: z.string().optional() },
  async (a) => json(await call("boolean", a)),
);

tool("split_boolean", "Undo a boolean structurally: its inputs become separate top-level objects again.", { id: z.string() }, async (a) => json(await call("split_boolean", a)));

tool("add_feature", "Append a fillet, chamfer or shell to an object.", { id: z.string(), feature }, async (a) => json(await call("add_feature", a)));

tool("duplicate", "Copy a top-level object, optionally moved by offset [dx, dy, dz].", { id: z.string(), offset: vec3.optional() }, async (a) => json(await call("duplicate", a)));

tool("undo", "Undo the last change (the user's or yours).", {}, async () => json(await call("undo")));
tool("redo", "Redo the last undone change.", {}, async () => json(await call("redo")));
tool("new_scene", "Clear the scene (undoable). Ask the user before clearing work they made.", {}, async () => json(await call("new_scene")));

tool(
  "screenshot",
  "Render the model and return a PNG so you can see it. view: iso, top, bottom, front, back, left, right, or omit to use the user's current camera.",
  {
    view: z.enum(["iso", "top", "bottom", "front", "back", "left", "right"]).optional(),
    width: z.number().int().min(256).max(2048).optional(),
    height: z.number().int().min(256).max(2048).optional(),
  },
  async (a) => {
    const { png } = await call("screenshot", a);
    return { content: [{ type: "image", data: png, mimeType: "image/png" }] };
  },
);

tool(
  "export_model",
  "Export visible objects (or just ids) to a file. STL is a mesh for 3D printing; STEP is an exact solid for other CAD tools. path defaults to ~/Downloads/<scene name>.<format>.",
  {
    format: z.enum(["stl", "step"]).optional(),
    path: z.string().optional().describe("Absolute path, or relative to the home folder."),
    ids: z.array(z.string()).optional(),
  },
  async ({ format = "stl", path, ids }) => {
    const r = await call("export_model", { format, ids });
    const base = (r.name || "model").replace(/[^\w.-]+/g, "-");
    let out = path ? resolve(homedir(), path.replace(/^~(?=\/|$)/, homedir())) : resolve(homedir(), "Downloads", `${base}.${format}`);
    if (!extname(out)) out += `.${format}`;
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, Buffer.from(r.base64, "base64"));
    return json({ path: out, format, bytes: r.bytes });
  },
);

await listen();
await server.connect(new StdioServerTransport());
log("ready");
