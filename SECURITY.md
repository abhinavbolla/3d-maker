# Security policy

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
[Report a vulnerability](https://github.com/abhinavbolla/draftsman/security/advisories/new).

Please include what an attacker could do, steps to reproduce, and the commit you tested.

We'll acknowledge your report within 7 days, keep you updated while we fix it, and credit you in
the advisory unless you'd rather stay anonymous.

Draftsman is pre-release. There are no supported versions yet; fixes land on `main`.

## What matters most

Draftsman starts your own Claude Code on your computer and lets it drive the app. Reports about
that path matter most:

- A web page or another program reaching the MCP bridge or the endpoint that starts Claude.
- A prompt, a model file or a web page running commands outside the tools Draftsman allows Claude.
- A model script escaping its worker to reach the network or your files.

## How it is put together

- **Claude runs as you.** The app starts your own `claude -p` in print mode, with only
  Draftsman's MCP tools allowed and Bash, file editing and web tools turned off. Draftsman never
  holds or sees your Claude credentials.
- **Starting Claude.** The desktop app does it from Rust. The browser version uses an endpoint
  in the dev server that only accepts a JSON `POST` from its own origin on `localhost`.
- **The MCP bridge** listens on `127.0.0.1` only, on ports 7457 to 7466. It only accepts
  WebSocket connections whose origin is the app itself: the Tauri window, or the dev server on a
  localhost port from 5170 to 5189.
- **Model scripts are code.** A model is a JavaScript script, run in a web worker with `fetch`,
  `WebSocket` and other browser globals hidden from it. That is a guard against mistakes, not a
  sandbox, so treat a model file from someone else like any other code.
- **Model scripts with no app window open.** The MCP server then runs scripts itself
  ([mcp/headless.mjs](mcp/headless.mjs)), where a script would otherwise have the user's files,
  shell and network, without Claude Code asking first. So each kernel worker is a separate Node
  process inside a boundary:
  - Node's permission model (`--permission`): it may read only the kernel's own code (in a
    checkout `mcp/kernel-process.mjs`, `src/kernel/` and `package.json`; in the installed app the
    one bundled server file) and write no files, and it may not start processes or worker
    threads, load add-ons, use WASI or open the inspector.
  - An empty environment, so no tokens or keys to read; `node:sqlite` turned off; and
    `process.kill`, `process.binding` and the like removed, since signals to other processes are
    outside Node's permission model.
  - The network: Node's permission model covers it only from Node 25. On macOS the process also
    runs under the system sandbox (`sandbox-exec`, with network, file writes, forking and signals
    to other processes denied), whatever the Node version. On Linux and Windows before Node 25
    there is nothing to keep a script off the network, so the server refuses to build without a
    window there and says why.
  - What it does not cover: a script can still use as much CPU and memory as it likes (the
    kernel's time limits stop a job, as in the app); it can send made-up results back to the
    server over its own channel, which the server treats as model data, never as commands; it
    can learn what the kernel's own files say. Node calls its permission model a seat belt that
    "does not provide security guarantees in the presence of malicious code", and
    `sandbox-exec` is deprecated by Apple though still shipped; the macOS sandbox is the
    stronger of the two. `test/headless.test.mjs` tries the escapes (reading, writing, running
    a command, connecting over TCP, HTTP and UDP, the inspector, signals, the environment) and
    checks that each one fails and leaves nothing behind.
