# 3D Maker

[![CI](https://github.com/abhinavbolla/3d-maker/actions/workflows/ci.yml/badge.svg)](https://github.com/abhinavbolla/3d-maker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**CAD you talk to.** Describe a part or a whole machine, and Claude draws it in 3D, in real dimensions, with parts that move. Look around it, click a part to change it, and export a picture or a file for other apps.

![A helicopter rotor head made in 3D Maker: hub, blade cuffs, pitch links, swashplate, scissors and servos, on a studio floor](docs/rotor-head.png)

> **3D Maker is in early development.** It runs from a clone of this repository, and there is no installer yet.

## What works today

| | |
|---|---|
| Models from a prompt, changed by prompt or by sliders on a part | ✅ |
| Big models built from a plan, each step checked | ✅ |
| Mechanisms that move, with joint and collision checks | ✅ |
| A studio view with materials, and CAD-style navigation | ✅ |
| Export: PNG pictures, STL and 3MF meshes | ✅ |
| 2D drawings: front, top and side views, a section and the overall sizes on an A3 sheet (SVG) | ✅ |
| Dimensions of holes, PDF and DXF drawings, STEP export, video, installers | Planned |

The [roadmap](docs/roadmap.md) has the plan.

## Run it

You need Node 20 or newer and [Claude Code](https://claude.com/claude-code), installed and logged in. The desktop app also needs Rust and Xcode's command line tools.

```bash
npm install
npm run app        # desktop app
npm start          # or in your browser, at http://localhost:5173
```

## Your first model

- **Describe it.** Type "a desk lamp with a weighted base" in the box at the bottom and press Enter. Claude builds it, looks at it, and fixes what looks wrong.
- **Go big.** For a helicopter or an engine, Claude makes a plan and builds it one checked step at a time.
- **Change a part.** Click it, then move its sliders or type "make this longer".
- **Look around.** Drag to turn, right-drag or two fingers to slide, scroll or pinch to zoom. The view cube looks from any side.
- **Undo.** ⌘Z undoes every change, Claude's included.
- **Export** a PNG picture, a drawing sheet (SVG), or a 3MF or STL file.

The [guide](docs/using.md) has every gesture and key, and what Claude can draw.

## Why 3D Maker

- **You describe; Claude draws.** There are no tool palettes to learn. It runs on the Claude Code you already have, with no API key.
- **It is a model, not a picture.** Real millimetres, separate named parts, and mechanisms that are checked as they move.
- **It is yours.** MIT licensed, on our own geometry kernel, and a model is a short script you can read and keep.

## How it works

The prompt box starts your own `claude -p`, which drives the app through an MCP server. Claude writes the model as a short script. Our own kernel turns it into solids with signed distance fields, so joining and cutting shapes cannot fail. [docs/architecture.md](docs/architecture.md) walks through it.

## Benchmarks

On 20 of CADPrompt's 200 parts, every part built, at 0.916 IoGT. Eight complex moving objects average 6.4 out of 10 from a judge. [docs/benchmarks.md](docs/benchmarks.md) has the results and how to run them.

## Limitations

- **Meshes only.** Export is STL and 3MF, not STEP, and curved surfaces are fine meshes, not exact curves.
- **Drawings are a first version.** One A3 sheet with three views, a section and the overall sizes, as SVG. No PDF or DXF yet, and no dimensions of holes.
- **No dragging.** You change a model with prompts and sliders.
- **Fine detail on big parts** is limited by the mesh: a 1 mm engraving on a 10 m fuselage comes out rough.
- **No installer.** It runs from this folder.

The [guide](docs/using.md#limitations) lists the rest.

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security problems privately, as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE). CI checks the license of every dependency.
