// The axis compass: a small drawing of the model's X, Y and Z axes that turns
// with the view, so you can always tell which way the model faces. Click an
// end to look at the model from that side.
const NS = "http://www.w3.org/2000/svg";
const ARM = 30; // length of an axis in the drawing
const ENDS = [
  { axis: "x", sign: 1, view: "right", label: "X", title: "Look from the right (+X)" },
  { axis: "x", sign: -1, view: "left", title: "Look from the left (−X)" },
  { axis: "y", sign: 1, view: "back", label: "Y", title: "Look from the back (+Y)" },
  { axis: "y", sign: -1, view: "front", title: "Look from the front (−Y)" },
  { axis: "z", sign: 1, view: "top", label: "Z", title: "Look from above (+Z)" },
  { axis: "z", sign: -1, view: "bottom", title: "Look from below (−Z)" },
];

const el = (name, attrs = {}, parent) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
};

// svg: an empty <svg> element. onLook(view): an end was chosen.
export function createCompass(svg, { onLook }) {
  svg.setAttribute("viewBox", "-46 -46 92 92");
  const ends = ENDS.map((end) => {
    const g = el("g", { class: `end ${end.axis}${end.label ? "" : " far"}`, role: "button", tabindex: "0", "aria-label": end.title }, svg);
    el("title", {}, g).textContent = end.title;
    const line = end.label ? el("line", { x1: 0, y1: 0 }, g) : null;
    const dot = el("circle", { r: end.label ? 9 : 5 }, g);
    const text = end.label ? el("text", { "text-anchor": "middle", "dominant-baseline": "central" }, g) : null;
    if (text) text.textContent = end.label;
    const look = () => onLook(end.view);
    g.addEventListener("click", look);
    g.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      look();
    });
    return { ...end, g, line, dot, text };
  });

  let order = "";
  return {
    // Redraws for a camera (a three.js camera whose matrixWorld is current).
    update(camera) {
      const m = camera.matrixWorld.elements;
      // Each world axis as the camera sees it: right, up, and towards the eye.
      const seen = { x: [m[0], m[4], m[8]], y: [m[1], m[5], m[9]], z: [m[2], m[6], m[10]] };
      for (const end of ends) {
        const [right, up, near] = seen[end.axis].map((v) => v * end.sign);
        end.near = near;
        const x = (right * ARM).toFixed(2), y = (-up * ARM).toFixed(2);
        end.dot.setAttribute("cx", x);
        end.dot.setAttribute("cy", y);
        end.line?.setAttribute("x2", x);
        end.line?.setAttribute("y2", y);
        end.text?.setAttribute("x", x);
        end.text?.setAttribute("y", y);
        // Ends pointing away from you are drawn fainter.
        end.g.style.opacity = (0.5 + 0.5 * Math.min(1, near + 1)).toFixed(2);
      }
      // Far ends first, so near ones are drawn over them. Only when the order
      // changes: moving an element drops the keyboard focus it holds.
      const sorted = [...ends].sort((a, b) => a.near - b.near);
      const key = sorted.map((end) => end.view).join();
      if (key === order) return;
      order = key;
      for (const end of sorted) svg.appendChild(end.g);
    },
  };
}
