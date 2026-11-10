// Our own benchmark of complex, moving objects (test/bench/objects.json).
// Each prompt runs through the app with your real Claude Code; then a fresh
// Claude, which sees only the prompt and the pictures (not the builder's
// reply), judges the result. Checks the app measures itself are reported
// next to the judge's scores.
//
// Usage: node test/bench/objects.mjs [--only id,id] [--parallel 3] [--out dir] [--judge-only]
// Finished objects are skipped on a rerun; --judge-only rejudges saved runs.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const out = opt("--out", "runs/bench/objects");
const parallel = Math.min(Number(opt("--parallel", 3)), 4); // the app accepts windows on ports 5170-5189 only
const only = opt("--only", "")?.split(",").filter(Boolean);
const objects = JSON.parse(readFileSync("test/bench/objects.json", "utf8")).filter((o) => !only.length || only.includes(o.id));
mkdirSync(out, { recursive: true });

const run = (cmd, argv, env = {}) =>
  new Promise((done) => {
    const child = spawn(cmd, argv, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("exit", (code) => done({ code, log }));
  });

const KEYS = ["recognisable", "proportions", "form", "detail", "mechanism"];
const RUBRIC = `Score each from 1 to 10, where 10 is "looks like a professional 3D model of the real thing" and 1 is "unrecognisable":
- recognisable: would someone name the object from the pictures alone?
- proportions: sizes and ratios of the main parts match the real object
- form: surfaces look like the real one (flowing bodies, real cross-sections), not boxes and tubes
- detail: the parts a real one has are there and look right
- mechanism: the moving parts the prompt asks for exist and are built so they could work (10 if the prompt asks for none)`;

async function judge(o, dir) {
  const pics = ["iso", "front", "top"].map((v) => resolve(dir, `${v}.png`)).filter(existsSync);
  if (!pics.length) return null;
  const text = `You are judging a 3D model made from this request: "${o.prompt}".
Look at these renders of it (Read each file): ${pics.join(", ")}. The views are iso, side (named "front") and top.
${RUBRIC}
Be strict and specific. Reply with only a JSON object: {"recognisable":n,"proportions":n,"form":n,"detail":n,"mechanism":n,"worst":["the 3 most obvious ways it differs from the real thing"]}`;
  // One look is noisy (±1 on a 10-point scale), so three independent looks
  // are averaged; the "worst" list is the first look's.
  const looks = await Promise.all([0, 1, 2].map(async () => {
    const { log } = await run("claude", ["-p", text, "--allowedTools", "Read", "--output-format", "json"]);
    try {
      return JSON.parse(/\{[\s\S]*\}/.exec(JSON.parse(log).result)[0]);
    } catch {
      return null;
    }
  }));
  const ok = looks.filter((l) => l && KEYS.every((k) => typeof l[k] === "number"));
  if (!ok.length) return { error: "the judge gave no scores" };
  const j = Object.fromEntries(KEYS.map((k) => [k, +(ok.reduce((t, l) => t + l[k], 0) / ok.length).toFixed(1)]));
  j.overall = +(KEYS.reduce((t, k) => t + j[k], 0) / KEYS.length).toFixed(1);
  const per = ok.map((l) => KEYS.reduce((t, k) => t + l[k], 0) / KEYS.length);
  j.spread = +(Math.max(...per) - Math.min(...per)).toFixed(1);
  j.looks = ok.length;
  j.worst = ok[0].worst;
  return j;
}

async function one(o, port) {
  const dir = join(out, o.id);
  if (!args.includes("--judge-only")) {
    const { log } = await run(process.execPath, ["test/run-prompt.mjs", o.prompt, dir], { PORT: String(port), TIMEOUT_MIN: "40" });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.log"), log);
  }
  const r = existsSync(join(dir, "result.json")) ? JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) : null;
  const checks = r
    ? {
        seconds: r.seconds,
        parts: r.summary.parts.length,
        stl_closed: r.stl.closed,
        overlaps: r.fit?.overlaps.length ?? null,
        joints: r.summary.motion?.joints?.length ?? 0,
      }
    : { failed: true };
  const score = { id: o.id, prompt: o.prompt, checks, judge: await judge(o, dir) };
  writeFileSync(join(dir, "score.json"), JSON.stringify(score, null, 1));
  console.log(`${o.id.padEnd(13)} ${score.judge?.overall ?? "–"}/10  ${JSON.stringify(checks)}`);
  return score;
}

const todo = objects.filter((o) => args.includes("--judge-only") || !existsSync(join(out, o.id, "score.json")));
console.log(`${objects.length} objects, ${todo.length} to run, ${parallel} at a time → ${out}`);
const queue = [...todo];
await Promise.all(Array.from({ length: parallel }, async (_, k) => { while (queue.length) await one(queue.shift(), 5185 + k); }));

const scores = objects.map((o) => join(out, o.id, "score.json")).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")));
const keys = ["recognisable", "proportions", "form", "detail", "mechanism", "overall"];
const lines = [
  `${"object".padEnd(13)} ${keys.map((k) => k.slice(0, 5).padStart(6)).join("")}   parts overl  time`,
  ...scores.map((s) => `${s.id.padEnd(13)} ${keys.map((k) => String(s.judge?.[k] ?? "–").padStart(6)).join("")}   ${String(s.checks.parts ?? "–").padStart(5)} ${String(s.checks.overlaps ?? "–").padStart(5)} ${String(s.checks.seconds ?? "–").padStart(5)}`),
];
const judged = scores.filter((s) => typeof s.judge?.overall === "number");
const mean = (k) => (judged.reduce((t, s) => t + s.judge[k], 0) / (judged.length || 1)).toFixed(1);
lines.push(`${`mean of ${judged.length}`.padEnd(13)} ${keys.map((k) => mean(k).padStart(6)).join("")}`);
console.log(`\n${lines.join("\n")}`);
writeFileSync(join(out, "summary.txt"), `${lines.join("\n")}\n`);
