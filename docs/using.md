# Using Draftsman

The [README](../README.md) gets you to a first model. This page is the full guide.

## Making things

- Type what you want in the box at the bottom and press Enter: "a desk lamp with a weighted base", "a helicopter whose rotors spin". Claude writes the model, looks at it from a few angles, and fixes what looks wrong.
- Big or mechanical things (a helicopter, a rotor head, an engine) are built with a plan. Claude lists the sub-assemblies and their parts, then builds and checks them one at a time. A line above the prompt shows progress, like "5 of 20 done · now: Stationary swashplate". A step only counts as done once all its parts exist and are solid.
- Under Claude's reply, a grey line says what this window saw happen: whether the model changed, how many changes and looks, and any step that failed. The app counts this itself; it is not taken from Claude's words.
- Click a part to select it. Its sliders appear in the top-right corner, and the prompt box now talks about that part ("make this longer").
- ⌘Z and ⇧⌘Z undo and redo every change, Claude's included. ⌘S saves and ⌘O opens. The model is also autosaved.

## Looking around

- Drag to turn the view. It turns around the middle of the window, which starts as the middle of the model, and the model stays upright. While you turn, a ring marks that centre, and the origin's axes and its three planes show.
- Right-drag or shift-drag to slide the view. On a trackpad, slide two fingers.
- Scroll with a mouse wheel, or pinch on a trackpad, to move towards what the pointer is on. Over empty space you keep flying, so you can travel to any part of a big model and look at it up close.
- Double-click a point to bring it to the middle; the view then turns around it. Fit (or F) frames the whole model from a corner, and Esc deselects.
- The view cube at the bottom right turns with the model. Click a side, an edge or a corner to look from there without losing your place, or drag the cube to turn the view. Its red, green and blue lines are the X, Y and Z axes, and the red and green lines on the ground are the X and Y axes.
- When the view comes to rest, the gaps between parts and the inside corners darken a little, so an assembly reads as parts fitted together. The shading fades in once nothing moves and is left out while you turn the view or parts move, so moving costs nothing extra. Pictures and Claude's screenshots always have it.
- Ask for edges ("show it with edges") to see sharp edges as thin dark lines, as in engineering views; outlines join them once the view is still. "Turn the edges off" goes back. The app remembers the choice.
- Moving parts play in the view; Pause stops them. They play at up to 60 frames a second, and at 30 while you work in another window (typing to Claude beside the app, say). While the window is hidden they wait, and go on from where they were when it shows again.

## What Claude can draw

- Real outlines (arcs, curves, splines, rounded corners, airfoil sections), turned into solids by extruding, spinning, sweeping along a path (rails, bent tube, springs) or lofting through several of them (wings, blades, hulls, bottles).
- Bodies from their side and top outlines, the way they are drawn on paper, with rounded cross-sections (fuselages, car bodies, cabs).
- Shapes that are twisted, tapered and bent, lattice infill (gyroid, diamond, grid, honeycomb), convex hulls, and raised or engraved text in our own single-stroke font.
- Real hardware at ISO metric sizes: threads, bolts, nuts, washers, and the clearance, tapped, counterbored or countersunk holes that fit them. Moulded parts can have draft.
- Materials: metal, brushed metal, anodised metal, paint, plastic, rubber and glass.
- Motion: parts that turn, slide, follow each other or are linked by rods. Claude declares every joint, and the app checks over the whole motion that no joint comes apart and no parts pass into each other.

## Getting it out

The Export menu saves:

- **Picture**: the view as a studio shot on a light backdrop, as a PNG.
- **3MF**: one named, coloured object per part, for other 3D apps and slicers.
- **STL**: each part its own closed shell, or all parts joined into one solid.
- **Drawing**: an A3 sheet as an SVG, which browsers, Inkscape and Illustrator open and print.
- **glTF**: a .glb file for Blender, game engines and web viewers. Each part is a named node with its colour and material (metal, paint, plastic, rubber or glass), and the model's motion is an animation that loops, so a mechanism plays there as it does here. glTF is in metres with Y up, so the file is too; apps that read it put the model the right way up and the right size.
- **OBJ**: one object per part, with normals, in millimetres with Y up, as most apps expect an OBJ. Its colours and materials go in an MTL file of the same name beside it; keep the two together.
- **PLY**: one mesh, each vertex coloured with its part's colour, in millimetres with Z up, like the STL. The part names are in comment lines in its header.

Motion goes only into the glTF file; the other files hold the parts where the script puts them.

Every visible part is meshed at the same detail on all cores, so a 60-part rotor head exports in seconds.

### The drawing

![The rotor head as a drawing: front, top, side and isometric views, a section through the mast, overall sizes and a title block on an A3 sheet](rotor-head-drawing.png)

The sheet shows the model from the front, from above and from the side, with hidden edges left out, and where there is room an isometric view at the top right. Next to the views is section A–A: the model cut by a plane, with the cut faces hatched, each part its own way, and what lies beyond the cut drawn behind them. The cutting line and the way the section looks are marked on one of the views.

The views are laid out in first-angle projection (ISO: the top view under the front view, the view from the left on its right) or third-angle projection (the top view above it, the view from the right on its right). Which one follows the region your system's language names: third angle in the US, Canada and Japan, first angle elsewhere, and first angle (ISO's) when no region is named. Say "third angle" or "first angle" to change it.

The overall width, depth and height are dimensioned in millimetres. The scale is the largest standard one that fits the sheet: 1:1, 1:2, 1:5, 1:10, 1:20, 1:50 and so on, or 2:1, 5:1 and up for small parts. Outlines are 0.5 mm wide and dimensions and hatching 0.25 mm, or thinner where a crowded assembly would run together at that weight.

The sheet follows ISO 5457 (frame, grid reference border, centring marks), and its title block ISO 7200. The block fills itself in:

| Field | Where it comes from |
| --- | --- |
| Title | The model's title. A title too long for its cell is split near its 30th character, and the rest goes in the supplementary title (or, if you gave one, the title gets smaller letters). A title too long even for that is cut short with … on the sheet, and the app says so. |
| Identification number | Made up once for the model (such as 3DM-4K7Q2X) and saved with it, until you give your own. |
| Date of issue | Today. |
| Document type | Part drawing, or Assembly drawing for more than one part. |
| Scale, projection, units, sheet | From the sheet itself. |
| Created by, legal owner | Blank until you say. The app does not know your name or employer and does not guess. |
| Approved by | Blank, a line to sign, unless you name the approver when you ask for the drawing. An approval is for one issue of a drawing, so it is never remembered: the next drawing has the empty line again. |
| Revision, general tolerances | Blank until you say; the app never changes a revision by itself. The tolerances note only appears when you give one. |

To fill in or change any of it, tell Claude, for example: "export a drawing, drawn by Ana Ruiz, owner Example Works Ltd, drawing number BRK-0042, revision A, tolerances ISO 2768-m". Each field holds what ISO 7200 recommends: 20 characters for created by and approved by, 16 for the number, 2 for the revision, 50 for the supplementary title; 40 for the legal owner and 30 for the tolerances, which it leaves open. A longer value is refused with a message saying so, never cut short on the sheet. Ask for a field to be left empty to clear it; an empty number gets a new one made up.

The app remembers what you said once the drawing is saved; a drawing that fails, or whose save you cancel, leaves nothing remembered:

- **Kept for you, in this app only:** your name (created by), the legal owner, and first or third angle. They are never written into a model file.
- **Kept with the model, and saved in its file:** the number, revision, supplementary title and general tolerances. No one's name is saved in a model file. Claude rewriting the script keeps them, since it is still the same model; New starts a model with none of them, and so a new number. Open brings in the file's own.

After each drawing the app says in one line what went on the sheet: what you said, what was remembered, what is blank, and how to change it.

From the Export menu the section cuts across the model's longest side, at its middle. Ask Claude for a different one: "export a drawing with the section across z, 40 mm up".

Parts are drawn where the script puts them, not as their motion poses them, the same as in the STL and 3MF files. The views are drawn from the same meshes as those files, so a line can be off by the mesh's detail; the section is not, because it is cut from the exact shapes.

## Driving it from Claude Code

The prompt box is the usual way in. You can also drive the app from Claude Code or Claude Desktop directly by adding the MCP server:

```bash
claude mcp add --scope user draftsman -- node /path/to/draftsman/mcp/server.mjs
```

## Limitations

- **No exact CAD surfaces yet.** Export is meshes (STL, 3MF, glTF, OBJ, PLY), not STEP, and curved surfaces are fine meshes rather than exact curves. This is the price of a kernel where joining and cutting cannot fail. The [roadmap](roadmap.md) says what we plan to do about it.
- **Drawings are a first version.** One A3 sheet as SVG: no PDF or DXF, no dashed hidden edges, no centre lines or parts list, and only the overall sizes are dimensioned. Where a small piece of a part rises out of a bigger piece of the same part (a boss on a curved body), the line where they meet is not drawn yet.
- **Fine detail on big parts.** A 1 mm engraving on a 10 m fuselage is limited by that part's mesh, and features smaller than a mesh cell come out saw-toothed. The very tip of a sharp trailing edge is a few mm short. Threads on a big model look like smooth rods.
- **Changes are prompts and sliders.** You can't drag parts around in the view.
- **Collisions in motion** are checked at up to 120 moments of the loop; a very fast part could pass through something between two of them.
- **Text** has one font and no accents yet.
- **Packaging.** The app runs from this folder, so there is no installer, signing or real icon yet.
- **Sharing the app.** Running your own `claude -p` from an app is fine for your own use. Check Anthropic's terms before giving the app to others.
