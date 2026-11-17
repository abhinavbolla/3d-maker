// Bundles the MCP server (mcp/server.mjs and the packages it uses) into one
// file, dist-mcp/server.mjs. The installed desktop app carries it as a
// resource and starts it with the user's own Node, so it runs without this
// repository or its node_modules. `npm run build` makes it.
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "mcp/server.mjs",
    outDir: "dist-mcp",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    rollupOptions: { output: { entryFileNames: "server.mjs", codeSplitting: false } },
  },
  ssr: { noExternal: true, target: "node" },
  logLevel: "warn",
});
