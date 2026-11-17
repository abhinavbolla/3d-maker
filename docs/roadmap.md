# Roadmap

Draftsman's goal is an open-source CAD application that anyone can use by describing what they want, and that holds up next to professional tools such as Rhino: models that look right, drawings you can build from, and files other apps can open.

This page says where it stands against that goal and what comes next. The order within each section is the order we plan to work in.

## Where it stands

| What a CAD tool needs | Today |
|---|---|
| Making 3D models | By prompt, with sliders on parts. Outlines, extrude, revolve, sweep, loft, bodies from views, bend, twist, taper, threads and hardware. |
| Mechanisms | Motion, joints checked over the whole loop, collision checks. |
| Looking at the model | Studio view with shadows, a reflecting floor, shading in the creases and materials, and a "shaded with edges" look. Turn, slide and zoom as in other CAD programs, with a view cube, and the turning centre and the origin's axes and planes shown while you turn. |
| Pictures | PNG studio shots of any view, and from cameras Claude places, with a chosen lens and size. |
| 2D drawings | One sheet, A4 to A0, as SVG, PDF or DXF: front, top, side and isometric views, hidden edges left out or dashed, centre lines, a hatched section, a detail view, the overall sizes, hole diameters and positions, and an ISO title block. Single outlines at 1:1 as DXF or SVG. |
| Buildings | One storey by prompt: walls, doors, windows, rooms with their areas, slab, roof, stair. A floor plan sheet with door swings, room areas and dimension chains. |
| Files for other apps | STL, 3MF, OBJ, PLY, glTF with materials and motion, and STEP: exact solids for simple parts (primitives, extrusions and revolves of line-and-arc outlines), flat faces from the mesh for the rest. 2D: drawings as PDF and DXF, outlines at 1:1 as DXF and SVG. |
| Exact surfaces | In STEP files, for parts the script describes exactly without 3D cuts or joins. Elsewhere surfaces are fine meshes of distance fields. |
| Direct editing | Sliders and prompts. Hiding and isolating parts, sections, exploded views and measuring, by prompt. No dragging. |
| Video | MP4 films (WebM where H.264 is missing) from shots Claude plans: turntables, orbits, moves between saved views, following a part, with the crease shading and the view's hidden parts, section or exploded view. |
| Installing | Installers for macOS, Windows and Linux, built for each release, with our own icon. Not signed yet. |

## The look

A studio shot of a mechanism from a professional tool gets its look from four things: lighting, materials, crisp small edges, and framing. Lighting, materials and framing are in: Claude can place the camera, pick a lens and save a picture, so "give me a hero shot of the rotor head" works.

Done so far: shading in the creases (ambient occlusion, worked out once the view rests, so it costs nothing while anything moves), an optional "shaded with edges" look that Claude turns on by prompt, and brushed and anodised metal.

What is left:

3. **Small fillets and chamfers everywhere.** Real machined parts have a small break on every edge, and those edges catch the light. The kernel can round edges; what is missing is detail in the mesh where the surface curves tightly, so a 1 mm fillet on a 1 m part survives. This needs detail shared out by curvature, not only by surface area.
4. **Smoother metal.** Normals now come from the distance field, so small fillets and curves are shaded round and sharp edges stay crisp. What is left: finer view meshes on shiny parts, where the outline of a coarse mesh still shows its facets.
5. **Materials Claude chooses.** Parts can now be metal, brushed or anodised metal, paint, plastic, rubber or glass. Next: brushed metal with a grain that follows the part, textures such as tread and knurling, and decals.
6. **Surroundings.** Pictures and films have one studio backdrop. Other places to put a model: an outdoor sky and ground, and a darker studio.

## 2D drawings

A model is not finished for a workshop until it has drawings. Distance fields make some of this easier than it is for other kernels: a section through a part is an exact outline, with no surface-to-surface intersection to compute.

Done so far: an A3 sheet as SVG to ISO 5457 (frame, grid reference border, centring marks) with the front, top and side views in first or third angle (sharp edges and outlines, hidden edges left out), an isometric view, one section cut straight from the distance functions with its faces hatched per part, the overall width, depth and height, and an ISO 7200 title block that fills itself in and remembers what you tell it. Claude can export it, say where the section goes and fill in the title block. The same sheet comes as PDF (vector, real size) and as DXF (layers for each kind of line), on A4 to A0. Hidden edges can be dashed; holes and turned parts get centre lines; holes get their diameters and positions, from the script's own values or from circles fitted to a view; and a detail view can show a crowded place at a larger scale. One section or view's outline can be saved alone at 1:1 for cutting.

What is left:

1. **Views.** The lines where a small piece of a part meets a bigger piece of the same part, which the mesh has no edge for. Views drawn from the distance functions instead of the mesh, so curves are exact here too. Detail views drawn from a finer view instead of an enlarged one.
2. **Sections.** Planes at any angle, stepped and half sections, several sections on a sheet, and detail views.
3. **Dimensions.** Radii and angles, counterbore and countersink callouts, hole patterns on a pitch circle, chamfers, tolerances and surface finish.
4. **Sheets.** Several sheets, and a parts list with balloons.
5. **Drawings by prompt.** "Make a drawing of the bracket with a section through the holes": Claude choosing the views, the sections and what to dimension, and looking at the sheet it made.

## Buildings

Houses and floor plans, made the same way as everything else: you describe the building, Claude writes the script, the building is real solids in the view, and the floor plan comes out as a sheet an architect would recognise.

Done so far (first stage): one-storey buildings in the script language. Outer walls from the outside corners of a footprint, named by the way each side faces; inner walls along their centre lines, joined at corners, bends and T-junctions with no overlaps or gaps; doors (lining, leaf and handles, opening in, out or into a named room) and windows (frame, mullions, glazing and an outside sill) placed along a named wall; a floor slab; a gable or flat roof whose gable ends are part of the walls; a straight stair; and rooms named by a point inside, with their areas worked out from the walls. Each piece is an ordinary part, so the view, the exports and the fit check work on a house unchanged. The floor plan sheet (Export menu and `export_floor_plan`): walls cut from their distance functions at 1200 mm, doors with swings, windows, room names, areas and inside sizes, outside dimension chains, the roof's edge, a north arrow, a scale bar and the ISO title block.

What is left:

1. **More than one storey**: floors, a stair that arrives somewhere, and a plan per floor.
2. **Elevations and sections** of a building on their own sheets, with levels.
3. **Walls**: curved walls, walls of layers (block, insulation, render) drawn with their own hatching, and wall joins drawn as one material or two.
4. **Roofs**: hip roofs, roofs over outlines that are not rectangles, and fascia, gutters and tiles.
5. **The plan**: furniture and fittings (kitchen, bathroom), door and window tags with a schedule, a room too small for its name labelled from outside with a leader, grid lines, and a level for the floor.
6. **Rules**: room sizes, door widths and window areas checked against a building code the user names.
7. **Renderings**: a house that reads as a house in a picture, with materials for walls, roof and ground, glass you can see through, and daylight. Today the 3D building is plain walls and a roof.

## Files for other apps

Done so far: STL, 3MF, glTF (a named node per part, its colour and material, and the motion as an animation that loops), OBJ with an MTL of each part's colour and material, PLY coloured per vertex, and SVG and DXF of single outlines and sections at 1:1, for laser cutters and 2D CAD.

What is left:

1. **STEP.** This is the hard one, and the main thing that separates Draftsman from professional CAD. STEP files hold exact surfaces; our kernel holds distance fields. Done so far: STEP (AP214) with exact surfaces written straight from the script for boxes, cylinders, cones, spheres, tori, capsules, and extrusions and revolves of line-and-arc outlines with their holes, and a closed solid of flat faces from the mesh for every other part, as a named, coloured assembly. What is left: exact cuts and joins in 3D (a plate with a drilled hole, a shaft with a key), which need the solids intersected; fillets and rounded boxes; fitted surfaces for smooth blends, lofts and sweeps instead of flat faces. This will take a long time, and it is the largest open question on this page.
2. **Import.** Open an STL or a STEP file as a reference to build around.
3. **Checked in the programs people use.** FreeCAD opens our STEP samples as valid, closed solids in CI ([testing.md](testing.md)). The other files have not been opened in the programs they are meant for: glTF in Blender, DXF in a 2D CAD program, and STEP in Fusion and SolidWorks.
4. **A model as one HTML file** that anyone can open in a browser and turn, with no app.

## Working with the model directly

The prompt stays the main way to make things. These are for looking, checking and small adjustments, and they stay out of the way until you reach for them.

Done so far, by prompt: measuring (a part's size, volume, surface area, centre of mass and mass; the distance between two parts or two points), hiding and isolating parts, a section view with filled cut faces at any plane, and an exploded view that keeps sub-assemblies together. A line above the prompt box says what the view leaves out.

What is left:

1. **Measuring and cutting by hand.** Click two points for a distance, slide the cutting plane, and a thin dimension line in the view for the last measurement.
2. **A short list of the model's parts**, to hide and pick from.
3. **Move a part by dragging it**, with the change written back into the script.
4. **Reference pictures.** Drop in a photo or a blueprint for Claude to work from, shown behind the model for comparison.

## Video

Done so far: recording frame by frame (each frame's camera and motion come from its number, so the film is smooth however long a frame takes), MP4 with H.264 or WebM with VP9 or VP8 from our own file writers, camera moves (hold, turntable, orbit, moves between cameras or saved views, following a part), and shots Claude plans and previews by prompt.

What is left:

1. **Exploding and assembling** a model on camera.
2. **Sound, motion blur and titles.** Without motion blur a fast rotor strobes.
3. **A judge for films.** A fresh look at each film (framing, pace, what the frame cuts off) before it is handed over, the way the benchmark judges a model.

## Modelling depth

Rhino's strength is free-form curves and surfaces. To compete there:

1. **Fillets and chamfers on chosen edges**, with a radius that can change along the edge.
2. **Surfaces through curves**: sweeps along two rails, patches through a network of curves, and blends that stay smooth where surfaces meet.
3. **Sheet-metal and shell tools**: exact wall thickness, bends and flat patterns.
4. **Constraints** between parts ("this face sits on that one"), so assemblies update when a part changes.
5. **A parts list** with quantities and materials.
6. **Faster builds.** A helicopter takes minutes, and keeping thin walls whole made builds about 20% slower (39% on the helicopter's first view). First win that time back; then parts of a plan could be built side by side, and a model could appear piece by piece as Claude writes it.

## Realism

What limits how real a prompted model looks is mostly judgement, not geometry. Done so far: Claude writes down the real object's main sizes first, and compares flat side, top and front pictures of the model with the real thing.

What is left:

1. **A critic pass.** A fresh judge that looks at the finished model and asks whether it looks like the real thing, before Claude may call it done. Today Claude judges its own pictures.
2. **Proportion warnings**, reported the way the fit check reports overlaps: a strut too thin for its length, a wheel too small for the body.
3. **A size sheet.** Every main dimension written down with where it came from, and the model checked against it.

## The app

Done so far: installers for macOS, Windows and Linux, built by a release workflow and attached to a draft release, with our own icon; four examples on the empty window (a mug, a bolted bracket, a rotor head that moves and a helicopter) that open at once and suggest what to try next; and a Claude Code plugin that adds the MCP server and a skill in one step, with the way to add the server to other MCP clients.

What is left:

1. **Signed installers.** The workflow signs as soon as the certificates exist ([releasing.md](releasing.md)); then automatic updates.
2. **Settings**: units, theme, grid, and which Claude model to use.
3. **Touch and trackpad gestures** throughout.
4. **A first release**, and the plugin and the other clients tried for real. The Claude Code plugin has not been installed from the marketplace yet, and the setup written for Claude Desktop, Cursor and VS Code has not been tried.
5. **Building with no window open.** Claude Code makes a model and writes its files without the app running.
6. **Trying it in the browser** in one click, with the examples, sliders and exports working without Claude.
7. **A shorter Export menu.** It has grown to 13 entries, 16 for a building.
8. **Starter issues** taken from this page, for people who want to help.

## How we measure progress

Changes to what Claude makes are checked against the [benchmarks](benchmarks.md): eight complex moving objects scored by a judge, and CADPrompt scored against its ground-truth meshes. A change that claims to improve the look or the shapes should move those numbers.

The benchmarks last ran on 10 November 2026: 6.4 out of 10 on the eight objects, and 20 of CADPrompt's 200 parts. The mesher, the look and what Claude is told have all changed since, so the next run is due now, and after it all 200 CADPrompt parts.

Not measured yet:

1. **The desktop app.** Every automatic test runs the app in Chrome. Films, large saves and the newer exports have not been run in the desktop window, and no test drives it.
2. **A weak machine.** The app is meant to be light enough for a low-end computer, but GPU time and memory have been measured on one Apple silicon Mac only. Wanted: the same numbers on a 4 GB machine with built-in graphics, and then ways of drawing that keep a big model smooth there.
