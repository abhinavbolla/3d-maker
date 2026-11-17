---
name: draftsman
description: How to model parts, machines and buildings in the Draftsman app through its MCP tools (reference, set_model, set_plan, finish_step, check_fit, screenshot, section_view, measure, set_camera, record_video, the exports). Use when the user asks to model, change, check, measure, draw, film or export something in Draftsman.
---

# Working in Draftsman

Draftsman turns a JavaScript model script into solid parts that the user watches live in the app. The tools below are the `draftsman` MCP server's; they reach the app window the user has open. If a tool says the app is not open, ask the user to start it and try again. Do not work around it.

## Before you write a script

- Call `reference` once per conversation, before your first script. It is the whole modelling language and the way to work. Use only the functions it lists. Do not guess names.
- For a model that already exists, call `get_model` first. If it shows an unfinished plan, continue that plan.
- Units are millimetres, +Z is up, the ground is z = 0. Model real things at real size.

## Small things (up to about 5 parts)

Write the whole script with one `set_model`, then `screenshot` and fix what looks wrong. For later changes use `edit_model`: its `old_text` must appear exactly once in the script.

## Big or mechanical things: build with a plan

1. Call `set_plan` first and quickly. Each step is one sub-assembly with the exact part names it creates (`steps: [{ name, parts }]`, 2 to 40 steps). Work out dimensions later, one step at a time.
2. Step 1: `set_model` with `title()`, the shared dimensions as constants at the top, and the first step's parts. Later steps: `append_to_model` with that step's code, reusing the constants.
3. After each step, call `finish_step` with the step's name. Look at the picture it returns, and fix anything floating, passing through other parts, the wrong size or crude before the next step. Do not skip a step.
4. When every step is done, take screenshots from two or three views and fix what is still wrong.

## Buildings

Houses, cabins and offices of one storey are built with the reference's building functions: `house()` for wall height and thicknesses, `outerWalls()` round the outside corners, `wall()` for inner walls, then `door()`, `window()`, `room()` (a point inside each room) and `roof()`. They make the parts themselves. Plan in XY with north +Y, at real sizes. `get_model` lists every wall, room area and opening. `export_floor_plan` gives the architect's plan, as `format` svg, pdf or dxf.

## Check, do not assume

- **Look.** Call `screenshot` after every change. Use `view: "iso"`, then `"front"`, `"top"` or `"right"`; the straight views are flat and true to scale. `part` frames one part; `parts` frames several and shows the rest faintly. For moving parts, pass `at` (seconds) and look at two or three moments.
- **Fit.** `finish_step` lists overlaps within a step. When the model is done, call `check_fit` once for all of it: it checks at rest and over the whole motion. With exactly two `parts` it also gives `gap_mm`. Fix each overlap by cutting a hole where one part fits into another, or by moving it. Say the parts do not collide only if the last `check_fit` after your last change found nothing.
- **Mechanisms.** Declare a `joint()` at every connection. Finish only when every joint's `max_gap_mm` and every link's `max_stretch_mm` is under 1 and there are no motion warnings.
- **Inside.** To check what you cannot see from outside (a shaft through its bearings, a wall's thickness, holes that should line up), cut the model open with `section_view` (`axis` and `offset`, or `point` and `normal`) and take a screenshot from the view it returns as `look_into_it_from` (given for an `axis`). `hide_parts` (`hide`, `show`, `only`, `all`) and `explode_view` (`factor`, `axis`, `together`) uncover parts that others hide. Call `clear_view` when done, unless the user asked to keep the view.
- **Numbers.** Answer questions about sizes, gaps and weight with `measure`, never from a picture: `part` or `parts` for size, volume, area and centre of mass, with `material` or `density_g_cm3` for mass; `between` (two part names) for the shortest distance; `points` (two points) for a distance.

## Getting it out

Export only when the user asks. Each export writes to `~/Downloads/<title>.<ext>` unless you pass `path`.

- `export_stl` (3D printing; `solid: true` joins every part), `export_3mf` (slicers), `export_step` (CAD programs; tell the user which parts came out faceted or were left out), `export_glb` (Blender, games, the web, with the motion), `export_html` (one file to send to someone with nothing installed), `export_obj`, `export_ply`.
- `export_drawing` makes a 2D sheet as `format` svg, pdf or dxf. Pass only title-block values the user gave in this conversation (`drawn_by`, `owner`, `approved_by`, `number`, `revision`, `subtitle`, `tolerances`); never guess a name or a company. `sheet`, `hidden_edges`, `detail`, `projection`, and `axis` with `offset` for the section, are there when the user asks. `outline` gives a single outline at 1:1 for a laser or water-jet cutter. Reply with the path and the `line` it returns, nothing more.
- The view shades the creases between parts by itself. `set_look` with `edges: true` adds sharp edges as thin dark lines, when the user asks for edges; `edges: false` turns them off.

## Pictures and films

Only when the user asks. They show the model as the view does: a section, hidden parts or an exploded view stay in them, so call `clear_view` first for the whole model.

- `set_camera` moves the user's view (`view`, `azimuth`, `elevation`, `parts`, `lens_mm`); `save_as` keeps it as a named view.
- `save_picture` saves a studio PNG from a `camera`. Look at the preview it returns.
- For a film, plan a few `shots` of 2 to 6 s (`move`: hold, turntable, orbit, move or follow), try them with `preview_shots`, fix the ones that frame badly, then `record_video`. Slow fast rotors down with `speed` 0.25 to 0.5. Say in your reply whether it came out as mp4 or webm.

## When you are done

Answer in one or two short sentences about what you made or changed. Do not paste the script.
