// End-to-end over MCP, against the open app (npm run app, or npm start):
// loads a model script, checks a bad script is rejected, takes screenshots
// and exports an STL. Usage: node test/mcp.test.mjs [model.js] [outDir]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const modelFile = process.argv[2] ?? new URL("./models/helicopter.js", import.meta.url).pathname;
const out = process.argv[3] ?? tmpdir();
const client = new Client({ name: "3d-maker-test", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("../mcp/server.mjs", import.meta.url).pathname] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: r.isError ? r.content[0].text : null, data: r.content[0].type === "text" && !r.isError ? JSON.parse(r.content[0].text) : null, raw: r };
};

const before = await call("get_model");
const t0 = Date.now();
const set = await call("set_model", { script: readFileSync(modelFile, "utf8") });
assert.equal(set.error, null, set.error);
console.log(`set_model: ${set.data.parts.length} parts in ${Date.now() - t0} ms, overall ${set.data.overall.size.join(" x ")} mm`);
for (const p of set.data.parts) console.log(`  ${p.name}: ${p.size?.join(" x ") ?? p.empty}`);

const bad = await call("edit_model", { old_text: 'title("', new_text: 'nope(); title("' });
assert.match(bad.error, /Line \d+: nope is not defined/);
assert.match(bad.error, /not changed/);
console.log("bad script rejected:", bad.error.split("\n")[0]);

for (const view of ["iso", "front", "top"]) {
  const s = await call("screenshot", { view, width: 1024, height: 640 });
  assert.equal(s.raw.content[0].type, "image");
  writeFileSync(join(out, `shot-${view}.png`), Buffer.from(s.raw.content[0].data, "base64"));
}
console.log("screenshots in", out);

const t1 = Date.now();
const exp = await call("export_stl", { path: join(out, "model.stl") });
assert.equal(exp.error, null, exp.error);
console.log(`export_stl: ${exp.data.triangles} triangles in ${Date.now() - t1} ms -> ${exp.data.path}`);
if (!before.data?.script) console.log("(the app had no model before)");
await client.close();
