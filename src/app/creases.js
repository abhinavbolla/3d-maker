// Shading in the creases (ambient occlusion), and the outlines of the
// "shaded with edges" look, worked out from one picture of the parts' depth
// and facing. It is made once when the view comes to rest, never while
// anything moves, and costs three passes at one pixel per CSS pixel:
//   1. the parts' depth and normals (opaque parts only: no floor, glass,
//      grid or lines, so the floor and the background are never darkened),
//   2. how much of the half-space above each point the parts nearby cover,
//      16 directions per pixel, turned a different way on each pixel of a
//      4 x 4 tile,
//   3. that averaged over the 4 x 4 tile, which cancels the turning exactly
//      on flat faces (no grain, no banding), without averaging across a jump
//      in depth (no halos), with the outlines added.
// The result is a picture of how much to darken each pixel. It is laid over
// the drawn view by multiplying, either by the GPU (pictures, screenshots,
// frame()) or, in the window, as a still image the browser blends over the
// canvas, which then fades in without the view being drawn again.
import * as THREE from "three";

const SAMPLES = 16;

// Directions in the half-space above a surface (z up), more of them close to
// the point than far from it. Fixed, so pictures come out the same each time.
function hemisphere() {
  const out = [];
  for (let i = 0; i < SAMPLES; i++) {
    const u = (i + 0.5) / SAMPLES;
    const a = i * 2.399963; // golden angle
    const r = Math.sqrt(u);
    const len = 0.15 + 0.85 * ((i * 7) % SAMPLES / SAMPLES) ** 2;
    out.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), Math.sqrt(1 - u) + 0.08).normalize().multiplyScalar(len));
  }
  return out;
}

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

// View-space position from the depth picture; works for perspective and flat cameras.
const VIEW_AT = /* glsl */ `
  uniform sampler2D tDepth;
  uniform mat4 invProj;
  uniform mat4 proj;
  uniform vec2 texel;
  uniform float radiusPx;
  uniform float maxRadius;
  vec3 viewAt(vec2 uv, float d) {
    vec4 p = invProj * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
  }
  // The reach of the shading at a point: a share of the picture's height,
  // and never more than maxRadius millimetres.
  float pixelAt(vec3 P) { return 2.0 * (proj[3][3] > 0.5 ? 1.0 : -P.z) * texel.y / proj[1][1]; }
  float reachAt(vec3 P) { return min(radiusPx * pixelAt(P), maxRadius); }`;

const AO_FRAGMENT = /* glsl */ `
  uniform sampler2D tNormal;
  uniform vec3 kernel[${SAMPLES}];
  varying vec2 vUv;
  ${VIEW_AT}
  float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
  float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
  void main() {
    float d = texture2D(tDepth, vUv).x;
    if (d >= 1.0) { gl_FragColor = vec4(1.0); return; }
    vec3 P = viewAt(vUv, d);
    vec3 N = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
    float R = reachAt(P);
    float turn = (bayer4(gl_FragCoord.xy) + 0.5 / 16.0) * 6.2831853;
    vec3 r = vec3(cos(turn), sin(turn), 0.0);
    vec3 T = r - N * dot(r, N);
    T = dot(T, T) < 1e-6 ? normalize(cross(N, vec3(0.0, 0.0, 1.0))) : normalize(T);
    vec3 B = cross(N, T);
    float covered = 0.0;
    for (int i = 0; i < ${SAMPLES}; i++) {
      vec3 k = kernel[i];
      vec3 S = P + (T * k.x + B * k.y + N * k.z) * R;
      vec4 q = proj * vec4(S, 1.0);
      vec2 uv = q.xy / q.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
      float sd = texture2D(tDepth, uv).x;
      if (sd >= 1.0) continue;
      float z = viewAt(uv, sd).z;
      // Only what is near counts: a part far in front covers nothing here.
      float near = clamp(2.0 - abs(P.z - z) / R, 0.0, 1.0);
      covered += step(S.z + 0.03 * R, z) * near;
    }
    gl_FragColor = vec4(vec3(1.0 - covered / float(${SAMPLES})), 1.0);
  }`;

// Averages the shading over the 4 x 4 tile, keeps it to pixels at about the
// same depth, and turns it into the factor the view is multiplied by. With
// outlines on, a pixel of a part next to the background or to something
// much further away is drawn as a line.
const FINISH_FRAGMENT = /* glsl */ `
  uniform sampler2D tAO;
  uniform float strength;
  uniform float outlines;
  varying vec2 vUv;
  ${VIEW_AT}
  void main() {
    float d = texture2D(tDepth, vUv).x;
    if (d >= 1.0) { gl_FragColor = vec4(1.0); return; }
    vec3 P = viewAt(vUv, d);
    float R = reachAt(P);
    float sum = 0.0, weight = 0.0;
    for (int x = -2; x < 2; x++)
      for (int y = -2; y < 2; y++) {
        vec2 uv = vUv + vec2(float(x), float(y)) * texel;
        float sd = texture2D(tDepth, uv).x;
        float w = sd >= 1.0 ? 0.0 : step(abs(viewAt(uv, sd).z - P.z), 0.5 * R) + 1e-4;
        sum += texture2D(tAO, uv).r * w;
        weight += w;
      }
    float open = sum / weight;
    float f = mix(1.0, open * open, strength);
    if (outlines > 0.5) {
      float pixel = pixelAt(P);
      float line = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 o = i == 0 ? vec2(1.0, 0.0) : i == 1 ? vec2(-1.0, 0.0) : i == 2 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
        vec2 uv = vUv + o * texel;
        float sd = texture2D(tDepth, uv).x;
        line = max(line, sd >= 1.0 ? 1.0 : step(10.0 * pixel, P.z - viewAt(uv, sd).z));
      }
      f *= 1.0 - 0.82 * line;
    }
    gl_FragColor = vec4(vec3(f), 1.0);
  }`;

// Multiplies whatever is drawn by the factor. In an sRGB target the GPU
// blends in linear light, so the factor is converted to match the canvas.
const APPLY_FRAGMENT = /* glsl */ `
  uniform sampler2D tFactor;
  uniform float amount;
  uniform float linear;
  varying vec2 vUv;
  void main() {
    float f = mix(1.0, texture2D(tFactor, vUv).r, amount);
    gl_FragColor = vec4(vec3(linear > 0.5 ? pow(f, 2.2) : f), 1.0);
  }`;

export function createCreases(renderer) {
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  const shared = {
    tDepth: { value: null },
    proj: { value: new THREE.Matrix4() },
    invProj: { value: new THREE.Matrix4() },
    texel: { value: new THREE.Vector2() },
    radiusPx: { value: 1 },
    maxRadius: { value: 1 },
  };
  const pass = (fragmentShader, uniforms, extra = {}) => {
    const material = new THREE.ShaderMaterial({ vertexShader: QUAD_VERTEX, fragmentShader, uniforms: { ...shared, ...uniforms }, depthTest: false, depthWrite: false, ...extra });
    const mesh = new THREE.Mesh(quadGeometry, material);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    return { scene, material };
  };
  const ao = pass(AO_FRAGMENT, { tNormal: { value: null }, kernel: { value: hemisphere() } });
  const finish = pass(FINISH_FRAGMENT, { tAO: { value: null }, strength: { value: 0.75 }, outlines: { value: 0 } });
  const apply = pass(APPLY_FRAGMENT, { tFactor: { value: null }, amount: { value: 1 }, linear: { value: 0 } }, {
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });

  let targets = null;
  function sized(w, h) {
    if (targets && targets.w === w && targets.h === h) return targets;
    dispose();
    const flat = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
    const parts = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    parts.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    targets = {
      w,
      h,
      parts,
      ao: new THREE.WebGLRenderTarget(w, h, { ...flat, format: THREE.RedFormat }),
      factor: new THREE.WebGLRenderTarget(w, h, { ...flat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }),
    };
    return targets;
  }
  function dispose() {
    if (!targets) return;
    for (const k of ["parts", "ao", "factor"]) targets[k].dispose();
    targets.parts.depthTexture.dispose();
    targets = null;
  }

  // One normal material per part material, so a part's clipping planes and
  // sides carry over to the depth picture.
  const normalOf = new WeakMap();
  function normalMaterial(m) {
    let n = normalOf.get(m);
    if (!n) normalOf.set(m, (n = new THREE.MeshNormalMaterial()));
    n.side = m.side;
    n.clippingPlanes = m.clippingPlanes;
    n.clipIntersection = m.clipIntersection;
    n.clipShadows = m.clipShadows;
    return n;
  }

  // Works out the darkening for `camera` over a picture w x h px of the
  // drawing buffer, from root's opaque meshes. reach: the largest reach of
  // the shading, mm. outlines: also draw outlines. Leaves the factor in
  // targets.factor and returns it.
  function compute(root, camera, w, h, { reach, outlines = false }) {
    const t = sized(w, h);
    const swapped = [];
    root.traverse((o) => {
      if (!o.visible) return;
      if (o.isMesh && !o.material.transparent && o.material.opacity >= 1) {
        swapped.push([o, o.material, true]);
        o.material = normalMaterial(o.material);
      } else if (o.isMesh || o.isLine || o.isPoints || o.isSprite) {
        swapped.push([o, o.material, false]);
        o.visible = false;
      }
    });
    const was = { target: renderer.getRenderTarget(), autoClear: renderer.autoClear, shadows: renderer.shadowMap.autoUpdate, alpha: renderer.getClearAlpha(), color: renderer.getClearColor(new THREE.Color()) };
    try {
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = true;
      renderer.setClearColor(0x8080ff, 1);
      renderer.setRenderTarget(t.parts);
      renderer.render(root, camera);
    } finally {
      for (const [o, material, drawn] of swapped) {
        if (drawn) o.material = material;
        else o.visible = true;
      }
    }
    try {
      camera.updateMatrixWorld();
      shared.tDepth.value = t.parts.depthTexture;
      shared.proj.value.copy(camera.projectionMatrix);
      shared.invProj.value.copy(camera.projectionMatrixInverse);
      shared.texel.value.set(1 / w, 1 / h);
      shared.radiusPx.value = 0.028 * h;
      shared.maxRadius.value = reach;
      ao.material.uniforms.tNormal.value = t.parts.texture;
      renderer.setRenderTarget(t.ao);
      renderer.render(ao.scene, quadCamera);
      finish.material.uniforms.tAO.value = t.ao.texture;
      finish.material.uniforms.outlines.value = outlines ? 1 : 0;
      renderer.setRenderTarget(t.factor);
      renderer.render(finish.scene, quadCamera);
    } finally {
      renderer.setRenderTarget(was.target);
      renderer.autoClear = was.autoClear;
      renderer.shadowMap.autoUpdate = was.shadows;
      renderer.setClearColor(was.color, was.alpha);
    }
    return t.factor;
  }

  // Multiplies `target` (null: the canvas) by the last factor worked out,
  // `amount` of the way (0 to 1). Draws one quad, with no clear.
  function overlay(target, amount = 1) {
    if (!targets) return;
    const was = { target: renderer.getRenderTarget(), autoClear: renderer.autoClear };
    apply.material.uniforms.tFactor.value = targets.factor.texture;
    apply.material.uniforms.amount.value = amount;
    apply.material.uniforms.linear.value = target?.texture.colorSpace === THREE.SRGBColorSpace ? 1 : 0;
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(target);
      renderer.render(apply.scene, quadCamera);
    } finally {
      renderer.setRenderTarget(was.target);
      renderer.autoClear = was.autoClear;
    }
  }

  // The last factor as an image for a 2D canvas (the window's overlay).
  function toImage(ctx) {
    const { w, h, factor } = targets;
    const pixels = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(factor, 0, 0, w, h, pixels);
    const img = ctx.createImageData(w, h);
    // GL's rows run bottom up.
    for (let y = 0; y < h; y++) img.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return img;
  }

  return { compute, overlay, toImage, dispose };
}
