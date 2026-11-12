# Architecture

3D Maker has three parts: the app (a web page, wrapped in a Tauri window for the desktop), an MCP
server that Claude Code talks to, and a geometry kernel that runs in web workers inside the app.

```
prompt box ──▶ your `claude -p` (Claude Code) ──stdio──▶ mcp/server.mjs ──WebSocket──▶ app
                                                                                       │
                     model script ──▶ kernel workers: run script, mesh parts ──▶ 3D view
```

## A prompt, end to end

1. You type in the prompt box. [src/app/claude.js](../src/app/claude.js) starts your own
   `claude -p` with this app's MCP server, only its tools allowed, and Bash, file and web tools
   turned off. The desktop app starts it from Rust ([src-tauri/src/lib.rs](../src-tauri/src/lib.rs));
   the browser version uses a small endpoint in the dev server ([vite.config.js](../vite.config.js)).
2. Claude reads the modelling language from the `reference` tool
   ([mcp/reference.mjs](../mcp/reference.mjs)), then calls tools such as `set_plan`, `set_model`,
   `edit_model`, `screenshot`, `check_fit` and `finish_step` ([mcp/server.mjs](../mcp/server.mjs)).
3. The MCP server forwards each call over a WebSocket on `127.0.0.1` to the window that started
   the run. Every window has its own id, so several windows can run at once.
   [src/app/bridge.js](../src/app/bridge.js) keeps a connection to every MCP server it finds, and
   [src/app/commands.js](../src/app/commands.js) answers the calls.
4. A new script goes to the kernel workers ([src/app/kernel.js](../src/app/kernel.js)), which run
   it and mesh its parts in parallel. Only parts that changed are meshed again. A quick preview
   shows first; a finer mesh follows in the background, and screenshots wait for it.
5. [src/app/viewport.js](../src/app/viewport.js) draws the parts with three.js in a studio (a
   key light with shadows, a floor with a faint reflection, and materials), plays their motion,
   and takes the screenshots Claude looks at. [src/app/navigate.js](../src/app/navigate.js)
   moves the camera the way CAD programs do, and
   [src/app/viewcube.js](../src/app/viewcube.js) draws the view cube.

## The model

A model is a short JavaScript script plus slider values ([src/app/store.js](../src/app/store.js)).
The script builds shapes and declares named parts, `param()` values for the sliders, motion and
joints. [src/kernel/script.js](../src/kernel/script.js) runs it and returns plain data: a JSON
shape tree for each part. Because the result is data, parts can be hashed, cached, sent to other
workers and meshed in parallel. A slider change re-runs the script, so nothing downstream breaks.

The modelling language is small: `sphere`, `capsule`, `revolve`, `union(..., smooth)`,
`.symmetric("y")`, `.radial(4)`, `part(...)`, `param(...)`. Motion is part of the script too: a
part can `follow` another or move by any function of time (`turn`, `slide`, `link` for rigid
rods, `where` to track a point on another part), and `joint` declares connections the app checks.
The full reference is what Claude reads: [mcp/reference.mjs](../mcp/reference.mjs).

## The kernel

Everything in [src/kernel](../src/kernel) is our own code with no dependencies.

| File | What it does |
|---|---|
| [sdf.js](../src/kernel/sdf.js) | Compiles a shape tree into a signed distance function `f(x, y, z)`: negative inside, positive outside. Joining, cutting, blending and hollowing are a line of math each, so they cannot fail. 2D profiles compile the same way. |
| [mesh.js](../src/kernel/mesh.js) | Turns a distance function into a closed triangle mesh: a coarse-to-fine search for cells near the surface, then dual contouring, which keeps sharp edges sharp. It adds detail where parts are thin, repairs pinched spots, and meshes flat parts with tapering edges (blades, wings, keels) stretched through their thickness. |
| [pieces.js](../src/kernel/pieces.js) | Splits a part made of a body plus small or thin pieces (bolts on a hub, spokes in a wheel), so each piece is meshed at a cell size that suits it. |
| [fit.js](../src/kernel/fit.js) | Finds where parts pass into each other, how deep and where, working on the distance functions directly: space is split into boxes and searched deepest overlap first. |
| [motion.js](../src/kernel/motion.js) | Poses as functions of time, parts that follow other parts, rigid links, and joints checked over the whole motion. |
| [hull.js](../src/kernel/hull.js) | 3D convex hulls, built one point at a time. |
| [font.js](../src/kernel/font.js) | A single-stroke font in the style of technical drawing lettering. |
| [threemf.js](../src/kernel/threemf.js) | 3MF export, including its own zip writer. |
| [worker.js](../src/kernel/worker.js) | The worker that runs scripts and meshes parts. |

More on the mesher and the fit checks:

- **Detail** is shared out by surface area, so a big part gets as much detail as a small one.
  The fine pass uses the real surface of the preview meshes, so a rotor spread over 16 m does not
  starve the fuselage.
- **Thin edges.** A flat part whose edges taper thinner than a cell (a rotor blade, a wing, a
  keel) is meshed stretched up to 8x through its thickness and squeezed back. Its trailing edge
  comes out straight instead of bitten, without filling its broad faces with cells.
- **Shading.** In the view, vertices are split along sharp edges, so each face is shaded flat to
  its edge instead of smearing into the next.
- **Fit checks** need no meshes. A box of space is settled as soon as the distances at its centre
  show it is wholly inside both parts or outside one.
- **Export** meshes every visible part at the same detail on all cores.

## Windows and the bridge

Each window has its own id. A Claude run started from a window drives only that window, even
with several windows or browser tabs open. The bridge listens on localhost and only accepts the
app itself, checked by WebSocket origin. [SECURITY.md](../SECURITY.md) has the details.

## Tests

[testing.md](testing.md) lists every test and what it covers, and [benchmarks.md](benchmarks.md)
has the benchmark results.
