# Architecture

Draftsman has three parts: the app (a web page, wrapped in a Tauri window for the desktop), an MCP
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
   An installed app runs its own copy of the MCP server, bundled into one file by
   [vite.mcp.config.js](../vite.mcp.config.js), with the user's Node.js.
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
   and takes the screenshots Claude looks at. It draws a frame only when something changes, and
   motion at up to 60 frames a second (30 while the window is not focused, none while it is
   hidden). The shadow and the floor's reflection are drawn before the view, from a lighter copy
   of each part that the kernel workers make with its mesh; pictures and screenshots use the
   full meshes. [src/app/look.js](../src/app/look.js) adds shading in the creases
   ([creases.js](../src/app/creases.js)), worked out once when the view rests and laid over the
   canvas, and the optional edge lines ([edges.js](../src/app/edges.js)), prebuilt per mesh.
   [src/app/navigate.js](../src/app/navigate.js)
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
| [gltf.js](../src/kernel/gltf.js) | glTF binary (.glb) export: a node, mesh and PBR material per part, turned into metres with Y up, and the sampled motion as an animation. |
| [htmlfile.js](../src/kernel/htmlfile.js) | One self-contained HTML file: the parts' meshes packed in base64 (positions in 16-bit steps across the model's box, normals in bytes), their looks and poses, and a small WebGL viewer of our own. Nothing in it reaches the network. |
| [obj.js](../src/kernel/obj.js), [ply.js](../src/kernel/ply.js) | OBJ with its MTL, and binary PLY coloured per vertex. |
| [step.js](../src/kernel/step.js) | STEP export (AP214): an assembly of named, coloured solids. [brep.js](../src/kernel/brep.js) builds exact solids from shape trees that say exactly what a shape is, from outlines of lines and arcs ([outline2.js](../src/kernel/outline2.js)); [facets.js](../src/kernel/facets.js) turns any other part's mesh into a solid of flat faces. |
| [drawing.js](../src/kernel/drawing.js) | 2D drawings: line views with hidden edges removed, sections, overall dimensions, and the drawing sheet as SVG. |
| [worker.js](../src/kernel/worker.js) | The worker that runs scripts and meshes parts. |

More on the mesher and the fit checks:

- **Detail** is shared out by surface area, so a big part gets as much detail as a small one.
  The fine pass uses the real surface of the preview meshes, so a rotor spread over 16 m does not
  starve the fuselage.
- **Thin walls.** A wall thinner than a cell can fall between the grid points, so the search also tests cell edges: where the empty spheres around an edge's two ends (radius: their distance) do not cover it, the edge is split and its middle tested. A part with walls hidden this way is refined, or meshed stretched if it is flat; if no cell the budget allows can hold the wall, its surface is moved out until the wall is a little more than a cell thick, so it is drawn whole.
- **Thin edges.** A flat part whose edges taper thinner than a cell (a rotor blade, a wing, a
  keel) is meshed stretched up to 8x through its thickness and squeezed back. Its trailing edge
  comes out straight instead of bitten, without filling its broad faces with cells.
- **Shading.** In the view, vertices are split along sharp edges, so each face is shaded flat to
  its edge instead of smearing into the next. Whether a fold between two triangles is a sharp edge
  or a tight curve is asked of the distance function: its normal is followed from one triangle,
  past the edge, to the next; over a fillet it turns all the way, over a sharp edge all at once.
  The normals come from the distance function too, so a fillet only a cell or two across is
  shaded round, and the face beside a sharp edge has its own normal right up to the edge.
- **Fit checks** need no meshes. A box of space is settled as soon as the distances at its centre
  show it is wholly inside both parts or outside one.
- **Export** meshes every visible part at the same detail on all cores.
- **Drawings** come from two sources. A view is drawn from the export meshes: sharp edges and outlines are kept, and the distance function decides which mesh edges are real creases (a coarse mesh of a round surface has edges too). Hidden edges go by depth: every triangle is drawn into a depth picture 3200 pixels across, and each edge is tested against it just inside the face it borders. A section is not drawn from the mesh at all: each part's distance function is sampled on the cutting plane, coarse to fine, and contoured there, with corners put back where two sides meet. So a cut face is exact, where other kernels have to intersect surfaces. The three views and the section each run on their own worker.

## Windows and the bridge

Each window has its own id. A Claude run started from a window drives only that window, even
with several windows or browser tabs open. The bridge listens on localhost and only accepts the
app itself, checked by WebSocket origin. [SECURITY.md](../SECURITY.md) has the details.

## With no window open

When no window is connected, the MCP server keeps a model of its own
([mcp/headless.mjs](../mcp/headless.mjs)): the app's own store, commands and kernel pool
([store.js](../src/app/store.js), [commands.js](../src/app/commands.js),
[kernel.js](../src/app/kernel.js)), with no view, no autosave and no fine pass. Each kernel
worker is a separate Node process: [mcp/kernel-process.mjs](../mcp/kernel-process.mjs) running
[src/kernel/worker.js](../src/kernel/worker.js) over the process's IPC channel (bundled, the
server's own file started with `--draftsman-kernel`, so the one file the desktop app carries
works the same). A model script is code, and here it would otherwise run as the user, so the
processes run inside a boundary: Node's permission model (reads only of the kernel's code, no
writes, processes, threads, add-ons or inspector), an empty environment, and on macOS the system
sandbox, for the network, which Node's model covers only from Node 25. Where there is nothing to
keep a script off the network, building without a window is refused. [SECURITY.md](../SECURITY.md)
says exactly what is and is not covered. So `set_model`, `measure`, `check_fit` and every export
give what the app gives for the same script; tools that draw answer that they need the app.

Measured on the bracket (test/models/bracket.js), main thread / worker threads / sandboxed
processes (two runs): set_model 852 / 706 / 757–847 ms the first time and 779 / 627 /
618–640 ms after a change; STL export 3.0 / 2.8 / 2.8–2.9 s; drawing 4.6 / 3.1 / 3.1–3.2 s.
Starting the processes adds up to about 140 ms to the first call. Separate processes also keep
the server answering while a part meshes.

Calls wait for a window only in the 8 s after the bridge starts (an open window finds a new server
within about 5 s) or after a window goes away (it may be reloading); otherwise they go to the
server's model at once, and to a window as soon as one says hello. A run the app started
(`--app`) never uses the server's model. A window keeps its own model: when one connects, the
server's model is dropped, not pushed into the window or its autosave.

## Tests

[testing.md](testing.md) lists every test and what it covers, and [benchmarks.md](benchmarks.md)
has the benchmark results.
