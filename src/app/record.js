// Recording a film of the model, frame by frame. For frame n the motion's
// time and the camera come from n alone (camera.js), the frame is drawn
// finished at the film's size (viewport.studio), and handed to the
// browser's video encoder (WebCodecs). However long a frame takes to draw,
// the film plays smoothly at its own rate, and nothing the live view does
// (its pace, skipped redraws, kept shadows) can drop or repeat a frame: the
// live view is paused while a film is made.
//
// The film is H.264 in an MP4 file where the browser can encode H.264, as
// almost every player opens it; otherwise VP9 (or VP8) in a WebM file.
// Both containers are written by our own code (kernel/mp4.js, webm.js).
import { planShots, toThree } from "./camera.js";
import { writeMP4 } from "../kernel/mp4.js";
import { writeWebM } from "../kernel/webm.js";

export const FPS = [24, 25, 30, 50, 60];
export const MAX_SIDE = 3840;

// H.264 levels (ITU-T H.264 table A-1): the most macroblocks a second and
// in a frame each allows, and its number in a codec string.
const LEVELS = [[108000, 3600, 0x1f], [216000, 5120, 0x20], [245760, 8192, 0x28], [522240, 8704, 0x2a], [589824, 22080, 0x32], [983040, 36864, 0x33], [2073600, 36864, 0x34]];
function avcLevel(width, height, fps) {
  const frame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = LEVELS.find(([perSecond, perFrame]) => frame <= perFrame && frame * fps <= perSecond);
  return (level ?? LEVELS.at(-1))[2].toString(16).toUpperCase().padStart(2, "0");
}

// The first encoder the browser has for this size: High, Main, then
// Constrained Baseline H.264, else VP9, else VP8. format "webm" skips H.264.
export async function chooseCodec({ width, height, fps, format = "mp4" }) {
  if (typeof VideoEncoder === "undefined") throw new Error("This browser cannot encode video (it has no WebCodecs VideoEncoder).");
  // About 0.13 bits a pixel each frame: 8 Mbit/s at 1080p and 30 frames a second.
  const bitrate = Math.round(Math.min(Math.max(width * height * fps * 0.13, 1e6), 60e6));
  const level = avcLevel(width, height, fps);
  const tries = [
    ...(format === "webm" ? [] : ["6400", "4D40", "42E0"].map((p) => ({ codec: `avc1.${p}${level}`, container: "mp4", avc: { format: "avc" } }))),
    { codec: "vp09.00.40.08", container: "webm", name: "vp9" },
    { codec: "vp8", container: "webm", name: "vp8" },
  ];
  for (const t of tries) {
    const config = { codec: t.codec, width, height, bitrate, framerate: fps, ...(t.avc ? { avc: t.avc } : {}) };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return { config, container: t.container, name: t.name ?? "h264" };
    } catch {
      // A codec string this browser does not know: try the next.
    }
  }
  throw new Error(`This browser has no video encoder for ${width} x ${height} at ${fps} frames a second.`);
}

export const LABELS = { h264: "H.264 in MP4", vp9: "VP9 in WebM", vp8: "VP8 in WebM" };

// A number for each frame's pixels, to compare two recordings.
function hash(pixels) {
  let h = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i += 4) {
    h ^= pixels[i] | (pixels[i + 1] << 8) | (pixels[i + 2] << 16);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export class Cancelled extends Error {
  constructor() {
    super("The recording was cancelled. No file was written.");
  }
}

// Records shots into a film. Returns { bytes, container, codec, frames,
// seconds, width, height, fps, stills, hashes? }.
// viewport: the view (its camera hooks and studio). ctx: as for planShots.
// onFrame(done, total): after each frame. signal: an AbortSignal to cancel.
// stills: frame numbers to keep a small JPEG of (for Claude to look at).
// test: { hashes: true } returns each frame's pixel hash; { slowMs } waits
// that long after each frame, to show that slow frames change nothing;
// { track: part } returns that part's pose matrix in each frame.
export async function record({ viewport, shots, width = 1920, height = 1080, fps = 30, format = "mp4", startAt = 0, ctx, onFrame = () => {}, signal, stills = [], test = {} }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > MAX_SIDE || height > MAX_SIDE) throw new Error(`width and height must be whole numbers from 64 to ${MAX_SIDE}.`);
  if (width % 2 || height % 2) throw new Error("width and height must be even numbers (video encoders need them so).");
  if (!FPS.includes(fps)) throw new Error(`fps must be one of ${FPS.join(", ")}.`);
  if (!["mp4", "webm"].includes(format)) throw new Error('format must be "mp4" or "webm".');
  const plan = planShots(shots, { ...ctx, fps, startAt, aspect: width / height });
  if (plan.frames > fps * 600) throw new Error("A recording can be at most 10 minutes long.");
  const chosen = await chooseCodec({ width, height, fps, format });
  const size = ctx.size();

  const chunks = [];
  let description = null;
  let failure = null;
  const encoder = new VideoEncoder({
    output(chunk, meta) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, timestamp: chunk.timestamp, key: chunk.type === "key" });
      if (meta?.decoderConfig?.description && !description) {
        const d = meta.decoderConfig.description;
        description = new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0));
      }
    },
    error(e) {
      failure = e;
    },
  });
  encoder.configure(chosen.config);
  const keyEvery = fps * 2;
  const frameUs = 1e6 / fps;
  // Every frame's pose from the motion itself, at exactly its time.
  const times = [...new Set(Array.from({ length: plan.frames }, (_, n) => plan.timeAt(n)))];
  const exact = ctx.posesAt ? await ctx.posesAt(times) : null;
  const studio = viewport.studio(width, height);
  if (exact) viewport.useExactPoses(exact);
  const cam = toThree(plan.at(0).camera, width / height, size);
  const hashes = [];
  const tracked = []; // test.track: that part's pose in each frame
  const kept = {};
  try {
    for (let n = 0; n < plan.frames; n++) {
      if (signal?.aborted) throw new Cancelled();
      if (failure) throw new Error(`The video encoder failed: ${failure.message ?? failure}`);
      const { camera, time } = plan.at(n);
      toThree(camera, width / height, size, cam);
      // The seam for the finished frame: everything that makes a frame
      // (pose, shadows, mirror, shading) happens inside studio.draw.
      const canvas = studio.draw(cam, time);
      if (test.hashes) hashes.push(hash(studio.pixels()));
      if (test.track) tracked.push(ctx.partsAt(time).get(test.track)?.matrix.elements);
      if (stills.includes(n)) kept[n] = studio.still(480);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(n * frameUs), duration: Math.round(frameUs) });
      encoder.encode(frame, { keyFrame: n % keyEvery === 0 });
      frame.close();
      onFrame(n + 1, plan.frames);
      // Let the encoder keep up, the progress line show and a cancel land.
      while (encoder.encodeQueueSize > 3 && !failure) await new Promise((r) => setTimeout(r, 1));
      await new Promise((r) => setTimeout(r, test.slowMs ?? 0));
    }
    await encoder.flush();
    if (failure) throw new Error(`The video encoder failed: ${failure.message ?? failure}`);
  } finally {
    if (encoder.state !== "closed") encoder.close();
    viewport.useExactPoses(null);
    studio.end();
  }
  // Kept in the order the encoder gave them, which is decode order.
  if (chunks.length !== plan.frames) throw new Error(`The video encoder gave ${chunks.length} frames for ${plan.frames}.`);
  const bytes = chosen.container === "mp4" ? writeMP4({ frames: chunks, config: description, width, height, fps }) : writeWebM({ frames: chunks, codec: chosen.name, width, height, fps });
  return {
    bytes,
    container: chosen.container,
    codec: chosen.name,
    codec_string: chosen.config.codec,
    frames: plan.frames,
    seconds: plan.seconds,
    width,
    height,
    fps,
    shots: plan.shots,
    end: plan.end,
    stills: kept,
    ...(test.hashes ? { hashes } : {}),
    ...(test.track ? { tracked, times: Array.from({ length: plan.frames }, (_, n) => plan.timeAt(n)) } : {}),
  };
}
