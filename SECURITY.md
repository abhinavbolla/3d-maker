# Security policy

3D Maker starts your own Claude Code on your computer and lets it drive the app, so we take
reports about what reaches that path seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
[Report a vulnerability](https://github.com/abhinavbolla/3d-maker/security/advisories/new)
(Security tab → "Report a vulnerability").

Please include:
- what an attacker could do, and under which conditions;
- steps to reproduce, or a proof of concept;
- the commit you tested.

We'll acknowledge your report within 7 days, keep you updated while we fix it, and credit you in
the advisory unless you'd rather stay anonymous.

## How 3D Maker is put together

- **Claude runs as you.** The app starts your own `claude -p` with only 3D Maker's MCP tools
  allowed, and with Bash, file editing and web tools turned off. 3D Maker never holds or sees
  your Claude credentials.
- **Starting Claude.** The desktop app does it from Rust and only in print mode (`-p`). The
  browser version uses an endpoint in the dev server that only accepts a JSON `POST` from its
  own origin on `localhost`.
- **The MCP bridge.** The MCP server listens on `127.0.0.1` only, on ports 7457 to 7466, and
  only accepts WebSocket connections whose origin is the app itself (the Tauri window, or the
  dev server on a localhost port from 5170 to 5189).
- **Model scripts are code.** A model is a JavaScript script. It runs in a web worker with the
  usual browser globals (`fetch`, `WebSocket`, `self` and others) hidden from it. That hiding
  is a guard against mistakes, not a sandbox, so treat a model file from someone else like any
  other code before you open it.

## Scope

Especially relevant:
- A web page or another program reaching the MCP bridge or the Claude endpoint.
- Anything that lets a prompt, a model file or a web page run commands outside the tools
  3D Maker allows Claude.
- Model scripts escaping the worker to reach the network or your files.

3D Maker is pre-release. There are no supported versions yet; fixes land on `main`.
