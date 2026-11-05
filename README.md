# 3D Maker

Describe what you want to make, and Claude builds it as a 3D model you can 3D print. Click any part to tweak it with a few sliders, or select it and describe the change.

![A helicopter Claude made in 3D Maker](docs/helicopter.png)

It runs on the Claude Code you already have, on your own Claude plan. There is no API key and no AI bill.

## Run it

You need Node 20 or newer, and [Claude Code](https://claude.com/claude-code), installed and logged in (run `claude` once in a terminal). The desktop app also needs Rust and Xcode's command line tools.

```bash
npm install
npm run app        # desktop app
npm start          # or the same app in your browser, at http://localhost:5173
```

## Using it

- Type what you want in the box at the bottom and press Enter, for example "a desk lamp with a weighted base" or "a helicopter whose rotors spin". Claude writes the model, looks at it from a few angles, and fixes what looks wrong.
- Click a part to select it. Its sliders appear in the top-right corner, and the prompt box now talks about that part ("make this longer").
- Parts that spin or swing move in the view. Pause stops them.
- Drag to orbit, right-drag to pan, scroll to zoom, F to fit the view, Esc to deselect.
- ⌘Z / ⇧⌘Z undo and redo every change, Claude's included. ⌘S saves, ⌘O opens, ⌘E exports an STL. The model is also autosaved.

Export STL joins all visible parts into one closed solid, ready for a slicer.

## How it works

```
prompt box ──▶ your `claude -p` (Claude Code) ──stdio──▶ mcp/server.mjs ──WebSocket──▶ app
                                                                                       │
                     model script ──▶ kernel workers: run script, mesh parts ──▶ 3D view
```

- **Models are short scripts.** Claude writes JavaScript in a small modelling language (`sphere`, `capsule`, `revolve`, `union(..., smooth)`, `.symmetric("y")`, `.radial(4)`, `part(...)`, `param(...)`). The full reference is the instructions in [mcp/server.mjs](mcp/server.mjs). Sliders are `param()` values, so a tweak re-runs the script and nothing downstream breaks.
- **Our own geometry kernel** ([src/kernel](src/kernel)). Shapes are signed distance fields: a function that says how far any point is from the surface. Joining, cutting, blending and hollowing are a line of math each and cannot fail. The mesher refines coarse to fine near the surface, uses dual contouring so sharp edges stay sharp, adds detail where parts are thin, and repairs pinched spots, so every mesh is closed.
- **The prompt box** starts your own `claude -p` with this app's MCP server and only its tools allowed. The desktop app does this from Rust ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)); the browser version uses a small endpoint in the dev server ([vite.config.js](vite.config.js)). Follow-up prompts continue the same Claude conversation.
- The bridge only accepts the app itself (checked by WebSocket origin) on localhost.

You can also drive the app from Claude Code or Claude Desktop directly by adding the MCP server:

```bash
claude mcp add --scope user 3d-maker -- node /path/to/3d-maker/mcp/server.mjs
```

## Tests

```bash
node test/kernel.test.mjs              # volumes, sharp corners, 500+ random shapes all closed, scripts
node test/mcp.test.mjs                 # end to end over MCP; needs the app open
node test/check-stl.mjs model.stl      # checks an STL is well formed and closed
cd src-tauri && cargo test -- --include-ignored   # finds and runs your Claude Code
```

## Not done yet

- No exact CAD surfaces: export is STL only (no STEP), and curved surfaces are fine meshes rather than exact curves. This is the price of a kernel where nothing fails.
- Very fine detail on very large models (a 1 mm logo on a 10 m helicopter) is limited by mesh detail. The view uses lighter meshes than the export.
- No dragging parts around in the view; changes are sliders or prompts.
- Packaging: the app runs from this folder. It finds the MCP server and Node here, so there is no installer, no signing and no real icon yet.
- Running your own `claude -p` from an app is fine for your own use. Check Anthropic's terms before giving the app to others.

## Licenses

Our code has no license yet. Dependencies are MIT (three.js, MCP SDK, ws, zod, Vite, Tauri's JS packages) or MIT/Apache-2.0 (Tauri). One build-time-only dependency of Vite, lightningcss, is MPL-2.0; it is not shipped in the app.
