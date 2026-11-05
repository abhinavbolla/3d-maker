// Keeps the current scene across restarts. The desktop app writes a file in
// its data folder (WebKit flushes localStorage lazily and can lose the last
// edits on quit); a plain browser falls back to localStorage.
const KEY = "3d-maker:autosave";
const isTauri = () => Boolean(window.__TAURI_INTERNALS__);
const invoke = (cmd, args) => import("@tauri-apps/api/core").then(({ invoke }) => invoke(cmd, args));

const valid = (doc) => doc && doc.version === 1 && Array.isArray(doc.nodes);

export async function loadAutosave() {
  try {
    const raw = isTauri() ? await invoke("autosave_read") : localStorage.getItem(KEY);
    const doc = raw && JSON.parse(raw);
    return valid(doc) ? doc : null;
  } catch {
    return null;
  }
}

let timer = 0;
let latest = null;

async function flush() {
  clearTimeout(timer);
  if (!latest) return;
  const text = latest;
  latest = null;
  try {
    if (isTauri()) await invoke("autosave_write", { text });
    else localStorage.setItem(KEY, text);
  } catch {
    // Autosave is a convenience; saving a file is the reliable path.
  }
}

// Debounced so a burst of edits (a gizmo drag, Claude building) writes once.
export function autosave(doc) {
  latest = JSON.stringify(doc);
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
}

window.addEventListener("pagehide", flush);
