// Moving around the model, the way CAD programs do it.
//   drag          turn the view around its centre: the point in the middle of
//                 the window, which starts as the middle of the model. The
//                 model stays upright (Z up). onPivot says where the centre
//                 is, so the view can show it while you turn.
//   right-drag    slide the view; the grabbed point stays under the pointer
//   (or middle-drag, or shift-drag)
//   mouse wheel, or a pinch on a trackpad
//                 move towards or away from the point under the pointer;
//                 over empty space it flies along that line, so you can
//                 travel to any part of a big model
//   two fingers on a trackpad
//                 slide the view, as they would a map
//   double-click  bring that point to the middle of the view, which makes it
//                 the centre the view turns around
import * as THREE from "three";

const DRAG_START = 4; // px a press may move and still count as a click
const TURN = 0.006; // radians per px
const MAX_TILT = 89.5 * (Math.PI / 180);
const Z = new THREE.Vector3(0, 0, 1);

// surfaceAt(clientX, clientY): the point of the model under the pointer, or
// null. size(): the model's overall size in mm. floor(): the ground's z.
// onPivot(point | null): a turn around that point has started, or has ended.
export function createNavigation(camera, dom, { surfaceAt, size, floor, onChange, onPivot = () => {} }) {
  // The point the camera looks at, always in the middle of the window. The
  // view turns around it, and how far away it is sets the pace over empty space.
  const target = new THREE.Vector3();
  const ray = new THREE.Raycaster();
  const v = new THREE.Vector3();
  dom.style.touchAction = "none";

  function pointerRay(e) {
    const r = dom.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    return ray.ray;
  }
  // What the pointer is over: { point, solid }. The model's surface, else the
  // ground if it is not far off, else a point as far away as the target.
  function under(e, offModel = false) {
    const hit = offModel ? null : surfaceAt(e.clientX, e.clientY);
    if (hit) return { point: hit, solid: true };
    const r = pointerRay(e);
    const reach = Math.max(camera.position.distanceTo(target), size() / 4);
    const t = r.direction.z ? (floor() - r.origin.z) / r.direction.z : -1;
    if (t > 0 && t < reach * 4) return { point: r.at(t, new THREE.Vector3()), solid: true };
    return { point: r.at(reach, new THREE.Vector3()), solid: false };
  }
  const depthOf = (point) => Math.max(v.subVectors(point, camera.position).dot(camera.getWorldDirection(new THREE.Vector3())), 1e-6);

  // Keeps the clipping planes around what is in view, then redraws.
  function changed() {
    const far = camera.position.distanceTo(target);
    camera.near = Math.max(far * 0.02, size() * 2e-5);
    camera.far = far + camera.position.length() + size() * 12;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    onChange();
  }

  // Turns the view around the target: sideways about the upright through it,
  // up and down about the line across the window.
  function orbit(dx, dy) {
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const tilt = Math.asin(THREE.MathUtils.clamp(-dir.z, -1, 1)); // above the horizon, looking down
    const lift = THREE.MathUtils.clamp(tilt + dy * TURN, -MAX_TILT, MAX_TILT) - tilt;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const q = new THREE.Quaternion().setFromAxisAngle(Z, -dx * TURN).multiply(new THREE.Quaternion().setFromAxisAngle(right, -lift));
    camera.position.sub(target).applyQuaternion(q).add(target);
    camera.up.copy(Z);
    camera.lookAt(target);
  }

  function slide(depth, dx, dy) {
    const perPx = (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / dom.clientHeight;
    const move = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(-dx * perPx);
    move.addScaledVector(v.setFromMatrixColumn(camera.matrixWorld, 1), dy * perPx);
    camera.position.add(move);
    target.add(move);
  }

  // A scroll keeps heading for the point it started on, so a run of wheel
  // steps does not look the surface up again for each one.
  let heading = null; // { x, y, time, at }
  function scrollAim(e) {
    const now = performance.now();
    if (!heading || now - heading.time > 250 || Math.hypot(e.clientX - heading.x, e.clientY - heading.y) > 3) heading = { x: e.clientX, y: e.clientY, at: under(e) };
    heading.time = now;
    // Off the model the aim moves on with the camera, so flying keeps its pace.
    return heading.at.solid ? heading.at : under(e, true);
  }

  let press = null; // { x, y, id, mode, slides, at, depth }
  // Ends the press in hand, however it ended.
  function end() {
    if (!press) return;
    if (dom.hasPointerCapture(press.id)) dom.releasePointerCapture(press.id);
    dom.style.cursor = "";
    if (press.mode === "orbit") onPivot(null);
    press = null;
  }
  dom.addEventListener("pointerdown", (e) => {
    // A second finger is left alone. But a new first pointer means the old
    // press is over, even if its release never reached us (it ended outside
    // the window, or over something lying on top of the view). Without this
    // one lost release would stop every later drag.
    if (press && !e.isPrimary) return;
    end();
    press = { x: e.clientX, y: e.clientY, id: e.pointerId, mode: null, slides: e.button !== 0 || e.shiftKey, at: under(e) };
    try {
      // From here every move and the release come to the view, wherever the pointer goes.
      dom.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; the drag still works inside the view.
    }
  });
  dom.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.id) return;
    // The mouse button came up somewhere we did not hear of it.
    if (e.pointerType === "mouse" && e.buttons === 0) return end();
    if (!press.mode) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= DRAG_START) return;
      press.mode = press.slides ? "slide" : "orbit";
      press.depth = depthOf(press.at.point);
      if (press.mode === "orbit") onPivot(target);
      dom.style.cursor = "grabbing";
    }
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    press.x = e.clientX;
    press.y = e.clientY;
    if (press.mode === "orbit") orbit(dx, dy);
    else slide(press.depth, dx, dy);
    changed();
  });
  const release = (e) => {
    if (press && e.pointerId === press.id) end();
  };
  dom.addEventListener("pointerup", release);
  dom.addEventListener("pointercancel", release);
  dom.addEventListener("lostpointercapture", release);
  window.addEventListener("blur", end);
  dom.addEventListener("contextmenu", (e) => e.preventDefault());

  // Whether a scroll comes from two fingers on a trackpad. A wheel scrolls
  // one way at a time, so the first scroll that goes both ways at once tells
  // us there is a trackpad, and that is remembered. Until then only a
  // sideways scroll counts.
  const TRACKPAD = "3d-maker:trackpad";
  let trackpad = false;
  try {
    trackpad = Boolean(localStorage.getItem(TRACKPAD));
  } catch {
    // No storage: found out again each time the app opens.
  }
  function fromFingers(e) {
    if (e.ctrlKey || e.metaKey || e.deltaMode !== 0) return false;
    if (!trackpad && e.deltaX && e.deltaY) {
      trackpad = true;
      try {
        localStorage.setItem(TRACKPAD, "1");
      } catch {
        // Not remembered; nothing else changes.
      }
    }
    if (!trackpad) return Math.abs(e.deltaX) > Math.abs(e.deltaY);
    // A mouse used beside the trackpad still zooms. Its wheel scrolls straight
    // and in whole notches, or on a Mac in fractions of a line; fingers move
    // in whole or half points.
    const notches = e.wheelDeltaY && e.wheelDeltaY % 120 === 0 && e.wheelDeltaY !== -3 * e.deltaY;
    const wheel = e.deltaX === 0 && (notches || (e.deltaY * 2) % 1 !== 0);
    return !wheel;
  }

  dom.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const lines = e.deltaMode === 1 ? 16 : 1;
      if (fromFingers(e)) {
        slide(depthOf(scrollAim(e).point), -e.deltaX, trackpad ? -e.deltaY : 0);
        return changed();
      }
      // A pinch arrives as small ctrl-wheel steps; a mouse wheel in lines or notches.
      const steps = e.deltaY * lines * (e.ctrlKey ? 8 : 1);
      const scale = Math.exp(THREE.MathUtils.clamp(steps, -400, 400) * 0.0016);
      const at = scrollAim(e);
      const from = v.subVectors(camera.position, at.point).clone();
      // Stop just short of the surface, and do not back off for ever.
      const length = THREE.MathUtils.clamp(from.length() * scale, size() * 1e-4, size() * 60);
      const move = from.clone().setLength(length).sub(from);
      camera.position.add(move);
      // Over the model the target follows it in, so later moves keep its
      // pace. Over empty space the target travels with the camera, so
      // flying never slows to a stop.
      if (at.solid) target.copy(camera.position).addScaledVector(camera.getWorldDirection(new THREE.Vector3()), depthOf(at.point));
      else target.add(move);
      changed();
    },
    { passive: false },
  );

  dom.addEventListener("dblclick", (e) => {
    const at = under(e);
    if (!at.solid) return;
    const move = v.subVectors(at.point, target).clone();
    camera.position.add(move);
    target.add(move);
    changed();
  });

  return {
    target,
    // After the camera has been placed some other way (fit, a standard view).
    lookAt(point) {
      target.copy(point);
      changed();
    },
    // Turns the view as a drag of dx, dy px across the window would.
    turn(dx, dy) {
      orbit(dx, dy);
      changed();
    },
    // Says a turn made with turn() has started or ended, so its centre shows.
    turning: (on) => onPivot(on ? target : null),
  };
}
