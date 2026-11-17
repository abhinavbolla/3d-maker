#!/usr/bin/env node
// Starts Draftsman's MCP server for the Claude Code plugin. The plugin does not
// carry the server itself: it runs the one that comes with the Draftsman app
// (or with a copy of the repository), so the tools always match the app.
// Looks, in order, at:
//   1. DRAFTSMAN_SERVER (the plugin's "server_path" option), a path to server.mjs;
//   2. the repository this plugin sits in, when it was added from a clone and
//      `npm install` has been run there;
//   3. where the installed app keeps it on macOS, Windows and Linux.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const say = (msg) => console.error(`[draftsman] ${msg}`);

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  say(`Draftsman needs Node.js 20 or newer; this is ${process.version}. Install a newer one from nodejs.org.`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");

function candidates() {
  const out = [];
  const given = process.env.DRAFTSMAN_SERVER?.trim();
  if (given) out.push({ path: resolve(homedir(), given.replace(/^~(?=[/\\]|$)/, homedir())), given: true });
  if (existsSync(join(repo, "node_modules", "@modelcontextprotocol", "sdk"))) out.push({ path: join(repo, "mcp", "server.mjs") });
  if (process.platform === "darwin") {
    for (const apps of ["/Applications", join(homedir(), "Applications")]) out.push({ path: join(apps, "Draftsman.app", "Contents", "Resources", "mcp", "server.mjs") });
  } else if (process.platform === "win32") {
    for (const base of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) if (base) out.push({ path: join(base, "Draftsman", "mcp", "server.mjs") });
  } else {
    for (const base of ["/usr/lib/Draftsman", "/usr/lib/draftsman", "/opt/Draftsman"]) out.push({ path: join(base, "mcp", "server.mjs") });
  }
  return out;
}

const all = candidates();
const given = all.find((c) => c.given);
if (given && !existsSync(given.path)) {
  say(`The server_path option points to ${given.path}, which does not exist. It should be the mcp/server.mjs of a Draftsman checkout (after npm install), or of the installed app.`);
  process.exit(1);
}
const found = all.find((c) => existsSync(c.path));
if (!found) {
  say("Could not find Draftsman's MCP server. Install the Draftsman app (github.com/abhinavbolla/draftsman/releases), or set this plugin's server_path option to the mcp/server.mjs of a Draftsman checkout after npm install.");
  say(`Looked in: ${all.map((c) => c.path).join(", ")}`);
  process.exit(1);
}
say(`starting ${found.path}`);
await import(pathToFileURL(found.path).href);
