# Changelog

Notable changes to Draftsman. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions will follow
[Semantic Versioning](https://semver.org). There are no releases yet.

## [Unreleased]

### Added

- A prompt box that runs your own Claude Code with Draftsman's MCP server, and follow-up prompts
  that continue the same conversation. A desktop app (Tauri) and the same app in a browser.
- Click a part to get its sliders and talk to it from the prompt box. Undo and redo for every
  change, Claude's included, and autosave.
- Our own signed-distance-field kernel: primitives, smooth unions, cuts, shells, symmetry and
  patterns; 2D profiles with arcs, splines and airfoil sections, extruded, revolved, swept and
  lofted; bodies from side and top outlines with rounded cross-sections; bend, twist and taper;
  lattice infill; convex hulls; single-stroke text.
- ISO metric threads, bolts, nuts, washers and matching holes, and draft for moulded parts.
- A mesher that refines coarse to fine near the surface and uses dual contouring, so edges stay
  sharp and every mesh is closed. Small and thin pieces of a part get their own detail, and flat
  parts with tapering edges are meshed stretched through their thickness.
- Motion and mechanisms: parts that turn, slide, follow and link, joints checked over the whole
  motion, and fit checks that find parts passing into each other at rest and in motion.
- Plans for big models: Claude lists the sub-assemblies and their parts, then builds and checks
  them one step at a time, with progress shown above the prompt.
- Export as STL (each part its own shell), STL as one solid, and 3MF with named, coloured parts.
- A studio view: a key light that casts shadows, a floor with a soft shadow and a faint
  reflection, and parts drawn as metal, paint, plastic, rubber or glass. Scripts can name a
  part's material.
- Moving around the model the way other CAD programs do it: drag to turn the view around its
  centre with the model kept upright, right-drag or shift-drag to slide it, and scroll or pinch
  towards whatever the pointer is on. On a trackpad two fingers slide the view. Double-click a
  point to make it the centre.
- A view cube that turns with the model, with the X, Y and Z axes drawn from its corner. Click a
  side, an edge or a corner to look from there; drag it to turn the view.
- While you turn the view, a ring marks the centre it turns around, and the origin's axes and
  its three planes show. The X and Y axes are drawn on the ground grid.
- Export > Picture saves the view as a studio shot (PNG).
- 2D drawings. Export > Drawing saves an A3 sheet as SVG: the front, top and side views in
  first-angle projection with hidden edges left out, a section A–A with its cut faces hatched
  and its cutting line marked on a view, the overall width, depth and height in millimetres, and
  a title block with the model's title, a standard scale and the date. The section is cut from
  the exact shapes, not from the mesh. Claude can export one with the new `export_drawing` tool
  and say where the section goes.
- The drawing sheet follows ISO 5457 and ISO 7200: a full title block that fills itself in and
  remembers what you tell Claude, an isometric view, a grid border and heavier lines.
- Benchmarks: eight complex moving objects scored by a judge, and CADPrompt scored against its
  ground-truth meshes.
- `node test/gpu-load.mjs` measures what the view really costs the GPU on a Mac with Apple
  silicon: GPU time per second and per frame, read from the driver, for a still model, a turning
  view and moving parts.
- Video. Export > Video (turntable) records one turn round the model with its motion playing,
  and Claude can direct a film from shots (hold, turntable, orbit, a move between two cameras
  or saved views, following a part) with the new `preview_shots` and `record_video` tools.
  Each frame's camera and motion come from its number, so the film is smooth however slowly
  frames draw. The file is H.264 in MP4, or VP9 or VP8 in WebM where the browser has no H.264
  encoder, written by our own code with the browser's WebCodecs encoder. A line shows the
  progress, with Cancel.
- A camera Claude can direct: `set_camera` places the view (a direction, a position and a
  target, or framed on chosen parts) with a lens in millimetres, and keeps named views with
  the model; `save_picture` saves a studio picture from any camera at any size.

### Changed

- The project is now called Draftsman; it was formerly 3D Maker. The MCP server and its tools are
  named `draftsman`, formerly `3d-maker`, so re-add the server if you registered it yourself
  (see [docs/using.md](docs/using.md)). A model autosaved under the old name still opens.
- The view uses much less GPU: motion plays at up to 60 frames a second (30 while you work in
  another window, none while the window is hidden), the shadow map is kept while only the view
  moves, the floor's reflection draws an eighth of the samples on a Retina screen, and app updates
  that leave the view as it was no longer redraw it. Pictures and screenshots are unchanged.
- The view's shadow and floor reflection cost the GPU much less. Both are drawn before the view
  instead of in the middle of it, from a lighter copy of each part with about a ninth of its
  triangles. Pictures and screenshots still use the full meshes.

### Fixed

- Parts that spin fast about an axis away from the origin stay on it in the view. Between the
  motion's samples a part used to move its position and its turn apart, which put the
  helicopter's 1200 rpm tail rotor up to 3.2 m off its axis; it now turns about the axis itself.
  Recorded videos pose every frame from the motion at exactly that frame's time.
