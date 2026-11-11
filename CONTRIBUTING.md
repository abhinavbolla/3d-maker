# Contributing to 3D Maker

Thanks for helping! 3D Maker is CAD you talk to: you describe a part or a machine, your own
Claude Code draws it in 3D on our signed-distance-field kernel, and you change it by pointing at
parts.

## How to contribute

1. **Pick something.** Anything in the issue tracker, an item from the
   [roadmap](docs/roadmap.md), or a limitation from the [README](README.md#limitations). For anything bigger than a small fix, open an issue first so
   we can agree on the approach.
2. **Fork** the repository and create a branch in your fork.
3. **Set up and check.** You need Node 20 or newer and Google Chrome (the app tests run in
   headless Chrome). The desktop app also needs Rust and, on macOS, Xcode's command line tools.
   ```bash
   npm install
   npm test                 # kernel, window routing and app commands; no Claude needed
   ```
   If you changed `src-tauri`:
   ```bash
   cd src-tauri
   cargo fmt --check
   cargo clippy --all-targets -- -D warnings
   cargo test
   ```
4. **Open a pull request** against `main` and fill in the template. CI runs the same checks. For
   first-time contributors it runs once a maintainer approves the run.

`main` is protected: every change goes through a pull request with passing CI.

## Ground rules

1. **Our own code.** The kernel, mesher, fit checks, font and file writers are written here. Don't
   paste in code from other CAD kernels or modellers, open source or not. Ideas from papers and
   talks are welcome; write your own implementation.
2. **Permissive dependencies only.** A new dependency needs a one-line reason in the PR and an
   MIT, Apache-2.0, BSD or ISC license. Fewer is better: the kernel has none.
3. **Measure geometry changes.** Changes to the kernel or mesher come with a test that checks the
   result by measuring it (volume, size, closed mesh), and the before and after numbers that
   matter (triangles, time, error) in the PR.
4. **Check prompt changes with real runs.** Changes to what Claude is told
   ([mcp/reference.mjs](mcp/reference.mjs) or the tool descriptions in
   [mcp/server.mjs](mcp/server.mjs)) need a prompt run before and after
   (`npm run try -- "..."`), or results from the [benchmarks](docs/benchmarks.md).
5. **Keep the UI calm.** The app is a prompt box and the model. Changes happen through prompts
   and the sliders on a selected part, not through panels of CAD tools.
6. **Small PRs** with [Conventional Commit](https://www.conventionalcommits.org) messages
   (`feat:`, `fix:`, `perf:`, `docs:`, `test:`, `chore:`).

## Tests that use Claude

`npm run test:e2e`, `npm run try` and the benchmarks run your real Claude Code and use your Claude
plan, so CI doesn't run them. Run the ones your change touches and say so in the PR.
`node test/mcp.test.mjs` drives an app window you already have open.

## License

3D Maker is licensed under the [MIT License](LICENSE). By contributing, you agree that your
contributions are licensed under it too.

## Security

Please don't report security problems in public issues. See [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part follows our [code of conduct](CODE_OF_CONDUCT.md).
