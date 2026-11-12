# Security policy

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
[Report a vulnerability](https://github.com/abhinavbolla/3d-maker/security/advisories/new).

Please include what an attacker could do, steps to reproduce, and the commit you tested.

We'll acknowledge your report within 7 days, keep you updated while we fix it, and credit you in
the advisory unless you'd rather stay anonymous.

3D Maker is pre-release. There are no supported versions yet; fixes land on `main`.

## What matters most

3D Maker starts your own Claude Code on your computer and lets it drive the app. Reports about
that path matter most:

- A web page or another program reaching the MCP bridge or the endpoint that starts Claude.
- A prompt, a model file or a web page running commands outside the tools 3D Maker allows Claude.
- A model script escaping its worker to reach the network or your files.

## How it is put together

- **Claude runs as you.** The app starts your own `claude -p` in print mode, with only
  3D Maker's MCP tools allowed and Bash, file editing and web tools turned off. 3D Maker never
  holds or sees your Claude credentials.
- **Starting Claude.** The desktop app does it from Rust. The browser version uses an endpoint
  in the dev server that only accepts a JSON `POST` from its own origin on `localhost`.
- **The MCP bridge** listens on `127.0.0.1` only, on ports 7457 to 7466. It only accepts
  WebSocket connections whose origin is the app itself: the Tauri window, or the dev server on a
  localhost port from 5170 to 5189.
- **Model scripts are code.** A model is a JavaScript script, run in a web worker with `fetch`,
  `WebSocket` and other browser globals hidden from it. That is a guard against mistakes, not a
  sandbox, so treat a model file from someone else like any other code.
