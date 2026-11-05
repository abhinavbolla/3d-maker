// Three.js viewport: Z-up CAD camera, grid, shaded meshes with edges,
// click to select, and a move/rotate/scale gizmo.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const DEG = Math.PI / 180;
const VIEWS = {
  iso: [1, -1.2, 0.9],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function createViewport(container, { onSelect, onTransform }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
  camera.position.set(160, -200, 140);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1, -1.5, 2);
  camera.add(key);
  scene.add(camera);

  const grid = new THREE.Group();
  scene.add(grid);
  const axes = new THREE.Group();
  scene.add(axes);

  const content = new THREE.Group();
  scene.add(content);
  const ghostGroup = new THREE.Group();
  scene.add(ghostGroup);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = false;
  orbit.screenSpacePanning = true;
  orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };

  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(0.8);
  const gizmoHelper = gizmo.getHelper();
  scene.add(gizmoHelper);
  const pivot = new THREE.Object3D();
  scene.add(pivot);

  let meshes = new Map(); // id -> { group, node }
  let selectedId = null;
  let snap = true;
  let dragStart = null; // { pivot: Matrix4, node: Matrix4 }

  function themeColors() {
    return {
      bg: new THREE.Color(cssVar("--viewport") || "#e8e9eb"),
      grid: new THREE.Color(cssVar("--grid") || "#cfd2d6"),
      grid10: new THREE.Color(cssVar("--grid-major") || "#b6bbc1"),
      edge: new THREE.Color(cssVar("--edge") || "#2b2f33"),
      select: new THREE.Color(cssVar("--accent") || "#2f6fde"),
    };
  }
  let colors = themeColors();

  function makeGrid(size = 400) {
    grid.clear();
    const minor = [];
    const major = [];
    for (let i = -size; i <= size; i += 10) {
      const arr = i % 50 === 0 ? major : minor;
      arr.push(-size, i, 0, size, i, 0, i, -size, 0, i, size, 0);
    }
    const line = (pts, color, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    };
    grid.add(line(minor, colors.grid, 1), line(major, colors.grid10, 1));
    axes.clear();
    const axis = (to, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), to]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }));
    };
    axes.add(axis(new THREE.Vector3(size / 4, 0, 0), 0xc8463d), axis(new THREE.Vector3(0, size / 4, 0), 0x4b9a3f), axis(new THREE.Vector3(0, 0, size / 8), 0x3d6fc8));
  }

  function applyTheme() {
    colors = themeColors();
    scene.background = colors.bg;
    makeGrid();
    for (const { group } of meshes.values()) {
      const edges = group.children.find((c) => c.isLineSegments);
      if (edges) edges.material.color.copy(colors.edge);
    }
    highlight();
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

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

  let frame = 0;
  function render() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderer.render(scene, camera);
    });
  }
  orbit.addEventListener("change", render);
  gizmo.addEventListener("change", render);

  // ---- meshes ----
  function buildGroup(result, node) {
    const group = new THREE.Group();
    group.userData.id = result.id;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(result.vertices, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(result.triangles, 1));
    const mat = new THREE.MeshStandardMaterial({
      color: node.color,
      roughness: 0.65,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.id = result.id;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(result.lines, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: colors.edge, transparent: true, opacity: 0.55 }));
    group.add(mesh, lines);
    return group;
  }

  function disposeGroup(group) {
    group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
  }

  // nodes: top-level doc nodes; build: Map id -> worker result
  function setScene(nodes, build, ghost) {
    detachGizmo();
    for (const { group } of meshes.values()) {
      content.remove(group);
      disposeGroup(group);
    }
    meshes = new Map();
    for (const node of nodes) {
      const r = build.get(node.id);
      if (!r || r.error || node.visible === false) continue;
      const group = buildGroup(r, node);
      content.add(group);
      meshes.set(node.id, { group, node, bounds: r.bounds });
    }
    ghostGroup.children.forEach((c) => disposeGroup(c));
    ghostGroup.clear();
    if (ghost) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(ghost.vertices, 3));
      geo.setIndex(new THREE.BufferAttribute(ghost.triangles, 1));
      const mat = new THREE.MeshBasicMaterial({ color: colors.select, transparent: true, opacity: 0.25, depthTest: false });
      const wire = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colors.select, wireframe: true, transparent: true, opacity: 0.35, depthTest: false }));
      ghostGroup.add(new THREE.Mesh(geo, mat), wire);
    }
    highlight();
    if (selectedId) attachGizmo();
    render();
  }

  function highlight() {
    for (const [id, { group, node }] of meshes) {
      const mesh = group.children[0];
      const lines = group.children[1];
      const on = id === selectedId;
      mesh.material.emissive = on ? colors.select.clone().multiplyScalar(0.12) : new THREE.Color(0);
      lines.material.color.copy(on ? colors.select : colors.edge);
      lines.material.opacity = on ? 1 : 0.55;
      mesh.material.color.set(node.color);
    }
    render();
  }

  // ---- gizmo ----
  function nodeMatrix(node) {
    const m = new THREE.Matrix4();
    const [rx, ry, rz] = node.rotation ?? [0, 0, 0];
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx * DEG, ry * DEG, rz * DEG, "ZYX"));
    const s = node.scale ?? 1;
    m.compose(new THREE.Vector3(...(node.position ?? [0, 0, 0])), q, new THREE.Vector3(s, s, s));
    return m;
  }

  function attachGizmo() {
    const entry = meshes.get(selectedId);
    if (!entry) return detachGizmo();
    const [[a, b, c], [d, e, f]] = entry.bounds;
    pivot.position.set((a + d) / 2, (b + e) / 2, (c + f) / 2);
    pivot.rotation.set(0, 0, 0);
    pivot.scale.set(1, 1, 1);
    pivot.updateMatrixWorld(true);
    gizmo.attach(pivot);
    gizmoHelper.visible = true;
  }

  function detachGizmo() {
    gizmo.detach();
    for (const { group } of meshes.values()) {
      if (group.parent !== content) content.attach(group);
    }
  }

  gizmo.addEventListener("dragging-changed", (e) => {
    orbit.enabled = !e.value;
    const entry = meshes.get(selectedId);
    if (!entry) return;
    if (e.value) {
      pivot.updateMatrixWorld(true);
      dragStart = { pivot: pivot.matrixWorld.clone(), node: nodeMatrix(entry.node) };
      pivot.attach(entry.group);
    } else if (dragStart) {
      pivot.updateMatrixWorld(true);
      const delta = pivot.matrixWorld.clone().multiply(dragStart.pivot.clone().invert());
      const next = delta.multiply(dragStart.node);
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      next.decompose(pos, quat, scl);
      const eul = new THREE.Euler().setFromQuaternion(quat, "ZYX");
      const r = (v, p = 1e4) => Math.round(v * p) / p || 0;
      dragStart = null;
      onTransform(selectedId, {
        position: [r(pos.x), r(pos.y), r(pos.z)],
        rotation: [r(eul.x / DEG, 1e3), r(eul.y / DEG, 1e3), r(eul.z / DEG, 1e3)],
        scale: r(scl.x),
      });
    }
  });

  function setMode(mode) {
    gizmo.setMode(mode);
    render();
  }

  function setSnap(on) {
    snap = on;
    gizmo.setTranslationSnap(on ? 1 : null);
    gizmo.setRotationSnap(on ? 15 * DEG : null);
    gizmo.setScaleSnap(on ? 0.05 : null);
  }
  setSnap(true);

  // ---- picking ----
  const ray = new THREE.Raycaster();
  let down = null;
  renderer.domElement.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
    if (gizmo.dragging || gizmo.axis) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...meshes.values()].map((m) => m.group.children[0]), false)[0];
    onSelect(hit ? hit.object.userData.id : null, e);
  });

  function select(id) {
    selectedId = id && meshes.has(id) ? id : null;
    detachGizmo();
    if (selectedId) attachGizmo();
    else gizmoHelper.visible = false;
    highlight();
  }

  // ---- camera ----
  function sceneBox() {
    const box = new THREE.Box3();
    for (const { bounds } of meshes.values()) {
      box.expandByPoint(new THREE.Vector3(...bounds[0]));
      box.expandByPoint(new THREE.Vector3(...bounds[1]));
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 50));
    return box;
  }

  function placeCamera(cam, view, box, aspect) {
    const dir = new THREE.Vector3(...(VIEWS[view] ?? VIEWS.iso)).normalize();
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 10);
    const fov = cam.fov * DEG;
    const fit = Math.max(radius / Math.sin(fov / 2), radius / Math.sin(Math.atan(Math.tan(fov / 2) * aspect)));
    cam.position.copy(center).addScaledVector(dir, fit * 1.05);
    cam.up.set(0, 0, 1);
    if (view === "top" || view === "bottom") cam.up.set(0, 1, 0);
    cam.lookAt(center);
    cam.near = fit / 100;
    cam.far = fit * 100;
    cam.updateProjectionMatrix();
    return center;
  }

  function setView(view = "iso") {
    const center = placeCamera(camera, view, sceneBox(), camera.aspect);
    orbit.target.copy(center);
    orbit.update();
    render();
  }

  // Renders a fixed-size PNG from any standard view without touching the on-screen camera.
  function screenshot({ view, width = 1024, height = 768 } = {}) {
    const cam = camera.clone();
    cam.aspect = width / height;
    if (view) placeCamera(cam, view, sceneBox(), cam.aspect);
    else cam.updateProjectionMatrix();
    const target = new THREE.WebGLRenderTarget(width, height, { samples: 4, colorSpace: THREE.SRGBColorSpace });
    // Show true colours: no gizmo, no selection tint, no ghost.
    const helperWasVisible = gizmoHelper.visible;
    const wasSelected = selectedId;
    gizmoHelper.visible = false;
    ghostGroup.visible = false;
    selectedId = null;
    highlight();
    renderer.setRenderTarget(target);
    renderer.render(scene, cam);
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    renderer.setRenderTarget(null);
    target.dispose();
    gizmoHelper.visible = helperWasVisible;
    ghostGroup.visible = true;
    selectedId = wasSelected;
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

  applyTheme();
  resize();
  return { setScene, select, setMode, setSnap, setView, screenshot, getSnap: () => snap, render };
}
