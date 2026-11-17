// The examples on the empty window: a row of small buttons, each opening a
// ready model at once, without Claude. The scripts are loaded only when one
// is chosen, so they add nothing to the app's first load.
import { EXAMPLES } from "../examples/list.js";

const scripts = import.meta.glob(["../examples/*.js", "!../examples/list.js"], { query: "?raw", import: "default" });
const pictures = import.meta.glob("../examples/*.webp", { query: "?no-inline", import: "default", eager: true });

// The placeholder that suggests what to try next: both prompts, or on a
// narrow window, where the box holds one line of about 30 letters, the first.
export const tryText = (ex) => (matchMedia("(max-width: 600px)").matches ? `Try “${ex.try[0]}”` : `Try “${ex.try[0]}” or “${ex.try[1]}”`);

export async function exampleScript(id) {
  const load = scripts[`../examples/${id}.js`];
  if (!load) throw new Error(`There is no example "${id}".`);
  return load();
}

// Fills `box` with one button per example; onOpen(example) runs on a click.
export function showExamples(box, onOpen) {
  box.replaceChildren(
    ...EXAMPLES.map((ex) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.example = ex.id;
      b.title = `Open the ${ex.name.toLowerCase()} and change it`;
      const src = pictures[`../examples/${ex.id}.webp`];
      if (src) b.append(Object.assign(document.createElement("img"), { src, alt: "", width: 40, height: 28, decoding: "async" }));
      b.append(Object.assign(document.createElement("span"), { textContent: ex.name }));
      b.addEventListener("click", () => onOpen(ex));
      return b;
    }),
  );
}
