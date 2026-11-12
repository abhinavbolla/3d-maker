# Contributing to 3D Maker

Thanks for helping.

## How to contribute

1. **Pick something**: an issue, an item from the [roadmap](docs/roadmap.md), or a
   [limitation](docs/using.md#limitations). For anything bigger than a small fix, open an issue
   first so we can agree on the approach.
2. **Fork** the repository and make a branch.
3. **Set up and check.** You need Node 20 or newer and Google Chrome. The desktop app also needs
   Rust and, on macOS, Xcode's command line tools.
   ```bash
   npm install
   npm test
   ```
   If you changed `src-tauri`:
   ```bash
   cd src-tauri
   cargo fmt --check
   cargo clippy --all-targets -- -D warnings
   cargo test
   ```
4. **Open a pull request** against `main` and fill in the template. CI runs the same checks; for
   first-time contributors it runs once a maintainer approves the run.

[docs/testing.md](docs/testing.md) lists every test, including the ones that use your Claude plan.

## Ground rules

1. **Our own code.** Don't paste in code from other CAD kernels or modellers, open source or
   not. Ideas from papers and talks are welcome; write your own implementation.
2. **Permissive dependencies only**: MIT, Apache-2.0, BSD or ISC, with a one-line reason in the
   PR. Fewer is better. CI checks every dependency's license; the few exceptions are named in
   [test/licenses.mjs](test/licenses.mjs) and [src-tauri/deny.toml](src-tauri/deny.toml).
3. **Measure geometry changes.** A change to the kernel or mesher comes with a test that measures
   the result (volume, size, closed mesh), and the before and after numbers in the PR.
4. **Check prompt changes with real runs.** A change to what Claude is told
   ([mcp/reference.mjs](mcp/reference.mjs), or the tool descriptions in
   [mcp/server.mjs](mcp/server.mjs)) needs a prompt run before and after
   (`npm run try -- "..."`), or [benchmark](docs/benchmarks.md) results.
5. **Keep the UI calm.** The app is a prompt box and the model, with no panels of CAD tools.
6. **Small PRs** with [Conventional Commit](https://www.conventionalcommits.org) messages.

## The rest

- **License.** 3D Maker is [MIT licensed](LICENSE), and your contributions are licensed under it too.
- **Security.** Report security problems privately: see [SECURITY.md](SECURITY.md).
- **Conduct.** Everyone taking part follows our [code of conduct](CODE_OF_CONDUCT.md).
