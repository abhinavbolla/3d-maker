// The 3D view: the model in a studio (a key light that casts shadows, a floor
// with a soft shadow and a faint reflection, metal, paint, rubber and glass),
// a ground grid scaled to the model with the X and Y axes drawn on it, click
// to pick a part, movement around the model, motion for parts that spin or
// swing, and, while the view turns, the centre it turns around and the
// origin's axes and planes.
import * as THREE from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import { createNavigation } from "./navigate.js";
import { createLook } from "./look.js";
import { createInspect } from "./inspect.js";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const DEG = Math.PI / 180;
export const VIEWS = {
  iso: [1, -1.25, 0.8],
  low: [1, -1.5, 0.28],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
};
// Where the key light stands, as a direction from the model.
const KEY = new THREE.Vector3(12, -18, 28).normalize();

// The studio as the model's surfaces reflect it: a pale dome, darker below
// the horizon so metal has something to contrast with, a big soft light where
// the key light is, a strip to one side, and a rim light behind.
function studio() {
  const s = new THREE.Scene();
  const dome = new THREE.SphereGeometry(40, 48, 24);
  const at = dome.attributes.position;
  const shade = new Float32Array(at.count * 3);
  for (let i = 0; i < at.count; i++) shade.fill(at.getZ(i) < 0 ? 0.4 : 0.62 + 0.3 * (at.getZ(i) / 40), i * 3, i * 3 + 3);
  dome.setAttribute("color", new THREE.BufferAttribute(shade, 3));
  s.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const panel = (w, h, brightness, x, y, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(brightness), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    s.add(m);
  };
  panel(26, 18, 9, 12, -18, 28);
  panel(7, 30, 4, -30, -6, 10);
  panel(26, 7, 5, 4, 30, 14);
  return s;
}

// The backdrop behind the model: brightest behind it, falling off to the edges.
function backdrop(inner, outer) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const fall = g.createRadialGradient(128, 146, 16, 128, 146, 200);
  fall.addColorStop(0, inner);
  fall.addColorStop(1, outer);
  g.fillStyle = fall;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// The floor's reflection: what a mirror would show, softened, kept faint, and
// fading out away from the model. Empty parts of the mirror stay clear.
const FLOOR = {
  name: "FloorReflection",
  uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, strength: { value: 0.42 }, centre: { value: new THREE.Vector2() }, radius: { value: 1 } },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec2 vAt;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vAt = (modelMatrix * vec4(position, 1.0)).xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform vec2 centre;
    uniform float radius;
    varying vec4 vUv;
    varying vec2 vAt;
    void main() {
      float b = 0.003 * vUv.w;
      vec4 r = texture2DProj(tDiffuse, vUv) * 0.4;
      r += texture2DProj(tDiffuse, vUv + vec4(b, 0.0, 0.0, 0.0)) * 0.15;
      r += texture2DProj(tDiffuse, vUv - vec4(b, 0.0, 0.0, 0.0)) * 0.15;
      r += texture2DProj(tDiffuse, vUv + vec4(0.0, b, 0.0, 0.0)) * 0.15;
      r += texture2DProj(tDiffuse, vUv - vec4(0.0, b, 0.0, 0.0)) * 0.15;
      float show = r.a * strength * (1.0 - smoothstep(0.35, 1.0, distance(vAt, centre) / radius));
      gl_FragColor = vec4(r.a > 0.0 ? r.rgb / r.a : vec3(0.0), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      gl_FragColor = vec4(gl_FragColor.rgb * show, show);
    }`,
};

// How a part is drawn. A script can name its material; without one, grey
// parts are drawn as metal, near-black ones as rubber and coloured ones as
// paint, which suits most machines.
const LOOKS = {
  metal: { metalness: 0.92, roughness: 0.36, clearcoat: 0, transparent: false, opacity: 1 },
  // Brushed: the highlights spread wide and soft. Anodised: a coloured metal
  // with a thin clear skin over it.
  brushed: { metalness: 0.88, roughness: 0.56, clearcoat: 0, transparent: false, opacity: 1 },
  anodised: { metalness: 0.72, roughness: 0.3, clearcoat: 0.3, transparent: false, opacity: 1 },
  paint: { metalness: 0, roughness: 0.46, clearcoat: 0.55, transparent: false, opacity: 1 },
  plastic: { metalness: 0, roughness: 0.52, clearcoat: 0, transparent: false, opacity: 1 },
  rubber: { metalness: 0, roughness: 0.93, clearcoat: 0, transparent: false, opacity: 1 },
  glass: { metalness: 0, roughness: 0.05, clearcoat: 0, transparent: true, opacity: 0.36 },
};
// In the floor's mirror a part fades out with its height above the floor, the
// way a satin floor shows what stands on it and loses what is high above.
// x: 1 while the mirror's picture is drawn, y: the floor's z, z: the height
// at which a part has faded out.
const mirrorFade = { value: new THREE.Vector3(0, 0, 1) };
function fadeInMirror(material) {
  material.customProgramCacheKey = () => "mirror-fade";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.mirrorFade = mirrorFade;
    shader.vertexShader = "varying float vHeight;\n" + shader.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\n  vHeight = (modelMatrix * vec4(transformed, 1.0)).z;");
    shader.fragmentShader =
      "uniform vec3 mirrorFade;\nvarying float vHeight;\n" +
      shader.fragmentShader.replace("#include <dithering_fragment>", "#include <dithering_fragment>\n  if (mirrorFade.x > 0.5) {\n    float keep = 1.0 - smoothstep(0.0, mirrorFade.z, vHeight - mirrorFade.y);\n    gl_FragColor = vec4(gl_FragColor.rgb * keep, keep);\n  }");
  };
  return material;
}
const hsl = { h: 0, s: 0, l: 0 };
function lookOf(part) {
  if (LOOKS[part.material]) return part.material;
  new THREE.Color(part.color).getHSL(hsl);
  return hsl.s >= 0.16 ? "paint" : hsl.l < 0.16 ? "rubber" : "metal";
}

const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// onView(camera): the camera has turned, for the view cube.
export function createViewport(container, { onPick, onView = () => {} }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.localClippingEnabled = true; // for a section (inspect.js)
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(studio(), 0.03).texture;
  scene.environmentIntensity = 0.8;
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 4;
  key.shadow.bias = -0.0003;
  scene.add(key, key.target);

  const camera = new THREE.PerspectiveCamera(35, 1, 1, 1e6);
  camera.position.set(300, -380, 250);

  const grid = new THREE.Group();
  scene.add(grid);
  const content = new THREE.Group();
  scene.add(content);

  // ---- floor: a soft shadow and a faint reflection under the model ----
  const shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.24, depthWrite: false }));
  shadowFloor.receiveShadow = true;
  shadowFloor.renderOrder = -2;
  // In the window the mirror's picture is drawn one pixel per CSS pixel. The
  // floor blurs and fades it, so on a Retina screen that and 2 samples (not 4)
  // look the same as full size and draw an eighth of the samples. With no
  // samples, thin moving parts get stepped edges that crawl. Below a pixel
  // ratio of 2 it keeps 4 samples, so at a ratio of 1 it is as before. Saved
  // pictures get it at full size, 4 samples.
  const mirror = new Reflector(new THREE.PlaneGeometry(1, 1), { shader: FLOOR, multisample: 4, clipBias: 0.001 });
  Object.assign(mirror.material, { transparent: true, premultipliedAlpha: true, depthWrite: false });
  mirror.renderOrder = -1;
  scene.add(shadowFloor, mirror);

  // ---- guides: shown while the view turns, and left out of every picture ----
  // The turning point: a dot on the centre the view turns around, the upright
  // axis through it, and a ring lying flat around it. The view swings round
  // that axis, along that ring.
  const pivotInk = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  const inked = (geometry, opacity) => new THREE.Mesh(geometry, Object.assign(pivotInk.clone(), { opacity, side: THREE.DoubleSide }));
  const pivot = new THREE.Group();
  pivot.add(inked(new THREE.CircleGeometry(1, 72), 0.09), inked(new THREE.TorusGeometry(1, 0.016, 8, 96), 0.8), inked(new THREE.CylinderGeometry(0.014, 0.014, 2.8, 8).rotateX(Math.PI / 2), 0.5), inked(new THREE.SphereGeometry(0.08, 16, 12), 1));
  pivot.traverse((o) => (o.renderOrder = 10));
  // The origin: the X, Y and Z axes from it and the three planes through it,
  // each plane in the colour of the axis it faces along. Unlike the turning
  // point they are part of the space, so the model hides what is behind it.
  const origin = new THREE.Group();
  const corners = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  const originInk = {}; // axis name -> its materials
  for (const [axis, turn] of [["z", null], ["y", (g) => g.rotateX(-Math.PI / 2)], ["x", (g) => g.rotateY(Math.PI / 2)]]) {
    const fill = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
    const line = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6, toneMapped: false });
    const sheet = new THREE.PlaneGeometry(2, 2);
    const edge = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(corners, 3));
    const along = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 1.3], 3));
    turn?.(sheet);
    turn?.(edge);
    turn?.(along);
    origin.add(new THREE.Mesh(sheet, fill), new THREE.LineLoop(edge, line), new THREE.Line(along, new THREE.LineBasicMaterial({ toneMapped: false })));
    originInk[axis] = origin.children.slice(-3).map((o) => o.material);
  }
  const guides = new THREE.Group();
  guides.add(pivot, origin);
  guides.visible = false;
  scene.add(guides);
  const PIVOT_RING = 46; // the ring's radius on screen, px
  function sizePivot() {
    const depth = pivot.position.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3()));
    pivot.scale.setScalar((PIVOT_RING * 2 * Math.max(depth, 1e-6) * Math.tan((camera.fov * DEG) / 2)) / renderer.domElement.clientHeight);
  }

  // The mirror's own picture holds just the model: no backdrop, grid or shadow.
  const reflect = mirror.onBeforeRender;
  const drawMirror = (mirror.onBeforeRender = function (...args) {
    const was = [scene.background, renderer.getClearAlpha(), grid.visible, shadowFloor.visible, guides.visible];
    scene.background = null;
    renderer.setClearAlpha(0);
    grid.visible = shadowFloor.visible = guides.visible = false;
    look.lines(false);
    mirrorFade.value.x = 1;
    reflect.apply(this, args);
    mirrorFade.value.x = 0;
    look.lines(true);
    [scene.background, , grid.visible, shadowFloor.visible, guides.visible] = was;
    renderer.setClearAlpha(was[1]);
  });

  // Stands the lights and the floor around the model.
  let stageSize = 400; // the model's overall size, mm
  let floorZ = 0;
  function setStage(box) {
    const b = box ?? new THREE.Box3(new THREE.Vector3(-100, -100, 0), new THREE.Vector3(100, 100, 100));
    const center = b.getCenter(new THREE.Vector3());
    const radius = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 5);
    stageSize = radius * 2;
    floorZ = Math.min(0, b.min.z);
    key.target.position.copy(center);
    key.position.copy(center).addScaledVector(KEY, radius * 3);
    const reach = radius * 1.3;
    Object.assign(key.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: radius, far: radius * 4.5 + (center.z - floorZ) * 2 });
    key.shadow.camera.updateProjectionMatrix();
    key.shadow.normalBias = radius / 500;
    for (const f of [shadowFloor, mirror]) {
      f.visible = Boolean(box);
      // A hair under the model (see makeGrid).
      f.position.set(center.x, center.y, floorZ - radius * 2e-3);
      f.scale.setScalar(radius * 16);
    }
    // The origin's planes reach a little past a model that stands on the origin.
    origin.scale.setScalar(radius * 0.75);
    // Clear of the ground grid, which lies in the same plane.
    origin.position.z = radius * 2e-4;
    mirrorFade.value.set(0, floorZ, radius * 0.3);
    mirror.material.uniforms.centre.value.set(center.x, center.y);
    mirror.material.uniforms.radius.value = radius * 2.6;
  }

  let parts = new Map(); // name -> { object, mesh, part }
  let selected = null;
  let playing = true;
  let fitted = false;
  let lastBox = null;
  // Crease shading and edge lines (look.js).
  const look = createLook(container, { renderer, camera, content, parts: () => parts, reach: () => stageSize * 0.02, schedule });
  // Hidden parts, the section and the exploded view (inspect.js).
  const inspect = createInspect({
    onChange({ moved, restage }) {
      if (moved) shadowsMoved = true;
      if (restage) setStage(inspect.stageBox() ?? modelBox());
      render();
    },
  });

  const colors = () => ({
    bg: backdrop(cssVar("--viewport-glow", "#fbfbfc"), cssVar("--viewport", "#dfe1e5")),
    grid: new THREE.Color(cssVar("--grid", "#d6d9dd")),
    major: new THREE.Color(cssVar("--grid-major", "#c3c7cc")),
    accent: new THREE.Color(cssVar("--accent", "#2f6fde")),
    x: new THREE.Color(cssVar("--axis-x", "#d2554c")),
    y: new THREE.Color(cssVar("--axis-y", "#3f9a5b")),
    z: new THREE.Color(cssVar("--axis-z", "#3d78d8")),
  });
  let theme = null;

  // ---- grid: 10 cells of a round size around the model, with the X axis
  // (red) and the Y axis (green) drawn on it where they cross it ----
  function makeGrid(box) {
    grid.traverse((o) => o.geometry?.dispose());
    grid.clear();
    // The grid, the floor's shadow and its mirror lie a hair (a thousandth
    // of the model's size) under where the model stands, so the inside of a
    // cut part's bottom face (a section, inspect.js), which lies in that
    // plane, hides them instead of fighting them pixel by pixel.
    grid.position.z = -stageSize * 1e-3;
    const size = box ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y, 50) : 200;
    const step = 10 ** Math.floor(Math.log10(size / 4));
    const half = Math.ceil((size * 1.4) / step / 2) * step;
    const cx = box ? Math.round((box.min.x + box.max.x) / 2 / step) * step : 0;
    const cy = box ? Math.round((box.min.y + box.max.y) / 2 / step) * step : 0;
    const minor = [], major = [];
    for (let v = -half; v <= half + 1e-9; v += step) {
      const list = Math.abs(Math.round(v / step)) % 10 === 0 ? major : minor;
      // The grid lines the X and Y axes lie on are left out; the axes are drawn there.
      if (Math.abs(cy + v) > step / 2) list.push(cx - half, cy + v, floorZ, cx + half, cy + v, floorZ);
      if (Math.abs(cx + v) > step / 2) list.push(cx + v, cy - half, floorZ, cx + v, cy + half, floorZ);
    }
    for (const [pts, color] of [[minor, theme.grid], [major, theme.major]]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      grid.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })));
    }
    const axes = [];
    if (Math.abs(cy) <= half) axes.push([[cx - half, 0, floorZ, cx + half, 0, floorZ], theme.x]);
    if (Math.abs(cx) <= half) axes.push([[0, cy - half, floorZ, 0, cy + half, floorZ], theme.y]);
    for (const [pts, color] of axes) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      grid.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })));
    }
  }

  const paper = backdrop("#ffffff", "#dcdfe3"); // the backdrop of saved pictures
  function applyTheme() {
    theme?.bg.dispose();
    theme = colors();
    scene.background = theme.bg;
    pivot.traverse((o) => o.material?.color.copy(theme.accent));
    for (const axis of ["x", "y", "z"]) for (const material of originInk[axis]) material.color.copy(theme[axis]);
    makeGrid(lastBox);
    highlight();
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

  // ---- render loop: only runs while something moves ----
  let frame = 0;
  const seen = new THREE.Quaternion(0, 0, 0, 0); // the camera's turn when the view cube last heard of it
  const timer = new THREE.Timer();
  let time = 0;
  let loopSeconds = 4;
  // The key light stands still with the model, so the shadow map only needs
  // drawing again when parts move or change, not when the view turns.
  let shadowsMoved = true;
  // The browser can take the view's graphics context away (the GPU process
  // restarts, or runs out of memory) and give a new one back. three.js
  // rebuilds what it draws every frame, but not what was drawn once into a
  // texture: the studio the materials reflect comes back black, so parts
  // look dark. It is made again here, and the backdrops uploaded again.
  // While the context is gone nothing can be drawn: pictures and films
  // refuse (see filmStudio) rather than come out black.
  let contextLost = false;
  const GONE = "The view's graphics were reset by the browser (its GPU context was lost), so nothing could be drawn. Nothing was saved; try again in a moment.";
  const lostNow = () => contextLost || renderer.getContext().isContextLost();
  renderer.domElement.addEventListener("webglcontextlost", () => (contextLost = true));
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    contextLost = false;
    const gen = new THREE.PMREMGenerator(renderer);
    const old = scene.environment;
    scene.environment = gen.fromScene(studio(), 0.03).texture;
    gen.dispose();
    old?.dispose();
    paper.needsUpdate = true;
    if (theme) theme.bg.needsUpdate = true;
    key.shadow.map?.dispose();
    key.shadow.map = null;
    shadowsMoved = true;
    render();
  });
  // Motion stops while the page is hidden and goes on from where it was when
  // it shows again.
  const moving = () => playing && !document.hidden && [...parts.values()].some((p) => p.part.frames);
  document.addEventListener("visibilitychange", () => {
    if (!moving()) return;
    timer.update();
    schedule();
  });
  // Motion on its own is drawn at up to 60 frames a second, which is every
  // frame of most screens and every other one of a 120 Hz screen, and at up
  // to 30 while another window has focus (you are typing to Claude beside
  // it, say). Anything you do still gets every frame.
  let asked = false; // a frame was asked for by something other than the motion
  let drawnAt = -Infinity;
  function tick(now) {
    frame = 0;
    if (recording) return; // a film is being made (see filmStudio); it redraws after
    if (!asked) {
      if (!moving()) return look.rest();
      // 4 ms short of the full gap, so a frame that comes a little early still counts.
      if (now - drawnAt < 1000 / (document.hasFocus() ? 60 : 30) - 4) return schedule();
    }
    asked = false;
    drawnAt = now;
    timer.update();
    const dt = timer.getDelta();
    if (moving()) {
      time += Math.min(dt, 0.1);
      shadowsMoved = true;
    }
    if (inspect.step()) shadowsMoved = true;
    pose(time);
    if (guides.visible) sizePivot();
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = shadowsMoved;
    try {
      draw();
      shadowsMoved = false;
      look.drawn(moving());
    } finally {
      // Pictures and screenshots draw their own shadows.
      renderer.shadowMap.autoUpdate = true;
    }
    if (inspect.animating()) render();
    if (!seen.equals(camera.quaternion)) onView(camera);
    seen.copy(camera.quaternion);
    if (moving()) schedule();
  }
  // One frame of the view. The floor's mirror is drawn first, and with it the
  // shadow map if it is due, both from the parts' lighter copies: neither
  // shows a part's fine detail, and together they were most of a frame's
  // triangles. three.js would draw the mirror when it reaches the floor, in
  // the middle of the view; the GPU then has to put the half-drawn view aside
  // and pick it up again, which costs more than the mirror itself.
  // Pictures and screenshots are drawn the plain way, from the full meshes.
  function draw() {
    if (!mirror.visible) return renderer.render(scene, camera);
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    lighten(true);
    try {
      drawMirror.call(mirror, renderer, scene, camera);
    } finally {
      lighten(false);
    }
    mirror.onBeforeRender = () => {};
    try {
      renderer.render(scene, camera);
    } finally {
      mirror.onBeforeRender = drawMirror;
    }
  }
  // Shows each part's lighter copy in place of its mesh, or the mesh again.
  function lighten(on) {
    for (const { mesh, light } of parts.values()) {
      if (!light) continue;
      light.visible = on;
      mesh.visible = !on;
    }
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(tick);
  }
  function render() {
    asked = true;
    schedule();
  }

  // Poses come from the kernel, sampled over the loop (60 per second). In
  // between two samples a part moves as a screw: it turns about the axis the
  // step between them turns about, wherever that axis is, and slides along
  // it. So a part spinning about a centre far from the origin stays on its
  // axis (taking position and rotation apart would cut across the circle).
  // A recording gives exact poses for its frames instead (useExactPoses).
  const qa = new THREE.Quaternion();
  const qd = new THREE.Quaternion();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const along = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const ma = new THREE.Matrix4();
  const mb = new THREE.Matrix4();
  const md = new THREE.Matrix4();
  const setFrame = (m, f, i) => m.set(f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5], f[i + 6], f[i + 7], f[i + 8], f[i + 9], f[i + 10], f[i + 11], 0, 0, 0, 1);
  // out = the screw motion a fraction w of the way from pose a to pose b.
  function screw(a, b, w, out) {
    md.copy(a).invert().premultiply(b); // the step: b = md · a
    md.decompose(pb, qd, sc);
    if (qd.w < 0) qd.set(-qd.x, -qd.y, -qd.z, -qd.w);
    const angle = 2 * Math.acos(Math.min(1, qd.w));
    if (angle < 1e-9) return out.makeTranslation(pb.multiplyScalar(w)).multiply(a);
    axis.set(qd.x, qd.y, qd.z).normalize();
    const slide = pb.dot(axis);
    // The axis passes through the point centre: the part of the step's
    // move square to the axis is a turn about it.
    along.copy(pb).addScaledVector(axis, -slide);
    centre.crossVectors(axis, along).multiplyScalar(1 / Math.tan(angle / 2)).add(along).multiplyScalar(0.5);
    qd.setFromAxisAngle(axis, angle * w);
    // x -> R(x - centre) + centre + slide·w·axis
    out.makeRotationFromQuaternion(qd);
    pa.copy(centre).applyQuaternion(qd).negate().add(centre).addScaledVector(axis, slide * w);
    out.setPosition(pa);
    return out.multiply(a);
  }
  let exact = null; // { index: Map(time -> i), frames: { name: Float32Array } }
  function pose(t) {
    const k = exact?.index.get(t);
    for (const [name, { object, part }] of parts) {
      const f = part.frames;
      if (!f) {
        object.matrix.identity();
      } else if (k !== undefined && exact.frames[name]) {
        setFrame(object.matrix, exact.frames[name], k * 12);
      } else {
        const n = f.length / 12;
        const x = (((t % loopSeconds) + loopSeconds) % loopSeconds) / loopSeconds * n;
        const i = Math.floor(x) % n;
        const j = (i + 1) % n;
        const w = x - Math.floor(x);
        setFrame(ma, f, i * 12);
        setFrame(mb, f, j * 12);
        screw(ma, mb, w, object.matrix);
      }
      inspect.place(part.name, object.matrix);
      object.matrixWorldNeedsUpdate = true;
    }
  }

  function sizeMirror(w, h, samples) {
    const target = mirror.getRenderTarget();
    if (target.samples !== samples) {
      target.samples = samples;
      target.dispose();
    }
    target.setSize(w, h);
  }
  function resize() {
    if (recording) return; // filmStudio's end() sizes the view again
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    sizeMirror(w, h, renderer.getPixelRatio() >= 2 ? 2 : 4);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }
  new ResizeObserver(resize).observe(container);

  // ---- parts ----
  function makeObject(part) {
    const { positions, indices, normals } = part.mesh;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, fadeInMirror(new THREE.MeshPhysicalMaterial({ color: part.color, clearcoatRoughness: 0.3 })));
    mesh.receiveShadow = true;
    mesh.userData.name = part.name;
    const object = new THREE.Group();
    object.matrixAutoUpdate = false;
    object.add(mesh);
    // The part's lighter copy, shown only while the shadow map and the
    // floor's mirror are drawn (see draw). It is never picked.
    let light = null;
    if (part.mesh.light) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(part.mesh.light.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(part.mesh.light.normals, 3));
      g.setIndex(new THREE.BufferAttribute(part.mesh.light.indices, 1));
      g.boundingSphere = geo.boundingSphere;
      light = new THREE.Mesh(g, mesh.material);
      light.receiveShadow = true;
      light.visible = false;
      light.raycast = () => {};
      object.add(light);
    }
    dress(mesh, light, part);
    return { object, mesh, light };
  }

  function dress(mesh, light, part) {
    const look = lookOf(part);
    if (mesh.userData.look === look) return;
    mesh.userData.look = look;
    Object.assign(mesh.material, LOOKS[look], { needsUpdate: true });
    for (const m of light ? [mesh, light] : [mesh]) {
      m.castShadow = look !== "glass";
      m.renderOrder = look === "glass" ? 1 : 0;
    }
  }

  function setParts(list) {
    const next = new Map();
    for (const part of list) {
      if (part.hidden || !part.mesh.indices.length) continue;
      const old = parts.get(part.name);
      if (old && old.part.mesh === part.mesh) {
        old.mesh.material.color.set(part.color);
        dress(old.mesh, old.light, part);
        old.part = part;
        next.set(part.name, old);
        parts.delete(part.name);
        continue;
      }
      const made = makeObject(part);
      content.add(made.object);
      next.set(part.name, { ...made, part });
      look.dress(next.get(part.name));
    }
    for (const entry of parts.values()) {
      const { object, mesh, light } = entry;
      look.drop(entry);
      content.remove(object);
      mesh.geometry.dispose();
      light?.geometry.dispose();
      mesh.material.dispose();
    }
    parts = next;
    inspect.attach(parts);
    shadowsMoved = true;
    const box = modelBox();
    if (!lastBox || !box || !box.equals(lastBox)) {
      lastBox = box;
      setStage(box);
      makeGrid(box);
    }
    if (inspect.exploded()) setStage(inspect.stageBox());
    if (!parts.size) {
      // Back to a default framing, so an empty grid is not a speck far away.
      fit();
      fitted = false;
    }
    highlight();
    render();
  }

  // placed: where the exploded view has moved the parts to.
  function modelBox(names, placed = false) {
    if (typeof names === "string") names = [names];
    const box = new THREE.Box3();
    for (const [n, { part }] of parts) {
      if (names && !names.includes(n)) continue;
      const b = part.mesh.bounds;
      const o = (placed && inspect.shift(n)) || { x: 0, y: 0, z: 0 };
      if (b) box.expandByPoint(new THREE.Vector3(b[0] + o.x, b[1] + o.y, b[2] + o.z)).expandByPoint(new THREE.Vector3(b[3] + o.x, b[4] + o.y, b[5] + o.z));
    }
    return box.isEmpty() ? null : box;
  }
  // What a picture frames: the parts asked for, or all parts that are shown.
  const frameBox = (names) => modelBox(names ?? inspect.shownNames(), true);

  function highlight() {
    for (const [name, { mesh, part }] of parts) {
      mesh.material.color.set(part.color);
      mesh.material.emissive.copy(name === selected ? theme.accent : new THREE.Color(0));
      mesh.material.emissiveIntensity = name === selected ? 0.22 : 0;
    }
    render();
  }

  function select(name) {
    const next = name && parts.has(name) ? name : null;
    // The app asks again on every change of its state, most of them nothing to do with the view.
    if (next === selected) return;
    selected = next;
    highlight();
  }

  // ---- picking ----
  const ray = new THREE.Raycaster();
  // The model's surface under a point of the window: { point, object } or null.
  function surfaceAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    content.updateMatrixWorld(true);
    ray.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
    return inspect.pick(ray.intersectObjects([...parts.values()].map((p) => p.mesh), false), ray.ray);
  }
  const nav = createNavigation(camera, renderer.domElement, {
    surfaceAt: (x, y) => surfaceAt(x, y)?.point ?? null,
    size: () => stageSize,
    floor: () => floorZ,
    onChange: () => render(),
    onPivot(point) {
      guides.visible = Boolean(point);
      if (point) pivot.position.copy(point);
      render();
    },
  });
  let down = null;
  renderer.domElement.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    // Exact point first, then a small ring around it so thin parts (blades,
    // struts) are easy to hit.
    let hit = null;
    for (const [dx, dy] of [[0, 0], ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => [6 * Math.cos(i * 0.785), 6 * Math.sin(i * 0.785)])]) {
      hit = surfaceAt(e.clientX + dx, e.clientY + dy);
      if (hit) break;
    }
    onPick(hit ? hit.object.userData.name : null);
  });

  // ---- camera ----
  function placeCamera(cam, view, box) {
    const dir = new THREE.Vector3(...(VIEWS[view] ?? VIEWS.iso)).normalize();
    const b = box ?? new THREE.Box3(new THREE.Vector3(-100, -100, 0), new THREE.Vector3(100, 100, 100));
    const center = b.getCenter(new THREE.Vector3());
    const radius = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 5);
    const fov = cam.fov * DEG;
    const fit = Math.max(radius / Math.sin(fov / 2), radius / Math.sin(Math.atan(Math.tan(fov / 2) * cam.aspect)));
    cam.up.set(0, 0, 1);
    if (view === "top") cam.up.set(0, 1, 0);
    if (view === "bottom") cam.up.set(0, -1, 0);
    cam.position.copy(center).addScaledVector(dir, fit * 1.02);
    cam.lookAt(center);
    cam.near = fit / 200;
    cam.far = fit * 200;
    cam.updateProjectionMatrix();
    // The bounding sphere leaves a flat model small in the frame. Move in
    // until the box's corners fill about 90% of the view.
    if (box) {
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
      for (let k = 0; k < 3; k++) {
        cam.updateMatrixWorld(true);
        const extent = Math.max(...corners.map((c) => c.clone().project(cam)).map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
        if (!(extent > 0) || Math.abs(extent - 0.9) < 0.02) break;
        const dist = cam.position.distanceTo(center) * Math.min(Math.max(extent / 0.9, 0.3), 3);
        cam.position.copy(center).addScaledVector(dir, Math.max(dist, radius * 1.05));
      }
      cam.updateProjectionMatrix();
    }
    return center;
  }

  // A straight-on view without perspective (like a drawing), fitted to the
  // model: sizes compare truly across the picture and the model fills it.
  // Used for pictures from the side, top, front and so on.
  function flatCamera(view, box, aspect) {
    const dir = new THREE.Vector3(...VIEWS[view]).normalize();
    const center = box.getCenter(new THREE.Vector3());
    const reach = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, reach / 100, reach * 4);
    cam.up.set(0, 0, 1);
    if (view === "top") cam.up.set(0, 1, 0);
    if (view === "bottom") cam.up.set(0, -1, 0);
    cam.position.copy(center).addScaledVector(dir, reach * 2);
    cam.lookAt(center);
    cam.updateMatrixWorld(true);
    let w = 0, h = 0;
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(cam.matrixWorldInverse);
      w = Math.max(w, Math.abs(c.x));
      h = Math.max(h, Math.abs(c.y));
    }
    w = Math.max(w, 1e-3) * 1.06;
    h = Math.max(h, 1e-3) * 1.06;
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
    Object.assign(cam, { left: -w, right: w, top: h, bottom: -h });
    cam.updateProjectionMatrix();
    return cam;
  }

  // Frames the whole model, or just the named parts, from a standard view.
  function fit(view = "iso", names) {
    nav.lookAt(placeCamera(camera, view, frameBox(names) ?? modelBox()));
    fitted = true;
  }

  // Turns the view to look from a direction (a standard view's name, or
  // [x, y, z]) at what it is looking at now, from as far away as it is now.
  // Unlike fit, it keeps your place.
  let turning = 0;
  const stopTurning = () => cancelAnimationFrame(turning);
  renderer.domElement.addEventListener("pointerdown", stopTurning);
  renderer.domElement.addEventListener("wheel", stopTurning, { passive: true });
  function lookFrom(view) {
    const dir = new THREE.Vector3(...(VIEWS[view] ?? view));
    if (!(dir.length() > 0)) return;
    dir.normalize();
    stopTurning();
    const distance = camera.position.distanceTo(nav.target);
    const end = camera.clone();
    // Straight down or up, the front of the model is at the bottom of the window.
    const upright = Math.hypot(dir.x, dir.y) > 1e-6;
    end.up.set(0, upright ? 0 : Math.sign(dir.z), upright ? 1 : 0);
    end.position.copy(nav.target).addScaledVector(dir, distance);
    end.lookAt(nav.target);
    const from = camera.quaternion.clone();
    const started = performance.now();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const step = () => {
      const t = still ? 1 : Math.min((performance.now() - started) / 260, 1);
      camera.quaternion.slerpQuaternions(from, end.quaternion, t * t * (3 - 2 * t));
      // The camera looks down its own -z, so it stands at +z from the target.
      camera.position.set(0, 0, distance).applyQuaternion(camera.quaternion).add(nav.target);
      camera.up.copy(end.up);
      nav.lookAt(nav.target);
      if (t < 1) turning = requestAnimationFrame(step);
    };
    step();
  }

  // Frames the model the first time one appears, so new models are in view.
  function fitIfNew() {
    if (!fitted && parts.size) fit();
  }

  // A PNG from any standard view, without the selection tint, posed at time
  // `at` seconds into the motion loop (0 = rest).
  // parts: frame just these parts. ghost: show the other parts faintly, so
  // the framed ones stand out but you can still see what they attach to.
  function screenshot({ view, width = 1024, height = 768, parts: only, ghost = false, at = 0 } = {}) {
    if (lostNow()) throw new Error(GONE);
    const unknown = (only ?? []).filter((n) => !parts.has(n));
    if (unknown.length) throw new Error(`There is no part named ${unknown.map((n) => `"${n}"`).join(", ")}.`);
    inspect.settle();
    const restore = inspect.reveal(only);
    let cam = camera.clone();
    cam.aspect = width / height;
    const v = view ?? (only ? "iso" : null);
    if (v && v !== "iso" && VIEWS[v] && frameBox(only)) cam = flatCamera(v, frameBox(only), width / height);
    else if (v) placeCamera(cam, v, frameBox(only));
    else cam.updateProjectionMatrix();
    const ghosted = [];
    if (only && ghost) {
      for (const [n, { mesh }] of parts) {
        if (only.includes(n) || !mesh.visible) continue;
        ghosted.push([mesh.material, mesh.material.transparent, mesh.material.opacity, mesh.material.depthWrite]);
        Object.assign(mesh.material, { transparent: true, opacity: 0.12, depthWrite: false, needsUpdate: true });
      }
    }
    const target = new THREE.WebGLRenderTarget(width, height, { samples: 4, colorSpace: THREE.SRGBColorSpace });
    const was = selected;
    selected = null;
    highlight();
    pose(at);
    content.updateMatrixWorld(true);
    // These pictures are for measuring by eye, so the floor's shadow and
    // reflection are left out of them.
    const floor = [shadowFloor.visible, mirror.visible, guides.visible];
    shadowFloor.visible = mirror.visible = guides.visible = false;
    renderer.setRenderTarget(target);
    renderer.render(scene, cam);
    look.paint(cam, width, height, target);
    shadowsMoved = true; // the shadow map now holds this pose
    [shadowFloor.visible, mirror.visible, guides.visible] = floor;
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    renderer.setRenderTarget(null);
    target.dispose();
    pose(time);
    for (const [m, transparent, opacity, depthWrite] of ghosted) Object.assign(m, { transparent, opacity, depthWrite, needsUpdate: true });
    restore();
    selected = was;
    highlight();
    if (lostNow()) throw new Error(GONE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) img.data.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1];
  }

  // A studio picture of the view as it is now, as base64 PNG: on the light
  // backdrop whatever the theme, without the grid or the selection tint.
  function picture({ width = 3200 } = {}) {
    if (lostNow()) throw new Error(GONE);
    const { clientWidth: w, clientHeight: h } = container;
    const W = Math.min(Math.round(width), renderer.capabilities.maxTextureSize);
    const H = Math.round((W * h) / w);
    const was = { selected, ratio: renderer.getPixelRatio(), grid: grid.visible, shadow: key.shadow.mapSize.x, guides: guides.visible };
    shadowsMoved = true;
    inspect.settle();
    try {
      selected = null;
      highlight();
      grid.visible = guides.visible = false;
      scene.background = paper;
      key.shadow.mapSize.setScalar(4096);
      key.shadow.map?.dispose();
      key.shadow.map = null;
      renderer.setPixelRatio(1);
      renderer.setSize(W, H, false);
      sizeMirror(W, H, 4);
      pose(time);
      renderer.render(scene, camera);
      look.paint(camera, W, H, null);
      if (lostNow()) throw new Error(GONE);
      return { png: renderer.domElement.toDataURL("image/png").split(",")[1], width: W, height: H };
    } finally {
      key.shadow.mapSize.setScalar(was.shadow);
      key.shadow.map?.dispose();
      key.shadow.map = null;
      grid.visible = was.grid;
      guides.visible = was.guides;
      scene.background = theme.bg;
      renderer.setPixelRatio(was.ratio);
      selected = was.selected;
      highlight();
      resize();
    }
  }

  // Where a point of the model is in the window, px.
  function onScreen(point) {
    const p = point.project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }

  function setPlaying(on) {
    playing = on;
    timer.update();
    render();
  }

  // ---- for camera.js and record.js: a directed camera, and films ----
  // While a film studio is open the live view draws nothing, whatever the window
  // does, and the canvas shows each finished frame as it is made.
  let recording = false;
  // creases: lay the crease shading over each frame (look.js), worked out
  // afresh for that frame's pose and camera at the film's size.
  function filmStudio(W, H, { creases = true } = {}) {
    if (recording) throw new Error("A recording is already being made.");
    const gl = renderer.getContext();
    if (lostNow()) throw new Error(GONE);
    recording = true;
    cancelAnimationFrame(frame);
    frame = 0;
    const was = { selected, ratio: renderer.getPixelRatio(), grid: grid.visible, guides: guides.visible, fit: renderer.domElement.style.objectFit };
    // Puts back everything the studio changed, once: after the last frame,
    // and as well when setting up or a frame fails.
    let open = true;
    function end() {
      if (!open) return;
      open = false;
      grid.visible = was.grid;
      guides.visible = was.guides;
      scene.background = theme.bg;
      renderer.setPixelRatio(was.ratio);
      renderer.domElement.style.objectFit = was.fit;
      selected = was.selected;
      recording = false;
      shadowsMoved = true;
      pose(time);
      highlight();
      resize();
    }
    try {
      stopTurning();
      // The view as it is shown (hidden parts, the section, the exploded view)
      // is what is filmed; an explosion still under way is finished first.
      inspect.settle();
      look.hide();
      selected = null;
      highlight();
      grid.visible = guides.visible = false;
      scene.background = paper;
      renderer.setPixelRatio(1);
      renderer.setSize(W, H, false);
      renderer.domElement.style.objectFit = "contain";
      sizeMirror(W, H, 4);
      renderer.shadowMap.autoUpdate = true;
    } catch (err) {
      end();
      throw err;
    }
    let small = null;
    return {
      // One finished frame at the film's size, posed at motion time t: the
      // full meshes, the shadow map drawn again for this pose, the floor's
      // mirror, and the crease shading worked out for this frame (the same
      // steps as picture()). A frame drawn without a context would be
      // black, so it is refused instead.
      draw(cam, t) {
        if (lostNow()) throw new Error(GONE);
        pose(t);
        content.updateMatrixWorld(true);
        renderer.render(scene, cam);
        if (creases) look.paint(cam, W, H, null);
        if (lostNow()) throw new Error(GONE);
        return renderer.domElement;
      },
      // The frame just drawn, as RGBA rows from the bottom up.
      pixels() {
        const p = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, p);
        return p;
      },
      png: () => renderer.domElement.toDataURL("image/png").split(",")[1],
      // The frame just drawn, `width` px across, as base64 JPEG.
      still(width) {
        small ??= document.createElement("canvas");
        small.width = width;
        small.height = Math.round((width * H) / W);
        small.getContext("2d").drawImage(renderer.domElement, 0, 0, small.width, small.height);
        return small.toDataURL("image/jpeg", 0.85).split(",")[1];
      },
      end,
    };
  }
  // Up to about 1500 of a mesh's vertices, for framing it tightly.
  const samples = new WeakMap();
  const sampled = (mesh) => {
    if (!samples.has(mesh)) {
      const p = mesh.positions, n = p.length / 3, step = Math.max(1, Math.floor(n / 1500));
      const out = new Float32Array(Math.ceil(n / step) * 3);
      for (let i = 0, k = 0; i < n; i += step, k += 3) out.set(p.subarray(i * 3, i * 3 + 3), k);
      samples.set(mesh, out);
    }
    return samples.get(mesh);
  };
  // Where each shown part is at motion time t (exploded, if the view is):
  // its pose, its own bounds and some of its own vertices. Hidden parts are
  // left out, so a camera frames what is shown.
  function partsAt(t) {
    pose(t);
    const out = new Map();
    for (const [name, { object, mesh, part }] of parts) {
      const b = object.visible && part.mesh.bounds;
      // clip: the section's plane through this part (what is kept is on its
      // positive side), so a camera frames what is left of a cut part.
      if (b) out.set(name, { matrix: object.matrix.clone(), bounds: new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5])), points: () => sampled(part.mesh), clip: mesh.material.clippingPlanes?.[0]?.clone() ?? null });
    }
    pose(time);
    return out;
  }

  // Draws one finished frame of the view as it is now onto the canvas, the
  // crease shading included (creases: false leaves it out), synchronously,
  // and returns the canvas. Read it before giving the browser back control
  // (toDataURL, drawImage, new VideoFrame): the canvas is not kept after
  // that. The window goes back to drawing itself on its next frame.
  //
  // With width and height (px) it draws at that size instead, one pixel per
  // pixel, with the camera's shape following it, and hands the canvas to
  // read(canvas) while the frame is on it; the window's own size comes back
  // before it returns what read returned.
  function finishedFrame({ creases = true, width, height } = {}, read) {
    const sized = width > 0 && height > 0;
    const was = { ratio: renderer.getPixelRatio(), aspect: camera.aspect };
    try {
      if (sized) {
        renderer.setPixelRatio(1);
        renderer.setSize(Math.round(width), Math.round(height), false);
        sizeMirror(Math.round(width), Math.round(height), 4);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
      pose(time);
      if (guides.visible) sizePivot();
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = shadowsMoved;
      try {
        draw();
        shadowsMoved = false;
      } finally {
        renderer.shadowMap.autoUpdate = true;
      }
      look.hide();
      if (creases) look.paint(camera, renderer.domElement.width, renderer.domElement.height, null);
      return read ? read(renderer.domElement) : renderer.domElement;
    } finally {
      if (sized) {
        renderer.setPixelRatio(was.ratio);
        camera.aspect = was.aspect;
        resize();
      }
      render();
    }
  }

  setStage(null);
  applyTheme();
  resize();
  return {
    studio: filmStudio,
    partsAt,
    canvas: renderer.domElement,
    motionTime: () => time,
    isRecording: () => recording,
    // Poses worked out by the kernel at exactly these motion times (a
    // recording's frames): { times: [t], frames: { name: Float32Array } },
    // or null to go back to the sampled loop.
    useExactPoses(table) {
      exact = table ? { index: new Map(table.times.map((t, i) => [t, i])), frames: table.frames } : null;
    },
    maxSize: () => renderer.capabilities.maxTextureSize,
    // The live camera, and placing it (the view then turns around target).
    liveCamera: () => ({ position: camera.position.clone(), target: nav.target.clone(), up: camera.up.clone(), fov: camera.fov, aspect: camera.aspect }),
    setLiveCamera({ position, target, up, fov }) {
      stopTurning();
      camera.position.copy(position);
      camera.up.copy(up);
      camera.fov = fov;
      camera.lookAt(target);
      nav.lookAt(target);
      fitted = true;
    },
    setParts,
    select,
    fit,
    fitIfNew,
    lookFrom,
    // Turns the view as a drag of dx, dy px would; turning(on) shows what it turns around.
    turn: (dx, dy) => nav.turn(dx, dy),
    turning: (on) => nav.turning(on),
    screenshot,
    picture,
    frame: finishedFrame,
    // The look: setLook({ edges }) turns the edge lines on or off and returns the look.
    setLook: (v) => (look.set(v), render(), look.get()),
    getLook: () => look.get(),
    setPlaying,
    // The model's overall size [x, y, z] in mm, or null without a model.
    size() {
      const s = modelBox()?.getSize(new THREE.Vector3());
      return s ? [s.x, s.y, s.z] : null;
    },
    hasMotion: () => [...parts.values()].some((p) => p.part.frames),
    setLoop(seconds) {
      loopSeconds = seconds > 0 ? seconds : 4;
    },
    isPlaying: () => playing,
    screenPosition(name) {
      const box = modelBox(name, true);
      return box ? onScreen(box.getCenter(new THREE.Vector3())) : null;
    },
    // Where the turning point is drawn in the window, or null when the view
    // is not being turned.
    turningPoint: () => (guides.visible ? onScreen(pivot.position.clone()) : null),
    resetFit: () => (fitted = false),
    // Hiding, the section and the exploded view (inspect.js).
    inspect,
  };
}
