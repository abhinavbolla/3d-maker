# Roadmap

3D Maker's goal is an open-source CAD application that anyone can use by describing what they want, and that holds up next to professional tools such as Rhino: models that look right, drawings you can build from, and files other apps can open.

This page says where it stands against that goal and what comes next. The order within each section is the order we plan to work in.

## Where it stands

| What a CAD tool needs | Today |
|---|---|
| Making 3D models | By prompt, with sliders on parts. Outlines, extrude, revolve, sweep, loft, bodies from views, bend, twist, taper, threads and hardware. |
| Mechanisms | Motion, joints checked over the whole loop, collision checks. |
| Looking at the model | Studio view with shadows, a reflecting floor and materials. Turn, slide and zoom as in other CAD programs, with a view cube, and the turning centre and the origin's axes and planes shown while you turn. |
| Pictures | PNG studio shots of any view. |
| 2D drawings | None. |
| Files for other apps | Meshes only: STL and 3MF. |
| Exact surfaces | None. Surfaces are fine meshes of distance fields. |
| Direct editing | Sliders and prompts. No dragging, measuring or sectioning. |
| Video | Motion plays in the view. Nothing is recorded. |
| Installing | Runs from a clone of the repository. |

## The look

A studio shot of a mechanism from a professional tool gets its look from four things: lighting, materials, crisp small edges, and framing. The first two are in. What is left:

1. **Shading in the creases.** Ambient occlusion darkens the gaps between parts and the inside of corners. It is what makes an assembly read as many parts fitted together.
2. **Edge lines.** An optional "shaded with edges" look, where sharp edges and outlines are drawn as thin dark lines, as in engineering views.
3. **Small fillets and chamfers everywhere.** Real machined parts have a small break on every edge, and those edges catch the light. The kernel can round edges; what is missing is detail in the mesh where the surface curves tightly, so a 1 mm fillet on a 1 m part survives. This needs detail shared out by curvature, not only by surface area.
4. **Smoother metal.** Polished materials show every mesh facet. Normals taken from the distance field itself, and finer view meshes on shiny parts, fix most of it.
5. **Materials Claude chooses.** Parts can now be metal, paint, plastic, rubber or glass. Next: brushed and anodised metals, textures such as tread and knurling, and decals.
6. **A camera Claude can direct.** Tools for Claude to place the camera, pick a lens and save a picture, so "give me a hero shot of the rotor head" works.

## 2D drawings

A model is not finished for a workshop until it has drawings. Distance fields make some of this easier than it is for other kernels: a section through a part is an exact outline, with no surface-to-surface intersection to compute.

1. **Views.** Front, top, side and isometric views as clean line drawings, with hidden edges dashed or left out.
2. **Sections.** Cut the model with a plane and hatch the cut faces.
3. **Dimensions.** Overall sizes, hole positions and diameters, taken from the model and from the values in its script.
4. **Sheets.** A drawing sheet with a title block, scale and several views, exported as PDF, SVG and DXF.
5. **Drawings by prompt.** "Make a drawing of the bracket with a section through the holes."

## Files for other apps

1. **glTF.** Parts, colours, materials and motion in one file, for Blender, game engines and the web.
2. **OBJ and PLY.** The simple mesh formats that everything reads.
3. **SVG and DXF** of outlines and sections, for laser cutters and 2D CAD.
4. **STEP.** This is the hard one, and the main thing that separates 3D Maker from professional CAD. STEP files hold exact surfaces; our kernel holds distance fields. The plan is to write exact surfaces straight from the script where the shape allows it, because the script already says "this is an extrusion of that outline" or "this is a cylinder with a hole". Prisms, turned parts, plates with holes and their cuts and joins come first. Shapes with no exact form (smooth blends, lattices, twisted bodies) would go out as fitted surfaces or fine meshes inside the STEP file. This will take a long time, and it is the largest open question on this page.
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

1. **Installers** for macOS, Windows and Linux, signed, with a real icon.
2. **Settings**: units, theme, grid, and which Claude model to use.
3. **A gallery of examples** to start from.
4. **Touch and trackpad gestures** throughout.

## How we measure progress

Changes to what Claude makes are checked against the [benchmarks](benchmarks.md): eight complex moving objects scored by a judge, and CADPrompt scored against its ground-truth meshes. A change that claims to improve the look or the shapes should move those numbers.
