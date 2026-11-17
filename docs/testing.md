# Testing

## Without Claude

```bash
npm test                                  # kernel, window routing, plan tools (needs Chrome); CI runs this
npm run licenses                          # every npm package carries an accepted license; CI runs this
node test/check-stl.mjs model.stl         # checks an STL is well formed and closed
node test/check-3mf.mjs model.3mf         # checks a 3MF: zip, names, colours, every part closed
node test/check-step.mjs model.step       # checks a STEP file: entities, assembly, closed solids, geometry, volumes
node test/step-run.mjs model.js out.step  # loads a script, exports it as STEP and checks the file
node test/render-step.mjs model.step out.png  # draws a STEP file from its own faces, as read back
node test/step-samples.mjs out-dir        # writes the STEP samples FreeCAD is asked to open, and what each should hold
node test/export-run.mjs runs/x/model.js  # loads a saved script and times its STL export
node test/check-meshfile.mjs model.glb    # checks a GLB, OBJ (with its MTL) or PLY: names, sizes, every part closed
node test/meshfile-run.mjs model.js [dir]  # exports a script as GLB, OBJ and PLY, times and checks them, and loads the GLB with three.js
node test/drawing-run.mjs model.js out.svg  # loads a script and saves its drawing sheet
node test/example-pictures.mjs            # draws the examples' small pictures again (src/examples/*.webp)
node test/kernel.test.mjs drawing         # only the kernel tests with "drawing" in their name
cd src-tauri && cargo test                # the desktop app's Rust side
```

`npm test` checks the kernel's volumes and sizes against exact answers, drawings by measuring their views and sections, window routing over the bridge, and the app's commands in headless Chrome.

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
