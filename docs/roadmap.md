# Roadmap

Draftsman's goal is an open-source CAD application that anyone can use by describing what they want, and that holds up next to professional tools such as Rhino: models that look right, drawings you can build from, and files other apps can open.

This page says where it stands against that goal and what comes next. The order within each section is the order we plan to work in.

## Where it stands

| What a CAD tool needs | Today |
|---|---|
| Making 3D models | By prompt, with sliders on parts. Outlines, extrude, revolve, sweep, loft, bodies from views, bend, twist, taper, threads and hardware. |
| Mechanisms | Motion, joints checked over the whole loop, collision checks. |
| Looking at the model | Studio view with shadows, a reflecting floor and materials. Turn, slide and zoom as in other CAD programs, with a view cube, and the turning centre and the origin's axes and planes shown while you turn. |
| Pictures | PNG studio shots of any view. |
| 2D drawings | One sheet, A4 to A0, as SVG, PDF or DXF: front, top, side and isometric views, hidden edges left out or dashed, centre lines, a hatched section, a detail view, the overall sizes, hole diameters and positions, and an ISO title block. Single outlines at 1:1 as DXF or SVG. |
| Buildings | One storey by prompt: walls, doors, windows, rooms with their areas, slab, roof, stair. A floor plan sheet with door swings, room areas and dimension chains. |
| Files for other apps | STL, 3MF, OBJ, PLY, glTF with materials and motion, and STEP: exact solids for simple parts (primitives, extrusions and revolves of line-and-arc outlines), flat faces from the mesh for the rest. 2D: drawings as PDF and DXF, outlines at 1:1 as DXF and SVG. |
| Exact surfaces | In STEP files, for parts the script describes exactly without 3D cuts or joins. Elsewhere surfaces are fine meshes of distance fields. |
| Direct editing | Sliders and prompts. Hiding and isolating parts, sections, exploded views and measuring, by prompt. No dragging. |
| Video | Motion plays in the view. Nothing is recorded. |
| Installing | Installers for macOS, Windows and Linux, built for each release, with our own icon. Not signed yet. |

## The look

A studio shot of a mechanism from a professional tool gets its look from four things: lighting, materials, crisp small edges, and framing. The first two are in. What is left:

1. **Shading in the creases.** Ambient occlusion darkens the gaps between parts and the inside of corners. It is what makes an assembly read as many parts fitted together.
2. **Edge lines.** An optional "shaded with edges" look, where sharp edges and outlines are drawn as thin dark lines, as in engineering views.
3. **Small fillets and chamfers everywhere.** Real machined parts have a small break on every edge, and those edges catch the light. The kernel can round edges; what is missing is detail in the mesh where the surface curves tightly, so a 1 mm fillet on a 1 m part survives. This needs detail shared out by curvature, not only by surface area.
4. **Smoother metal.** Normals now come from the distance field, so small fillets and curves are shaded round and sharp edges stay crisp. What is left: finer view meshes on shiny parts, where the outline of a coarse mesh still shows its facets.
5. **Materials Claude chooses.** Parts can now be metal, paint, plastic, rubber or glass. Next: brushed and anodised metals, textures such as tread and knurling, and decals.
6. **A camera Claude can direct.** Tools for Claude to place the camera, pick a lens and save a picture, so "give me a hero shot of the rotor head" works.

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

## Files for other apps

Done so far: STL, 3MF, glTF (a named node per part, its colour and material, and the motion as an animation that loops), OBJ with an MTL of each part's colour and material, PLY coloured per vertex, and SVG and DXF of single outlines and sections at 1:1, for laser cutters and 2D CAD.

What is left:

1. **STEP.** This is the hard one, and the main thing that separates Draftsman from professional CAD. STEP files hold exact surfaces; our kernel holds distance fields. Done so far: STEP (AP214) with exact surfaces written straight from the script for boxes, cylinders, cones, spheres, tori, capsules, and extrusions and revolves of line-and-arc outlines with their holes, and a closed solid of flat faces from the mesh for every other part, as a named, coloured assembly. What is left: exact cuts and joins in 3D (a plate with a drilled hole, a shaft with a key), which need the solids intersected; fillets and rounded boxes; fitted surfaces for smooth blends, lofts and sweeps instead of flat faces; and checking the files in FreeCAD, Fusion and SolidWorks. This will take a long time, and it is the largest open question on this page.
2. **Import.** Open an STL or a STEP file as a reference to build around.

## Working with the model directly

The prompt stays the main way to make things. These are for looking, checking and small adjustments, and they stay out of the way until you reach for them.

Done so far, by prompt: measuring (a part's size, volume, surface area, centre of mass and mass; the distance between two parts or two points), hiding and isolating parts, a section view with filled cut faces at any plane, and an exploded view that keeps sub-assemblies together. A line above the prompt box says what the view leaves out.

What is left:

1. **Measuring and cutting by hand.** Click two points for a distance, slide the cutting plane, and a thin dimension line in the view for the last measurement.
2. **A short list of the model's parts**, to hide and pick from.
3. **Move a part by dragging it**, with the change written back into the script.
4. **Reference pictures.** Drop in a photo or a blueprint for Claude to work from, shown behind the model for comparison.

## Video

Motion already plays in the view. Making a film of it needs:

1. **Recording.** Save the view as a video file, frame by frame, so the result is smooth however long each frame takes to draw.
2. **Camera moves.** Turntables, fly-arounds, and moves between saved views.
3. **Shots by prompt.** Tools for Claude to plan a sequence: "start wide, move in on the swashplate, then follow one blade round".
4. **Exploding and assembling** a model on camera.

## Modelling depth

Rhino's strength is free-form curves and surfaces. To compete there:

1. **Fillets and chamfers on chosen edges**, with a radius that can change along the edge.
2. **Surfaces through curves**: sweeps along two rails, patches through a network of curves, and blends that stay smooth where surfaces meet.
3. **Sheet-metal and shell tools**: exact wall thickness, bends and flat patterns.
4. **Constraints** between parts ("this face sits on that one"), so assemblies update when a part changes.
5. **A parts list** with quantities and materials.
6. **Faster builds.** A helicopter takes minutes. Parts of a plan could be built side by side, and a model could appear piece by piece as Claude writes it.

## The app

Done so far: installers for macOS, Windows and Linux, built by a release workflow and attached to a draft release, with our own icon; and four examples on the empty window (a mug, a bolted bracket, a rotor head that moves and a helicopter) that open at once and suggest what to try next.

What is left:

1. **Signed installers.** The workflow signs as soon as the certificates exist ([releasing.md](releasing.md)); then automatic updates.
2. **Settings**: units, theme, grid, and which Claude model to use.
3. **Touch and trackpad gestures** throughout.

## How we measure progress

Changes to what Claude makes are checked against the [benchmarks](benchmarks.md): eight complex moving objects scored by a judge, and CADPrompt scored against its ground-truth meshes. A change that claims to improve the look or the shapes should move those numbers.
