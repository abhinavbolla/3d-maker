// Checks that a Claude run started from one window only drives that window,
// even when other 3D Maker windows are open and connected later.
// Usage: node test/bridge.test.mjs (needs neither the app nor Claude)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import assert from "node:assert/strict";

const server = new URL("../mcp/server.mjs", import.meta.url).pathname;

async function startServer(extraArgs) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [server, ...extraArgs], stderr: "pipe" });
  const port = new Promise((resolve) => {
    let err = "";
    transport.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/bridge listening on 127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
  });
  const client = new Client({ name: "bridge-test", version: "1" });
  await client.connect(transport);
  return { client, port: await port };
}

// A pretend app window: answers get_model with its own name.
function fakeWindow(port, window, seen) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "http://localhost:5173" });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", app: "3d-maker", version: 3, window }));
      setTimeout(() => resolve(ws), 150);
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      seen.push(`${window}:${msg.method}`);
      ws.send(JSON.stringify({ id: msg.id, result: { script: `script of ${window}` } }));
    });
    ws.on("close", (code) => seen.push(`${window}:closed ${code}`));
    ws.on("error", reject);
  });
}

const text = (r) => r.content[0].text;

// Paired run: window A started it, window B connects after A.
{
  const seen = [];
  const { client, port } = await startServer(["--app", "window-a"]);
  const a = await fakeWindow(port, "window-a", seen);
  const b = await fakeWindow(port, "window-b", seen);
  const r = await client.callTool({ name: "get_model", arguments: {} });
  assert.equal(r.isError, undefined, text(r));
  assert.match(text(r), /script of window-a/);
  assert.ok(seen.includes("window-b:closed 4001"), `window B should be turned away: ${seen}`);
  assert.ok(!seen.includes("window-b:get_model"), "window B must not receive calls");
  a.close();
  await new Promise((r) => setTimeout(r, 100));
  const gone = await client.callTool({ name: "get_model", arguments: {} });
  assert.equal(gone.isError, true);
  assert.match(text(gone), /window that asked is no longer connected/);
  b.close();
  await client.close();
  console.log("paired run: only the window that started it is driven");
}

// A hello from a page that is not the app is refused at the door.
{
  const { client, port } = await startServer(["--app", "window-a"]);
  const refused = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "http://evil.example" });
    ws.on("open", () => resolve(false));
    ws.on("error", () => resolve(true));
  });
  assert.ok(refused, "foreign origin must be refused");
  await client.close();
  console.log("other web pages cannot connect");
}
process.exit(0);
