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
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

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
  // phones get 1.5x: the AO pass costs per pixel and multisampling covers the edges
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Khronos PBR Neutral: made for product renders, keeps the CAD colors
  // (red bumpers, orange plates) true instead of washing or clipping them
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.8;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;   // PCF honors shadow.radius, so the edges blur

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  const target = new THREE.Vector3();

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1.6, 3.2, 1.8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -0.8, right: 0.8, top: 0.8, bottom: -0.8, near: 0.5, far: 8 });
  key.shadow.radius = 4;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.003;   // stops shadow acne shards on the flat plates
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdfe6ff, 0.35);  // cool rim light to separate the model from the background
  rim.position.set(-2, 1.2, -2.2);
  scene.add(rim);

  const ground = new THREE.Mesh(new THREE.CircleGeometry(1.6, 64), new THREE.ShadowMaterial({ opacity: 0.45 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.userData.noAO = true;
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
  const { parts, size } = await loadParts(model, renderer.capabilities.getMaxAnisotropy());
  parts.splice(steps.length);
  stage.appendChild(renderer.domElement);

  // X-ray ghost of every step at its final position, so you can see where
  // the next piece goes before it arrives. It reuses the merged geometry.
  const ghostMat = new THREE.MeshBasicMaterial({
    color: 0xf2efe9, transparent: true, opacity: 0.04, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  parts.forEach((p) => p.group.children.forEach((m) => {
    const g = new THREE.Mesh(m.geometry, ghostMat);
    g.userData.noAO = true;
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

  /* ---------- post-processing ----------
     Ambient occlusion (GTAO) darkens the gaps and corners where parts meet,
     which is most of what makes CAD look solid instead of plastic. It needs
     WebGL2; without it we draw straight to the canvas as before. The
     composer's buffer is multisampled, so edges stay antialiased. */
  let composer = null;
  if (renderer.capabilities.isWebGL2) {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    const ao = new SolidGTAOPass(scene, camera, 1, 1);
    ao.updateGtaoMaterial({ radius: 0.06, distanceExponent: 1.5, thickness: 1.5, scale: 1.1, samples: 16 });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    ao.blendIntensity = 1;
    composer.addPass(ao);
    composer.addPass(new OutputPass());
  }
  const draw = () => (composer ? composer.render() : renderer.render(scene, camera));

  /* ---------- sizing: frame the finished robot ---------- */
  target.set(0, size.y * 0.42, 0);
  const radius = 0.5 * Math.hypot(size.x, size.y, size.z);
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
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
    ghostMat.opacity = 0.04 * (1 - clamp01((t - N + 0.5) / 0.5));

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
      draw();
      last = shown;
      needsRender = false;
    }
    requestAnimationFrame(tick);
  }

  resize();
  apply(shown);
  draw();
  section.classList.add("ready");
}

// GTAO, but only for solid geometry: the x-ray ghost, the shadow catcher,
// the polycarbonate and parts still fading in are left out of the depth
// buffer so they don't cast occlusion onto what's behind them.
class SolidGTAOPass extends GTAOPass {
  overrideVisibility() {
    super.overrideVisibility();
    this.scene.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      if (o.userData.noAO || m.userData.baseTransparent || m.opacity < 0.6) o.visible = false;
    });
  }
}

/* =====================================================================
   Load the CAD and turn each step into a handful of merged meshes
   (one per material) so the whole robot is ~20 draw calls.
   ===================================================================== */
async function loadParts(model, anisotropy) {
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

  const fabric = new Set();      // materials of the bumper fabric
  const parts = root.children.map((stepNode) => {
    const buckets = new Map();   // material -> geometries in model space
    stepNode.traverse((o) => {
      if (!o.isMesh) return;
      // (GLTFLoader turns spaces in names into underscores)
      if (/bumper[ _]soft/i.test(o.name) || /bumper[ _]soft/i.test(o.parent?.name || "")) fabric.add(o.material);
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
      if (fabric.has(material)) {
        boxUVs(merged, 1 / 0.035);   // one weave tile every 3.5 cm
        group.add(new THREE.Mesh(merged, fabricMaterial(material, anisotropy)));
        continue;
      }
      group.add(new THREE.Mesh(merged, material));
    }
    model.add(group);
    const from = stepNode.userData.from || [0, 0.6, 0];
    return { group, from: new THREE.Vector3(...from).multiplyScalar(ROBOT_WIDTH) };
  });

  return { parts, size };
}

/* =====================================================================
   Bumper fabric: the CAD only has a flat red, so the woven look is drawn
   here. A canvas makes a basket-weave height field, turned into a normal
   map, on a cloth-like material (sheen catches light at grazing angles,
   like real Cordura).
   ===================================================================== */
function fabricMaterial(cad, anisotropy) {
  const color = cad.color.clone().multiplyScalar(0.42);   // bumper red is darker than the CAD's pure red
  const normalMap = weaveNormalMap();
  normalMap.anisotropy = anisotropy;
  return new THREE.MeshPhysicalMaterial({
    name: "bumper fabric",
    color,
    roughness: 0.82,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.45,
    sheenColor: new THREE.Color(1, 0.42, 0.38),
    normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    envMapIntensity: 0.6,
  });
}

function weaveNormalMap() {
  const N = 256, CELLS = 16, cell = N / CELLS;
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      const u = (x % cell) / cell, v = (y % cell) / cell;
      // threads alternate over/under: horizontal threads in one checker
      // color, vertical in the other, each a rounded ridge
      const horizontal = (cx + cy) % 2 === 0;
      const across = horizontal ? v : u, along = horizontal ? u : v;
      // each thread a little thicker or thinner than the next, like real yarn
      const thread = horizontal ? cy : cx;
      const yarn = 0.75 + 0.25 * Math.abs(Math.sin(thread * 91.7 + (horizontal ? 0 : 37.1)));
      const ridge = Math.pow(Math.sin(Math.PI * across), 0.7) * yarn;   // round thread profile
      const dip = 0.75 + 0.25 * Math.sin(Math.PI * along);      // dips where it goes under
      const fuzz = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 * 0.08;
      h[y * N + x] = ridge * dip + fuzz;
    }
  }
  const data = new Uint8Array(N * N * 4);
  const at = (x, y) => h[((y + N) % N) * N + ((x + N) % N)];
  const k = 2.2;   // bump strength
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) * k, ny = (at(x, y - 1) - at(x, y + 1)) * k;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      data[i] = (nx / len * 0.5 + 0.5) * 255;
      data[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// UVs by projecting each triangle onto the plane its normal faces most
// (the merged geometry is non-indexed, so every triangle owns its vertices)
function boxUVs(geometry, scale) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    n.subVectors(c, b).cross(a.clone().sub(b));
    if (n.lengthSq() === 0) n.fromBufferAttribute(nor, i);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let j = 0; j < 3; j++) {
      const x = pos.getX(i + j), y = pos.getY(i + j), z = pos.getZ(i + j);
      const [u, v] = ay >= ax && ay >= az ? [x, z] : ax >= az ? [z, y] : [x, y];
      uv[(i + j) * 2] = u * scale;
      uv[(i + j) * 2 + 1] = v * scale;
    }
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}
