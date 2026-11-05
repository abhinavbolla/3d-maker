// End-to-end check of the MCP server against a running app (npm run dev, open in a browser or npm run app).
// Run: node test/mcp.test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const client = new Client({ name: "3d-maker-test", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["mcp/server.mjs"], stderr: "inherit" }));
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].type === "text" ? JSON.parse(r.content[0].text) : r.content[0];
};

await call("new_scene");
const a = await call("add_shape", { kind: "box", params: { width: 40, depth: 30, height: 10 }, name: "Plate" });
const b = await call("add_shape", { kind: "cylinder", params: { radius: 5, height: 30 }, position: [0, 0, -5], name: "Hole" });
const cut = await call("boolean", { op: "subtract", ids: [a.id, b.id], name: "Plate with hole" });
assert.equal(cut.scene.objects.length, 1);
assert.ok(cut.scene.objects[0].volume_mm3 < 40 * 30 * 10);

// A broken edit is rejected and leaves the scene as it was.
const bad = await client.callTool({ name: "add_feature", arguments: { id: cut.id, feature: { type: "fillet", radius: 50 } } });
assert.ok(bad.isError, "oversized fillet should fail");
console.log("rejected as expected:", bad.content[0].text);
const after = await call("get_scene");
assert.equal(after.objects[0].features, undefined);

await call("add_feature", { id: cut.id, feature: { type: "fillet", radius: 2, edges: "vertical" } });
const img = await call("screenshot", { view: "iso", width: 512, height: 384 });
assert.equal(img.type, "image");
assert.ok(Buffer.from(img.data, "base64").subarray(1, 4).toString() === "PNG");

const out = join(tmpdir(), "3d-maker-test.stl");
const exp = await call("export_model", { format: "stl", path: out });
const stl = await readFile(exp.path);
assert.equal(stl.length, 84 + stl.readUInt32LE(80) * 50);
console.log(`ok: exported ${stl.readUInt32LE(80)} triangles to ${exp.path}`);
await rm(out);
await call("undo");
await client.close();
