// 3D Maker: type what you want, Claude builds it, click a part to tweak it.
import { createViewport } from "./app/viewport.js";
import { createKernel } from "./app/kernel.js";
import { createStore, emptyDoc } from "./app/store.js";
import { createCommands } from "./app/commands.js";
import { startBridge } from "./app/bridge.js";
import { createClaude } from "./app/claude.js";
import { loadAutosave } from "./app/autosave.js";
import { saveBytes, openText } from "./app/files.js";

const $ = (id) => document.getElementById(id);
const kernel = createKernel();
const store = createStore(kernel, (await loadAutosave()) ?? emptyDoc());

// ---- status line ----
let note = "";
let noteTimer = 0;
function say(text, ms = 4000) {
  note = text;
  clearTimeout(noteTimer);
  if (ms) noteTimer = setTimeout(() => ((note = ""), renderStatus()), ms);
  renderStatus();
}

// ---- viewport ----
const viewport = createViewport($("viewport"), {
  onPick(name) {
    store.select(name);
  },
});

// ---- Claude ----
let working = null; // { prompt, status, started }
const claude = createClaude({
  onEvent(ev) {
    if (ev.kind === "session") store.setSession(ev.id);
    if (ev.kind === "status" && working) working.status = ev.text;
    if (ev.kind === "done") {
      const run = working;
      working = null;
      const receipt = run ? receiptFor(run) : "";
      if (ev.stopped) showReply(run?.prompt ?? "", "Stopped.", { receipt });
      else if (ev.error) showReply(run?.prompt ?? "", ev.error, { error: true, receipt });
      else showReply(run?.prompt ?? "", ev.text || "Done.", { receipt });
    }
    renderAll();
  },
});

const commands = createCommands({ store, viewport, kernel });
let bridgeActivity = "";
const bridge = startBridge(commands, {
  onStatus() {},
  onActivity(method, phase, message) {
    if (working) return countActivity(working, method, phase, message);
    // Show work from Claude clients outside the app (Claude Desktop) too.
    bridgeActivity = phase === "start" ? ({ set_model: "Claude is building the model", edit_model: "Claude is changing the model", screenshot: "Claude is looking at the model" }[method] ?? "") : "";
    renderStatus();
  },
});

// What this window saw happen during a Claude run, counted here rather than
// taken from Claude's reply, so you can tell what Claude actually did.
function countActivity(run, method, phase, message) {
  if (phase === "error") run.failed.push(message ?? method);
  else if (phase === "ok" && (method === "set_model" || method === "edit_model")) run.changes++;
  else if (phase === "ok" && method === "screenshot") run.looks++;
  else if (phase === "ok" && method === "finish_step") (run.steps++, run.looks++);
}
function receiptFor(run) {
  const changed = store.state.doc.script !== run.before;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [];
  if (changed) {
    const n = store.state.result?.parts.length ?? 0;
    parts.push(`Model changed in this window: ${plural(run.changes, "change", "changes")}, now ${plural(n, "part", "parts")}.`);
  } else parts.push("The model in this window was not changed.");
  const plan = store.state.doc.plan;
  if (plan && run.steps) {
    const done = plan.steps.filter((s) => s.done).length;
    const open = plan.steps.filter((s) => !s.done).map((s) => s.name);
    parts.push(done === plan.steps.length ? `Plan: all ${plan.steps.length} steps done and checked.` : `Plan: ${done} of ${plan.steps.length} steps done; not done: ${open.join(", ")}.`);
  }
  if (run.looks) parts.push(`Claude looked at it ${plural(run.looks, "time", "times")}.`);
  if (run.failed.length) parts.push(`${plural(run.failed.length, "step", "steps")} failed and ${run.failed.length === 1 ? "was" : "were"} not applied.`);
  lastReceipt = { changed, changes: run.changes, looks: run.looks, steps: run.steps, failed: run.failed.slice(), seconds: Math.round((Date.now() - run.started) / 1000) };
  return parts.join(" ");
}
let lastReceipt = null;

function showReply(prompt, text, { error = false, receipt = "" } = {}) {
  $("reply").hidden = false;
  $("reply").classList.toggle("error", error);
  $("reply-prompt").textContent = prompt;
  $("reply-text").textContent = text;
  $("reply-receipt").textContent = receipt;
  $("reply-receipt").hidden = !receipt;
}

async function send() {
  const text = $("input").value.trim();
  if (!text || working) return;
  const sel = store.state.selected;
  const prompt = sel ? `The user has selected the part "${sel}".\n\n${text}` : text;
  working = { prompt: text, status: "Thinking", started: Date.now(), before: store.state.doc.script, changes: 0, looks: 0, steps: 0, failed: [] };
  $("input").value = "";
  fitInput();
  $("reply").hidden = true;
  bridge.kick();
  renderAll();
  claude.send(prompt, { session: store.state.doc.session, windowId: bridge.windowId }).catch((err) => {
    working = null;
    showReply(text, String(err.message ?? err), { error: true });
    renderAll();
  });
}

$("prompt").addEventListener("submit", (e) => {
  e.preventDefault();
  if (working) claude.stop();
  else send();
});
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
  if (e.key === "Escape") $("input").blur();
});
function fitInput() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight + 1, 160)}px`;
  t.style.overflowY = t.scrollHeight > 160 ? "auto" : "hidden";
  renderSend();
}
$("input").addEventListener("input", fitInput);

// ---- part card: the selected part's sliders ----
let cardKey = "";
function renderCard() {
  const { selected, result } = store.state;
  const card = $("card");
  if (!selected || !result) {
    card.hidden = true;
    cardKey = "";
    return;
  }
  const params = result.params.filter((p) => p.part === selected || p.part === null);
  const key = selected + "|" + params.map((p) => `${p.key}:${p.min}:${p.max}`).join(",");
  card.hidden = false;
  $("card-name").textContent = selected;
  if (key !== cardKey) {
    cardKey = key;
    $("card-params").replaceChildren(...params.map(paramRow));
  } else {
    // Same sliders: just sync values, without fighting a drag in progress.
    for (const p of params) {
      const row = $("card-params").querySelector(`[data-key="${CSS.escape(p.key)}"]`);
      if (!row || row.contains(document.activeElement)) continue;
      row.querySelector("input[type=range]").value = p.value;
      row.querySelector("input[type=number]").value = fmt(p.value);
    }
  }
  $("card-hint").textContent = params.length ? "Or type below to change it." : "Type below to change this part.";
}

const fmt = (v) => String(Math.round(v * 1000) / 1000);
function paramRow(p) {
  const row = document.createElement("div");
  row.className = "param";
  row.dataset.key = p.key;
  const id = `p-${Math.random().toString(36).slice(2)}`;
  const label = Object.assign(document.createElement("label"), { htmlFor: id, textContent: p.part ? p.label : `${p.label} (whole model)` });
  const number = Object.assign(document.createElement("input"), { type: "number", min: p.min, max: p.max, step: p.step, value: fmt(p.value) });
  number.setAttribute("aria-label", p.label);
  const range = Object.assign(document.createElement("input"), { type: "range", id, min: p.min, max: p.max, step: p.step, value: p.value });
  range.addEventListener("input", () => {
    number.value = fmt(+range.value);
    store.setValue(p.key, +range.value);
  });
  range.addEventListener("change", () => commitValue(p.key, +range.value));
  number.addEventListener("change", () => {
    const v = Math.min(Math.max(+number.value, p.min), p.max);
    if (!Number.isFinite(v)) return;
    range.value = v;
    commitValue(p.key, v);
  });
  row.append(label, number, range);
  return row;
}
function commitValue(key, v) {
  store.setValue(key, v, { final: true }).catch((err) => say(err.message, 8000));
}

$("card-close").addEventListener("click", () => store.select(null));
$("reply-close").addEventListener("click", () => ($("reply").hidden = true));
$("chip-clear").addEventListener("click", () => store.select(null));

// ---- rendering ----
function renderSend() {
  const btn = $("send");
  btn.textContent = working ? "Stop" : store.state.result?.parts.length ? "Send" : "Make";
  btn.classList.toggle("stop", Boolean(working));
  btn.disabled = !working && !$("input").value.trim();
}

// A big model's build plan: "5 of 20 done · Stationary swashplate".
function renderProgress() {
  const plan = store.state.doc.plan;
  const done = plan ? plan.steps.filter((s) => s.done).length : 0;
  const show = Boolean(plan) && (Boolean(working) || done < plan.steps.length);
  $("progress").hidden = !show;
  if (!show) return;
  const next = plan.steps.find((s) => !s.done);
  $("progress-text").textContent = next ? `${done} of ${plan.steps.length} done · ${working ? "now" : "next"}: ${next.name}` : `All ${plan.steps.length} steps done · checking the whole model`;
  $("progress-bar").firstElementChild.style.width = `${(100 * done) / plan.steps.length}%`;
  $("progress").title = plan.steps.map((s) => `${s.done ? "✓" : "·"} ${s.name}`).join("\n");
}

function renderStatus() {
  let text = note;
  if (working) text = `${working.status} · ${Math.round((Date.now() - working.started) / 1000)} s`;
  else if (bridgeActivity) text = bridgeActivity;
  else if (!text && store.state.building) text = "Building";
  $("status").textContent = text;
}
setInterval(() => working && renderStatus(), 1000);

let lastResult = null;
function renderAll() {
  const { result, selected } = store.state;
  if (result && result !== lastResult) {
    lastResult = result;
    viewport.setParts(result.parts);
    viewport.fitIfNew();
  }
  viewport.select(selected);
  const title = result?.title || "";
  $("title").textContent = title || "3D Maker";
  document.title = title ? `${title} · 3D Maker` : "3D Maker";
  $("chip").hidden = !selected;
  $("chip-name").textContent = selected ?? "";
  $("input").placeholder = selected ? `Change ${selected}` : result?.parts.length ? "Describe a change" : "Describe what to make";
  const motion = viewport.hasMotion();
  $("play").hidden = !motion;
  $("play").textContent = viewport.isPlaying() ? "Pause" : "Play";
  renderCard();
  renderSend();
  renderStatus();
  renderProgress();
}
store.subscribe(renderAll);

$("play").addEventListener("click", () => {
  viewport.setPlaying(!viewport.isPlaying());
  renderAll();
});

// ---- file actions ----
const fileName = () => (store.state.result?.title || "model").replace(/[^\w.-]+/g, "-");
const actions = {
  async new() {
    if (!store.state.doc.script) return;
    claude.stop();
    viewport.resetFit();
    $("reply").hidden = true;
    await store.commit(emptyDoc());
    say("New model. Undo brings the previous one back.");
  },
  async open() {
    const file = await openText();
    if (!file) return;
    let doc;
    try {
      doc = JSON.parse(file.text);
      if (doc.version !== 2 || typeof doc.script !== "string") throw new Error();
    } catch {
      return say("That file is not a 3D Maker model.", 6000);
    }
    viewport.resetFit();
    await store.load({ ...emptyDoc(), ...doc, session: null }, file.name).catch((err) => say(err.message, 8000));
    viewport.fitIfNew();
  },
  async save() {
    const { session, ...doc } = store.state.doc;
    const where = await saveBytes(new TextEncoder().encode(JSON.stringify(doc, null, 2)), `${fileName()}.json`, "json");
    if (where) say(`Saved ${where.split("/").pop()}`);
  },
  async export() {
    if (!store.state.result?.parts.length) return say("There is nothing to export yet.");
    say("Exporting", 0);
    try {
      const r = await kernel.exportSTL(store.state.result.parts);
      const where = await saveBytes(r.bytes, `${fileName()}.stl`, "stl");
      say(where ? `Exported ${where.split("/").pop()}` : "");
    } catch (err) {
      say(err.message, 8000);
    }
  },
};
document.querySelectorAll("[data-action]").forEach((b) => b.addEventListener("click", () => actions[b.dataset.action]().catch((err) => say(err.message, 8000))));

addEventListener("keydown", (e) => {
  const typing = e.target.closest?.("textarea, input");
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "s") return e.preventDefault(), actions.save();
  if (mod && e.key.toLowerCase() === "o") return e.preventDefault(), actions.open();
  if (mod && e.key.toLowerCase() === "e") return e.preventDefault(), actions.export();
  if (typing) return;
  if (mod && e.key.toLowerCase() === "z") return e.preventDefault(), e.shiftKey ? store.redo() : store.undo();
  if (e.key === "Escape") return store.select(null);
  if (e.key === "f" && !mod) return viewport.fit();
  if (e.key.length === 1 && !mod && !e.altKey) $("input").focus();
});

// ---- start ----
renderAll();
if (store.state.doc.script) {
  store
    .reload()
    .then(() => viewport.fitIfNew())
    .catch((err) => say(err.message, 8000));
}
$("input").focus();

// Lets the end-to-end test (test/e2e.test.mjs) read what the window shows.
if (import.meta.env.DEV) {
  window.__3dmaker = {
    windowId: bridge.windowId,
    busy: () => Boolean(working),
    plan: () => store.state.doc.plan,
    state: () => ({ script: store.state.doc.script, title: store.state.result?.title ?? "", parts: store.state.result?.parts.map((p) => p.name) ?? [], selected: store.state.selected, session: store.state.doc.session }),
    summary: () => commands.get_model({}),
    select: (name) => store.select(name),
    exportSTL: () => commands.export_stl({}),
    call: (name, args = {}) => commands[name](args),
    reply: () => ({ shown: !$("reply").hidden, prompt: $("reply-prompt").textContent, text: $("reply-text").textContent, receipt: lastReceipt }),
  };
}
