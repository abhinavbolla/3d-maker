## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## How it was checked

<!-- Tests added or run. For changes to the kernel or mesher: what you measured (volumes,
     triangle counts, timings). For changes to what Claude is told (mcp/reference.mjs or the
     tool descriptions): a prompt you ran before and after, or benchmark results.
     Screenshots for anything visible. -->

## New dependencies

<!-- One line per new package or crate: why it's needed, and its license
     (MIT, Apache-2.0, BSD or ISC). Or "None". -->

## Checklist

- [ ] `npm test` passes
- [ ] If `src-tauri` changed: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` pass
- [ ] Tests added or updated for new logic
- [ ] README or docs updated if behaviour, the modelling language or commands changed
