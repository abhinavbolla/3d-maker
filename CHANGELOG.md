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
- A Claude Code plugin (`claude plugin marketplace add abhinavbolla/draftsman`, then
  `claude plugin install draftsman@draftsman`) that adds Draftsman's MCP server and a skill with
  the way to work in it, and how to add the server to Claude Desktop, Cursor, VS Code or any other
  MCP client, in `docs/using.md`. `AGENTS.md` gives contributors' coding agents the hard rules and
  what enforces each.
- `test/tools.test.mjs`, in `npm test`: rules for the MCP tool list (names, descriptions,
  arguments, enums, tools named in the text) and a ceiling on its size, which every client reads
  in every conversation.
- Plans for big models: Claude lists the sub-assemblies and their parts, then builds and checks
  them one step at a time, with progress shown above the prompt.
- Export as STL (each part its own shell), STL as one solid, and 3MF with named, coloured parts.
- Export as glTF (.glb) with a named node, colour and material per part and the motion as an
  animation; OBJ with an MTL; and binary PLY coloured per vertex. From the Export menu, and for
  Claude as `export_glb`, `export_obj` and `export_ply`.
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
- Drawings as PDF and DXF as well as SVG, from the Export menu or `export_drawing`. The PDF is
  vector, at the sheet's real size; the DXF has layers for visible and hidden edges, centre
  lines, section, hatching, dimensions and frame. Export > Outline, DXF saves one section alone
  at 1:1 for a laser cutter, with round holes as true circles (SVG too, and any view's outline).
- Drawings show centre lines of holes and turned parts, and on a drawing of a few parts every size needed to make them: the diameters and positions of holes and bosses, blind holes' depths, step heights and wall thicknesses. Sizes come from the script's own values (or from circles fitted to the view, with their accuracy). The section goes through the holes' axes. Drawing numbers begin with DFT-.
  Hidden edges can be drawn dashed, sheets come in A4 to A0, and a detail view shows a crowded
  place at a larger scale.
- Benchmarks: eight complex moving objects scored by a judge, and CADPrompt scored against its
  ground-truth meshes.
- Shading in the creases: once the view rests, the gaps between parts and inside corners are
  darkened, worked out once in three passes at one pixel per CSS pixel and faded in. Frames
  drawn while parts move or the view turns cost exactly what they did. Pictures and screenshots
  include it.
- A "shaded with edges" look: sharp edges as thin dark lines (prebuilt line geometry, no extra
  pass) and outlines once the view is still. Claude turns it on or off with the new `set_look`
  tool, and the app remembers it.
- Two more materials a script can name: `brushed` and `anodised` metal.
- `frame()` on the view draws one finished frame, crease shading included, synchronously, at
  the window's size or a given one.
- `node test/gpu-load.mjs` measures what the view really costs the GPU on a Mac with Apple
  silicon: GPU time per second and per frame, read from the driver, for a still model, a turning
  view and moving parts.
- STEP export (AP214). Export > STEP, or the `export_step` tool, saves an assembly of named,
  coloured solids in mm for other CAD programs. Boxes, cylinders, cones, spheres, tori, capsules,
  and extrusions and revolves of outlines made of lines and arcs (holes included) come out with
  exact planes, cylinders, cones, spheres and tori; every other part comes out as a closed solid of
  flat faces made from its mesh. `node test/check-step.mjs` checks a STEP file on its own.
- Examples on the empty window: a coffee mug, an angle bracket with bolts, a rotor head that
  moves and a helicopter. One click opens a ready model without Claude, with sliders, a clean
  undo history, and two prompts to try on it in the prompt box.
- Installers: a release workflow builds the desktop app for macOS (Apple silicon and Intel),
  Windows and Linux when a version tag is pushed and attaches them to a draft release. It signs
  when the certificates are added as secrets ([docs/releasing.md](docs/releasing.md)). The
  installed app carries its own MCP server and runs it with the user's Node.js; it says when
  Claude Code or Node.js is missing and where to get them.
- An app icon of our own.
- Looking inside and checking a model, by prompt: ask Claude to hide or isolate parts, cut the
  model open with a section (its cut faces filled, so solids look solid), or explode it, and a
  line above the prompt box says what the view leaves out (a click or Esc shows the whole model
  again). This is view state: exports, drawings and undo are not affected. Claude can also
  measure a part's size, volume, surface area, centre of mass and mass in a named material, the
  shortest distance between two parts, and the distance between two points, from the exact
  shapes. New tools: `hide_parts`, `section_view`, `explode_view`, `clear_view` and `measure`.
- A section's cut faces are hatched, the hatch turned the other way on the next part, as on a
  drawing. The crease shading treats a cut face as the flat face it is, and with edges on it gets
  an outline where it ends. Edge lines are cut by the section, hidden with their parts and move
  with the exploded view, and lines on the back of a part are no longer drawn.

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
- Thin walls no longer go missing from meshes. A 200 x 120 x 1 mm plate at a small budget used to
  mesh to nothing, because every grid point fell outside it; the mesher now finds walls hidden
  between grid points, meshes flat plates, discs and blades stretched through their thickness, and
  refines for thin tubes and shells. A wall too thin for any cell the budget allows is drawn a
  little more than a cell thick instead of in shreds.
- Export meshes no longer have edges shared by four triangles where a part repeats a piece onto
  itself (a centred bar in `radial(6)`) or has small pieces with the same box: the rotor head's
  mast now exports closed for slicers.
- Smoother metal. Small fillets and tight curves are shaded round instead of in facets, and sharp
  edges stay crisp: the view asks the distance function whether each fold in the mesh is a sharp
  edge or a curve, and takes its normals from it.
