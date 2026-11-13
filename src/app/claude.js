// Runs the user's own Claude Code (the `claude` command they already have and
// are logged in to) for each prompt, with 3D Maker's MCP server attached, and
// streams what it does. Nothing here holds or sees Claude credentials.
//
// The desktop app starts the process from Rust; the browser dev build goes
// through a small endpoint in the Vite dev server (see vite.config.js).
/* global __MCP_SERVER_PATH__, __NODE_PATH__ */
import { REFERENCE } from "../../mcp/reference.mjs";

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

const TOOLS = ["get_model", "set_model", "edit_model", "append_to_model", "set_plan", "finish_step", "check_fit", "screenshot", "export_stl", "export_3mf", "export_drawing", "reference"].map((t) => `mcp__3d-maker__${t}`);

const APP_PROMPT = `You are the modelling assistant inside the 3D Maker app. The user types requests into the app and watches the 3D view while you work. Use only the 3d-maker tools: call get_model before changing an existing model, follow HOW TO WORK below (big or mechanical models are built step by step with set_plan and finish_step; put the plan up within a minute and work out each step's details when you reach it), check your work with screenshots and check_fit, and fix what looks wrong before you finish. Keep your final reply to one or two short sentences about what you made or changed, in plain words. Never paste the script.

The 3D Maker modelling language follows. It is the same text the reference tool returns, so you do not need to call that tool.

${REFERENCE}`;

export function args(prompt, { session, model, windowId }) {
  const mcp = { mcpServers: { "3d-maker": { command: __NODE_PATH__, args: [__MCP_SERVER_PATH__, ...(windowId ? ["--app", windowId] : [])] } } };
  const a = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--mcp-config", JSON.stringify(mcp), "--strict-mcp-config", "--allowedTools", TOOLS.join(","), "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task", "--append-system-prompt", APP_PROMPT];
  if (model) a.push("--model", model);
  if (session) a.push("--resume", session);
  return a;
}

const TOOL_STATUS = {
  get_model: "Reading the model",
  set_model: "Building the model",
  edit_model: "Changing the model",
  append_to_model: "Adding parts",
  set_plan: "Planning",
  finish_step: "Checking the step",
  check_fit: "Checking how the parts fit",
  screenshot: "Looking at it",
  export_stl: "Exporting",
  export_3mf: "Exporting",
  export_drawing: "Making the drawing",
};

// onEvent receives { kind: "session" | "text" | "status" | "done", ... }.
export function createClaude({ onEvent }) {
  let current = null;

  function handleLine(line, run) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.session_id && ev.session_id !== run.session) {
      run.session = ev.session_id;
      onEvent({ kind: "session", id: ev.session_id });
    }
    if (ev.type === "assistant") {
      for (const c of ev.message?.content ?? []) {
        if (c.type === "text" && c.text.trim()) run.texts.push(c.text.trim());
        if (c.type === "tool_use") {
          const name = String(c.name).replace(/^mcp__3d-maker__/, "");
          onEvent({ kind: "status", text: TOOL_STATUS[name] ?? "Working" });
        }
      }
    }
    // A tool finished; Claude is deciding what to do next.
    if (ev.type === "user") onEvent({ kind: "status", text: "Thinking" });
    if (ev.type === "result") {
      run.result = ev;
    }
  }

  function finish(run, { code, stderr, stopped }) {
    if (current === run) current = null;
    if (stopped) return onEvent({ kind: "done", stopped: true });
    const r = run.result;
    if (r && !r.is_error) return onEvent({ kind: "done", text: (r.result || run.texts.at(-1) || "").trim() });
    const why = (r?.result || r?.errors?.join?.("\n") || stderr || "").trim();
    let text = why || `Claude Code stopped (exit code ${code}).`;
    if (/not found|ENOENT|No such file/i.test(text) && !r) text = "Claude Code was not found. Install it from claude.com/claude-code, run `claude` once in a terminal to log in, then try again.";
    else if (/log ?in|auth|OAuth|expired|credential/i.test(text)) text = `Claude Code needs you to log in. Run \`claude\` in a terminal, log in, then try again.\n\n${why}`;
    onEvent({ kind: "done", error: text });
  }

  async function send(prompt, opts = {}) {
    if (current) throw new Error("Claude is already working.");
    const run = { session: opts.session ?? null, texts: [], result: null, stop: null };
    current = run;
    onEvent({ kind: "status", text: "Thinking" });
    const a = args(prompt, opts);
    if (isTauri()) {
      const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
      let id = null;
      const early = [];
      const offLine = await listen("claude-line", ({ payload }) => (id === null ? early.push(payload) : payload.run === id && handleLine(payload.line, run)));
      const offExit = await listen("claude-exit", ({ payload }) => {
        if (payload.run !== id) return;
        offLine();
        offExit();
        finish(run, { code: payload.code, stderr: payload.stderr, stopped: run.stopped });
      });
      try {
        id = await invoke("claude_start", { args: a });
      } catch (err) {
        offLine();
        offExit();
        return finish(run, { code: -1, stderr: String(err) });
      }
      for (const p of early) if (p.run === id) handleLine(p.line, run);
      run.stop = () => invoke("claude_stop", { run: id });
      return;
    }
    const ctl = new AbortController();
    run.stop = () => ctl.abort();
    try {
      const res = await fetch("/api/claude", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: a }), signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      let exit = { code: 0, stderr: "" };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith("\u0000exit ")) exit = JSON.parse(line.slice(6));
          else handleLine(line, run);
        }
      }
      finish(run, exit);
    } catch (err) {
      finish(run, ctl.signal.aborted ? { stopped: true } : { code: -1, stderr: String(err?.message ?? err) });
    }
  }

  return {
    send,
    stop() {
      if (!current) return;
      current.stopped = true;
      current.stop?.();
    },
    busy: () => Boolean(current),
  };
}
