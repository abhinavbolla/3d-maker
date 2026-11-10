// Runs CADPrompt (Alrashedy et al., ICLR 2025: 200 text prompts for single
// CAD parts, each with a ground-truth mesh) through the app with your real
// Claude Code, and scores each result with mesh-score.mjs.
//
// The dataset is not in this repo (it states no licence). Fetch it first:
//   git clone https://github.com/Kamel773/CAD_Code_Generation runs/bench/cadprompt-src
//
// Usage: node test/bench/cadprompt.mjs [--per 5] [--all] [--parallel 3] [--abstract] [--out dir]
//   --per N      N samples from each of the four expert complexity levels (default 5)
//   --all        all 200 samples
//   --abstract   the prompts without measurements (default: with measurements)
// Finished samples are skipped on a rerun, so a stopped run can be resumed.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAILED, score } from "./mesh-score.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const SRC = "runs/bench/cadprompt-src";
const DATA = join(SRC, "CADPrompt");
if (!existsSync(DATA)) {
  console.error(`No dataset in ${SRC}. Fetch it with:\n  git clone https://github.com/Kamel773/CAD_Code_Generation ${SRC}`);
  process.exit(2);
}
const abstract = args.includes("--abstract");
const out = opt("--out", `runs/bench/cadprompt-${abstract ? "abstract" : "measured"}`);
const parallel = Math.min(Number(opt("--parallel", 3)), 4); // the app accepts windows on ports 5170-5189 only
mkdirSync(out, { recursive: true });

// The expert stratification (Simple / Moderate / Complex / Very Complex) from
// the dataset's spreadsheet, read straight out of the .xlsx (a zip of XML).
function strata() {
  const xl = join(SRC, "Data_Stratification.xlsx");
  const unzip = (f) => execFileSync("unzip", ["-p", xl, f], { encoding: "utf8" });
  const strings = [...unzip("xl/sharedStrings.xml").matchAll(/<si>.*?<t[^>]*>(.*?)<\/t>.*?<\/si>/gs)].map((m) => m[1].trim());
  const rows = [...unzip("xl/worksheets/sheet1.xml").matchAll(/<row[^>]*>(.*?)<\/row>/gs)].slice(1);
  return rows.map(([, row]) => {
    const cell = {};
    for (const [, attrs, body] of row.matchAll(/<c ([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      let v = /<v>(.*?)<\/v>/.exec(body ?? "")?.[1] ?? "";
      if (/t="s"/.test(attrs) && v) v = strings[Number(v)];
      cell[/r="([A-Z]+)/.exec(attrs)[1]] = v;
    }
    return { id: String(cell.A).padStart(8, "0"), level: cell.B, mesh: cell.C };
  });
}

const all = strata().filter((s) => existsSync(join(DATA, s.id)));
const per = Number(opt("--per", 5));
const picked = args.includes("--all")
  ? all
  : ["Simple", "Moderate", "Complex", "Very Complex"].flatMap((level) => all.filter((s) => s.level === level).slice(0, per));

// The prompts ask for "Python code using CADQuery"; this app takes the
// object itself, so that request is dropped and the description kept.
export const adapt = (text) => {
  const s = text
    .replace(/\b(?:please\s+)?(?:write|generate|create)\s+(?:a\s+|the\s+)?python\s+code\s+(?:using|with|in)\s+cad\s*query\s+(?:to\s+|that\s+|which\s+)?/gi, "")
    .replace(/\s+using\s+cad\s*query\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const promptOf = (id) =>
  adapt(readFileSync(join(DATA, id, abstract ? "Natural_Language_Descriptions_Prompt.txt" : "Natural_Language_Descriptions_Prompt_with_specific_measurements.txt"), "utf8"));

function runOne(sample, port) {
  const dir = join(out, sample.id);
  return new Promise((done) => {
    const child = spawn(process.execPath, ["test/run-prompt.mjs", promptOf(sample.id), dir], {
      env: { ...process.env, PORT: String(port), TIMEOUT_MIN: "20" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("exit", (code) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "run.log"), log);
      const stl = join(dir, "model.stl");
      let s;
      try {
        s = existsSync(stl) ? { ...score(stl, join(DATA, sample.id, "Ground_Truth.stl")), built: true } : null;
      } catch (e) {
        s = null;
      }
      const seconds = Number(/(\d+) s · /.exec(log)?.[1] ?? NaN);
      const result = { ...sample, exit: code, seconds, ...(s ?? { as_built: FAILED, any_turn: FAILED, built: false }) };
      writeFileSync(join(dir, "score.json"), JSON.stringify(result, null, 1));
      console.log(`${sample.id} ${sample.level.padEnd(12)} ${result.built ? `pc ${result.as_built.pc.toFixed(3)}  haus ${result.as_built.haus.toFixed(3)}  iogt ${result.as_built.iogt.toFixed(3)}` : "FAILED"}  ${seconds} s`);
      done(result);
    });
  });
}

const todo = picked.filter((s) => !existsSync(join(out, s.id, "score.json")));
console.log(`CADPrompt (${abstract ? "abstract" : "with measurements"}): ${picked.length} samples, ${todo.length} to run, ${parallel} at a time → ${out}`);
const queue = [...todo];
await Promise.all(
  Array.from({ length: parallel }, async (_, k) => {
    while (queue.length) await runOne(queue.shift(), 5181 + k);
  }),
);

// ---- summary over every finished sample in the picked set ----
const results = picked.map((s) => join(out, s.id, "score.json")).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")));
const avg = (rs, key, m) => rs.reduce((s, r) => s + r[key][m], 0) / (rs.length || 1);
const row = (name, rs) =>
  `${name.padEnd(13)} ${String(rs.length).padStart(3)}  built ${((100 * rs.filter((r) => r.built).length) / (rs.length || 1)).toFixed(0).padStart(3)}%  ` +
  `pc ${avg(rs, "as_built", "pc").toFixed(3)}  haus ${avg(rs, "as_built", "haus").toFixed(3)}  iogt ${avg(rs, "as_built", "iogt").toFixed(3)}  ` +
  `| any turn: pc ${avg(rs, "any_turn", "pc").toFixed(3)}  iogt ${avg(rs, "any_turn", "iogt").toFixed(3)}`;
const lines = [row("All", results), ...["Simple", "Moderate", "Complex", "Very Complex"].map((l) => row(l, results.filter((r) => r.level === l)))];
const summary = lines.join("\n");
console.log(`\n${summary}`);
writeFileSync(join(out, "summary.txt"), `${summary}\n`);
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
