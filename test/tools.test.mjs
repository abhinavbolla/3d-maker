// Rules for the MCP tool list. Every Claude client reads the whole list and the
// server instructions at the start of every conversation, so the list is a
// budget, and its words are what the model goes by. This starts the real server
// over stdio, lists its tools as a client does, and checks them.
// Usage: node test/tools.test.mjs [--list] [server.mjs]   (needs neither the app nor Claude)
//
// Where a tool breaks a rule today it is named in KNOWN below, with what is
// wrong, so the test passes. KNOWN may only shrink: an entry that no longer
// applies fails the test until it is removed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
// Another server file can be given, to see that the checks catch what they should.
const server = args.find((a) => !a.startsWith("--")) ?? new URL("../mcp/server.mjs", import.meta.url).pathname;

// The tool list plus the server instructions, as the client receives them
// (JSON.stringify of tools/list's tools, and the instructions text). Raise it
// only on purpose, in the PR that adds the words, saying what they buy.
const BUDGET_BYTES = 32000;

// rule: tool (or tool.argument) -> what is wrong with it today.
const KNOWN = {};

// Abbreviations that are written in capitals and are not shouting.
const ACRONYMS = new Set(["STL", "STEP", "PNG", "SVG", "PDF", "DXF", "OBJ", "MTL", "HTML", "PLY", "GLB", "ISO", "AP214", "3MF", "CAD", "XYZ", "A-A", "US", "JSON", "PLA", "ABS", "PETG"]);
const SHOUTING = /\b(IMPORTANT|MUST|NEVER|ALWAYS|CRITICAL|NOTE|WARNING|DO NOT|ONLY)\b/;
const ADVERTISING = /\b(best|powerful|amazing|seamless(ly)?|state[- ]of[- ]the[- ]art|blazing|ultimate|revolutionary|world[- ]class|cutting[- ]edge|robust|effortless(ly)?|magic(al)?|incredible)\b|!/i;
// Words a user of a CAD app would not use for what a tool does.
const JARGON = /\b(SDF|signed distance|websocket|RPC|payload|invoke|endpoint|base64|stdio|handler|schema)\b/i;
// Argument names that pick one of a few things.
const CHOICE_NAMES = /^(axis|view|format|sheet|mode|kind|side|projection|outline|together|remove|units?|style|material|type|align)$/;
const SUFFIXES = /_(v\d+|\d+|new|old|ex|full|all|alt|more|extra|advanced|simple|basic|raw|real|now|again|tool)$/;
// Leading words that do not say what a tool does.
const NOT_A_VERB = /^(the|a|an|this|tool|use|used|function|helper|returns? the [a-z]+ of this|it)\b/i;

const transport = new StdioClientTransport({ command: process.execPath, args: [server], stderr: "pipe" });
let stderr = "";
transport.stderr.on("data", (d) => (stderr += d));
const client = new Client({ name: "tools-test", version: "1" });
await client.connect(transport);
const { tools } = await client.listTools();
const instructions = client.getInstructions() ?? "";
const serverName = client.getServerVersion()?.name;
// The reference tool answers from the server alone, without the app.
const reference = (await client.callTool({ name: "reference", arguments: {} })).content[0].text;
await client.close();

if (args.includes("--list")) {
  for (const t of tools) console.log(`${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(", ")})`);
}

const names = new Set(tools.map((t) => t.name));
const found = {}; // rule -> key -> message
const report = (rule, key, msg) => ((found[rule] ??= {})[key] = msg);
const firstSentence = (s) => (s.match(/^[\s\S]*?[.:](?=\s|$)/)?.[0] ?? s).trim();

// Every argument, nested ones included, as [key, schema, the descriptions of
// the arguments it sits in, nearest first].
function argumentsOf(tool) {
  const out = [];
  const walk = (schema, prefix, above) => {
    for (const [k, v] of Object.entries(schema?.properties ?? {})) {
      out.push([`${prefix}${k}`, v, above]);
      const here = [v.description, v.items?.description, ...above].filter(Boolean);
      for (const alt of [v, v.items, ...(v.anyOf ?? []), ...(v.items?.anyOf ?? [])]) if (alt?.properties) walk(alt, `${prefix}${k}.`, here);
    }
  };
  walk(tool.inputSchema, `${tool.name}.`, []);
  return out;
}
// A field inside an argument that says it takes another tool's arguments
// ("an object of set_camera's arguments", "as for preview_shots") is described
// there, once: its description is that tool's description of the same field.
const describedIn = new Map(); // tool -> field name -> description
for (const t of tools) {
  const fields = new Map();
  for (const [k, v] of argumentsOf(t)) if (v.description && !fields.has(k.split(".").at(-1))) fields.set(k.split(".").at(-1), v.description);
  describedIn.set(t.name, fields);
}
function descriptionOf(key, v, above) {
  if (v.description) return v.description;
  const field = key.split(".").at(-1);
  for (const text of above) {
    for (const m of text.matchAll(/\b([a-z][a-z0-9_]*)'s arguments|\bas for ([a-z][a-z0-9_]*)/g)) {
      const d = describedIn.get(m[1] ?? m[2])?.get(field);
      if (d) return d;
    }
  }
  return "";
}
const isString = (v) => v.type === "string" || v.anyOf?.some((a) => a.type === "string");
const hasEnum = (v) => Boolean(v.enum || v.anyOf?.some((a) => a.enum));

for (const t of tools) {
  const n = t.name;
  if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(n)) report("snake-case", n, "is not snake_case");
  if (n.length > 32) report("name-length", n, `is ${n.length} characters, more than 32`);
  if (SUFFIXES.test(n)) report("same-intent", n, "ends in a suffix that hides another version of the same tool");
  for (const m of names) if (m !== n && n.startsWith(`${m}_`)) report("same-intent", n, `is ${m} with a suffix: make it an argument of ${m}`);

  const d = t.description ?? "";
  if (!d.trim()) report("description", n, "has no description");
  const first = firstSentence(d);
  if (NOT_A_VERB.test(first) || first.length > 200) report("first-sentence", n, `first sentence (${first.length} characters): ${first.slice(0, 80)}`);
  if (JARGON.test(first)) report("plain-words", n, `first sentence uses ${first.match(JARGON)[0]}`);
  for (const [key, text] of [[n, d], ...argumentsOf(t).map(([k, v]) => [k, v.description ?? ""])]) {
    const caps = text.match(SHOUTING) ?? (text.match(/\b[A-Z][A-Z0-9-]{3,}\b/g) ?? []).find((w) => !ACRONYMS.has(w));
    if (caps) report("no-orders", key, `writes ${[caps].flat()[0]} in capitals`);
    if (ADVERTISING.test(text)) report("no-advertising", key, `advertises: "${text.match(ADVERTISING)[0]}"`);
  }

  for (const [key, v, above] of argumentsOf(t)) {
    const desc = descriptionOf(key, v, above);
    if (!desc) report("argument-description", key, "has no description");
    const arg = key.split(".").at(-1);
    // A choice that also takes a name (a saved view's name) cannot be an enum.
    if (isString(v) && !hasEnum(v) && CHOICE_NAMES.test(arg) && !/\bname\b/.test(desc)) report("enum", key, "picks one of a few things but is a free string");
    if (isString(v) && !hasEnum(v) && /"[^"]+", "[^"]+",? or "[^"]+"/.test(desc)) report("enum", key, "lists its choices in words but is a free string");
    if (/server instructions/.test(desc)) report("names-real-things", key, "points to the server instructions for something they do not hold");
  }
}

// What the instructions and descriptions call a tool must be one.
const argsOfTool = new Map(tools.map((t) => [t.name, new Set(argumentsOf(t).map(([k]) => k.split(".").at(-1)))]));
const argNames = new Set([...argsOfTool.values()].flatMap((a) => [...a]));
const TOOLISH = /\b(?:get|set|edit|append|finish|check|export|hide|section|explode|clear|save|preview|record|show|list|add|remove|delete|load|open)_[a-z0-9_]+\b/g;
for (const [key, text] of [["instructions", instructions], ["reference", reference], ...tools.map((t) => [t.name, t.description])]) {
  for (const w of new Set(text.match(TOOLISH) ?? [])) if (!names.has(w) && !argNames.has(w) && !/_(mm|cm3|g_cm3|seconds|parts|out|edges|view|step|from)$/.test(w)) report("names-real-things", `${key}:${w}`, `names ${w}, which is not a tool`);
}
// The plugin's skill: every tool, argument, result field and script function it
// names in `code` must be one the server or the reference really has.
{
  const skill = readFileSync(new URL("../plugins/draftsman/skills/draftsman/SKILL.md", import.meta.url), "utf8");
  const seen = [instructions, reference, ...tools.map((t) => t.description)].join("\n");
  for (const [, code] of skill.matchAll(/`([^`]+)`/g)) {
    const fn = code.match(/^([a-z][A-Za-z0-9]*)\(\)$/);
    if (fn && !seen.includes(`${fn[1]}(`)) report("skill", code, "is not a function the reference lists");
    if (!/^[a-z][a-z0-9_]*$/.test(code)) continue;
    if (code === serverName || names.has(code) || argNames.has(code) || new RegExp(`\\b${code}\\b`).test(seen)) continue;
    report("skill", code, "is not a tool, an argument, or a word the tools or reference use");
  }
  // An argument named in a paragraph or bullet that names tools must be one of theirs.
  for (const block of skill.split(/\n(?=- |\d+\. |\n)/)) {
    const codes = [...block.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]);
    const own = codes.filter((c) => names.has(c));
    if (!own.length) continue;
    for (const c of codes) if (argNames.has(c) && !names.has(c) && !own.some((t) => argsOfTool.get(t).has(c))) report("skill", `${own.join("/")}.${c}`, `is not an argument of ${own.join(" or ")}`);
  }
  for (const w of new Set(skill.match(TOOLISH) ?? [])) if (!names.has(w) && !argNames.has(w)) report("skill", w, `names ${w}, which is not a tool`);
}
if (!/\breference\b/.test(instructions)) report("instructions", "reference", "the instructions do not send the model to the reference tool");
if (instructions.length > 4096) report("instructions", "length", `${instructions.length} characters; Claude Code cuts instructions off at 4096`);

// ---- compare with KNOWN ----
let failed = 0;
for (const [rule, entries] of Object.entries(found)) {
  for (const [key, msg] of Object.entries(entries)) {
    if (KNOWN[rule]?.[key]) continue;
    console.log(`FAIL ${rule}: ${key} ${msg}`);
    failed++;
  }
}
for (const [rule, entries] of Object.entries(KNOWN)) {
  for (const key of Object.keys(entries)) {
    if (found[rule]?.[key]) continue;
    console.log(`FAIL ${rule}: ${key} is fixed: remove it from KNOWN in test/tools.test.mjs`);
    failed++;
  }
}

// ---- the budget ----
const listBytes = Buffer.byteLength(JSON.stringify(tools));
const instrBytes = Buffer.byteLength(instructions);
const total = listBytes + instrBytes;
const tokens = (b) => Math.round(b / 4);
console.log(`${tools.length} tools: list ${listBytes} bytes, instructions ${instrBytes} bytes, together ${total} bytes, about ${tokens(total)} tokens (ceiling ${BUDGET_BYTES} bytes, about ${tokens(BUDGET_BYTES)} tokens)`);
const heaviest = tools.map((t) => [t.name, Buffer.byteLength(JSON.stringify(t))]).sort((a, b) => b[1] - a[1]).slice(0, 3);
console.log(`heaviest: ${heaviest.map(([n, b]) => `${n} ${b}`).join(", ")}`);
if (total > BUDGET_BYTES) {
  console.log(`FAIL budget: the tool list and instructions are ${total} bytes, over the ceiling of ${BUDGET_BYTES}. Shorten descriptions, fold a tool into another's arguments, or raise BUDGET_BYTES on purpose.`);
  failed++;
}
const knownCount = Object.values(KNOWN).reduce((s, e) => s + Object.keys(e).length, 0);
console.log(`${knownCount} known problems left in KNOWN`);
if (failed) {
  if (stderr && !/ready/.test(stderr)) console.log(stderr);
  console.log(`${failed} problem(s)`);
  process.exit(1);
}
console.log("tool list follows the rules");
process.exit(0);
