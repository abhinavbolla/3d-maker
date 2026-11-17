// The camera and film commands Claude calls (set_camera, save_picture,
// preview_shots, record_video), and the Export menu's turntable. The
// camera's arithmetic is in camera.js and the recording loop in record.js.
import * as THREE from "three";
import { resolveCamera, fovToLens, lensToFov, toSaved, describe, planShots, toThree, between, partPoints } from "./camera.js";
import { record, Cancelled, LABELS } from "./record.js";

// A finished film waits here while the MCP server fetches it in pieces, so
// no single message carries tens of megabytes.
const PIECE = 6 * 1024 * 1024;
const base64 = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

// onRecording({ done, total } | null): a film is being made, or no longer.
export function createDirector({ store, viewport, onRecording = () => {} }) {
  const r1 = (v) => Math.round(v * 10) / 10;
  const title = () => store.state.result?.title || "model";
  const fineDetail = () => store.state.refining && Promise.race([store.state.refining, new Promise((r) => setTimeout(r, 15000))]);
  const views = () => store.state.doc.views ?? {};
  const modelSize = () => {
    const s = viewport.size();
    return s ? Math.max(Math.hypot(...s), 1) : 400;
  };
  // What camera.js needs to know about the model and the view, for pictures
  // of a given shape, with parts posed at motion time t.
  function context(aspect, t = viewport.motionTime()) {
    const live = viewport.liveCamera();
    const partsAt = (time) => viewport.partsAt(time);
    const names = new Set(partsAt(t).keys());
    if (!names.size) throw new Error("There is no model to film yet.");
    return {
      aspect,
      views: views(),
      partNames: names,
      hasMotion: viewport.hasMotion(),
      partsAt,
      size: modelSize,
      current: () => ({ position: live.position, target: live.target, up: live.up, lens: fovToLens(live.fov, live.aspect) }),
      points: (only) => partPoints(partsAt(t), only),
      box(only) {
        const box = new THREE.Box3();
        for (const [name, { matrix, bounds }] of partsAt(t)) if (!only || only.includes(name)) box.union(bounds.clone().applyMatrix4(matrix));
        return box.isEmpty() ? null : box;
      },
    };
  }
  const liveAspect = () => viewport.liveCamera().aspect;

  // Moves the live view to a camera over about half a second.
  let flight = 0;
  let landing = null; // where a flight under way ends
  const stopFlight = () => (cancelAnimationFrame(flight), (landing = null));
  viewport.canvas.addEventListener("pointerdown", stopFlight);
  viewport.canvas.addEventListener("wheel", stopFlight, { passive: true });
  function flyTo(cam) {
    cancelAnimationFrame(flight);
    landing = cam;
    const live = viewport.liveCamera();
    const from = { position: live.position, target: live.target, up: live.up, lens: fovToLens(live.fov, live.aspect) };
    const started = performance.now();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const step = () => {
      const t = still ? 1 : Math.min((performance.now() - started) / 600, 1);
      const c = t < 1 ? between(from, cam, t * t * (3 - 2 * t)) : cam;
      viewport.setLiveCamera({ position: c.position, target: c.target, up: c.up, fov: lensToFov(c.lens, viewport.liveCamera().aspect) });
      if (t < 1) flight = requestAnimationFrame(step);
      else landing = null;
    };
    step();
  }

  // Draws stills from cameras at motion times, as small JPEGs.
  function stills(list, width, height, small) {
    const size = modelSize();
    const studio = viewport.studio(width, height);
    try {
      return list.map(({ camera: c, time }) => (studio.draw(toThree(c, width / height, size), time), studio.still(small)));
    } finally {
      studio.end();
    }
  }
  const sizeOf = (width, height, w0, h0) => {
    const w = width ?? w0, h = height ?? h0;
    if (![w, h].every((v) => Number.isInteger(v) && v >= 64 && v <= 8192)) throw new Error("width and height must be whole numbers of pixels from 64 to 8192.");
    return [w, h];
  };

  let busy = null; // { controller } while a film is being made
  let film = null; // { id, bytes } waiting to be fetched
  let filmId = 0;

  async function makeFilm(args) {
    if (busy) throw new Error("A recording is already being made. Wait for it, or cancel it.");
    if (!store.state.result?.parts.length) throw new Error("There is no model to film yet.");
    const controller = new AbortController();
    busy = { controller };
    film = null;
    // A flight under way lands first, so the view comes back to where it was going.
    cancelAnimationFrame(flight);
    if (landing) viewport.setLiveCamera({ ...landing, fov: lensToFov(landing.lens, viewport.liveCamera().aspect) });
    landing = null;
    const before = viewport.liveCamera();
    onRecording({ done: 0, total: 0 });
    try {
      await fineDetail();
      const width = args.width ?? 1920, height = args.height ?? 1080, fps = args.fps ?? 30;
      return await record({
        viewport,
        shots: args.shots,
        width,
        height,
        fps,
        format: args.format ?? "mp4",
        startAt: args.start_at ?? 0,
        ctx: context(width / height, args.start_at ?? 0),
        signal: controller.signal,
        stills: args.stills ?? [],
        test: args.test ?? {},
        onFrame: (done, total) => onRecording({ done, total }),
      });
    } finally {
      busy = null;
      onRecording(null);
      // The view is where it was before, at the window's own size.
      viewport.setLiveCamera(before);
    }
  }

  return {
    isRecording: () => Boolean(busy),
    cancel() {
      busy?.controller.abort();
    },
    // The Export menu's film: one slow turn round the whole model from where
    // the view looks now, with the motion playing. A model whose motion
    // repeats every few seconds gets a whole number of its loops, so the
    // film plays round seamlessly too.
    async turntable() {
      const live = viewport.liveCamera();
      const off = live.position.clone().sub(live.target);
      const el = Math.max(5, Math.min(45, (Math.atan2(off.z, Math.hypot(off.x, off.y)) * 180) / Math.PI));
      const az = (Math.atan2(off.x, -off.y) * 180) / Math.PI;
      const loop = viewport.hasMotion() ? store.state.result?.motion?.loop : 0;
      const seconds = loop > 0 && loop <= 12 ? loop * Math.max(1, Math.round(10 / loop)) : 10;
      const result = await makeFilm({ shots: [{ seconds, move: "turntable", camera: { azimuth: az, elevation: el } }] });
      return { ...result, name: title(), label: LABELS[result.codec] };
    },
    commands: {
      set_camera: async ({ save_as, forget, width, height, ...spec } = {}) => {
        if (forget !== undefined) {
          if (!views()[forget]) throw new Error(`There is no saved view named "${forget}".`);
          const { [forget]: _, ...rest } = views();
          store.setViews(rest);
          if (!Object.keys(spec).length && save_as === undefined) return { saved_views: Object.keys(rest) };
        }
        await fineDetail();
        const aspect = width && height ? width / height : liveAspect();
        const cam = resolveCamera(Object.keys(spec).length ? spec : "current", context(aspect));
        if (save_as !== undefined) {
          if (typeof save_as !== "string" || !save_as.trim() || save_as.length > 40) throw new Error("save_as must be a name of 1 to 40 characters.");
          if (["current", "iso", "low", "top", "bottom", "front", "back", "right", "left"].includes(save_as)) throw new Error(`"${save_as}" is the name of a standard view; choose another name.`);
          store.setViews({ ...views(), [save_as.trim()]: toSaved(cam) });
        }
        flyTo(cam);
        const [w, h] = aspect >= 1 ? [768, Math.round(768 / aspect / 2) * 2] : [Math.round(768 * aspect / 2) * 2, 768];
        const [png] = stills([{ camera: cam, time: viewport.motionTime() }], w, h, w);
        return { camera: describe(cam), saved_views: Object.keys(views()), jpeg: png };
      },
      save_picture: async ({ camera: spec, width, height, at } = {}) => {
        await fineDetail();
        const [w, h] = sizeOf(width, height, 1920, 1080);
        if (Math.max(w, h) > viewport.maxSize()) throw new Error(`This screen's graphics draw at most ${viewport.maxSize()} px across.`);
        const time = at ?? viewport.motionTime();
        const cam = resolveCamera(spec ?? "current", context(w / h, time));
        const studio = viewport.studio(w, h);
        let png, jpeg;
        try {
          studio.draw(toThree(cam, w / h, modelSize()), time);
          png = studio.png();
          jpeg = studio.still(Math.min(768, w));
        } finally {
          studio.end();
        }
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        return { name: title(), base64: png, width: w, height: h, bytes: bytes.length, camera: describe(cam), jpeg };
      },
      preview_shots: async ({ shots, width, height, start_at } = {}) => {
        await fineDetail();
        const [w, h] = sizeOf(width, height, 1920, 1080);
        const plan = planShots(shots, { ...context(w / h, start_at ?? 0), fps: 30, startAt: start_at ?? 0 });
        const picks = [];
        for (const [i, s] of plan.shots.entries()) {
          for (const k of [...new Set([0, Math.floor(s.count / 2), s.count - 1])]) picks.push({ shot: i + 1, frame: s.first + k });
        }
        const chosen = picks.slice(0, 24);
        const frames = chosen.map((p) => plan.at(p.frame));
        // Drawn at 768 px on the long side, kept at half that.
        const k = 768 / Math.max(w, h);
        const pics = stills(frames, Math.max(64, Math.round(w * k)), Math.max(64, Math.round(h * k)), Math.round(w * k / 2));
        return { seconds: plan.seconds, shots: plan.shots.map((s, i) => ({ shot: i + 1, move: s.move, seconds: s.seconds })), frames: chosen.map((p, i) => ({ ...p, at_seconds: r1(p.frame / 30), motion_seconds: r1(frames[i].time), jpeg: pics[i] })) };
      },
      record_video: async (args = {}) => {
        const fps = args.fps ?? 30;
        const seconds = Array.isArray(args.shots) ? args.shots.reduce((n, s) => n + Math.max(1, Math.round((s?.seconds ?? 0) * fps)), 0) : 0;
        const last = Math.max(seconds - 1, 0);
        let result;
        try {
          result = await makeFilm({ ...args, stills: [0, Math.floor(last / 2), last] });
        } catch (err) {
          if (err instanceof Cancelled) throw new Error("The user cancelled the recording. No file was written.");
          throw err;
        }
        const { bytes, stills: kept, end, hashes, ...facts } = result;
        film = { id: ++filmId, bytes };
        return {
          name: title(),
          id: film.id,
          bytes: bytes.length,
          pieces: Math.ceil(bytes.length / PIECE),
          ...facts,
          format: LABELS[facts.codec],
          end_camera: describe(end),
          stills: Object.entries(kept).map(([n, jpeg]) => ({ frame: Number(n), at_seconds: r1(Number(n) / fps), jpeg })),
          ...(hashes ? { hashes } : {}),
        };
      },
      // One piece of the film record_video made, as base64. The film is let
      // go once its last piece has been fetched.
      video_part: ({ id, index } = {}) => {
        if (!film || film.id !== id) throw new Error("That film is no longer here. Record it again.");
        const count = Math.ceil(film.bytes.length / PIECE);
        if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`index must be from 0 to ${count - 1}.`);
        const piece = base64(film.bytes.subarray(index * PIECE, (index + 1) * PIECE));
        if (index === count - 1) film = null;
        return { index, base64: piece };
      },
    },
  };
}
