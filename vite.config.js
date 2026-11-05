import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));

// Dev only: lets the browser build run the user's own `claude` command, the
// same way the desktop app does from Rust.
function claudeEndpoint() {
  return {
    name: "claude-endpoint",
    configureServer(server) {
      server.middlewares.use("/api/claude", (req, res) => {
        const origin = req.headers.origin ?? "";
        if (req.method !== "POST" || !/^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin) || !String(req.headers["content-type"]).startsWith("application/json")) {
          res.statusCode = 403;
          return res.end("Forbidden");
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let args;
          try {
            ({ args } = JSON.parse(body));
            if (!Array.isArray(args) || args[0] !== "-p" || !args.every((a) => typeof a === "string")) throw new Error("bad args");
          } catch {
            res.statusCode = 400;
            return res.end("Bad request");
          }
          const cwd = join(tmpdir(), "3d-maker-claude");
          mkdirSync(cwd, { recursive: true });
          res.setHeader("content-type", "application/x-ndjson");
          const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
          let stderr = "";
          child.stdout.pipe(res, { end: false });
          child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
          child.on("error", (err) => (stderr += String(err.message)));
          child.on("close", (code) => res.end(`\n\u0000exit ${JSON.stringify({ code, stderr })}\n`));
          res.on("close", () => child.exitCode === null && child.kill());
        });
      });
    },
  };
}

export default defineConfig({
  define: {
    __MCP_SERVER_PATH__: JSON.stringify(`${root}mcp/server.mjs`),
    __NODE_PATH__: JSON.stringify(process.execPath),
  },
  plugins: [claudeEndpoint()],
  server: { port: 5173, strictPort: true },
  clearScreen: false,
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 1000 },
});
