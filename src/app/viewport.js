// The 3D view: the model in a studio (a key light that casts shadows, a floor
// with a soft shadow and a faint reflection, metal, paint, rubber and glass),
// a ground grid scaled to the model, click to pick a part, free movement
// around the model, and motion for parts that spin or swing.
import * as THREE from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import { createNavigation } from "./navigate.js";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const DEG = Math.PI / 180;
const VIEWS = {
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

export function createViewport(container, { onPick }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
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
  const mirror = new Reflector(new THREE.PlaneGeometry(1, 1), { shader: FLOOR, multisample: 4, clipBias: 0.001 });
  Object.assign(mirror.material, { transparent: true, premultipliedAlpha: true, depthWrite: false });
  mirror.renderOrder = -1;
  scene.add(shadowFloor, mirror);
  // The mirror's own picture holds just the model: no backdrop, grid or shadow.
  const reflect = mirror.onBeforeRender;
  mirror.onBeforeRender = function (...args) {
    const was = [scene.background, renderer.getClearAlpha(), grid.visible, shadowFloor.visible];
    scene.background = null;
    renderer.setClearAlpha(0);
    grid.visible = shadowFloor.visible = false;
    mirrorFade.value.x = 1;
    reflect.apply(this, args);
    mirrorFade.value.x = 0;
    [scene.background, , grid.visible, shadowFloor.visible] = was;
    renderer.setClearAlpha(was[1]);
  };

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
      f.position.set(center.x, center.y, floorZ);
      f.scale.setScalar(radius * 16);
    }
    mirrorFade.value.set(0, floorZ, radius * 0.3);
    mirror.material.uniforms.centre.value.set(center.x, center.y);
    mirror.material.uniforms.radius.value = radius * 2.6;
  }

  let parts = new Map(); // name -> { object, mesh, part }
  let selected = null;
  let playing = true;
  let fitted = false;
  let lastBox = null;

  const colors = () => ({ bg: backdrop(cssVar("--viewport-glow", "#fbfbfc"), cssVar("--viewport", "#dfe1e5")), grid: new THREE.Color(cssVar("--grid", "#d6d9dd")), major: new THREE.Color(cssVar("--grid-major", "#c3c7cc")), accent: new THREE.Color(cssVar("--accent", "#2f6fde")) });
  let theme = null;

  // ---- grid: 10 cells of a round size around the model ----
  function makeGrid(box) {
    grid.traverse((o) => o.geometry?.dispose());
    grid.clear();
    const size = box ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y, 50) : 200;
    const step = 10 ** Math.floor(Math.log10(size / 4));
    const half = Math.ceil((size * 1.4) / step / 2) * step;
    const cx = box ? Math.round((box.min.x + box.max.x) / 2 / step) * step : 0;
    const cy = box ? Math.round((box.min.y + box.max.y) / 2 / step) * step : 0;
    const minor = [], major = [];
    for (let v = -half; v <= half + 1e-9; v += step) {
      const list = Math.abs(Math.round(v / step)) % 10 === 0 ? major : minor;
      list.push(cx - half, cy + v, floorZ, cx + half, cy + v, floorZ, cx + v, cy - half, floorZ, cx + v, cy + half, floorZ);
    }
    for (const [pts, color] of [[minor, theme.grid], [major, theme.major]]) {
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
    makeGrid(lastBox);
    highlight();
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

  // ---- render loop: only runs while something moves ----
  let frame = 0;
  const timer = new THREE.Timer();
  let time = 0;
  let loopSeconds = 4;
  const moving = () => playing && [...parts.values()].some((p) => p.part.frames);
  function tick() {
    frame = 0;
    timer.update();
    const dt = timer.getDelta();
    if (moving()) time += Math.min(dt, 0.1);
    pose(time);
    renderer.render(scene, camera);
    if (moving()) render();
  }
  function render() {
    if (!frame) {
      frame = requestAnimationFrame(tick);
    }
  }

  // Poses come from the kernel, sampled over the loop (60 per second); in
  // between two samples, rotation is slerped and position interpolated.
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const ma = new THREE.Matrix4();
  const mb = new THREE.Matrix4();
  const setFrame = (m, f, i) => m.set(f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5], f[i + 6], f[i + 7], f[i + 8], f[i + 9], f[i + 10], f[i + 11], 0, 0, 0, 1);
  function pose(t) {
    for (const { object, part } of parts.values()) {
      const f = part.frames;
      if (!f) {
        object.matrix.identity();
      } else {
        const n = f.length / 12;
        const x = (((t % loopSeconds) + loopSeconds) % loopSeconds) / loopSeconds * n;
        const i = Math.floor(x) % n;
        const j = (i + 1) % n;
        const w = x - Math.floor(x);
        setFrame(ma, f, i * 12).decompose(pa, qa, sc);
        setFrame(mb, f, j * 12).decompose(pb, qb, sc);
        object.matrix.compose(pa.lerp(pb, w), qa.slerp(qb, w), sc.set(1, 1, 1));
      }
      object.matrixWorldNeedsUpdate = true;
    }
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    const px = renderer.getPixelRatio();
    mirror.getRenderTarget().setSize(Math.round(w * px), Math.round(h * px));
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
    dress(mesh, part);
    mesh.receiveShadow = true;
    mesh.userData.name = part.name;
    const object = new THREE.Group();
    object.matrixAutoUpdate = false;
    object.add(mesh);
    return { object, mesh };
  }

  function dress(mesh, part) {
    const look = lookOf(part);
    if (mesh.userData.look === look) return;
    mesh.userData.look = look;
    Object.assign(mesh.material, LOOKS[look], { needsUpdate: true });
    mesh.castShadow = look !== "glass";
    mesh.renderOrder = look === "glass" ? 1 : 0;
  }

  function setParts(list) {
    const next = new Map();
    for (const part of list) {
      if (part.hidden || !part.mesh.indices.length) continue;
      const old = parts.get(part.name);
      if (old && old.part.mesh === part.mesh) {
        old.mesh.material.color.set(part.color);
        dress(old.mesh, part);
        old.part = part;
        next.set(part.name, old);
        parts.delete(part.name);
        continue;
      }
      const made = makeObject(part);
      content.add(made.object);
      next.set(part.name, { ...made, part });
    }
    for (const { object, mesh } of parts.values()) {
      content.remove(object);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    parts = next;
    const box = modelBox();
    if (!lastBox || !box || !box.equals(lastBox)) {
      lastBox = box;
      setStage(box);
      makeGrid(box);
    }
    if (!parts.size) {
      // Back to a default framing, so an empty grid is not a speck far away.
      fit();
      fitted = false;
    }
    highlight();
    render();
  }

  function modelBox(names) {
    if (typeof names === "string") names = [names];
    const box = new THREE.Box3();
    for (const [n, { part }] of parts) {
      if (names && !names.includes(n)) continue;
      const b = part.mesh.bounds;
      if (b) box.expandByPoint(new THREE.Vector3(b[0], b[1], b[2])).expandByPoint(new THREE.Vector3(b[3], b[4], b[5]));
    }
    return box.isEmpty() ? null : box;
  }

  function highlight() {
    for (const [name, { mesh, part }] of parts) {
      mesh.material.color.set(part.color);
      mesh.material.emissive.copy(name === selected ? theme.accent : new THREE.Color(0));
      mesh.material.emissiveIntensity = name === selected ? 0.22 : 0;
    }
    render();
  }

  function select(name) {
    selected = name && parts.has(name) ? name : null;
    highlight();
  }

  // ---- picking ----
  const ray = new THREE.Raycaster();
  // The model's surface under a point of the window: { point, object } or null.
  function surfaceAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    content.updateMatrixWorld(true);
    ray.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
    return ray.intersectObjects([...parts.values()].map((p) => p.mesh), false)[0] ?? null;
  }
  const nav = createNavigation(camera, renderer.domElement, {
    surfaceAt: (x, y) => surfaceAt(x, y)?.point ?? null,
    size: () => stageSize,
    floor: () => floorZ,
    onChange: () => render(),
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
    nav.lookAt(placeCamera(camera, view, modelBox(names) ?? modelBox()));
    fitted = true;
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
    const unknown = (only ?? []).filter((n) => !parts.has(n));
    if (unknown.length) throw new Error(`There is no part named ${unknown.map((n) => `"${n}"`).join(", ")}.`);
    let cam = camera.clone();
    cam.aspect = width / height;
    const v = view ?? (only ? "iso" : null);
    if (v && v !== "iso" && VIEWS[v] && modelBox(only)) cam = flatCamera(v, modelBox(only), width / height);
    else if (v) placeCamera(cam, v, modelBox(only));
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
    const floor = [shadowFloor.visible, mirror.visible];
    shadowFloor.visible = mirror.visible = false;
    renderer.setRenderTarget(target);
    renderer.render(scene, cam);
    [shadowFloor.visible, mirror.visible] = floor;
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    renderer.setRenderTarget(null);
    target.dispose();
    pose(time);
    for (const [m, transparent, opacity, depthWrite] of ghosted) Object.assign(m, { transparent, opacity, depthWrite, needsUpdate: true });
    selected = was;
    highlight();
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
    const { clientWidth: w, clientHeight: h } = container;
    const W = Math.min(Math.round(width), renderer.capabilities.maxTextureSize);
    const H = Math.round((W * h) / w);
    const was = { selected, ratio: renderer.getPixelRatio(), grid: grid.visible, shadow: key.shadow.mapSize.x };
    selected = null;
    highlight();
    grid.visible = false;
    scene.background = paper;
    key.shadow.mapSize.setScalar(4096);
    key.shadow.map?.dispose();
    key.shadow.map = null;
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    mirror.getRenderTarget().setSize(W, H);
    pose(time);
    renderer.render(scene, camera);
    const png = renderer.domElement.toDataURL("image/png").split(",")[1];
    key.shadow.mapSize.setScalar(was.shadow);
    key.shadow.map?.dispose();
    key.shadow.map = null;
    grid.visible = was.grid;
    scene.background = theme.bg;
    renderer.setPixelRatio(was.ratio);
    selected = was.selected;
    highlight();
    resize();
    return { png, width: W, height: H };
  }

  function setPlaying(on) {
    playing = on;
    timer.update();
    render();
  }

  setStage(null);
  applyTheme();
  resize();
  return {
    setParts,
    select,
    fit,
    fitIfNew,
    screenshot,
    picture,
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
      const box = modelBox(name);
      if (!box) return null;
      const p = box.getCenter(new THREE.Vector3()).project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
    },
    resetFit: () => (fitted = false),
  };
}
