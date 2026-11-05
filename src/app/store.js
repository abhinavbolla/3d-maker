// App state: the document, undo history, selection and the latest build.
// Every edit goes through commit(), which rebuilds the geometry and rejects
// edits that break a shape that was fine before.
import { emptyDoc } from "../model/schema.js";
import { findNode } from "../model/ops.js";
import { autosave } from "./autosave.js";

const HISTORY_LIMIT = 200;

export function createStore(kernel, initialDoc) {
  const listeners = new Set();
  const state = {
    doc: initialDoc ?? emptyDoc(),
    past: [],
    future: [],
    selection: null, // node id
    build: new Map(), // id -> result from the worker
    ghost: null,
    building: false,
    fileName: "Untitled",
    dirty: false,
  };

  const emit = (what) => listeners.forEach((fn) => fn(state, what));
  let queue = Promise.resolve();

  async function rebuild() {
    state.building = true;
    emit("building");
    try {
      const ghostId = state.selection && findNode(state.doc, state.selection)?.parent ? state.selection : null;
      const { results, ghost } = await kernel.build(state.doc, ghostId);
      state.build = new Map(results.map((r) => [r.id, r]));
      state.ghost = ghost;
    } finally {
      state.building = false;
    }
    emit("build");
    return state.build;
  }

  const errorsOf = (build) => new Map([...build].filter(([, r]) => r.error).map(([id, r]) => [id, r.error]));

  // Serialise all edits so concurrent UI and Claude edits cannot interleave.
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  function commit(nextDoc, { selection, history = true } = {}) {
    return serial(async () => {
      const prevDoc = state.doc;
      const prevErrors = errorsOf(state.build);
      state.doc = nextDoc;
      if (selection !== undefined) state.selection = selection;
      if (state.selection && !findNode(nextDoc, state.selection)) state.selection = null;
      const build = await rebuild();
      const fresh = [...errorsOf(build)].filter(([id, msg]) => prevErrors.get(id) !== msg);
      if (fresh.length) {
        state.doc = prevDoc;
        if (state.selection && !findNode(prevDoc, state.selection)) state.selection = null;
        await rebuild();
        emit("doc");
        throw new Error(fresh.map(([, msg]) => msg).join("; ") + " The change was not applied.");
      }
      if (history) {
        state.past.push(prevDoc);
        if (state.past.length > HISTORY_LIMIT) state.past.shift();
        state.future = [];
      }
      state.dirty = true;
      autosave(state.doc);
      emit("doc");
      return build;
    });
  }

  function step(from, to) {
    return serial(async () => {
      if (!from.length) return false;
      to.push(state.doc);
      state.doc = from.pop();
      if (state.selection && !findNode(state.doc, state.selection)) state.selection = null;
      await rebuild();
      autosave(state.doc);
      emit("doc");
      return true;
    });
  }

  return {
    state,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    commit,
    undo: () => step(state.past, state.future),
    redo: () => step(state.future, state.past),
    // Replace the whole document (open file, new scene). Undoable.
    load: (doc, fileName) => {
      if (fileName) state.fileName = fileName;
      return commit(doc, { selection: null }).then((b) => ((state.dirty = false), emit("doc"), b));
    },
    select: (id) => {
      if (state.selection === id) return;
      const wasNested = state.selection && findNode(state.doc, state.selection)?.parent;
      state.selection = id;
      emit("selection");
      const isNested = id && findNode(state.doc, id)?.parent;
      if (wasNested || isNested) serial(rebuild);
    },
    rebuild: () => serial(rebuild),
  };
}
