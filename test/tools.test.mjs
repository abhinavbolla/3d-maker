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

const args = process.argv.slice(2);
// Another server file can be given, to see that the checks catch what they should.
const server = args.find((a) => !a.startsWith("--")) ?? new URL("../mcp/server.mjs", import.meta.url).pathname;

// The tool list plus the server instructions, as the client receives them
// (JSON.stringify of tools/list's tools, and the instructions text). Raise it
// only on purpose, in the PR that adds the words, saying what they buy.
const BUDGET_BYTES = 23000;

// rule: tool (or tool.argument) -> what is wrong with it today.
const KNOWN = {
  "first-sentence": {
    reference: 'starts with a noun phrase ("The full Draftsman modelling language ...") rather than saying what the tool does',
  },
  "argument-description": {
    "edit_model.old_text": "no description",
    "edit_model.new_text": "no description",
    "append_to_model.code": "no description",
    "screenshot.view": "no description (explained only in the tool's text)",
    "screenshot.part": "no description (explained only in the tool's text)",
    "screenshot.parts": "no description (explained only in the tool's text)",
    "screenshot.width": "no description",
    "screenshot.height": "no description",
    "hide_parts.hide": "no description (explained only in the tool's text)",
    "hide_parts.show": "no description (explained only in the tool's text)",
    "hide_parts.only": "no description (explained only in the tool's text)",
    "hide_parts.all": "no description (explained only in the tool's text)",
    "section_view.axis": "no description (explained only in the tool's text)",
    "section_view.off": "no description (explained only in the tool's text)",
    "explode_view.axis": "no description (explained only in the tool's text)",
    "explode_view.together": "no description (explained only in the tool's text)",
    "measure.part": "no description (explained only in the tool's text)",
    "measure.parts": "no description (explained only in the tool's text)",
    "measure.material": "no description (explained only in the tool's text)",
    "measure.density_g_cm3": "no description (explained only in the tool's text)",
    "measure.between": "no description (explained only in the tool's text)",
    "measure.points": "no description (explained only in the tool's text)",
    "set_plan.steps": "no description (its items' fields have one)",
    "export_drawing.detail.view": "no description (the detail's at and radius have one)",
  },
  enum: {
    "measure.material": "picks one of a list of materials named in the tool's text, but takes any string",
  },
  "names-real-things": {
    "set_model.script": 'says the language is "described in the server instructions"; it is in the reference tool',
  },
};

// Abbreviations that are written in capitals and are not shouting.
const ACRONYMS = new Set(["STL", "STEP", "PNG", "SVG", "PDF", "DXF", "OBJ", "MTL", "PLY", "GLB", "ISO", "AP214", "3MF", "CAD", "XYZ", "A-A", "US", "JSON", "PLA", "ABS", "PETG"]);
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

// Every argument, nested ones included, as [key, schema].
function argumentsOf(tool) {
  const out = [];
  const walk = (schema, prefix) => {
    for (const [k, v] of Object.entries(schema?.properties ?? {})) {
      out.push([`${prefix}${k}`, v]);
      for (const alt of [v, v.items, ...(v.anyOf ?? []), ...(v.items?.anyOf ?? [])]) if (alt?.properties) walk(alt, `${prefix}${k}.`);
    }
  };
  walk(tool.inputSchema, `${tool.name}.`);
  return out;
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

  for (const [key, v] of argumentsOf(t)) {
    if (!v.description) report("argument-description", key, "has no description");
    const arg = key.split(".").at(-1);
    if (isString(v) && !hasEnum(v) && CHOICE_NAMES.test(arg)) report("enum", key, "picks one of a few things but is a free string");
    if (isString(v) && !hasEnum(v) && /"[^"]+", "[^"]+",? or "[^"]+"/.test(v.description ?? "")) report("enum", key, "lists its choices in words but is a free string");
    if (/server instructions/.test(v.description ?? "")) report("names-real-things", key, "points to the server instructions for something they do not hold");
  }
}

// What the instructions and descriptions call a tool must be one.
const TOOLISH = /\b(?:get|set|edit|append|finish|check|export|hide|section|explode|clear|save|preview|record|show|list|add|remove|delete|load|open)_[a-z0-9_]+\b/g;
for (const [key, text] of [["instructions", instructions], ["reference", reference], ...tools.map((t) => [t.name, t.description])]) {
  for (const w of new Set(text.match(TOOLISH) ?? [])) if (!names.has(w) && !/_(mm|cm3|g_cm3|seconds|parts|out|edges|view|step|from)$/.test(w)) report("names-real-things", `${key}:${w}`, `names ${w}, which is not a tool`);
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
