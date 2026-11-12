// Checks that every npm package in package-lock.json carries a license we
// accept: see "Permissive dependencies only" in CONTRIBUTING.md. The desktop
// app's Rust crates are checked by cargo deny, from src-tauri/deny.toml.
//   npm run licenses
import { readFileSync } from "node:fs";

const ALLOWED = new Set(["MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"]);

// Packages under another license, accepted one at a time, each with its reason.
const EXCEPTIONS = [
  { name: /^lightningcss(-|$)/, license: "MPL-2.0", reason: "Vite's CSS minifier: a build tool, used unchanged, and no part of what we ship" },
];

// Whether an SPDX expression such as "(MIT OR Apache-2.0) AND ISC" can be met
// with accepted licenses alone.
function accepted(expression, ok) {
  const words = expression.replace(/[()]/g, " $& ").split(/\s+/).filter(Boolean);
  let at = 0;
  const either = () => {
    let any = both();
    while (words[at] === "OR") {
      at++;
      any = both() || any;
    }
    return any;
  };
  const both = () => {
    let all = one();
    while (words[at] === "AND") {
      at++;
      all = one() && all;
    }
    return all;
  };
  const one = () => {
    const word = words[at++];
    if (word !== "(") return ok(word);
    const inside = either();
    at++; // the closing bracket
    return inside;
  };
  const result = either();
  return result && at === words.length;
}

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const refused = [];
let checked = 0;
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || entry.link) continue; // the project itself, or a link to a folder in it
  checked++;
  const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const license = typeof entry.license === "string" ? entry.license : "";
  const excepted = (id) => EXCEPTIONS.some((e) => e.license === id && e.name.test(name));
  if (!license || !accepted(license, (id) => ALLOWED.has(id) || excepted(id))) refused.push(`${name}@${entry.version}: ${license || "no license stated"}`);
}

if (refused.length) {
  console.error(`${refused.length} of ${checked} npm packages carry a license we don't accept:`);
  for (const line of refused) console.error(`  ${line}`);
  console.error(`Accepted: ${[...ALLOWED].join(", ")}. See "Permissive dependencies only" in CONTRIBUTING.md.`);
  process.exit(1);
}
console.log(`${checked} npm packages checked: all carry an accepted license`);
