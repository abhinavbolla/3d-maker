# Testing

## Without Claude

```bash
npm test                                  # kernel, window routing, plan tools (needs Chrome); CI runs this
npm run licenses                          # every npm package carries an accepted license; CI runs this
node test/check-stl.mjs model.stl         # checks an STL is well formed and closed
node test/check-3mf.mjs model.3mf         # checks a 3MF: zip, names, colours, every part closed
node test/export-run.mjs runs/x/model.js  # loads a saved script and times its STL export
node test/drawing-run.mjs model.js out.svg  # loads a script and saves its drawing sheet
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

## Benchmarks

How to run them, and every result so far, are in [benchmarks.md](benchmarks.md).
