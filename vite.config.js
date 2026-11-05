import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // Shown in the Connect Claude panel so the commands are copy-paste ready.
  define: {
    __MCP_SERVER_PATH__: JSON.stringify(`${root}mcp/server.mjs`),
    __NODE_PATH__: JSON.stringify(process.execPath),
  },
  server: { port: 5173, strictPort: true },
  clearScreen: false,
  worker: { format: "es" },
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
