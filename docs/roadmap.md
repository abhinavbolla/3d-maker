# Roadmap

Draftsman's goal is an open-source CAD application that anyone can use by describing what they want, and that holds up next to professional tools such as Rhino: models that look right, drawings you can build from, and files other apps can open.

This page says where it stands against that goal and what comes next. The order within each section is the order we plan to work in.

## Where it stands

| What a CAD tool needs | Today |
|---|---|
| Making 3D models | By prompt, with sliders on parts. Outlines, extrude, revolve, sweep, loft, bodies from views, bend, twist, taper, threads and hardware. |
| Mechanisms | Motion, joints checked over the whole loop, collision checks. |
| Looking at the model | Studio view with shadows, a reflecting floor and materials. Turn, slide and zoom as in other CAD programs, with a view cube, and the turning centre and the origin's axes and planes shown while you turn. |
| Pictures | PNG studio shots of any view, and from cameras Claude places, with a chosen lens and size. |
| 2D drawings | One A3 sheet as SVG: front, top, side and isometric views with hidden edges left out, a hatched section, the overall sizes and an ISO title block. |
| Files for other apps | Meshes only: STL and 3MF. |
| Exact surfaces | None. Surfaces are fine meshes of distance fields. |
| Direct editing | Sliders and prompts. No dragging, measuring or sectioning. |
| Video | MP4 films (WebM where H.264 is missing) from shots Claude plans: turntables, orbits, moves between saved views, following a part. |
| Installing | Runs from a clone of the repository. |

## The look

A studio shot of a mechanism from a professional tool gets its look from four things: lighting, materials, crisp small edges, and framing. Lighting, materials and framing are in: Claude can place the camera, pick a lens and save a picture, so "give me a hero shot of the rotor head" works. What is left:

1. **Shading in the creases.** Ambient occlusion darkens the gaps between parts and the inside of corners. It is what makes an assembly read as many parts fitted together.
2. **Edge lines.** An optional "shaded with edges" look, where sharp edges and outlines are drawn as thin dark lines, as in engineering views.
3. **Small fillets and chamfers everywhere.** Real machined parts have a small break on every edge, and those edges catch the light. The kernel can round edges; what is missing is detail in the mesh where the surface curves tightly, so a 1 mm fillet on a 1 m part survives. This needs detail shared out by curvature, not only by surface area.
4. **Smoother metal.** Polished materials show every mesh facet. Normals taken from the distance field itself, and finer view meshes on shiny parts, fix most of it.
5. **Materials Claude chooses.** Parts can now be metal, paint, plastic, rubber or glass. Next: brushed and anodised metals, textures such as tread and knurling, and decals.

## 2D drawings

A model is not finished for a workshop until it has drawings. Distance fields make some of this easier than it is for other kernels: a section through a part is an exact outline, with no surface-to-surface intersection to compute.

Done so far: an A3 sheet as SVG to ISO 5457 (frame, grid reference border, centring marks) with the front, top and side views in first or third angle (sharp edges and outlines, hidden edges left out), an isometric view, one section cut straight from the distance functions with its faces hatched per part, the overall width, depth and height, and an ISO 7200 title block that fills itself in and remembers what you tell it. Claude can export it, say where the section goes and fill in the title block.

What is left:

1. **Views.** Detail views at a larger scale, for crowded parts of an assembly (at 1:50 the rotor head's hub fills in, however thin its lines). Hidden edges dashed, as a choice. The lines where a small piece of a part meets a bigger piece of the same part, which the mesh has no edge for. Centre lines of holes and turned parts. Views drawn from the distance functions instead of the mesh, so curves are exact here too.
2. **Sections.** Planes at any angle, stepped and half sections, several sections on a sheet, and detail views.
3. **Dimensions.** Hole positions and diameters, radii and angles, taken from the model and from the values in its script.
4. **Sheets.** PDF and DXF. Other sheet sizes, several sheets, and a parts list with balloons.
5. **Drawings by prompt.** "Make a drawing of the bracket with a section through the holes": Claude choosing the views, the sections and what to dimension, and looking at the sheet it made.

## Files for other apps

1. **glTF.** Parts, colours, materials and motion in one file, for Blender, game engines and the web.
2. **OBJ and PLY.** The simple mesh formats that everything reads.
3. **SVG and DXF** of single outlines and sections at 1:1, for laser cutters and 2D CAD. (The drawing sheet is already an SVG.)
4. **STEP.** This is the hard one, and the main thing that separates Draftsman from professional CAD. STEP files hold exact surfaces; our kernel holds distance fields. The plan is to write exact surfaces straight from the script where the shape allows it, because the script already says "this is an extrusion of that outline" or "this is a cylinder with a hole". Prisms, turned parts, plates with holes and their cuts and joins come first. Shapes with no exact form (smooth blends, lattices, twisted bodies) would go out as fitted surfaces or fine meshes inside the STEP file. This will take a long time, and it is the largest open question on this page.
5. **Import.** Open an STL or a STEP file as a reference to build around.

## Working with the model directly

The prompt stays the main way to make things. These are for looking, checking and small adjustments, and they stay out of the way until you reach for them.

1. **Measure.** Click two points for a distance, or a part for its size, volume and mass.
2. **Hide and isolate parts**, and a short list of the model's parts.
3. **Section view.** Slide a cutting plane through the model to see inside.
4. **Exploded view** of an assembly.
5. **Move a part by dragging it**, with the change written back into the script.
6. **Reference pictures.** Drop in a photo or a blueprint for Claude to work from, shown behind the model for comparison.

## Video

Done so far: recording frame by frame (each frame's camera and motion come from its number, so the film is smooth however long a frame takes), MP4 with H.264 or WebM with VP9 or VP8 from our own file writers, camera moves (hold, turntable, orbit, moves between cameras or saved views, following a part), and shots Claude plans and previews by prompt.

What is left:

1. **Exploding and assembling** a model on camera.
2. **Sound, motion blur and titles.**

## Modelling depth

Rhino's strength is free-form curves and surfaces. To compete there:

1. **Fillets and chamfers on chosen edges**, with a radius that can change along the edge.
2. **Surfaces through curves**: sweeps along two rails, patches through a network of curves, and blends that stay smooth where surfaces meet.
3. **Sheet-metal and shell tools**: exact wall thickness, bends and flat patterns.
4. **Constraints** between parts ("this face sits on that one"), so assemblies update when a part changes.
5. **A parts list** with quantities and materials.
6. **Faster builds.** A helicopter takes minutes. Parts of a plan could be built side by side, and a model could appear piece by piece as Claude writes it.

## The app

1. **Installers** for macOS, Windows and Linux, signed, with a real icon.
2. **Settings**: units, theme, grid, and which Claude model to use.
3. **A gallery of examples** to start from.
4. **Touch and trackpad gestures** throughout.

## How we measure progress

Changes to what Claude makes are checked against the [benchmarks](benchmarks.md): eight complex moving objects scored by a judge, and CADPrompt scored against its ground-truth meshes. A change that claims to improve the look or the shapes should move those numbers.
