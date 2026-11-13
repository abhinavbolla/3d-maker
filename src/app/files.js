// Save, open and export. Uses native dialogs in the desktop app and
// download / file-picker fallbacks in a plain browser.
const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

async function tauri() {
  const [{ invoke }, dialog] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/plugin-dialog")]);
  return { invoke, dialog };
}

const FILTERS = {
  json: { name: "3D Maker model", extensions: ["json"] },
  stl: { name: "STL mesh", extensions: ["stl"] },
  "3mf": { name: "3MF model", extensions: ["3mf"] },
  png: { name: "PNG picture", extensions: ["png"] },
  svg: { name: "SVG drawing", extensions: ["svg"] },
};

// Returns the saved path (or file name in a browser), or null if cancelled.
export async function saveBytes(bytes, defaultName, kind) {
  if (isTauri()) {
    const { invoke, dialog } = await tauri();
    const path = await dialog.save({ defaultPath: defaultName, filters: [FILTERS[kind]] });
    if (!path) return null;
    await invoke("write_file", { path, data: Array.from(bytes) });
    return path;
  }
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return defaultName;
}

// Returns { name, text } or null if cancelled.
export async function openText() {
  if (isTauri()) {
    const { invoke, dialog } = await tauri();
    const path = await dialog.open({ multiple: false, filters: [FILTERS.json] });
    if (!path) return null;
    const text = await invoke("read_file", { path });
    return { name: path.split("/").pop(), text };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, text: await file.text() } : null);
    };
    input.click();
  });
}
