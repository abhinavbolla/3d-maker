# Working on Draftsman

Draftsman is CAD you talk to: a full-window 3D view and one prompt box. The user's own Claude Code
drives the app through an MCP server (`mcp/server.mjs`) and writes model scripts for our own
signed-distance-field kernel (`src/kernel`), which runs in web workers inside the app.

These rules come from [CONTRIBUTING.md](CONTRIBUTING.md). Each says what enforces it.

## Hard rules

1. **Our own code.** Do not paste or port code from other CAD kernels, modellers, exporters or
   libraries, open source or not. File-format specifications, papers and standards are fine to
   work from. *Enforced by:* review.
2. **Permissive dependencies only**: MIT, Apache-2.0, BSD or ISC, with a one-line reason in the
   PR. Fewer is better. *Enforced by:* `node test/licenses.mjs` (`npm run licenses`) and
   `cargo deny` with [src-tauri/deny.toml](src-tauri/deny.toml), both in CI.
3. **Measure geometry changes.** A change to the kernel or mesher comes with a test that measures
   the result (volume, size, closed mesh), and the before and after numbers in the PR.
   *Enforced by:* `node test/kernel.test.mjs` in `npm test`, and review of the numbers.
4. **Check prompt changes with a real run.** A change to what Claude is told (`mcp/reference.mjs`,
   or the tool descriptions in `mcp/server.mjs`) needs a prompt run before and after
   (`npm run try -- "..."`), or [benchmark](docs/benchmarks.md) results. *Enforced by:* review;
   `node test/tools.test.mjs` (in `npm test`) checks the tool list's rules and size budget.
5. **A calm, prompt-first UI.** The app is a prompt box and the model, with no panels of CAD
   tools. New abilities are reached by prompt, as an MCP tool Claude calls. *Enforced by:* review.
6. **Small PRs** with [Conventional Commit](https://www.conventionalcommits.org) messages
   (`feat(view): ...`, `fix(mesh): ...`). *Enforced by:* review.
7. **Never run `test/mcp.test.mjs`.** It loads models into, screenshots and exports from the
   Draftsman window open on this machine, which is the person's own work. *Enforced by:* it is in
   neither `npm test` nor CI; only a person runs it, by hand.

`npm test` must pass before a PR (CI runs it). It runs the kernel, bridge, tool-list and app
tests; the app test needs Google Chrome. [docs/testing.md](docs/testing.md) lists every test,
including the ones that spend a Claude plan.

## Working on X, read Y

| Working on | Read first |
|---|---|
| How the pieces fit together | [docs/architecture.md](docs/architecture.md) |
| What the app does, for users | [docs/using.md](docs/using.md) |
| What comes next | [docs/roadmap.md](docs/roadmap.md) |
| Tests, and which use a Claude plan | [docs/testing.md](docs/testing.md) |
| The kernel: shapes, distance functions | [src/kernel/sdf.js](src/kernel/sdf.js), [src/kernel/script.js](src/kernel/script.js) |
| Meshing | [src/kernel/mesh.js](src/kernel/mesh.js), [src/kernel/pieces.js](src/kernel/pieces.js) |
| Fit checks and motion | [src/kernel/fit.js](src/kernel/fit.js), [src/kernel/motion.js](src/kernel/motion.js) |
| Exports (STL, 3MF, STEP, glTF, OBJ, PLY) | [src/kernel](src/kernel) (`step.js`, `brep.js`, `gltf.js`, ...), [src/app/files.js](src/app/files.js) |
| Drawings | [src/kernel/drawing.js](src/kernel/drawing.js), [src/app/sheet.js](src/app/sheet.js) |
| The 3D view | [src/app/viewport.js](src/app/viewport.js), [src/app/navigate.js](src/app/navigate.js) |
| What Claude is told, and its tools | [mcp/reference.mjs](mcp/reference.mjs), [mcp/server.mjs](mcp/server.mjs), [src/app/claude.js](src/app/claude.js) |
| Tool calls inside the app | [src/app/commands.js](src/app/commands.js), [src/app/bridge.js](src/app/bridge.js) |
| The Claude Code plugin and its skill | [plugins/draftsman](plugins/draftsman), [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json) |
| The desktop app | [src-tauri](src-tauri), [docs/releasing.md](docs/releasing.md) |
| Benchmarks | [docs/benchmarks.md](docs/benchmarks.md) |
| Security of the bridge | [SECURITY.md](SECURITY.md) |
