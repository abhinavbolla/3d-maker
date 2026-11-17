// The view's finishing touches: shading in the creases (always) and the
// "shaded with edges" look (when asked for). See creases.js and edges.js.
//
// What it costs, frame by frame:
// - While anything moves (parts, the view turning, a slider), nothing: the
//   frame is drawn as before, and the shading is hidden.
// - Once nothing has been drawn for REST_MS, one step works out the shading
//   for the view as it is (three passes at one pixel per CSS pixel, or per
//   device pixel with edges on, for the outlines) and lays
//   it over the canvas as a still image that fades in. The view itself is
//   not drawn again, and after that nothing is drawn until something changes.
// - A frame drawn for a change that leaves the parts and the camera where
//   they were (a selection, the theme) keeps the shading.
// Edge lines are prebuilt line geometry beside each part: a few more lines
// in each frame, no extra pass.
import { createCreases } from "./creases.js";
import { edgeLines, loadLook, saveLook } from "./edges.js";

const REST_MS = 300;

// renderer, camera, content (the parts' group), parts() (name -> { object,
// mesh, part }), reach() (the shading's largest reach, mm), schedule() (ask
// for an animation frame without drawing).
export function createLook(container, { renderer, camera, content, parts, reach, schedule }) {
  const creases = createCreases(renderer);
  const look = loadLook();
  let shading = true; // off only for comparisons in tests

  // The shading in the window: a still image the browser multiplies over the canvas.
  const overlay = document.createElement("canvas");
  Object.assign(overlay.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", mixBlendMode: "multiply", opacity: "0" });
  overlay.hidden = true;
  container.appendChild(overlay);
  const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // What the shading depends on: the camera, the canvas, and where each
  // part is drawn, whether it shows, and how it is cut.
  function keyNow() {
    const k = [renderer.domElement.width, renderer.domElement.height, look.edges ? 1 : 0, ...camera.matrixWorld.elements, ...camera.projectionMatrix.elements];
    for (const p of renderer.clippingPlanes) k.push(...p.normal.toArray(), p.constant);
    content.updateMatrixWorld();
    for (const { object, mesh } of parts().values()) {
      let shown = mesh.visible;
      for (let o = object; o && shown; o = o.parent) shown = o.visible;
      k.push(shown ? 1 : 0, ...object.matrixWorld.elements, mesh.material.transparent ? 1 : 0);
      for (const p of mesh.material.clippingPlanes ?? []) k.push(...p.normal.toArray(), p.constant);
    }
    return k;
  }
  let shownKey = null; // the key of the shading on screen, or null
  let pending = false; // the view changed and has not been shaded yet
  let drawnAt = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

  function hide() {
    overlay.style.transition = "none";
    overlay.style.opacity = "0";
    overlay.hidden = true;
    shownKey = null;
  }

  // After the view has drawn a frame.
  function drawn(moving) {
    if (!shading) return;
    if (!moving && shownKey && same(shownKey, keyNow())) return;
    if (shownKey) hide();
    pending = true;
    drawnAt = performance.now();
    if (!moving) schedule();
  }

  // On an animation frame with nothing to draw: shade the view once it has
  // been still for long enough.
  function rest() {
    if (!pending) return;
    if (performance.now() - drawnAt < REST_MS) return schedule();
    pending = false;
    if (!parts().size) return;
    // The shading is soft, so one pixel per CSS pixel is enough for it.
    // Outlines are not: with edges on it is worked out at full size, or
    // they come out in steps two device pixels high.
    const ratio = !look.edges && renderer.getPixelRatio() >= 2 ? 2 : 1;
    const w = Math.max(1, Math.round(renderer.domElement.width / ratio)), h = Math.max(1, Math.round(renderer.domElement.height / ratio));
    creases.compute(content, camera, w, h, { reach: reach(), outlines: look.edges });
    overlay.width = w;
    overlay.height = h;
    const ctx = overlay.getContext("2d");
    ctx.putImageData(creases.toImage(ctx), 0, 0);
    creases.dispose();
    shownKey = keyNow();
    overlay.hidden = false;
    overlay.style.transition = "none";
    overlay.style.opacity = "0";
    void overlay.offsetWidth;
    overlay.style.transition = still() ? "none" : "opacity 0.2s ease-out";
    overlay.style.opacity = "1";
  }

  // Shades a picture just drawn into `target` (null: the canvas) from `cam`, w x h px.
  function paint(cam, w, h, target) {
    if (!shading) return;
    creases.compute(content, cam, w, h, { reach: reach(), outlines: look.edges });
    creases.overlay(target);
    creases.dispose();
  }

  // ---- edges ----
  function dress(entry) {
    const on = look.edges;
    if (on && !entry.edges) entry.object.add((entry.edges = edgeLines(entry.part.mesh)));
    if (!on && entry.edges) {
      entry.object.remove(entry.edges);
      entry.edges.geometry.dispose();
      entry.edges = null;
    }
    // The faces give way a little, so lines that lie on them win.
    Object.assign(entry.mesh.material, { polygonOffset: on, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  }
  function drop(entry) {
    entry.edges?.geometry.dispose();
  }
  // Hides or shows every part's lines (they stay out of the floor's mirror).
  function lines(on) {
    for (const { edges } of parts().values()) if (edges) edges.visible = on;
  }
  // edges: draw the edge lines (remembered). creases: false turns the crease
  // shading off, for comparing costs in tests; it is not remembered.
  function set({ edges, creases }) {
    if (typeof creases === "boolean" && creases !== shading) {
      shading = creases;
      hide();
      pending = false;
    }
    if (typeof edges === "boolean" && edges !== look.edges) {
      look.edges = edges;
      saveLook(look);
      for (const entry of parts().values()) dress(entry);
    }
    return get();
  }
  const get = () => ({ ...look, creases: shading });

  return { drawn, rest, paint, dress, drop, lines, set, get, hide };
}
