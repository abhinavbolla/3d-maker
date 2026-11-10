// The 3D view: Z-up camera, soft studio light, a ground grid scaled to the
// model, click to pick a part, and motion for parts that spin or swing.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const DEG = Math.PI / 180;
const VIEWS = {
  iso: [1, -1.25, 0.8],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
};
const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function createViewport(container, { onPick }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.9;
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(0.6, -1, 1.6);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(35, 1, 1, 1e6);
  camera.position.set(300, -380, 250);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.screenSpacePanning = true;
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.18;
  orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };

  const grid = new THREE.Group();
  scene.add(grid);
  const content = new THREE.Group();
  scene.add(content);

  let parts = new Map(); // name -> { object, mesh, part }
  let selected = null;
  let playing = true;
  let fitted = false;
  let lastBox = null;

  const colors = () => ({ bg: new THREE.Color(cssVar("--viewport", "#ecedef")), grid: new THREE.Color(cssVar("--grid", "#d6d9dd")), major: new THREE.Color(cssVar("--grid-major", "#c3c7cc")), accent: new THREE.Color(cssVar("--accent", "#2f6fde")) });
  let theme = colors();

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
      list.push(cx - half, cy + v, 0, cx + half, cy + v, 0, cx + v, cy - half, 0, cx + v, cy + half, 0);
    }
    for (const [pts, color] of [[minor, theme.grid], [major, theme.major]]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      grid.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })));
    }
  }

  function applyTheme() {
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
    const damping = orbit.update();
    renderer.render(scene, camera);
    if (moving() || damping) render();
  }
  function render() {
    if (!frame) {
      frame = requestAnimationFrame(tick);
    }
  }
  orbit.addEventListener("change", render);

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
    const mat = new THREE.MeshStandardMaterial({ color: part.color, roughness: 0.5, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.name = part.name;
    const object = new THREE.Group();
    object.matrixAutoUpdate = false;
    object.add(mesh);
    return { object, mesh };
  }

  function setParts(list) {
    const next = new Map();
    for (const part of list) {
      if (part.hidden || !part.mesh.indices.length) continue;
      const old = parts.get(part.name);
      if (old && old.part.mesh === part.mesh) {
        old.mesh.material.color.set(part.color);
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
  let down = null;
  renderer.domElement.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const rect = renderer.domElement.getBoundingClientRect();
    content.updateMatrixWorld(true);
    const meshes = [...parts.values()].map((p) => p.mesh);
    // Exact point first, then a small ring around it so thin parts (blades,
    // struts) are easy to hit.
    let hit = null;
    for (const [dx, dy] of [[0, 0], ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => [6 * Math.cos(i * 0.785), 6 * Math.sin(i * 0.785)])]) {
      ray.setFromCamera(new THREE.Vector2(((e.clientX + dx - rect.left) / rect.width) * 2 - 1, -((e.clientY + dy - rect.top) / rect.height) * 2 + 1), camera);
      hit = ray.intersectObjects(meshes, false)[0];
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

  function fit(view = "iso") {
    const center = placeCamera(camera, view, modelBox());
    orbit.target.copy(center);
    orbit.update();
    fitted = true;
    render();
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
    renderer.setRenderTarget(target);
    renderer.render(scene, cam);
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

  function setPlaying(on) {
    playing = on;
    timer.update();
    render();
  }

  applyTheme();
  resize();
  return {
    setParts,
    select,
    fit,
    fitIfNew,
    screenshot,
    setPlaying,
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
