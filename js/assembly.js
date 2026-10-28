// Home page "build the robot" scroll sequence.
//
// The section is several screens tall with a sticky stage inside. As you
// scroll through it, the 2026 robot assembles one subsystem at a time, the way
// Nothing's product pages build up a phone.
//
// Model: assets/cad/robot.glb, made from the team's Onshape export
// ("Full Robot.3mf"). Each top-level node is one build step, in order, and
// carries extras.from = the direction that step flies in from.
// See README for how to regenerate it from a new export.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { mergeGeometries, toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

const MODEL_URL = "assets/cad/robot.glb";
const ROBOT_WIDTH = 0.85;   // scene units; the model is scaled to this width
const YAW = Math.PI;        // turns the CAD so its front faces the camera at the end of the build

const section = document.querySelector(".assembly");
if (section) init(section).catch((err) => {
  console.warn("assembly: falling back to photo", err);
  section.classList.add("no-webgl");
});

async function init(section) {
  const stage = section.querySelector(".assembly-canvas");
  const steps = Array.from(section.querySelectorAll(".assembly-steps li"));
  const counter = section.querySelector(".assembly-count .now");
  const bar = section.querySelector(".assembly-progress span");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!window.WebGLRenderingContext) throw new Error("no WebGL");

  /* ---------- renderer / scene ---------- */
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  const target = new THREE.Vector3();

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1.6, 3.2, 1.8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -1, right: 1, top: 1, bottom: -1, near: 0.5, far: 8 });
  key.shadow.radius = 6;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdfe6ff, 0.35);  // cool rim light to separate the model from the background
  rim.position.set(-2, 1.2, -2.2);
  scene.add(rim);

  const ground = new THREE.Mesh(new THREE.CircleGeometry(1.6, 64), new THREE.ShadowMaterial({ opacity: 0.45 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // faint CAD-style floor grid
  const grid = new THREE.GridHelper(3, 30, 0x3a3a44, 0x24242b);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  grid.position.y = 0.0005;
  scene.add(grid);

  const model = new THREE.Group();
  scene.add(model);

  /* ---------- parts ---------- */
  const { parts, size } = await loadParts(model);
  parts.splice(steps.length);
  stage.appendChild(renderer.domElement);

  // X-ray ghost of every step at its final position, so you can see where
  // the next piece goes before it arrives. It reuses the merged geometry.
  const ghostMat = new THREE.MeshBasicMaterial({
    color: 0xf2efe9, transparent: true, opacity: 0.05, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  parts.forEach((p) => p.group.children.forEach((m) => {
    const g = new THREE.Mesh(m.geometry, ghostMat);
    g.position.copy(p.group.position);
    model.add(g);
  }));

  // Each step gets its own material copies so it can fade on its own.
  parts.forEach((p) => {
    p.mats = [];
    p.group.children.forEach((o) => {
      o.castShadow = !o.material.transparent;
      o.receiveShadow = true;
      o.material = o.material.clone();
      o.material.userData.baseOpacity = o.material.opacity;
      o.material.userData.baseTransparent = o.material.transparent;
      o.material.transparent = true;
      p.mats.push(o.material);
    });
    p.home = p.group.position.clone();
  });

  /* ---------- sizing: frame the finished robot ---------- */
  target.set(0, size.y * 0.42, 0);
  const radius = 0.5 * Math.hypot(size.x, size.y, size.z);
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const fitV = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
    const fitH = fitV / Math.min(1, camera.aspect);
    // a sphere around the robot is loose (the intake sticks out), so pull in a bit
    const dist = Math.max(fitV, fitH) * 0.8;
    camera.position.set(dist * 0.62, dist * 0.45, dist * 0.65).add(new THREE.Vector3(0, target.y * 0.3, 0));
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    needsRender = true;
  }
  new ResizeObserver(resize).observe(stage);

  /* ---------- scroll → progress ---------- */
  const N = parts.length;
  let goal = reduceMotion ? 1 : 0;   // where scroll says we should be
  let shown = goal;                  // eased value we actually draw
  let pointerX = 0, pointerY = 0, tiltX = 0, tiltY = 0;
  let activeStep = -1;
  let needsRender = true;
  let visible = false;

  if (reduceMotion) section.classList.add("static");

  function readScroll() {
    if (reduceMotion) return;
    const r = section.getBoundingClientRect();
    const travel = r.height - window.innerHeight;
    goal = travel > 0 ? Math.min(1, Math.max(0, -r.top / travel)) : 1;
  }

  stage.addEventListener("pointermove", (e) => {
    const r = stage.getBoundingClientRect();
    pointerX = (e.clientX - r.left) / r.width - 0.5;
    pointerY = (e.clientY - r.top) / r.height - 0.5;
  });
  stage.addEventListener("pointerleave", () => { pointerX = pointerY = 0; });

  const expoOut = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
  const clamp01 = (t) => Math.min(1, Math.max(0, t));

  function apply(p) {
    // The first ~6% of the section shows the empty ghost, then each step
    // gets an equal slice of the scroll and lands with an expo ease.
    const t = clamp01((p - 0.06) / 0.88) * N;
    parts.forEach((part, i) => {
      const k = expoOut(clamp01((t - i) / 0.85));
      part.group.position.copy(part.from).multiplyScalar(1 - k).add(part.home);
      part.group.visible = k > 0.001;
      part.mats.forEach((m) => {
        m.opacity = m.userData.baseOpacity * Math.min(1, k * 1.6);
        // once a solid part has landed, draw it as opaque again (correct depth sorting)
        const solid = k > 0.98 && !m.userData.baseTransparent;
        if (m.transparent === solid) { m.transparent = !solid; m.needsUpdate = true; }
        m.depthWrite = solid || !m.userData.baseTransparent;
      });
    });

    // slow turntable tied to scroll, plus a little tilt toward the pointer
    tiltX += (pointerY * 0.12 - tiltX) * 0.06;
    tiltY += (pointerX * 0.35 - tiltY) * 0.06;
    model.rotation.y = YAW - 0.7 + p * 1.25 + tiltY;
    model.rotation.x = tiltX;
    ghostMat.opacity = 0.05 * (1 - clamp01((t - N + 0.5) / 0.5));

    const step = Math.min(N - 1, Math.max(0, Math.floor(t - 0.15)));
    const started = t > 0.15;
    if (step !== activeStep || !started) {
      steps.forEach((li, i) => {
        li.classList.toggle("active", started && i === step);
        li.classList.toggle("past", started && i < step);
      });
      if (counter) counter.textContent = started ? String(step + 1).padStart(2, "0") : "00";
      activeStep = started ? step : -1;
    }
    section.classList.toggle("started", started);
    if (bar) bar.style.transform = `scaleX(${clamp01(t / N)})`;
  }

  /* ---------- loop: only runs while the section is on screen ---------- */
  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible) { readScroll(); requestAnimationFrame(tick); }
  }, { rootMargin: "100px 0px" }).observe(section);

  let last = -1;
  function tick() {
    if (!visible) return;
    readScroll();
    shown += (goal - shown) * 0.12;
    if (Math.abs(goal - shown) < 0.0005) shown = goal;
    const moving = Math.abs(shown - last) > 1e-5 || Math.abs(pointerX * 0.35 - tiltY) > 1e-4 || Math.abs(pointerY * 0.12 - tiltX) > 1e-4;
    if (moving || needsRender) {
      apply(shown);
      renderer.render(scene, camera);
      last = shown;
      needsRender = false;
    }
    requestAnimationFrame(tick);
  }

  resize();
  apply(shown);
  renderer.render(scene, camera);
  section.classList.add("ready");
}

/* =====================================================================
   Load the CAD and turn each step into a handful of merged meshes
   (one per material) so the whole robot is ~20 draw calls.
   ===================================================================== */
async function loadParts(model) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(MODEL_URL);
  const root = gltf.scene;

  // scale to ROBOT_WIDTH across, centered, sitting on the floor
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const raw = box.getSize(new THREE.Vector3());
  const s = ROBOT_WIDTH / Math.max(raw.x, raw.z);
  const c = box.getCenter(new THREE.Vector3());
  const fit = new THREE.Matrix4().makeScale(s, s, s)
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z));
  const size = raw.clone().multiplyScalar(s);

  const parts = root.children.map((stepNode) => {
    const buckets = new Map();   // material -> geometries in model space
    stepNode.traverse((o) => {
      if (!o.isMesh) return;
      const g = new THREE.BufferGeometry();
      // dequantize positions into plain floats, baked into model space
      const src = o.geometry.attributes.position;
      const pos = new Float32Array(src.count * 3);
      for (let i = 0; i < src.count; i++) { pos[i * 3] = src.getX(i); pos[i * 3 + 1] = src.getY(i); pos[i * 3 + 2] = src.getZ(i); }
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      if (o.geometry.index) g.setIndex(Array.from(o.geometry.index.array));
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(fit, o.matrixWorld));
      if (!buckets.has(o.material)) buckets.set(o.material, []);
      buckets.get(o.material).push(g);
    });

    const group = new THREE.Group();
    for (const [material, geoms] of buckets) {
      // creased normals: smooth across curved faces, sharp at real CAD edges
      const merged = toCreasedNormals(mergeGeometries(geoms, false), THREE.MathUtils.degToRad(35));
      geoms.forEach((g) => g.dispose());
      material.envMapIntensity = 1;
      if (material.transparent) { material.depthWrite = false; material.opacity = 0.18; }
      group.add(new THREE.Mesh(merged, material));
    }
    model.add(group);
    const from = stepNode.userData.from || [0, 0.6, 0];
    return { group, from: new THREE.Vector3(...from).multiplyScalar(ROBOT_WIDTH) };
  });

  return { parts, size };
}
