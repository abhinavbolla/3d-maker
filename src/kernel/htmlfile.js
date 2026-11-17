// A model as one HTML file that any browser opens with nothing installed and
// no network: the parts' meshes, names, colours and looks, the motion, and a
// small WebGL viewer of our own, all inline.
//
// Meshes are packed small: every position as three 16-bit steps across the
// model's box (the step is the box's size / 65535 on each axis), normals as
// three signed bytes, indices as 16 bits (a big part goes in pieces of at
// most 65536 vertices), each array in base64. A
// moving part keeps its sampled poses (frameCount x 12 floats, as
// src/kernel/motion.js makes them), and the viewer plays them round.
import { LOOKS, lookOf, srgb, toLinear } from "./gltf.js";

export const QUANT = 65535;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// A typed array's bytes in base64 (little-endian, as every browser's typed arrays are).
export function base64(typed) {
  const b = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  const out = [];
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
    if (s.length > 8192) out.push(s), (s = "");
  }
  out.push(s);
  return out.join("");
}

// Area-weighted vertex normals, for a mesh that comes without any.
function vertexNormals(P, I) {
  const N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) (N[k] += nx), (N[k + 1] += ny), (N[k + 2] += nz);
  }
  return N;
}

// A mesh in pieces of at most 65536 vertices, so every index fits in 16 bits
// (and WebGL 1 draws it with no extension). Triangles keep their order; a
// vertex used by two pieces is in both.
function pieces(I, n) {
  if (n <= 65536) return [{ vertices: null, indices: I }];
  const out = [];
  const local = new Int32Array(n).fill(-1);
  let verts = [], tris = [];
  const flush = () => {
    out.push({ vertices: Uint32Array.from(verts), indices: Uint32Array.from(tris) });
    for (const v of verts) local[v] = -1;
    (verts = []), (tris = []);
  };
  for (let t = 0; t < I.length; t += 3) {
    let fresh = 0;
    for (let k = 0; k < 3; k++) if (local[I[t + k]] < 0) fresh++;
    if (verts.length + fresh > 65536) flush();
    for (let k = 0; k < 3; k++) {
      const v = I[t + k];
      if (local[v] < 0) (local[v] = verts.length), verts.push(v);
      tris.push(local[v]);
    }
  }
  if (tris.length) flush();
  return out;
}

const escapeHTML =(s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const round = (v, d = 1000) => Math.round(v * d) / d;

// The data the viewer reads. parts: [{ name, color, material, positions,
// normals, indices, frames }] in our millimetres, Z up; motion: { loop } or null.
export function htmlModel(parts, { title = "", motion = null } = {}) {
  parts = parts.filter((p) => p.indices?.length);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const P = p.positions;
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], P[i + k])), (hi[k] = Math.max(hi[k], P[i + k]));
  }
  if (!parts.length) lo.fill(0), hi.fill(0);
  const ext = lo.map((v, k) => hi[k] - v);
  const step = ext.map((e) => (e > 0 ? e / QUANT : 0));
  const playing = motion?.loop > 0 && parts.some((p) => p.frames?.length);
  return {
    title,
    lo,
    step,
    size: ext.map((e) => round(e, 10)),
    loop: playing ? motion.loop : 0,
    parts: parts.map((p) => {
      const P = p.positions, I = p.indices;
      const N = p.normals?.length === P.length ? p.normals : vertexNormals(P, I);
      const meshes = pieces(I, P.length / 3).map(({ vertices, indices }) => {
        const n = vertices ? vertices.length : P.length / 3;
        const q = new Uint16Array(n * 3), nb = new Int8Array(n * 3);
        for (let j = 0; j < n; j++) {
          const i = (vertices ? vertices[j] : j) * 3;
          const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
          for (let k = 0; k < 3; k++) {
            q[j * 3 + k] = step[k] ? Math.round((P[i + k] - lo[k]) / step[k]) : 0;
            nb[j * 3 + k] = Math.round((N[i + k] / l) * 127);
          }
        }
        return { pos: base64(q), nrm: base64(nb), idx: base64(Uint16Array.from(indices)) };
      });
      const look = lookOf(p);
      const L = LOOKS[look];
      return {
        name: p.name,
        look,
        color: srgb(p.color).map((c) => round(toLinear(c), 10000)),
        metal: L.metallic,
        rough: L.roughness,
        alpha: L.alpha ?? 1,
        coat: L.clearcoat ?? 0,
        meshes,
        ...(playing && p.frames?.length ? { frames: base64(Float32Array.from(p.frames)) } : {}),
      };
    }),
  };
}

// The .html file's bytes.
export function toHTML(parts, options = {}) {
  const data = htmlModel(parts, options);
  // In a <script> element, "<" is the only character that could end it early.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const name = escapeHTML(data.title || "Model");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<meta name="generator" content="Draftsman">
<title>${name}</title>
<style>${STYLE}</style>
</head>
<body>
<canvas id="view" aria-label="${name}, a 3D model you can turn"></canvas>
<h1 id="title">${name}</h1>
<div id="size"></div>
<div id="hint">Drag to turn, scroll or pinch to zoom, right-drag or two fingers to move, double-click to reset</div>
<script type="application/json" id="model">${json}</script>
<script>${VIEWER}</script>
</body>
</html>
`;
  return new TextEncoder().encode(html);
}

const STYLE = `
:root { --bg: #f7f8f9; --bg2: #dde0e4; --text: #1c1e21; --muted: #6b7076; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #34373c; --bg2: #18191b; --text: #e6e7e9; --muted: #999ea4; } }
html, body { margin: 0; height: 100%; overflow: hidden; }
body { background: radial-gradient(ellipse at 50% 38%, var(--bg), var(--bg2)); color: var(--text); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
canvas { position: fixed; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: grab; display: block; }
canvas:active { cursor: grabbing; }
h1 { position: fixed; top: 16px; left: 20px; margin: 0; font-size: 17px; font-weight: 600; pointer-events: none; }
#size { position: fixed; right: 20px; bottom: 16px; font-variant-numeric: tabular-nums; pointer-events: none; }
#hint { position: fixed; left: 20px; bottom: 16px; right: 200px; color: var(--muted); font-size: 12px; pointer-events: none; }
@media (max-width: 560px) { #hint { display: none; } }
`;

// The viewer: plain WebGL 1. Z is up and the model's front faces -Y, as in
// the app. Lights are fixed to the camera, so every side reads as well.
// (No line comments in here: the tests look for "//" anywhere in the page.)
const VIEWER = String.raw`
(function () {
  "use strict";
  var D = JSON.parse(document.getElementById("model").textContent);
  var cv = document.getElementById("view");
  var hint = document.getElementById("hint");
  var mm = function (v) { return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10); };
  document.getElementById("size").textContent = D.size.map(mm).join(" × ") + " mm";
  var gl = cv.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true });
  if (!gl) { hint.textContent = "This browser cannot draw 3D: WebGL is turned off."; return; }

  function bytes(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function shader(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  var prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, [
    "attribute vec3 q; attribute vec3 n;",
    "uniform vec3 lo, ext; uniform mat4 mv, proj; uniform mat3 nm;",
    "varying vec3 vn, vp;",
    "void main() { vec4 e = mv * vec4(lo + q * ext, 1.0); vp = e.xyz; vn = nm * n; gl_Position = proj * e; }"
  ].join("\n")));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, [
    "precision mediump float;",
    "uniform vec3 col, up; uniform float metal, rough, alpha, coat;",
    "varying vec3 vn, vp;",
    "vec3 sky(vec3 d) { float h = dot(d, up); return mix(vec3(0.42, 0.41, 0.40), vec3(1.0, 1.0, 1.0), smoothstep(-0.6, 0.7, h)); }",
    "float spec(vec3 N, vec3 L, vec3 V, float p) { return pow(max(dot(N, normalize(L + V)), 0.0), p) * (p + 8.0) / 64.0; }",
    "void main() {",
    "  vec3 N = normalize(vn); if (!gl_FrontFacing) N = -N;",
    "  vec3 V = normalize(-vp);",
    "  vec3 L1 = normalize(vec3(-0.5, 0.7, 0.6)), L2 = normalize(vec3(0.8, 0.05, 0.4)), L3 = normalize(vec3(0.1, -0.6, -0.3));",
    "  float d1 = max(dot(N, L1), 0.0), d2 = max(dot(N, L2), 0.0), d3 = max(dot(N, L3), 0.0);",
    "  float nv = max(dot(N, V), 0.0);",
    "  vec3 F0 = mix(vec3(0.04), col, metal);",
    "  vec3 F = F0 + (1.0 - F0) * pow(1.0 - nv, 5.0) * (1.0 - rough);",
    "  vec3 amb = sky(N) * 0.85;",
    "  vec3 diff = col * (1.0 - 0.7 * metal) * (amb + d1 * 0.9 + d2 * 0.35 + d3 * 0.15);",
    "  float p = exp2(10.0 * (1.0 - rough) + 1.0);",
    "  vec3 refl = sky(reflect(-V, N)) * mix(1.0, 0.6, rough);",
    "  vec3 sp = F * (refl * mix(0.9, 0.6, 1.0 - metal) + (spec(N, L1, V, p) * 0.9 + spec(N, L2, V, p) * 0.35) * (1.0 - 0.6 * rough));",
    "  float c = coat * (0.04 + 0.96 * pow(1.0 - nv, 5.0));",
    "  vec3 color = diff + sp + c * (sky(reflect(-V, N)) * 0.5 + spec(N, L1, V, 300.0) * 0.6);",
    "  color = color * 1.3 / (1.0 + 0.5 * color);",
    "  float a = clamp(alpha + (1.0 - alpha) * pow(1.0 - nv, 3.0) * 0.6, 0.0, 1.0);",
    "  gl_FragColor = vec4(pow(color, vec3(1.0 / 2.2)) * a, a);",
    "}"
  ].join("\n")));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  var A = { q: gl.getAttribLocation(prog, "q"), n: gl.getAttribLocation(prog, "n") };
  var Un = {};
  ["lo", "ext", "mv", "proj", "nm", "col", "up", "metal", "rough", "alpha", "coat"].forEach(function (k) { Un[k] = gl.getUniformLocation(prog, k); });
  gl.enableVertexAttribArray(A.q);
  gl.enableVertexAttribArray(A.n);

  var ext = D.step.map(function (s) { return s * 65535; });
  var points = []; /* every 7th vertex at rest, to frame the model by */
  var parts = D.parts.map(function (p) {
    var buf = function (target, data) { var b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
    return {
      p: p,
      meshes: p.meshes.map(function (m) {
        var idx = bytes(m.idx), pos = bytes(m.pos);
        var q = new Uint16Array(pos.buffer);
        for (var v = 0; v < q.length; v += 3 * 7) points.push(D.lo[0] + q[v] * D.step[0], D.lo[1] + q[v + 1] * D.step[1], D.lo[2] + q[v + 2] * D.step[2]);
        return { q: buf(gl.ARRAY_BUFFER, pos), n: buf(gl.ARRAY_BUFFER, bytes(m.nrm)), i: buf(gl.ELEMENT_ARRAY_BUFFER, idx), count: idx.length / 2 };
      }),
      frames: p.frames ? new Float32Array(bytes(p.frames).buffer) : null
    };
  });

  var lo = D.lo, size = ext;
  var centre = [lo[0] + size[0] / 2, lo[1] + size[1] / 2, lo[2] + size[2] / 2];
  var radius = Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-3);
  var FOV = 30 * Math.PI / 180;
  var cam = {};
  /* The first view: from the front right and a little above, aimed at the
     middle of what is seen, as close as keeps the model inside 80% of the
     window (taken from a sample of its vertices). */
  function reset() {
    var aspect = cv.clientWidth / Math.max(cv.clientHeight, 1);
    cam = { yaw: -55 * Math.PI / 180, pitch: 24 * Math.PI / 180, dist: radius, target: centre.slice() };
    var a = axes(), tv = Math.tan(FOV / 2) * 0.8, th = tv * aspect;
    var fit = function () {
      var dist = radius * 0.05, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (var i = 0; i < points.length; i += 3) {
        var d = [points[i] - cam.target[0], points[i + 1] - cam.target[1], points[i + 2] - cam.target[2]];
        var x = a.r[0] * d[0] + a.r[1] * d[1] + a.r[2] * d[2], y = a.u[0] * d[0] + a.u[1] * d[1] + a.u[2] * d[2], z = a.f[0] * d[0] + a.f[1] * d[1] + a.f[2] * d[2];
        dist = Math.max(dist, Math.abs(x) / th - z, Math.abs(y) / tv - z);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      return { dist: dist, x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    };
    /* Centre what is seen, then come as close as it allows. */
    var f = fit();
    for (var k = 0; k < 3; k++) cam.target[k] += a.r[k] * f.x + a.u[k] * f.y;
    cam.dist = fit().dist;
  }

  function mul(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }
  function eye() {
    var cp = Math.cos(cam.pitch);
    return [cam.target[0] + cam.dist * cp * Math.cos(cam.yaw), cam.target[1] + cam.dist * cp * Math.sin(cam.yaw), cam.target[2] + cam.dist * Math.sin(cam.pitch)];
  }
  function axes() {
    var e = eye(), t = cam.target;
    var f = [t[0] - e[0], t[1] - e[1], t[2] - e[2]], l = Math.hypot(f[0], f[1], f[2]);
    f = [f[0] / l, f[1] / l, f[2] / l];
    var r = [f[1], -f[0], 0]; l = Math.hypot(r[0], r[1]) || 1; r = [r[0] / l, r[1] / l, 0];
    var u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return { e: e, f: f, r: r, u: u };
  }
  function viewMatrix() {
    var a = axes(), e = a.e, r = a.r, u = a.u, f = a.f;
    var dot = function (v) { return v[0] * e[0] + v[1] * e[1] + v[2] * e[2]; };
    return new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot(r), -dot(u), dot(f), 1]);
  }
  function perspective(aspect, near, far) {
    var t = 1 / Math.tan(FOV / 2);
    return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0]);
  }
  var IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  function pose(fr, time) {
    var count = fr.length / 12, x = time / D.loop * count, k = Math.floor(x) % count, j = (k + 1) % count, w = x - Math.floor(x);
    var m = function (i) { return fr[k * 12 + i] * (1 - w) + fr[j * 12 + i] * w; };
    return new Float32Array([m(0), m(4), m(8), 0, m(1), m(5), m(9), 0, m(2), m(6), m(10), 0, m(3), m(7), m(11), 1]);
  }

  var drawn = 0, start = performance.now(), queued = false;
  function draw(now) {
    queued = false;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    var view = viewMatrix();
    gl.uniformMatrix4fv(Un.proj, false, perspective(w / h, Math.max(cam.dist - radius * 2, cam.dist * 0.01), cam.dist + radius * 2));
    gl.uniform3f(Un.up, view[8], view[9], view[10]);
    gl.uniform3fv(Un.lo, lo);
    gl.uniform3fv(Un.ext, ext);
    var time = D.loop ? ((now - start) / 1000) % D.loop : 0;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    [false, true].forEach(function (glass) {
      gl.depthMask(!glass);
      if (glass) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
      if (glass) gl.disable(gl.CULL_FACE);
      parts.forEach(function (o) {
        var p = o.p;
        if ((p.alpha < 1) !== glass) return;
        var mv = mul(view, o.frames && D.loop ? pose(o.frames, time) : IDENTITY);
        gl.uniformMatrix4fv(Un.mv, false, mv);
        gl.uniformMatrix3fv(Un.nm, false, new Float32Array([mv[0], mv[1], mv[2], mv[4], mv[5], mv[6], mv[8], mv[9], mv[10]]));
        gl.uniform3fv(Un.col, p.color);
        gl.uniform1f(Un.metal, p.metal);
        gl.uniform1f(Un.rough, p.rough);
        gl.uniform1f(Un.alpha, p.alpha);
        gl.uniform1f(Un.coat, p.coat);
        o.meshes.forEach(function (m) {
          gl.bindBuffer(gl.ARRAY_BUFFER, m.q);
          gl.vertexAttribPointer(A.q, 3, gl.UNSIGNED_SHORT, true, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, m.n);
          gl.vertexAttribPointer(A.n, 3, gl.BYTE, true, 0, 0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.i);
          gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
        });
      });
    });
    document.documentElement.setAttribute("data-drawn", String(++drawn));
    if (D.loop) redraw();
  }
  function redraw() { if (!queued) { queued = true; requestAnimationFrame(draw); } }

  var held = new Map(), pinch = null;
  function pan(dx, dy) {
    var a = axes(), k = 2 * cam.dist * Math.tan(FOV / 2) / Math.max(cv.clientHeight, 1);
    for (var i = 0; i < 3; i++) cam.target[i] += (-dx * a.r[i] + dy * a.u[i]) * k;
  }
  function zoom(f) { cam.dist = Math.min(Math.max(cam.dist * f, radius * 0.05), radius * 40); }
  function twoFingers() {
    var p = Array.from(held.values());
    return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
  }
  cv.addEventListener("pointerdown", function (e) {
    cv.setPointerCapture(e.pointerId);
    held.set(e.pointerId, { x: e.clientX, y: e.clientY, move: e.button !== 0 || e.shiftKey });
    pinch = held.size === 2 ? twoFingers() : null;
  });
  cv.addEventListener("pointermove", function (e) {
    var h = held.get(e.pointerId);
    if (!h) return;
    var dx = e.clientX - h.x, dy = e.clientY - h.y;
    h.x = e.clientX; h.y = e.clientY;
    if (held.size === 1) {
      if (h.move) pan(dx, dy);
      else {
        cam.yaw -= dx * 0.008;
        cam.pitch = Math.min(Math.max(cam.pitch + dy * 0.008, -1.55), 1.55);
      }
    } else if (held.size === 2 && pinch) {
      var t = twoFingers();
      if (t.d > 0 && pinch.d > 0) zoom(pinch.d / t.d);
      pan(t.x - pinch.x, t.y - pinch.y);
      pinch = t;
    }
    redraw();
  });
  var up = function (e) { held.delete(e.pointerId); pinch = held.size === 2 ? twoFingers() : null; };
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", up);
  cv.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  cv.addEventListener("wheel", function (e) {
    e.preventDefault();
    zoom(Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
    redraw();
  }, { passive: false });
  cv.addEventListener("dblclick", function () { reset(); redraw(); });
  window.addEventListener("resize", redraw);
  cv.addEventListener("webglcontextlost", function (e) { e.preventDefault(); });
  cv.addEventListener("webglcontextrestored", function () { location.reload(); });
  reset();
  redraw();
})();
`;
