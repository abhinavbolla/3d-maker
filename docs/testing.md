# Testing

## Without Claude

```bash
npm test                                  # kernel, window routing, plan tools (needs Chrome); CI runs this
npm run licenses                          # every npm package carries an accepted license; CI runs this
node test/tools.test.mjs [--list]         # the MCP tool list follows its rules and stays within its size budget (in npm test)
node test/check-stl.mjs model.stl         # checks an STL is well formed and closed
node test/check-3mf.mjs model.3mf         # checks a 3MF: zip, names, colours, every part closed
node test/check-step.mjs model.step       # checks a STEP file: entities, assembly, closed solids, geometry, volumes
node test/step-run.mjs model.js out.step  # loads a script, exports it as STEP and checks the file
node test/render-step.mjs model.step out.png  # draws a STEP file from its own faces, as read back
node test/step-samples.mjs out-dir        # writes the STEP samples FreeCAD is asked to open, and what each should hold
node test/outside-samples.mjs out-dir     # writes the GLB, OBJ, PLY, STL and DXF samples Blender and FreeCAD are asked to open
node test/export-run.mjs runs/x/model.js  # loads a saved script and times its STL export
node test/check-meshfile.mjs model.glb    # checks a GLB, OBJ (with its MTL) or PLY: names, sizes, every part closed
node test/meshfile-run.mjs model.js [dir]  # exports a script as GLB, OBJ and PLY, times and checks them, and loads the GLB with three.js
node test/drawing-run.mjs model.js out.svg  # loads a script and saves its drawing sheet
node test/drawing-run.mjs model.js out.pdf "" "" '{"format":"pdf"}'  # the same as PDF (or DXF)
node test/check-dxf.mjs file.dxf [look.svg]  # reads a DXF on its own, checks it, draws what it holds
node test/example-pictures.mjs            # draws the examples' small pictures again (src/examples/*.webp)
node test/video-run.mjs model.js out.mp4 [shots.json]  # loads a script and records a video (a turntable by default)
HARNESS_GL=metal node test/video-run.mjs ...  # the same on the Mac's GPU, for full-size videos
node test/kernel.test.mjs drawing         # only the kernel tests with "drawing" in their name
cd src-tauri && cargo test                # the desktop app's Rust side
```

`npm test` checks the kernel's volumes and sizes against exact answers, drawings by measuring their views and sections, window routing over the bridge, the tool list, and the app's commands in headless Chrome.

### The tool list

Every Claude client reads all of Draftsman's tools and the server instructions at the start of every conversation, so `test/tools.test.mjs` starts the real server, lists the tools as a client does, and checks:

- names are snake_case, at most 32 characters, and none is another tool's name with a suffix (`screenshot_v2` should be an argument of `screenshot`);
- every tool has a description whose first sentence says what it does, in plain words, without capitals that give orders (MUST, NEVER) or advertising;
- every argument, nested ones included, has a description, and an argument that picks one of a few things is an enum (unless it also takes a name, such as a saved view's). A field is described once: inside an argument that says it takes "set_camera's arguments" or is "as for preview_shots", a field takes that tool's description of it;
- the plugin's skill (`plugins/draftsman/skills/draftsman/SKILL.md`) names only tools, arguments and script functions that exist, and in a bullet about a tool only that tool's arguments;
- the instructions, the descriptions and the reference text name only tools that exist, and the instructions send the model to `reference` and stay under the 4096 characters Claude Code shows;
- the size budget: the tool list and instructions together stay under a ceiling (`BUDGET_BYTES`), printed with an estimate in tokens at four characters each. Raise it only in the PR that adds the words, and say there what they buy.

Problems that exist today are listed in `KNOWN` at the top of the test, one line each. The list may only shrink: fixing one makes the test fail until its entry is removed. `node test/tools.test.mjs other-server.mjs` runs the same checks on another server file.

## With your Claude Code

These run your real Claude Code and use your Claude plan, so CI doesn't run them. Run the ones your change touches and say so in the PR.

```bash
npm run test:e2e                                  # the real prompt box, checked by measuring the result
npm run try -- "a rotor head"                     # one prompt; saves pictures, script and plan in runs/
node test/mcp.test.mjs                            # the MCP tools, against an app window you have open
cd src-tauri && cargo test -- --include-ignored   # also finds and runs your Claude Code
```

`npm run test:e2e` opens two app windows in headless Chrome and types two prompts into the first: "a 30 mm cube with a 10 mm hole", then, with it selected, "make this 50 mm wide". It checks the result by measuring it, not by reading Claude's reply: the part's size from its mesh, the hole from its volume, a closed STL, and that the second window was not touched. A third prompt (a desk fan) must be built with a plan, with every step finished and every planned part present.

It needs Google Chrome. It does not drive the desktop window itself, because WebDriver for Tauri does not run on macOS; the desktop app's way of starting Claude is covered by the Rust test.

## Build time

```bash
node test/build-time.mjs                      # the test models, three runs each
node test/build-time.mjs --parts model.js     # one script, with its slowest parts
```

This times a build the way the app does one: the script, then every part meshed at preview detail and again at fine detail, each with its copy for drawing and its lighter copy. It runs on one thread, so the times are the work itself and not how many workers the machine has. Beside each time it prints a hash of every vertex, normal and index that was built. A change that should only make builds faster must leave the hashes as they were; compare two versions by running each from its own checkout, one after the other, since other work on the machine moves the times.

## GPU load

```bash
node test/gpu-load.mjs                        # the rotor head: still, turning, parts moving
node test/gpu-load.mjs runs/x/model.js        # any saved script
node test/gpu-load.mjs --root ../other-copy   # the app from another checkout, to compare two versions
```

This measures what the view really costs the GPU, which `npm test` cannot: the tests draw in software. It opens the app in Chrome with hardware WebGL and runs each case for a few seconds. It needs a Mac with Apple silicon and the Xcode command line tools (for `clang`), and no admin rights.

It reports two things per case:

- **At the screen's pace**, as you would use the app: the GPU's power in watts, the frames drawn, and how long the GPU was busy for that Chrome per second. Power is read from the energy counters macOS keeps ([test/gpu-power.c](../test/gpu-power.c)) and is the whole machine's, so the still case is the floor to compare against. Busy time is the figure Activity Monitor shows per process; it says little about the work done, because a lightly loaded GPU slows its clock until it is busy most of the time anyway.
- **Flat out:** frames drawn back to back, which keeps the GPU at full speed. Frames per second measured this way is how much work a frame is, and is the steadiest figure of all; GPU time per frame is the GPU's share of it.

Each case runs in three rounds, taking turns, and the middle value is printed, with the lowest and highest for power. Other apps share the GPU and move the power readings, so close the ones that draw a lot before a run you want to quote. Without `--window` the frames come 60 a second, whatever the screen. CI does not run it: its numbers depend on the machine.

## Benchmarks

How to run them, and every result so far, are in [benchmarks.md](benchmarks.md).

## STEP files in a real CAD program

Our own reader can only say a STEP file is consistent. Whether a CAD program accepts it is checked on
GitHub: the `STEP in FreeCAD` workflow writes the samples in `test/models/step` with
`node test/step-samples.mjs`, installs FreeCAD on the runner and runs `test/freecad-check.py` in it.
FreeCAD has to read every file, find each solid valid and closed, name the parts as the file does, and
measure the volumes our reader measured, three of which are also worked out by hand. It then writes
each file out again and reads it back.

FreeCAD is an outside program in that job. It is not a dependency of Draftsman, and none of its code
is in this repository. The job runs when the STEP code or its samples change, and by hand from the
Actions tab.

## Mesh and DXF files in Blender and FreeCAD

The `Files in Blender and FreeCAD` workflow does the same for the other exports.
`node test/outside-samples.mjs out-dir` writes them as the app does: four models (one part of each
look with a turning shaft, the STEP cylinder, the angle bracket and the 47-part rotor head) as
`.glb`, `.obj` with its `.mtl`, `.ply` and `.stl`, the bracket's drawing sheet and a plate's outline
as `.dxf`, and `expected.json`, what the kernel says each file holds, from its own meshes and
drawing marks.

- **Blender** (`test/blender-check.py`, in `blender --background`) imports each mesh file with its
  own importer. For every part: its object and name, triangles, every edge shared by two faces once
  coincident vertices are merged, vertices, volume (to 0.05% of the kernel's mesh, and to 1% of the
  volume worked out by hand where there is one), faces pointing out, bounds in mm with Z up (glTF
  is read in metres and Y up, and turned back), and corner normals that agree with the faces. For
  glTF also the Principled BSDF material (name, base colour, metallic, roughness, alpha, clear coat,
  see-through glass) and the animation's length; for OBJ the material from the MTL; for PLY the
  vertex colours. PLY and STL are one mesh, checked as a whole.
- **FreeCAD** (`test/freecad-dxf-check.py`) imports each DXF with its own importer, layers as groups:
  no errors, circles and straight edges by layer, texts, the extents in mm, and every circle's centre
  and radius.

Neither program is a dependency of Draftsman, and none of their code is in this repository. The
jobs run when the exporters, the mesher, the drawing code or the samples change, and by hand from
the Actions tab.
