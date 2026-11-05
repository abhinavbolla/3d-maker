// The model document and its history. A document is the model script plus
// slider values; every build runs the script and meshes the parts.
import { autosave } from "./autosave.js";

export const emptyDoc = () => ({ version: 2, script: "", values: {}, session: null });
const HISTORY_LIMIT = 200;

export function createStore(kernel, initial) {
  const listeners = new Set();
  const state = {
    doc: initial ?? emptyDoc(),
    past: [],
    future: [],
    result: null, // last good build
    error: null, // why the last change was not applied
    building: false,
    selected: null, // part name
    fileName: null,
  };
  const emit = () => listeners.forEach((fn) => fn(state));

  // Builds run one at a time; drafts (slider drags) are dropped if a newer one arrives.
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));
  let latestDraft = 0;

  async function build(doc, quality) {
    if (!doc.script.trim()) return { parts: [], params: [], prints: [], warnings: [], title: "" };
    return kernel.build(doc, quality);
  }

  function apply(doc, result, history) {
    if (history && doc !== state.doc) {
      state.past.push(state.doc);
      if (state.past.length > HISTORY_LIMIT) state.past.shift();
      state.future = [];
    }
    state.doc = doc;
    state.result = result;
    state.error = null;
    if (state.selected && !result.parts.some((p) => p.name === state.selected)) state.selected = null;
    autosave(doc);
  }

  // Applies a new document if its script runs; otherwise keeps the current
  // model and throws the script error.
  function commit(doc, { history = true } = {}) {
    latestDraft++;
    return serial(async () => {
      state.building = true;
      emit();
      try {
        const result = await build(doc, "preview");
        if (result.error) {
          state.error = result.error;
          throw new Error(result.error);
        }
        apply(doc, result, history);
        return result;
      } finally {
        state.building = false;
        emit();
      }
    });
  }

  // A quick, low-detail build while a slider moves. Not recorded in history.
  function draft(doc) {
    const ticket = ++latestDraft;
    return serial(async () => {
      if (ticket !== latestDraft) return;
      const result = await build(doc, "draft");
      if (ticket !== latestDraft || result.error) return;
      state.result = result;
      emit();
    });
  }

  const undo = () => {
    if (!state.past.length) return;
    const prev = state.past.pop();
    state.future.push(state.doc);
    return commit(prev, { history: false }).catch(() => {});
  };
  const redo = () => {
    if (!state.future.length) return;
    const next = state.future.pop();
    state.past.push(state.doc);
    return commit(next, { history: false }).catch(() => {});
  };

  function setValue(key, value, { final = false } = {}) {
    const doc = { ...state.doc, values: { ...state.doc.values, [key]: value } };
    return final ? commit(doc) : draft(doc);
  }

  function select(name) {
    state.selected = name;
    emit();
  }

  function setSession(session) {
    state.doc = { ...state.doc, session };
    autosave(state.doc);
  }

  return {
    state,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    commit,
    draft,
    undo,
    redo,
    setValue,
    select,
    setSession,
    reload: () => commit(state.doc, { history: false }),
    load: (doc, fileName) => {
      state.fileName = fileName ?? null;
      return commit(doc);
    },
    emit,
  };
}
