// Save, open and export. Uses native dialogs in the desktop app and
// download / file-picker fallbacks in a plain browser.
import { mtlFileName } from "../kernel/obj.js";

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

async function tauri() {
  const [{ invoke }, dialog] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/plugin-dialog")]);
  return { invoke, dialog };
}

const FILTERS = {
  json: { name: "Draftsman model", extensions: ["json"] },
  stl: { name: "STL mesh", extensions: ["stl"] },
  "3mf": { name: "3MF model", extensions: ["3mf"] },
  step: { name: "STEP model", extensions: ["step", "stp"] },
  png: { name: "PNG picture", extensions: ["png"] },
  svg: { name: "SVG drawing", extensions: ["svg"] },
  mp4: { name: "MP4 video", extensions: ["mp4"] },
  webm: { name: "WebM video", extensions: ["webm"] },
  pdf: { name: "PDF drawing", extensions: ["pdf"] },
  dxf: { name: "DXF drawing", extensions: ["dxf"] },
  glb: { name: "glTF binary", extensions: ["glb"] },
  obj: { name: "OBJ mesh", extensions: ["obj"] },
  ply: { name: "PLY mesh", extensions: ["ply"] },
};
// Files this big go to the desktop app as raw bytes, not as a list of
// numbers in JSON, which for a video of tens of megabytes would be a few
// hundred megabytes of text.
const RAW_FROM = 4 * 1024 * 1024;

// Returns the saved path (or file name in a browser), or null if cancelled.
export async function saveBytes(bytes, defaultName, kind) {
  if (isTauri()) {
    const { invoke, dialog } = await tauri();
    const path = await dialog.save({ defaultPath: defaultName, filters: [FILTERS[kind]] });
    if (!path) return null;
    if (bytes.length >= RAW_FROM) await invoke("write_bytes", bytes, { headers: { path: encodeURIComponent(path) } });
    else await invoke("write_file", { path, data: Array.from(bytes) });
    return path;
  }
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  a.click();
  // A big file can take a while to hand over to the download.
  setTimeout(() => URL.revokeObjectURL(a.href), bytes.length > RAW_FROM ? 60000 : 1000);
  return defaultName;
}

// An OBJ and its MTL beside it. objBytes(mtlName) gives the OBJ, which names
// its MTL, once the file's name is known. Returns as saveBytes does.
export async function saveOBJ(objBytes, mtlBytes, defaultName) {
  if (isTauri()) {
    const { invoke, dialog } = await tauri();
    const path = await dialog.save({ defaultPath: defaultName, filters: [FILTERS.obj] });
    if (!path) return null;
    const mtl = mtlFileName(path);
    await invoke("write_file", { path, data: Array.from(objBytes(mtl)) });
    await invoke("write_file", { path: path.replace(/[^\\/]*$/, mtl), data: Array.from(mtlBytes) });
    return path;
  }
  const mtl = mtlFileName(defaultName);
  await saveBytes(objBytes(mtl), defaultName, "obj");
  await saveBytes(mtlBytes, mtl, "obj");
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
