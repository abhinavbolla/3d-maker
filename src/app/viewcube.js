// The view cube: a small cube in the corner that turns with the model, with
// its sides named and the X, Y and Z axes drawn from one corner, as CAD
// programs have. Click a side, an edge or a corner to look from there; drag
// the cube to turn the view.
const NS = "http://www.w3.org/2000/svg";
const HALF = 27; // half the cube's edge, px
const REACH = 2 * HALF + 13; // how far each axis runs from its corner, px
const DRAG_START = 4; // px a press may move and still count as a click
// Each side: the way it faces (n), and the way its name reads on it (a: to
// the right, d: downwards), in the model's axes.
const SIDES = [
  { name: "Top", n: [0, 0, 1], a: [1, 0, 0], d: [0, -1, 0] },
  { name: "Bottom", n: [0, 0, -1], a: [1, 0, 0], d: [0, 1, 0] },
  { name: "Front", n: [0, -1, 0], a: [1, 0, 0], d: [0, 0, -1] },
  { name: "Back", n: [0, 1, 0], a: [-1, 0, 0], d: [0, 0, -1] },
  { name: "Right", n: [1, 0, 0], a: [0, 1, 0], d: [0, 0, -1] },
  { name: "Left", n: [-1, 0, 0], a: [0, -1, 0], d: [0, 0, -1] },
];
const AXES = [
  { name: "x", along: [1, 0, 0] },
  { name: "y", along: [0, 1, 0] },
  { name: "z", along: [0, 0, 1] },
];
const CORNER = [-HALF, -HALF, -HALF]; // where the axes start: left, front, bottom

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// "top front right" for a direction to look from.
const sideNames = ([x, y, z]) => [z > 0 ? "top" : z < 0 ? "bottom" : "", y < 0 ? "front" : y > 0 ? "back" : "", x > 0 ? "right" : x < 0 ? "left" : ""].filter(Boolean).join(" ");

// root: an empty element. onLook([x, y, z]): look from that direction.
// onTurn(dx, dy): the cube was dragged that many px. onTurning(on): a drag
// of the cube has started or ended.
export function createViewCube(root, { onLook, onTurn, onTurning }) {
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "View cube. Choose a side, an edge or a corner to look from there.");

  const svg = root.appendChild(document.createElementNS(NS, "svg"));
  svg.setAttribute("viewBox", "-50 -50 100 100");
  svg.setAttribute("aria-hidden", "true");
  const axes = AXES.map((axis) => {
    const line = svg.appendChild(document.createElementNS(NS, "line"));
    const text = svg.appendChild(document.createElementNS(NS, "text"));
    line.setAttribute("class", axis.name);
    text.setAttribute("class", axis.name);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.textContent = axis.name.toUpperCase();
    return { ...axis, line, text };
  });

  const sides = SIDES.map((side) => {
    const face = root.appendChild(document.createElement("div"));
    face.className = "face";
    // Nine places to click: the side itself, its four edges and four corners.
    for (const row of [-1, 0, 1]) {
      for (const col of [-1, 0, 1]) {
        const from = side.n.map((v, i) => v + col * side.a[i] + row * side.d[i]);
        const zone = face.appendChild(document.createElement("button"));
        zone.type = "button";
        zone.title = `Look from the ${sideNames(from)}`;
        zone.setAttribute("aria-label", zone.title);
        if (row || col) zone.tabIndex = -1;
        else zone.textContent = side.name;
        zone.addEventListener("click", () => onLook(from));
      }
    }
    return { ...side, face };
  });

  // Dragging the cube turns the view. The pointer is captured only once the
  // drag starts, so a plain click still reaches the place it was made on.
  let drag = null; // { x, y, id, turning }
  const stop = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    if (drag.turning) {
      root.classList.remove("turning");
      onTurning(false);
    }
    drag = null;
  };
  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    stop();
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId, turning: false };
  });
  root.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (e.pointerType === "mouse" && e.buttons === 0) return stop();
    if (!drag.turning) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) <= DRAG_START) return;
      drag.turning = true;
      try {
        root.setPointerCapture(e.pointerId);
      } catch {
        // A pointer that is already gone cannot be captured; the drag still works over the cube.
      }
      root.classList.add("turning");
      onTurning(true);
    }
    onTurn(e.clientX - drag.x, e.clientY - drag.y);
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  root.addEventListener("pointerup", stop);
  root.addEventListener("pointercancel", stop);
  root.addEventListener("lostpointercapture", stop);
  window.addEventListener("blur", () => stop());

  const px = (v) => v.toFixed(3);
  return {
    // Redraws for a camera (a three.js camera whose matrixWorld is current).
    update(camera) {
      const m = camera.matrixWorld.elements;
      const right = [m[0], m[1], m[2]], up = [m[4], m[5], m[6]], eye = [m[8], m[9], m[10]];
      // A direction of the model as it lies on the screen: [to the right, downwards].
      const flat = (v) => [dot(right, v), -dot(up, v)];
      for (const side of sides) {
        const facing = dot(eye, side.n);
        side.face.style.visibility = facing > 0.02 ? "" : "hidden";
        const a = flat(side.a), d = flat(side.d), n = flat(side.n);
        side.face.style.transform = `matrix(${px(a[0])}, ${px(a[1])}, ${px(d[0])}, ${px(d[1])}, ${px(n[0] * HALF)}, ${px(n[1] * HALF)})`;
        // Sides turned away from you are a little darker.
        side.face.style.setProperty("--facing", facing.toFixed(2));
      }
      const start = flat(CORNER);
      for (const axis of axes) {
        const end = flat(CORNER.map((v, i) => v + axis.along[i] * REACH));
        const label = flat(CORNER.map((v, i) => v + axis.along[i] * (REACH + 8)));
        for (const [name, value] of [["x1", start[0]], ["y1", start[1]], ["x2", end[0]], ["y2", end[1]]]) axis.line.setAttribute(name, px(value));
        axis.text.setAttribute("x", px(label[0]));
        axis.text.setAttribute("y", px(label[1]));
      }
    },
  };
}
