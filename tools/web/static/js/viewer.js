// "Result" card: three.js viewer for the generated SMPL-H mesh sequence, playback controls
// and synchronisation with the source video.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { $, show, personColor } from "./utils.js";
import { appError, message as m, setAttr, setText, t } from "./i18n.js";
import * as api from "./api.js";
import { initPreviewCharacter } from "./preview-character.js";
import { initPoseEditor } from "./pose-editor.js";
import { setCelShading } from "./pmx-asset.js";
import { createClothDynamics } from "./cloth-dynamics.js";
import { openClothSolve, clothSettings, clothEnabled, clothSolving, clearClothTrack, clothTrack, applyClothFrame, updateClothSettings, setClothEnabled, clearClothLane, renderClothLane } from "./cloth-solve.js";

const BODY_STORAGE = "flowhmr-body-variant";
const MOUSE_MODE_STORAGE = "flowhmr-mouse-mode";
const CEL_STORAGE = "flowhmr-cel";

function rememberToggle(toggle, key, onChange) {
  const saved = localStorage.getItem(key);
  if (saved === "on" || saved === "off") toggle.checked = saved === "on";
  const save = () => localStorage.setItem(key, toggle.checked ? "on" : "off");
  toggle.addEventListener("change", () => {
    save();
    onChange?.(toggle.checked);
  });
  return save;
}

function halfFloatTable() {
  const out = new Float32Array(65536);
  for (let h = 0; h < out.length; h++) {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    out[h] = e === 0 ? s * 5.960464477539063e-8 * f
      : e === 31 ? (f ? NaN : s * Infinity)
      : s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  return out;
}

function floorGridTexture(renderer, size, dark) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = dark ? "#414141" : "#e4e4e4";
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = dark ? "#6b6b6b" : "#ababab";
  ctx.fillRect(0, 0, 6, 256);
  ctx.fillRect(0, 0, 256, 6);
  ctx.fillStyle = dark ? "#555555" : "#c4c4c4";
  ctx.fillRect(127, 0, 3, 256);
  ctx.fillRect(0, 127, 256, 3);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(size, size);
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

export function initViewer(preview) {
  const { video, clock } = preview;
  const container = $("viewer");
  const scrub = $("scrub");
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  // The backbuffer must be an integer multiple of CSS pixels. A 1.25 or 1.5
  // ratio lands MSAA samples off the pixel grid, so thin features (the cel
  // outline) come out stair-stepped even with antialiasing on. 2x everywhere is
  // a 4x fill bill, but this scene paints in about 1 ms, so supersampling is the
  // cheapest way to get a clean line.
  renderer.setPixelRatio(2);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  container.appendChild(renderer.domElement);
  const fromHalf = halfFloatTable();
  let renderRequest = 0, dirty = false, loadController = null;
  let bodyController = null;

  // Frame-time HUD. Two rates are shown side by side because they are
  // different things: the left value is how often the viewport actually drew,
  // the right value is the motion's fixed frame rate. Sampling happens around
  // renderer.render(), never in idle rAF callbacks.
  //
  // VIEW_MAX_FPS caps painting. 0 follows the display's refresh rate, which is
  // what requestAnimationFrame already synchronises to: a hard 120 fights that
  // cadence on non-divisible panels (144 Hz would quantise down to 72), and the
  // scene paints in well under a millisecond, so the cap only costs smoothness.
  const statsToggle = $("optFps"), statsEl = $("viewerStats");
  const FPS_STORAGE = "flowhmr-show-fps";
  const VIEW_MAX_FPS = 0;
  const MIN_PAINT_MS = VIEW_MAX_FPS > 0 ? 1000 / VIEW_MAX_FPS : 0;
  const SLOW_PAINT_MS = 1000 / 30;   // one motion frame at 30 fps
  const stats = { lastPaint: 0, gapSum: 0, gapCount: 0, costSum: 0, costMax: 0, slow: 0 };
  const resetStats = () => Object.assign(stats,
    { lastPaint: 0, gapSum: 0, gapCount: 0, costSum: 0, costMax: 0, slow: 0 });
  statsToggle.checked = localStorage.getItem(FPS_STORAGE) === "on";
  show("viewerStats", statsToggle.checked);
  statsToggle.addEventListener("change", () => {
    localStorage.setItem(FPS_STORAGE, statsToggle.checked ? "on" : "off");
    show("viewerStats", statsToggle.checked);
    resetStats();
    setText(statsEl, statsToggle.checked ? "…" : "");
    invalidate();
  });
  function samplePaint(now, cost) {
    if (!statsToggle.checked) { stats.lastPaint = 0; return; }
    const gap = stats.lastPaint ? now - stats.lastPaint : 0;
    stats.lastPaint = now;
    if (gap > 0 && gap < 2000) {
      stats.gapSum += gap;
      stats.gapCount += 1;
    }
    stats.costSum += cost;
    if (cost > stats.costMax) stats.costMax = cost;
    if (cost > SLOW_PAINT_MS) stats.slow += 1;
    if (stats.gapCount >= 30) {
      const gapMean = stats.gapSum / stats.gapCount;
      const costMean = stats.costSum / stats.gapCount;
      // Report the timeline's rate, not the clip's sample rate: the number next to
      // the timeline control is the one the user just changed, and two different
      // fps values on screen at once read as a bug.
      const timeline = displayFps();
      setText(statsEl, `${Math.round(1000 / gapMean)} fps · ${costMean.toFixed(1)} ms │ ${timeline} fps`);
      Object.assign(stats, { gapSum: 0, gapCount: 0, costSum: 0, costMax: 0, slow: 0 });
    }
  }
  let lastPaint = 0;
  function invalidate() {
    dirty = true;
    if (!renderRequest) renderRequest = requestAnimationFrame(tick);
  }

  const darkTheme = document.documentElement.dataset.theme === "dark";
  const LIGHT_BG = 0xe4e4e4;
  const DARK_BG = 0x414141;
  const BG = darkTheme ? DARK_BG : LIGHT_BG;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 10, 40);  // near/far follow the camera distance (see tick)

  const perspective = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
  const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 200);
  const defaultTarget = new THREE.Vector3(0, 0.9, 0);
  const frontOffset = new THREE.Vector3(0, -0.43, 4.8);
  const frontDirection = frontOffset.clone().normalize();
  let camera = perspective;
  camera.position.copy(defaultTarget).add(frontOffset);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(defaultTarget);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // Close enough to read a face or a seam, but still outside the body: zoom moves
  // toward the orbit target, so a smaller limit would bury the camera inside the
  // mesh. The pivot itself never moves on its own — a zoom-to-cursor was tried
  // and dropped, it turned the wheel into a twitchy chase.
  controls.minDistance = 0.22;
  controls.maxDistance = 25;

  // Custom wheel zoom. The stock OrbitControls (r160) divides the wheel delta by
  // (devicePixelRatio | 0), which is 0 at browser zoom < 100% -> infinite jumps, and it
  // applies large trackpad/free-spin deltas in a single step. Here each wheel event only
  // moves a target distance by a bounded factor, and the camera eases toward it per frame.
  controls.enableZoom = false;
  const zoom = { target: camera.position.distanceTo(controls.target) };
  renderer.domElement.addEventListener("wheel", (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? container.clientHeight : 1;
    const px = Math.max(-120, Math.min(120, e.deltaY * unit));  // cap per event (~1 notch)
    zoom.target = THREE.MathUtils.clamp(zoom.target * Math.pow(1.0015, px),
      controls.minDistance, controls.maxDistance);
    invalidate();
  }, { passive: false });
  const zoomDir = new THREE.Vector3();
  function applyZoom() {
    const dist = camera.position.distanceTo(controls.target);
    if (Math.abs(dist - zoom.target) < 1e-4) return false;
    // Easing alone is not enough: from 5 m down to 0.22 m the 20% rule travels
    // most of a metre in one frame, which reads as a lurch. Cap the per-frame
    // travel so a burst of wheel notches glides instead.
    const delta = zoom.target - dist;
    const step = Math.sign(delta) * Math.min(Math.abs(delta) * 0.2, 0.12);
    const next = dist + step;
    zoomDir.subVectors(camera.position, controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(zoomDir, next);
    if (camera === orthographic) updateOrthographic();
    dirty = true;
    return true;
  }
  window.__viewer = { get camera() { return camera; }, controls, zoom,
    get renderCount() { return renderer.info.render.frame; },
    get groundHeight() { return floor.position.y; },
    get skeleton() { return actors[0]?.skeleton?.group; }, get actors() { return actors; } };  // for automated tests

  // Soft studio lighting: sky/ground ambient, a front-top key light that casts the floor
  // shadow (it follows the body, see setFrame), a cool fill from the side and a rim light.
  const ambient = new THREE.HemisphereLight(0xf5f7ff, 0xc8ccd8, 1.4);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  const SUN_OFFSET = new THREE.Vector3(-2.2, 6, 3.6);  // front-left: shadow falls back-right
  sun.position.copy(SUN_OFFSET);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  const fill = new THREE.DirectionalLight(0xe6ebff, 0.55);
  fill.position.set(4, 2, 2);
  const rim = new THREE.DirectionalLight(0xffffff, 0.7);
  rim.position.set(1.5, 3, -5);
  scene.add(fill, rim);
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 20 });
  scene.add(sun, sun.target);

  function syncCharacterLighting() {
    const custom = !!character.active;
    // A custom character brings its own MMD ambient, so the scene ambient goes
    // lower than for the bare SMPL body: that is what gives the toon ramp a real
    // shadow side to step through, and the sun/rim carry the shaping instead.
    ambient.intensity = custom ? .34 : 1.4;
    sun.intensity = custom ? 1.68 : 1.9;
    fill.intensity = custom ? .22 : .55;
    rim.intensity = custom ? .62 : .7;
  }

  // Editor grid over the shadow plane, with the two horizontal world axes.
  const FLOOR_SIZE = 200;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
    new THREE.MeshBasicMaterial({ map: floorGridTexture(renderer, FLOOR_SIZE, darkTheme) }));
  floor.rotation.x = -Math.PI / 2;
  const axes = new THREE.BufferGeometry();
  axes.setAttribute("position", new THREE.Float32BufferAttribute([
    -100, 0.01, 0, 100, 0.01, 0, 0, 0.01, -100, 0, 0.01, 100,
  ], 3));
  const red = new THREE.Color(0xad5757);
  const green = new THREE.Color(0x55875a);
  axes.setAttribute("color", new THREE.Float32BufferAttribute([
    ...red.toArray(), ...red.toArray(), ...green.toArray(), ...green.toArray(),
  ], 3));
  const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
    new THREE.ShadowMaterial({ color: 0x4b5468, opacity: 0.34 }));
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = 0.001;
  shadowPlane.receiveShadow = true;
  const axisLines = new THREE.LineSegments(axes, new THREE.LineBasicMaterial({ vertexColors: true }));
  scene.add(floor, shadowPlane, axisLines);
  window.addEventListener("flowhmr:themechange", ({ detail }) => {
    const dark = detail.dark;
    const bg = dark ? DARK_BG : LIGHT_BG;
    scene.background.setHex(bg);
    scene.fog.color.setHex(bg);
    floor.material.map.dispose();
    floor.material.map = floorGridTexture(renderer, FLOOR_SIZE, dark);
    invalidate();
  });

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xa9a9a9, roughness: 0.75, metalness: 0.0 });
  let actors = [], estimatedGround = null;
  const skeletonToggle = $("optSkeleton"), coneToggle = $("optBoneCones"), skinToggle = $("optSkin");
  const bodySelect = $("bodyVariant");
  const groundAuto = $("optGroundAuto"), groundInput = $("groundHeight"), wireToggle = $("toggleWire");
  let showSkeletonOverlay = localStorage.getItem("flowhmr-skeleton") !== "off";
  const savedSkin = localStorage.getItem("flowhmr-skin");
  let showSkin = savedSkin === null ? localStorage.getItem("flowhmr-skeleton-only") !== "on" : savedSkin === "on";
  skeletonToggle.checked = showSkeletonOverlay;
  coneToggle.checked = localStorage.getItem("flowhmr-bone-cones") === "on";

  // ---------------------------------------------------------------- appearance
  // A character FBX may reference textures that no longer exist (absolute paths
  // from another machine, or a bake folder that was never shipped). The white
  // look ignores those materials entirely and shows the clean body shape; the
  // original look hands the asset's own materials back.
  const LOOK_STORAGE = "flowhmr-look", JOINT_SIZE_STORAGE = "flowhmr-joint-size";
  const BONE_WIDTH_STORAGE = "flowhmr-bone-width", LOOKS = new Set(["white", "original", "normal"]);
  const lookSelect = $("optLook"), jointSizeInput = $("optJointSize"), boneWidthInput = $("optBoneWidth");
  const storedLook = localStorage.getItem(LOOK_STORAGE);
  let look = LOOKS.has(storedLook) ? storedLook : "white";
  const clampNumber = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  let jointSize = clampNumber(localStorage.getItem(JOINT_SIZE_STORAGE), 1, 10, 4);
  let boneWidth = clampNumber(localStorage.getItem(BONE_WIDTH_STORAGE), 0.4, 2, 1);
  if (lookSelect) lookSelect.value = look;
  if (jointSizeInput) jointSizeInput.value = String(jointSize);
  if (boneWidthInput) boneWidthInput.value = String(boneWidth);
  const whiteLook = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.9, metalness: 0.0 });
  const normalLook = new THREE.MeshNormalMaterial();
  let lookDirty = false;

  // ------------------------------------------------------------ cel outline
  // Inverted-hull outline for MMD characters: the same skinned geometry drawn
  // back faces only, pushed out along the skinned normal. One extra draw call
  // per material group, no render target and no post pass, so it stays cheap.
  const OUTLINE_STORAGE = "flowhmr-outline";
  // World-space thickness in metres. At a typical 2.5 m framing this lands on
  // roughly 2–3 screen pixels, which is what makes the line read at all.
  const OUTLINE_THICKNESS = 0.0082;
  const outlineToggle = $("optOutline");
  let showOutline = localStorage.getItem(OUTLINE_STORAGE) !== "off";
  if (outlineToggle) outlineToggle.checked = showOutline;
  const outlineMaterial = new THREE.MeshPhongMaterial({
    color: 0x000000, emissive: 0x0c1018, specular: 0x000000, shininess: 0, side: THREE.BackSide,
  });
  // Placeholder for groups that must not be outlined: three skips invisible
  // materials, so the group costs nothing but keeps the material array aligned
  // with geometry.groups.
  const hiddenOutlineMaterial = new THREE.MeshBasicMaterial({ visible: false });
  /** Solid, opaque, single-sided surfaces only. Anything drawn from both sides
   *  or from the back is a sheet with no thickness, and a hull around it either
   *  inverts into itself or pokes through. */
  function outlineable(material) {
    if (!material || material.visible === false) return false;
    if (material.transparent) return false;
    if ((material.alphaTest ?? 0) > 0) return false;
    if (typeof material.opacity === "number" && material.opacity < 0.999) return false;
    if (material.side !== undefined && material.side !== THREE.FrontSide) return false;
    return true;
  }
  outlineMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.outlineThickness = { value: OUTLINE_THICKNESS };
    shader.vertexShader = "uniform float outlineThickness;\n" + shader.vertexShader.replace(
      "#include <skinning_vertex>",
      `#include <skinning_vertex>
      transformed += normalize( objectNormal ) * outlineThickness;`,
    );
  };
  outlineMaterial.customProgramCacheKey = () => "flowhmr-cel-outline";
  const celToggle = $("optCel");
  let showCel = localStorage.getItem(CEL_STORAGE) !== "off";
  if (celToggle) celToggle.checked = showCel;
  function syncCelShading() {
    for (const actor of actors) {
      const mesh = actor.character?.mesh;
      if (mesh) setCelShading(mesh, showCel);
    }
    invalidate();
  }
  celToggle?.addEventListener("change", () => {
    showCel = celToggle.checked;
    localStorage.setItem(CEL_STORAGE, showCel ? "on" : "off");
    syncCelShading();
  });

  // ---- cloth dock ------------------------------------------------------
  const clothToggle = $("optCloth");
  const clothSolveButton = $("clothSolveButton");
  if (clothToggle) clothToggle.checked = clothEnabled();
  clothToggle?.addEventListener("change", () => {
    setClothEnabled(clothToggle.checked);
    // Turning it off must restore the retargeted pose, not leave the last frame
    // of cloth baked into the skeleton.
    for (const actor of actors) drawActorFrame(actor, state.frame);
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  });
  function syncClothDock() {
    const ready = actors.some((actor) => actor.character?.mesh?.skeleton);
    if (clothSolveButton) clothSolveButton.disabled = !ready || !!clothSolving();
    if (clothToggle) clothToggle.disabled = !ready;
  }
  clothSolveButton?.addEventListener("click", async () => {
    const actor = actors.find((entry) => entry.character?.mesh?.skeleton);
    if (!actor) return;
    const from = Math.max(0, Math.round(state.frame));
    const last = actor.meta.num_frames - 1;
    await openClothSolve({
      actor,
      from,
      to: last,
      showFrame: (frame) => {
        state.frame = frame;
        for (const entry of actors) drawActorFrame(entry, frame);
        renderer.render(scene, camera);
      },
      confirmStart: true,
    });
    syncClothDock();
    // Redraw the lane from whatever the solve left in the cache.
    const baked = clothTrack(actor.id);
    if (baked?.mesh === actor.character?.mesh) renderClothLane(baked.amplitudes ?? [], baked.length);
    for (const entry of actors) drawActorFrame(entry, state.frame);
    invalidate();
  });
  for (const [id, key] of [["clothElasticity", "stiffness"], ["clothDamping", "damping"], ["clothGravity", "gravity"]]) {
    const input = $(id);
    if (!input) continue;
    input.value = String(clothSettings[key]);
    input.addEventListener("input", () => {
      updateClothSettings({ [key]: Number(input.value) });
      clearClothTrack();
      for (const actor of actors) {
        if (actor.character) actor.character.cloth = null;
        drawActorFrame(actor, state.frame);
      }
      invalidate();
    });
  }
  const clothCollideBox = $("clothCollide");
  if (clothCollideBox) {
    clothCollideBox.checked = clothSettings.collide !== false;
    clothCollideBox.addEventListener("change", () => {
      updateClothSettings({ collide: clothCollideBox.checked });
      clearClothTrack();
      for (const actor of actors) {
        if (actor.character) actor.character.cloth = null;
        drawActorFrame(actor, state.frame);
      }
      invalidate();
    });
  }

  const state = {
    jobId: null, meta: null, scene: null, bodyVariant: "neutral", frame: 0, playing: false, speed: 1, lastT: 0, acc: 0,
    dt: 1 / 60,
    prevRoot: new THREE.Vector3(),
  };
  const poseMenu = $("characterPoseMenu");
  const poseEditor = initPoseEditor((entry, settings) => {
    character.editPose(entry, settings);
    drawActorFrame(entry.actor, state.frame);
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  }, (id) => character.focus(id));
  poseMenu.addEventListener("toggle", () => syncSkeletonDisplay());
  const character = initPreviewCharacter(() => actors, () => {
    poseEditor.setActors(actors, character.focused?.id);
    syncSkeletonDisplay();
    if (state.meta && state.frame >= 0) updateFrameRoot(state.frame);
    labelBody();
  }, (error) => setText($("viewportObject"), error));

  function updateOrthographic() {
    const halfHeight = camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2));
    const halfWidth = halfHeight * perspective.aspect;
    Object.assign(orthographic, { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight });
    orthographic.updateProjectionMatrix();
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    perspective.aspect = Math.max(w, 1) / Math.max(h, 1);
    perspective.updateProjectionMatrix();
    updateOrthographic();
    invalidate();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const views = {
    front: new THREE.Vector3(0, 0, 1),
    back: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    left: new THREE.Vector3(-1, 0, 0),
    top: new THREE.Vector3(0, 1, 0),
    bottom: new THREE.Vector3(0, -1, 0),
  };
  const gizmo = $("viewGizmo");
  const gizmoButtons = [...gizmo.querySelectorAll("[data-view]")];
  const inverseView = new THREE.Quaternion();
  const projected = new THREE.Vector3();
  function updateGizmo() {
    inverseView.copy(camera.quaternion).invert();
    for (const button of gizmoButtons) {
      projected.copy(views[button.dataset.view]).applyQuaternion(inverseView);
      const x = 46 + projected.x * 28;
      const y = 46 - projected.y * 28;
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
      button.style.zIndex = Math.round(10 + projected.z * 9);
      button.style.opacity = projected.z < -0.28 ? "0.62" : "1";
      if (button.textContent) {
        const line = gizmo.querySelector(`line.gizmo-${button.textContent.toLowerCase()}`);
        line.setAttribute("x2", x);
        line.setAttribute("y2", y);
      }
    }
  }
  controls.addEventListener("change", () => { updateGizmo(); invalidate(); });
  controls.addEventListener("start", () => {
    setText($("viewportName"), m(camera === orthographic ? "view.user_orthographic" : "view.user_perspective"));
  });
  controls.update();
  updateGizmo();

  function setProjection(next) {
    if (next !== camera) {
      next.position.copy(camera.position);
      next.quaternion.copy(camera.quaternion);
      controls.object = camera = next;
    }
    updateOrthographic();
    controls.update();
    updateGizmo();
    setText($("viewportName"), m(camera === orthographic ? "view.user_orthographic" : "view.user_perspective"));
    invalidate();
  }
  function clearOrbitInertia() {
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = damping;
  }
  function setView(name) {
    const direction = views[name];
    clearOrbitInertia();
    setProjection(orthographic);
    const distance = camera.position.distanceTo(controls.target);
    camera.position.copy(controls.target).addScaledVector(direction, distance);
    controls.update();
    updateOrthographic();
    updateGizmo();
    zoom.target = distance;
    setText($("viewportName"), m("view.orthographic_direction", { direction: m(`view.${name}`) }));
  }
  function toggleProjection() {
    setProjection(camera === perspective ? orthographic : perspective);
  }
  $("toggleProjection").onclick = toggleProjection;
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.onclick = () => setView(button.dataset.view);
  });
  // ------------------------------------------------------------ view navigation
  // Left button keeps its original job (drag to pan) — UE spends it on selection,
  // which this viewport has nothing to select with. UE's right-drag orbit is
  // adopted because it is strictly better than a mode switch: rotating and
  // panning are always live at once instead of being mutually exclusive.
  controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
  controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  controls.screenSpacePanning = true;
  $("toggleGrid").onclick = (event) => {
    floor.visible = axisLines.visible = !floor.visible;
    shadowPlane.visible = floor.visible && (!actors.length || actors.some(({ body, character }) => (character?.mesh ?? body).visible));
    event.currentTarget.setAttribute("aria-pressed", String(floor.visible));
    invalidate();
  };
  function syncCharacterWire(root) {
    root?.traverse((object) => {
      if (!object.isMesh) return;
      for (const material of [].concat(object.material)) {
        if (!material || material.wireframe === bodyMat.wireframe) continue;
        material.wireframe = bodyMat.wireframe;
        material.needsUpdate = true;
      }
    });
  }

  // Keep the asset's own materials aside so the look can be swapped at any time.
  function lookBaseMaterial(mesh) {
    if (!mesh.userData.lookBase) mesh.userData.lookBase = mesh.material;
    return mesh.userData.lookBase;
  }
  function applyLookMaterial(mesh, material) {
    if (!mesh) return;
    const base = lookBaseMaterial(mesh);
    if (material) mesh.material = Array.isArray(base) ? base.map(() => material) : material;
    else if (mesh.material !== base) mesh.material = base;
  }
  function actorLookMaterial(actor) {
    if (look === "normal") return normalLook;
    if (look !== "white") return null;
    if (!actor.whiteLook) {
      actor.whiteLook = whiteLook.clone();
      actor.whiteLook.color.lerp(new THREE.Color(personColor(Math.max(0, (actor.number ?? 1) - 1))), 0.12);
    }
    return actor.whiteLook;
  }
  function applyLook() {
    whiteLook.wireframe = normalLook.wireframe = bodyMat.wireframe;
    for (const actor of actors) {
      const material = actorLookMaterial(actor);
      applyLookMaterial(actor.body, material);
      const root = actor.character?.mesh;
      if (root) {
        root.traverse((node) => { if (node.isMesh) applyLookMaterial(node, material); });
        // Newly attached characters start with whatever 三渲二 is set to.
        if (actor.character.asset?.kind === "pmx") setCelShading(root, showCel);
      }
    }
  }

  function clearOutlines(actor) {
    for (const node of actor.outlines ?? []) node.removeFromParent();
    actor.outlines = [];
  }
  // Vertex-shell outline: a copy of the mesh pushed along its normals and drawn
  // back-face only. A screen-space pass was tried and dropped — it cannot tell a
  // cloth fold from a stack of hair cards, so it drew every layer.
  function syncCharacterOutline(actor) {
    const root = actor.character?.mesh;
    const wanted = showOutline && actor.character?.asset?.kind === "pmx" && root?.visible;
    clearOutlines(actor);
    if (!wanted) return;
    root.updateMatrixWorld(true);
    root.traverse((node) => {
      if (!node.isSkinnedMesh || !node.skeleton) return;
      const source = Array.isArray(node.material) ? node.material : [node.material];
      const materials = source.map((material) => (outlineable(material) ? outlineMaterial : hiddenOutlineMaterial));
      if (materials.every((material) => material === hiddenOutlineMaterial)) return;
      const outline = new THREE.SkinnedMesh(node.geometry, source.length === 1 ? materials[0] : materials);
      outline.name = "character-outline";
      outline.bindMode = node.bindMode;
      outline.bind(node.skeleton, node.bindMatrix);
      outline.matrixAutoUpdate = false;
      outline.matrix.copy(node.matrix);
      outline.frustumCulled = false;
      outline.castShadow = false;
      outline.receiveShadow = false;
      node.parent.add(outline);
      actor.outlines.push(outline);
    });
  }

  // ---------------------------------------------------------------- display
  // One control decides what the viewport shows: Original / White / Normal /
  // Wire / Skeleton. The old split (a solid-wire-skeleton switch plus a separate
  // material dropdown) could be combined into states that meant nothing, such as
  // "wireframe with original materials". The hidden <select> stays as the state
  // holder so the rest of the look pipeline is unchanged.
  const displayMenu = $("displayMenu");
  const displayValue = $("displayValue");
  const displayButtons = displayMenu ? [...displayMenu.querySelectorAll("[data-display]")] : [];
  function currentDisplay() {
    if (!showSkin) return "skeleton";
    if (bodyMat.wireframe) return "wire";
    return look;
  }
  function syncDisplayMenu() {
    const mode = currentDisplay();
    const ready = actors.some((a) => a.skeleton);
    if (displayValue) setText(displayValue, m(`view.display_${mode}`));
    for (const button of displayButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.display === mode));
      button.disabled = button.dataset.display === "skeleton" && !ready;
    }
  }
  function setDisplay(mode) {
    const skin = mode !== "skeleton";
    if (showSkin !== skin) {
      showSkin = skin;
      localStorage.setItem("flowhmr-skin", skin ? "on" : "off");
    }
    bodyMat.wireframe = mode === "wire";
    bodyMat.needsUpdate = true;
    const nextLook = ["original", "white", "normal"].includes(mode) ? mode : look;
    if (nextLook !== look) {
      look = nextLook;
      localStorage.setItem(LOOK_STORAGE, look);
      if (lookSelect) lookSelect.value = look;
    }
    for (const { body, character } of actors) {
      body.material.wireframe = bodyMat.wireframe;
      body.material.needsUpdate = true;
      syncCharacterWire(character?.mesh);
    }
    applyLook();
    syncSkeletonDisplay();
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  }
  for (const button of displayButtons) {
    button.addEventListener("click", () => {
      setDisplay(button.dataset.display);
      displayMenu.open = false;
    });
  }
  wireToggle.onclick = () => setDisplay(bodyMat.wireframe ? look : "wire");

  function removeActors() {
    character.releaseActors(actors);
    for (const actor of actors) {
      removeSkeleton(actor);
      clearOutlines(actor);
      scene.remove(actor.group);
      actor.body.geometry.dispose();
      // The look material may be on screen; the owned material is the base one.
      const base = actor.body.userData.lookBase ?? actor.body.material;
      if (base !== bodyMat) base.dispose();
      actor.whiteLook?.dispose();
    }
    actors = [];
    show("previewCharacter", false);
    poseEditor.setActors([]);
    window.dispatchEvent(new Event("flowhmr:characterchange"));
  }

  function setGround(height) {
    floor.position.y = axisLines.position.y = height;
    shadowPlane.position.y = height + 0.001;
    invalidate();
  }

  function syncGround() {
    groundInput.disabled = groundAuto.checked;
    if (groundAuto.checked) {
      const height = estimatedGround?.height_m ?? 0;
      setGround(height);
      groundInput.value = height.toFixed(3);
      const source = ["correction", "shared", "contacts", "soles"].includes(estimatedGround?.source)
        ? estimatedGround.source : "unavailable";
      setText($("groundSource"), m(`view.ground_${source}`));
    } else {
      setText($("groundSource"), estimatedGround
        ? m("view.ground_reference", { height: estimatedGround.height_m.toFixed(3) }) : m("view.ground_manual"));
    }
  }
  groundAuto.addEventListener("change", syncGround);
  groundInput.addEventListener("input", () => {
    if (!groundAuto.checked && Number.isFinite(Math.fround(groundInput.valueAsNumber))) {
      setGround(groundInput.valueAsNumber);
    }
  });

  function removeSkeleton(actor) {
    const { skeleton } = actor;
    if (!skeleton) return;
    actor.group.remove(skeleton.group);
    for (const item of skeleton.group.children) {
      item.dispose?.();
      item.geometry.dispose();
      item.material.dispose();
    }
    actor.skeleton = null;
  }

  function makeBoneCones(count, xray) {
    // Square shoulder close to the head and a long tapered tail, as in
    // Blender's Octahedral display. The bone's local Z runs from head to tail.
    const points = [
      [0, 0, 0], [-.1, -.1, .1], [.1, -.1, .1], [.1, .1, .1], [-.1, .1, .1], [0, 0, 1],
    ];
    const faces = [[0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 1, 4], [5, 1, 2], [5, 2, 3], [5, 3, 4], [5, 4, 1]];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(faces.flatMap((face) => face.flatMap((i) => points[i])), 3));
    geometry.setAttribute("boneBarycentric", new THREE.Float32BufferAttribute(faces.flatMap(() => [1, 0, 0, 0, 1, 0, 0, 0, 1]), 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0xb2b2b2, roughness: 0.88, ...xray });
    material.onBeforeCompile = (shader) => {
      // Shade a thin contour on each visible face in the same draw call.
      shader.uniforms.boneEdgeColor = { value: new THREE.Color(0x27282b) };
      shader.vertexShader = "attribute vec3 boneBarycentric; varying vec3 vBoneBarycentric;\n" + shader.vertexShader
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBoneBarycentric = boneBarycentric;");
      shader.fragmentShader = "uniform vec3 boneEdgeColor; varying vec3 vBoneBarycentric;\n" + shader.fragmentShader
        .replace("#include <opaque_fragment>", `
          vec3 pixelWidth = max(fwidth(vBoneBarycentric), vec3(0.0001));
          vec3 edgeFade = smoothstep(vec3(0.06), vec3(0.96), vBoneBarycentric / pixelWidth);
          outgoingLight = mix(boneEdgeColor, outgoingLight, min(edgeFade.x, min(edgeFade.y, edgeFade.z)));
          #include <opaque_fragment>
        `);
    };
    const cones = new THREE.InstancedMesh(geometry, material, count);
    cones.name = "skeleton-cones";
    cones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cones.frustumCulled = false;
    cones.renderOrder = 4;
    return cones;
  }

  const boneAxis = new THREE.Vector3(0, 0, 1), boneHead = new THREE.Vector3(), boneDirection = new THREE.Vector3();
  const boneScale = new THREE.Vector3(), boneRotation = new THREE.Quaternion(), boneMatrix = new THREE.Matrix4();
  const inverseActor = new THREE.Matrix4();
  function drawSkeletonFrame(actor, frame) {
    const { skeleton } = actor;
    if (!skeleton?.group.visible) return;
    const { points, lines, cones, stride, joints, edges, parents } = skeleton;
    // With a custom character applied, the 52 SMPL joints are read from the
    // character's own bones (rig.sourceToTarget), so the overlay sits on the
    // retargeted body instead of on the raw capture. Only the bare SMPL-H body
    // falls back to the per-frame joint stream.
    if (actor.character) {
      const { asset, mesh, rig } = actor.character;
      const bones = asset.kind === "fbx" ? asset.getRig(mesh).bones : mesh.skeleton.bones;
      actor.group.updateWorldMatrix(true, false);
      mesh.updateMatrixWorld(true);
      inverseActor.copy(actor.group.matrixWorld).invert();
      for (let j = 0; j < parents.length; j++) {
        const bone = bones[rig.sourceToTarget[j]];
        if (bone) boneHead.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(inverseActor).toArray(points.array, j * 3);
        else if (parents[j] >= 0) points.array.copyWithin(j * 3, parents[j] * 3, parents[j] * 3 + 3);
      }
    } else {
      // Bare SMPL body: the joint stream is a flat array of whole frames.
      const total = stride > 0 ? joints.length / stride : 0;
      const f0 = Math.floor(frame);
      const t = frame - f0;
      const f1 = Math.min(total - 1, f0 + 1);
      const a = f0 * stride;
      if (t < 1e-4 || f1 === f0) {
        points.array.set(joints.subarray(a, a + stride));
      } else {
        const b = f1 * stride;
        for (let i = 0; i < stride; i++) {
          const va = joints[a + i];
          points.array[i] = va + (joints[b + i] - va) * t;
        }
      }
    }
    points.needsUpdate = true;
    if (cones.visible) {
      let count = 0;
      for (let i = 0; i < edges.length; i += 2) {
        boneHead.fromArray(points.array, edges[i] * 3);
        boneDirection.fromArray(points.array, edges[i + 1] * 3).sub(boneHead);
        const length = boneDirection.length();
        if (!Number.isFinite(length) || length < 1e-6) continue;
        boneScale.set(length * boneWidth, length * boneWidth, length);
        boneRotation.setFromUnitVectors(boneAxis, boneDirection.divideScalar(length));
        cones.setMatrixAt(count++, boneMatrix.compose(boneHead, boneRotation, boneScale));
      }
      cones.count = count;
      cones.instanceMatrix.needsUpdate = true;
    } else {
      for (let i = 0; i < edges.length; i++) {
        const from = edges[i] * 3;
        lines.array.set(points.array.subarray(from, from + 3), i * 3);
      }
      lines.needsUpdate = true;
    }
  }

  function syncSkeletonDisplay() {
    syncCharacterLighting();
    const ready = actors.some((a) => a.skeleton);
    const only = ready && !showSkin;
    const visible = ready && (only || showSkeletonOverlay);
    skeletonToggle.checked = only || showSkeletonOverlay;
    skeletonToggle.disabled = !ready || only;
    skinToggle.checked = !only;
    skinToggle.disabled = !ready;
    coneToggle.disabled = !visible;
    jointSizeInput.disabled = !visible;
    boneWidthInput.disabled = !visible || !coneToggle.checked;
    shadowPlane.visible = floor.visible && !only;
    wireToggle.disabled = only;
    syncDisplayMenu();
    setAttr($("skeletonOverlayLabel"), "title", m(character.active
      ? poseMenu.open ? "pose.target_overlay" : "character.skeleton" : "view.skeleton_hint"));
    applyLook();
    for (const actor of actors) {
      const mesh = actor.character?.mesh;
      actor.body.visible = !mesh && (!only || !actor.skeleton);
      if (mesh) {
        mesh.visible = !only || !actor.skeleton;
        syncCharacterWire(mesh);
      }
      syncCharacterOutline(actor);
      if (actor.skeleton) {
        const { group, bones, cones, jointMarkers } = actor.skeleton;
        group.visible = visible;
        bones.visible = !coneToggle.checked;
        jointMarkers.visible = !coneToggle.checked;
        jointMarkers.material.size = jointSize;
        cones.visible = coneToggle.checked;
        cones.material.depthTest = cones.material.depthWrite = only;
      }
      drawActorFrame(actor, state.frame);
    }
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  }

  function setInspection(actor, info) {
    if (!state.scene) {
      if (info && Number.isFinite(info.ground?.height_m)) estimatedGround = info.ground;
      syncGround();
    }
    const parents = info?.parents;
    if (!Array.isArray(parents) || info.frames !== actor.meta.num_frames || parents[0] !== -1
        || !parents.slice(1).every((parent, i) => Number.isInteger(parent) && parent >= 0 && parent <= i)
        || info.joints.length !== info.frames * parents.length * 3) return;
    removeSkeleton(actor);
    const edges = parents.slice(1).flatMap((parent, i) => [parent, i + 1]);
    const stride = parents.length * 3;
    const attribute = (length) => new THREE.BufferAttribute(new Float32Array(length), 3).setUsage(THREE.DynamicDrawUsage);
    const points = attribute(stride), lines = attribute(edges.length * 3);
    const pointsGeometry = new THREE.BufferGeometry().setAttribute("position", points);
    const linesGeometry = new THREE.BufferGeometry().setAttribute("position", lines);
    const xray = { depthTest: false, depthWrite: false };
    const bones = new THREE.LineSegments(linesGeometry, new THREE.LineBasicMaterial({ color: 0xffb860, ...xray }));
    const joints = new THREE.Points(pointsGeometry, new THREE.PointsMaterial({ color: 0xffe8a9, size: 4, sizeAttenuation: false, ...xray }));
    const cones = makeBoneCones(edges.length / 2, xray);
    bones.name = "skeleton-bones"; joints.name = "skeleton-joints";
    bones.renderOrder = 4; joints.renderOrder = 5;
    bones.frustumCulled = joints.frustumCulled = false;
    const group = new THREE.Group();
    group.add(bones, joints, cones);
    actor.group.add(group);
    actor.skeleton = { group, points, lines, bones, cones, jointMarkers: joints, stride, joints: info.joints, edges, parents };
    syncSkeletonDisplay();
  }
  skeletonToggle.addEventListener("change", () => {
    showSkeletonOverlay = skeletonToggle.checked;
    localStorage.setItem("flowhmr-skeleton", showSkeletonOverlay ? "on" : "off");
    syncSkeletonDisplay();
  });
  coneToggle.addEventListener("change", () => {
    localStorage.setItem("flowhmr-bone-cones", coneToggle.checked ? "on" : "off");
    syncSkeletonDisplay();
  });
  skinToggle.addEventListener("change", () => {
    showSkin = skinToggle.checked;
    localStorage.setItem("flowhmr-skin", showSkin ? "on" : "off");
    syncSkeletonDisplay();
  });
  lookSelect.addEventListener("change", () => {
    look = LOOKS.has(lookSelect.value) ? lookSelect.value : "white";
    localStorage.setItem(LOOK_STORAGE, look);
    syncLookChip();
    syncDisplayMenu();
    applyLook();
    for (const actor of actors) drawActorFrame(actor, state.frame);
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  });
  jointSizeInput.addEventListener("input", () => {
    jointSize = clampNumber(jointSizeInput.value, 1, 10, 4);
    localStorage.setItem(JOINT_SIZE_STORAGE, String(jointSize));
    for (const actor of actors) if (actor.skeleton) actor.skeleton.jointMarkers.material.size = jointSize;
    invalidate();
  });
  boneWidthInput.addEventListener("input", () => {
    boneWidth = clampNumber(boneWidthInput.value, 0.4, 2, 1);
    localStorage.setItem(BONE_WIDTH_STORAGE, String(boneWidth));
    for (const actor of actors) if (actor.skeleton?.cones.visible) drawActorFrame(actor, state.frame);
    invalidate();
  });
  outlineToggle?.addEventListener("change", () => {
    showOutline = outlineToggle.checked;
    localStorage.setItem(OUTLINE_STORAGE, showOutline ? "on" : "off");
    for (const actor of actors) syncCharacterOutline(actor);
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  });

  // Loading bar for the viewport. The load runs in stages (read the binary
  // meshes, then build rigs and skeletons) and each stage is a wide parallel
  // fetch, so the bar slides instead of pretending to know a percentage.
  const loadingBox = $("viewerLoading"), loadingText = $("viewerLoadingText");
  let loadingStage = 0;
  function showLoading(message) {
    if (!loadingBox) return;
    loadingStage += 1;
    loadingBox.classList.remove("hidden", "done");
    if (message) setText(loadingText, message);
    invalidate();
  }
  function finishLoading() {
    if (!loadingBox) return;
    loadingBox.classList.add("done");
    setTimeout(() => {
      if (loadingStage) loadingBox.classList.add("hidden");
    }, 220);
    invalidate();
  }

  // ---------------------------------------------------------- tool chips
  // Three compact chips instead of eleven flat controls: the look chip also
  // shows the active look, and opening one group closes the others.
  const lookChipValue = $("vtLookValue");
  function syncLookChip() {
    if (lookChipValue) setText(lookChipValue, m(`view.look_${look}`));
  }
  syncLookChip();
  const toolGroups = [...document.querySelectorAll("#viewerTools details.vt-group")];
  for (const group of toolGroups) {
    group.addEventListener("toggle", () => {
      if (!group.open) return;
      for (const other of toolGroups) if (other !== group) other.open = false;
    });
  }
  document.addEventListener("pointerdown", (event) => {
    // A click outside the chips closes whichever group is open.
    if (event.target.closest?.(".vt-group")) return;
    for (const group of toolGroups) group.open = false;
  });

  const sourceStart = (meta) => meta.track_start ?? 0;
  const actorFrame = (actor, frame) => sourceStart(state.meta) + frame - sourceStart(actor.meta);

  function frameRoot(f) {
    const root = new THREE.Vector3();
    for (const actor of actors) {
      const i = Math.min(actor.meta.num_frames - 1, Math.max(0, actorFrame(actor, f)));
      let [x, z] = actor.meta.root_trajectory[i];
      const scale = actor.character?.rig.rootMotionScale ?? 1;
      if (scale !== 1) {
        const [startX, startZ] = actor.meta.root_trajectory[0];
        x = startX + (x - startX) * scale;
        z = startZ + (z - startZ) * scale;
      }
      root.x += x * actor.cos + z * actor.sin + actor.group.position.x;
      root.z += z * actor.cos - x * actor.sin + actor.group.position.z;
    }
    return root.divideScalar(Math.max(1, actors.length));
  }

  // Cloth runs after the retarget pass: the body solve owns the mapped bones, and
  // the cloth solver only rewrites the bones it classified. When a baked track
  // exists for this actor it is read instead of simulated, which is what makes
  // scrubbing and looping free.
  function applyCloth(actor, frame) {
    const character = actor.character;
    if (!character || !clothEnabled()) return;
    if (!character.cloth) {
      if (!character.mesh?.skeleton?.bones?.length) return;
      character.cloth = createClothDynamics({
        mesh: character.mesh, rig: character.rig, options: clothSettings,
      });
      if (!character.cloth.info.bones) { character.cloth = null; return; }
    }
    const track = clothTrack(actor.id);
    // A track belongs to one mesh; after a character swap its bones are stale.
    if (track && track.mesh === character.mesh && applyClothFrame(track, frame)) return;
    character.cloth.step(frame, state.dt || 1 / 60);
  }

  function drawActorFrame(actor, globalFrame) {
    const { body, group, meta, verts } = actor;
    const f = actorFrame(actor, globalFrame);
    group.visible = globalFrame >= 0 && f >= 0 && f < meta.num_frames;
    if (!group.visible) return;
    if (actor.character) {
      // The rig has to be posed whenever the overlay reads it, not only when the
      // skin is on screen. "Skeleton" display mode hides the mesh but takes its
      // joint positions from that same rig, so gating on mesh.visible froze the
      // skeleton in place.
      if (actor.character.mesh.visible || actor.skeleton?.group.visible) {
        actor.character.rig.apply(f);
        applyCloth(actor, f);
      }
      drawSkeletonFrame(actor, f);
      return;
    }
    drawSkeletonFrame(actor, f);
    if (!body.visible) return;
    // Vertex frames are half-float snapshots, so a fractional frame blends the
    // two neighbours. Without this the body can only ever sit on whole frames
    // while the rig around it interpolates — the two would drift apart.
    const pos = body.geometry.attributes.position;
    const n = pos.array.length;
    const f0 = Math.floor(f);
    const t = f - f0;
    const f1 = Math.min(meta.num_frames - 1, f0 + 1);
    if (t < 1e-4 || f1 === f0) {
      const offset = f0 * n;
      for (let i = 0; i < n; i++) pos.array[i] = fromHalf[verts[offset + i]];
    } else {
      const o0 = f0 * n, o1 = f1 * n;
      for (let i = 0; i < n; i++) {
        const a = fromHalf[verts[o0 + i]];
        pos.array[i] = a + (fromHalf[verts[o1 + i]] - a) * t;
      }
    }
    pos.needsUpdate = true;
    body.geometry.computeVertexNormals();
  }

  function updateFrameRoot(f) {
    const root = frameRoot(f);
    sun.position.copy(root).add(SUN_OFFSET);
    sun.target.position.copy(root);
    if ($("optFollow").checked) {
      const delta = root.clone().sub(state.prevRoot);
      camera.position.add(delta);
      controls.target.add(delta);
    }
    state.prevRoot.copy(root);
  }

  function setFrame(f) {
    const m = state.meta;
    if (!m || !actors.length) return;
    f = Math.max(0, Math.min(m.num_frames - 1, f));
    if (f === state.frame) return;
    state.frame = f;
    for (const actor of actors) drawActorFrame(actor, f);
    updateFrameRoot(f);
    scrub.value = Math.round(f);
    // Frame numbers are shown on the timeline's own fps, like a DCC timeline:
    // the clip is still 30 fps of samples, so switching to 60 fps doubles the
    // numbers without changing the motion. `f` itself stays in source frames.
    const fps = displayFps();
    const offset = state.scene ? sourceStart(m) : 0;
    const displayFrame = Math.floor((offset + f) / m.fps * fps) + 1;
    const totalFrames = Math.round((offset + m.num_frames) / m.fps * fps);
    $("frameLabel").textContent = `${displayFrame} / ${totalFrames}`;
    $("playhead").textContent = displayFrame;
    const position = f / Math.max(1, m.num_frames - 1);
    $("timelineTrack").style.setProperty("--playhead", `calc(${position * 100}% + ${12 - 24 * position}px)`);
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  }

  const frameButtons = [...document.querySelectorAll("[data-frame-action]")];
  // ------------------------------------------------ timeline fps (display only)
  // The clip's sample rate never changes; this only decides what number the
  // timeline prints and how finely the scrubber is labelled.
  const DISPLAY_FPS_STORAGE = "flowhmr-timeline-fps";
  const fpsSelect = $("timelineFps");
  function displayFps() {
    const value = Number(fpsSelect?.value);
    return Number.isFinite(value) && value > 0 ? value : 30;
  }
  if (fpsSelect) {
    const stored = Number(localStorage.getItem(DISPLAY_FPS_STORAGE));
    if ([24, 25, 30, 48, 50, 60, 120].includes(stored)) fpsSelect.value = String(stored);
    fpsSelect.addEventListener("change", () => {
      localStorage.setItem(DISPLAY_FPS_STORAGE, fpsSelect.value);
      if (state.meta) setFrame(state.frame);
      else setTimeline(0);
    });
  }

  function setTimeline(frameCount) {
    const ready = frameCount > 0;
    scrub.max = Math.max(0, frameCount - 1);
    scrub.value = 0;
    scrub.disabled = $("btnPlay").disabled = $("speed").disabled = !ready;
    for (const button of frameButtons) button.disabled = !ready;
    $("timelineTrack").classList.toggle("has-motion", ready);
    const start = ready && state.scene ? sourceStart(state.meta) + 1 : 1;
    // The range readout moved into the fps control's tooltip; the control itself
    // now carries the same "start–end · fps" summary.
    const rangeText = ready ? `${start}–${start + frameCount - 1} · ${state.meta.fps} FPS` : m("timeline.no_motion");
    setAttr($("timelineFps"), "title", rangeText);
    $("timelineFps").disabled = !ready;
    const tickCount = Math.min(5, frameCount);
    const ticks = Array.from({ length: tickCount }, (_, i) => {
      const tick = document.createElement("span");
      tick.textContent = Math.round(i * (frameCount - 1) / Math.max(1, tickCount - 1)) + start;
      return tick;
    });
    $("timelineTicks").replaceChildren(...ticks);
    if (!ready) $("frameLabel").textContent = "– / –";
  }

  function frameView(direction) {
    const m = state.meta;
    const root = m ? frameRoot(state.frame) : new THREE.Vector3();
    const height = m ? Math.max(1.2, m.bbox_max[1] - m.bbox_min[1]) : defaultTarget.y * 2;
    const width = state.scene ? Math.hypot(m.bbox_max[0] - m.bbox_min[0], m.bbox_max[2] - m.bbox_min[2]) : 0;
    const distance = m ? Math.max(4, height * 2.4, width * 1.7) : frontOffset.length();
    controls.target.set(root.x, height * 0.5, root.z);
    camera.position.copy(controls.target).addScaledVector(direction, distance);
    zoom.target = camera.position.distanceTo(controls.target);
    state.prevRoot.copy(root);
    controls.update();
    updateOrthographic();
    invalidate();
  }

  function resetView() {
    frameView(camera.position.clone().sub(controls.target).normalize());
  }

  function frameDefaultView() {
    clearOrbitInertia();
    setProjection(perspective);
    frameView(frontDirection);
  }

  // On loop: move camera + target back with the body, keeping the user's zoom and angle.
  function recenterOnFrame(f) {
    const root = frameRoot(f);
    const delta = root.clone().sub(state.prevRoot);
    camera.position.add(delta);
    controls.target.add(delta);
    state.prevRoot.copy(root);
  }

  // ---------------------------------------------------------------- video sync
  const syncToggle = $("optSync");
  const media = { time: NaN, lastMove: 0, retried: false, fallback: false, play: null };
  const mediaEnabled = () => state.meta && syncToggle.checked && !!video.getAttribute("src");
  const resetMediaWatch = () => { media.time = NaN; media.lastMove = performance.now(); };
  const videoTimeFor = (f) => clock.timeOf((state.meta.track_start || 0) + f + 0.5, state.meta.fps);
  const videoFrame = () => clock.frameAt(video.currentTime, state.meta.fps) - (state.meta.track_start || 0);
  function playVideo() {
    if (!video.paused || media.play) return;
    const pending = media.play = video.play();
    pending.catch(() => {}).finally(() => { if (media.play === pending) media.play = null; });
  }

  function seekVideo(frame) {
    const time = videoTimeFor(frame);
    video.currentTime = Number.isFinite(video.duration) ? Math.min(time, video.duration) : time;
    resetMediaWatch();
  }

  function syncVideo(force) {
    if (!mediaEnabled() || media.fallback || video.readyState < 1 || !clock.ready) return;
    const different = Math.abs(video.currentTime - videoTimeFor(state.frame));
    if (state.playing) {
      video.playbackRate = state.speed;
      if (force || different > 0.15) seekVideo(state.frame);
      playVideo();
    } else {
      if (!video.paused) video.pause();
      if (force || different > 0.02) seekVideo(state.frame);
    }
  }

  function resetMediaSync() {
    if (media.fallback) preview.showPreviewIssue("");
    media.fallback = media.retried = false;
    resetMediaWatch();
  }

  function setPlaying(p, driveVideo = true) {
    if (state.playing !== p) {
      state.acc = state.lastT = 0;
      resetMediaWatch();
    }
    state.playing = p;
    $("iconPlay").classList.toggle("hidden", p);
    $("iconPause").classList.toggle("hidden", !p);
    if (driveVideo) syncVideo(true);
    invalidate();
  }

  video.addEventListener("flowhmr:sourcechanging", ({ detail }) => {
    media.play = null;
    if (!detail.retry) resetMediaSync(); else resetMediaWatch();
  });
  video.addEventListener("flowhmr:clockready", () => syncVideo(true));
  // Browsers without requestVideoFrameCallback use the zero-origin clock.
  video.addEventListener("loadedmetadata", () => syncVideo(true));
  video.addEventListener("play", () => {
    if (!mediaEnabled() || !clock.ready || video.paused || state.playing) return;
    resetMediaSync();
    const next = videoFrame();
    if (next < 0 || next >= state.meta.num_frames) {
      setFrame(0);
      seekVideo(0);
    } else setFrame(next);
    video.playbackRate = state.speed;
    setPlaying(true, false);
  });
  video.addEventListener("pause", () => {
    if (!mediaEnabled() || media.fallback || !video.paused || video.error || video.ended
        || !state.playing || !clock.ready) return;
    setFrame(videoFrame());
    setPlaying(false, false);
  });
  video.addEventListener("seeked", () => {
    if (mediaEnabled() && !state.playing && clock.ready) setFrame(videoFrame());
  });

  $("btnPlay").onclick = () => {
    if (!state.meta) return;
    if (!state.playing) {
      resetMediaSync();
      if (state.frame >= state.meta.num_frames - 1) setFrame(0);
    }
    setPlaying(!state.playing);
  };
  function jumpTo(frame) {
    if (!state.meta) return;
    setFrame(frame);
    setPlaying(false);
  }
  scrub.addEventListener("input", (e) => jumpTo(Number(e.target.value)));
  for (const button of frameButtons) {
    button.onclick = () => jumpTo({
      first: 0, previous: state.frame - 1, next: state.frame + 1, last: state.meta.num_frames - 1,
    }[button.dataset.frameAction]);
  }
  const speedSelect = $("speed");
  const savedSpeed = localStorage.getItem("flowhmr-playback-speed");
  if ([...speedSelect.options].some((option) => option.value === savedSpeed)) {
    speedSelect.value = savedSpeed;
    state.speed = Number(savedSpeed);
  }
  speedSelect.onchange = () => {
    state.speed = Number(speedSelect.value);
    localStorage.setItem("flowhmr-playback-speed", speedSelect.value);
    syncVideo(true);
  };
  $("btnReset").onclick = resetView;
  rememberToggle($("optFollow"), "flowhmr-follow");
  rememberToggle(syncToggle, "flowhmr-sync-video", (enabled) => {
    resetMediaSync();
    if (enabled) syncVideo(true); else video.pause();
  });
  const audioToggle = $("optAudio");
  const saveAudio = rememberToggle(audioToggle, "flowhmr-original-audio", (enabled) => { video.muted = !enabled; });
  video.muted = !audioToggle.checked;
  video.addEventListener("volumechange", () => {
    // Person selection mutes its looping preview temporarily.
    if (preview.temporaryMute) return;
    audioToggle.checked = !video.muted;
    saveAudio();
  });
  window.addEventListener("keydown", (e) => {
    const target = e.target;
    if (e.defaultPrevented || e.isComposing || !(target instanceof Element)) return;
    if (e.code === "Space") {
      const timelineControl = target.matches('.timeline-editor input[type="range"], #controls .transport, #btnPlay');
      if (!state.meta || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || target.isContentEditable
          || document.querySelector("dialog[open]")
          || (!timelineControl && target.closest("input, select, textarea, button, summary, a[href]"))) return;
      e.preventDefault();
      if (!e.repeat) $("btnPlay").click();
      return;
    }
    if (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    if (e.code === "Numpad1") { e.preventDefault(); setView(e.ctrlKey ? "back" : "front"); }
    if (e.code === "Numpad3") { e.preventDefault(); setView(e.ctrlKey ? "left" : "right"); }
    if (e.code === "Numpad7") { e.preventDefault(); setView(e.ctrlKey ? "bottom" : "top"); }
    if (e.code === "Numpad5") { e.preventDefault(); toggleProjection(); }
    if (e.code === "Home" || e.code === "KeyF") { e.preventDefault(); resetView(); }
    // Display keys follow the order of the 显示 menu.
    if (e.code === "Digit1") { e.preventDefault(); setDisplay("original"); }
    if (e.code === "Digit2") { e.preventDefault(); setDisplay("white"); }
    if (e.code === "Digit3") { e.preventDefault(); setDisplay("normal"); }
    if (e.code === "Digit4") { e.preventDefault(); setDisplay("wire"); }
    if (e.code === "Digit5") { e.preventDefault(); setDisplay("skeleton"); }
    if (e.code === "KeyS") {
      e.preventDefault();
      skeletonToggle.checked = !skeletonToggle.checked;
      skeletonToggle.dispatchEvent(new Event("change"));
    }
    if (e.code === "KeyO") {
      e.preventDefault();
      outlineToggle.checked = !outlineToggle.checked;
      outlineToggle.dispatchEvent(new Event("change"));
    }
    if (e.code === "KeyC" && celToggle) {
      e.preventDefault();
      celToggle.checked = !celToggle.checked;
      celToggle.dispatchEvent(new Event("change"));
    }
    if (!state.meta) return;
    if (e.code === "ArrowRight") { e.preventDefault(); jumpTo(state.frame + 1); }
    if (e.code === "ArrowLeft") { e.preventDefault(); jumpTo(state.frame - 1); }
  });

  function tickMedia(t) {
    if (clock.ready && video.readyState >= 1 && !video.seeking && (!video.paused || video.ended)) {
      const time = video.currentTime;
      if (!Number.isFinite(media.time) || Math.abs(media.time - time) > .001) {
        media.time = time;
        media.lastMove = t;
      }
      const next = videoFrame();
      if (video.ended || next >= state.meta.num_frames) {
        if ($("optFollow").checked) recenterOnFrame(0);
        setFrame(0);
        seekVideo(0);
        playVideo();
        return;
      }
      if (next >= 0 && next !== state.frame) setFrame(next);
    }
    // A stalled decoder can report paused=false indefinitely. Give the same
    // source one fresh load at the current frame, then keep the motion usable.
    if (t - media.lastMove < 1200) return;
    if (!media.retried && preview.retryPlayback()) {
      media.retried = true;
      return;
    }
    media.fallback = true;
    video.pause();
    preview.showPreviewIssue(m("source.sync_stalled"));
  }

  function tick(t) {
    renderRequest = 0;
    const dt = state.lastT ? (t - state.lastT) / 1000 : 0;
    state.dt = dt > 0 && dt < 0.5 ? dt : 1 / 60;
    state.lastT = t;
    if (state.playing && state.meta) {
      if (mediaEnabled() && !media.fallback) tickMedia(t);
      else {
        // Advance a fractional frame instead of stepping whole ones: a 30 fps
        // clip on a 60 Hz display then reposes the rig on every paint and the
        // rig's own blend fills the gap, which is what removes the stepping.
        let next = state.frame + dt * state.meta.fps * state.speed;
        if (next >= state.meta.num_frames) {
          next = 0;
          if ($("optFollow").checked) recenterOnFrame(0);
        }
        setFrame(next);
      }
    }
    const zooming = applyZoom();
    const orbiting = controls.update();
    // Paint whenever the scene changed, at most once per rAF tick: the browser
    // already synchronises rAF to the display, so an extra cap only quantises
    // the rate on panels whose refresh is not a multiple of it.
    if (dirty && t - lastPaint >= MIN_PAINT_MS) {
      dirty = false;
      lastPaint = t;
      const d = camera.position.distanceTo(controls.target);
      scene.fog.near = d + 6;
      scene.fog.far = d + 30;
      const started = performance.now();
      renderer.render(scene, camera);
      samplePaint(t, performance.now() - started);
    }
    if (state.playing || zooming || orbiting || dirty) {
      if (!renderRequest) renderRequest = requestAnimationFrame(tick);
    } else state.lastT = 0;
  }

  // ---------------------------------------------------------------- public API
  function labelBody() {
    const custom = actors.filter((actor) => actor.character).length;
    const asset = character.active;
    setText($("viewportObject"), () => [
      t("view.scene"),
      [state.scene ? t("person.count", { count: actors.length }) : "",
        ...(custom > 1 ? [t("character.custom_count", { count: custom })]
          : asset ? [({ mixamo: "Mixamo", metahuman: "MetaHuman" })[asset.profile] ?? "PMX", asset.name]
            : ["SMPL-H", t(`view.${state.bodyVariant}`)])].filter(Boolean).join(" · "),
    ].join(" | "));
  }

  async function loadActor(person, variant, signal) {
    const [meta, vertices, faces] = await Promise.all([
      api.getMeta(person.id, signal), api.getVertices(person.id, signal, variant), api.getFaces(person.id, signal),
    ]);
    if (!meta.num_frames || vertices.byteLength !== meta.num_frames * meta.num_vertices * 6
        || faces.byteLength !== meta.num_faces * 12 || (person.start != null &&
          (sourceStart(meta) !== person.start || person.end - person.start + 1 !== meta.num_frames))) {
      throw appError("view.mesh_incomplete");
    }
    return { person, meta, vertices, faces };
  }

  function addActor({ person, meta, vertices, faces }, multiple) {
    const geometry = new THREE.BufferGeometry();
    for (const key of ["position", "normal"]) {
      geometry.setAttribute(key, new THREE.BufferAttribute(new Float32Array(meta.num_vertices * 3), 3).setUsage(THREE.DynamicDrawUsage));
    }
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(faces), 1));
    const material = multiple ? bodyMat.clone() : bodyMat;
    if (multiple) material.color.lerp(new THREE.Color(personColor(person.person - 1)), 0.28);
    const body = new THREE.Mesh(geometry, material);
    body.name = "motion-skin";
    body.castShadow = true;
    body.frustumCulled = false;
    const group = new THREE.Group();
    const yaw = person.yaw ?? 0;
    group.rotation.y = yaw;
    group.position.fromArray(person.offset ?? [0, 0, 0]);
    group.name = multiple ? `person-${person.person}` : "motion-actor";
    group.add(body);
    scene.add(group);
    return { id: person.id, number: person.person, meta, verts: new Uint16Array(vertices), body, group, skeleton: null, character: null,
      cos: Math.cos(yaw), sin: Math.sin(yaw) };
  }

  function groupBounds() {
    const bounds = new THREE.Box3();
    for (const { meta, group } of actors) {
      group.updateMatrix();
      const { bbox_min: a, bbox_max: b } = meta;
      for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) {
        bounds.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(group.matrix));
      }
    }
    return { bbox_min: bounds.min.toArray(), bbox_max: bounds.max.toArray() };
  }

  bodySelect.addEventListener("change", async () => {
    const selected = bodySelect.value;
    if (!state.meta) {
      localStorage.setItem(BODY_STORAGE, selected);
      return;
    }
    bodyController?.abort();
    const change = bodyController = new AbortController();
    const jobId = state.jobId;
    bodySelect.disabled = true;
    setText($("viewportObject"), m("view.body_loading", { body: m(`view.${selected}`) }));
    try {
      const vertices = await Promise.all(actors.map((a) => api.getVertices(a.id, change.signal, selected)));
      if (change.signal.aborted || state.jobId !== jobId) return;
      if (vertices.some((data, i) => data.byteLength !== actors[i].meta.num_frames * actors[i].meta.num_vertices * 6)) {
        throw appError("view.body_incomplete");
      }
      vertices.forEach((data, i) => { actors[i].verts = new Uint16Array(data); });
      state.bodyVariant = selected;
      localStorage.setItem(BODY_STORAGE, selected);
      for (const actor of actors) drawActorFrame(actor, state.frame);
      invalidate();
      labelBody();
    } catch (error) {
      if (change.signal.aborted || state.jobId !== jobId) return;
      bodySelect.value = state.bodyVariant;
      setText($("viewportObject"), m("view.body_failed", { detail: error }));
    } finally {
      if (bodyController === change) { bodyController = null; bodySelect.disabled = false; }
    }
  });

  return {
    openCharacter: character.open,
    getPmxActors(people) {
      const selected = new Set(people.map(String));
      const targets = actors.filter((actor) => !state.scene || selected.has(String(actor.number)));
      if ((state.scene && targets.length !== selected.size) ||
          targets.some((actor) => !actor.character || actor.character.asset.kind === "fbx")) return [];
      return targets.map((actor) => ({
        person: actor.number,
        start: state.scene ? sourceStart(actor.meta) : 0,
        sceneEnd: state.scene ? sourceStart(state.meta) + state.meta.num_frames - 1 : null,
        fps: actor.meta.fps,
        yaw: actor.group.rotation.y,
        offset: actor.group.position.toArray(),
        asset: actor.character.asset,
        motion: actor.character.motion,
        poseOffsets: actor.character.poseOffsets,
      }));
    },
    setBodyVariants(names = ["neutral"], preferred = "neutral") {
      const available = new Set(names);
      for (const option of bodySelect.options) option.disabled = !available.has(option.value);
      const saved = state.meta ? state.bodyVariant : localStorage.getItem(BODY_STORAGE);
      bodySelect.value = available.has(saved) ? saved : available.has(preferred) ? preferred : names[0] ?? "";
      show("bodyVariantRow", available.size > 1);
      if (state.meta && bodySelect.value && bodySelect.value !== state.bodyVariant) {
        bodySelect.dispatchEvent(new Event("change"));
      }
    },
    get bodyVariant() { return state.meta ? state.bodyVariant : bodySelect.value || "neutral"; },
    seekSourceFrame(frame) {
      const first = state.meta?.track_start ?? 0;
      if (state.meta && frame >= first && frame < first + state.meta.num_frames) jumpTo(frame - first);
      else if (clock.ready && video.readyState >= 1) {
        setPlaying(false, false);
        video.pause();
        video.currentTime = Math.min(video.duration, clock.timeOf(frame + 0.5));
      }
    },
    async load(jobId, groupScene = null) {
      loadController?.abort();
      bodyController?.abort();
      bodyController = null;
      bodySelect.disabled = true;
      const load = loadController = new AbortController();
      const members = groupScene?.people ?? [{ id: jobId }];
      const inspections = members.map((p) => api.getInspection(p.id, load.signal).catch(() => null));
      let variant = bodySelect.value || "source";
      let data;
      showLoading(m("view.loading_mesh"));
      try {
        data = await Promise.all(members.map((p) => loadActor(p, variant, load.signal))).catch((error) => {
          if (load.signal.aborted || variant === "source") throw error;
          variant = "source";
          return Promise.all(members.map((p) => loadActor(p, variant, load.signal)));
        });
      } catch (error) {
        if (load.signal.aborted) return null;
        load.abort();
        loadController = null;
        bodySelect.disabled = false;
        finishLoading();
        throw error;
      }
      if (load.signal.aborted) return null;
      removeActors();
      showLoading(m("view.loading_rig"));
      actors = data.map((entry) => addActor(entry, !!groupScene));
      const meta = groupScene ? { ...groupScene, ...groupBounds() } : actors[0].meta;
      state.jobId = jobId;
      state.meta = meta;
      state.scene = groupScene;
      clearClothLane();
      state.frame = -1;
      state.acc = 0;
      state.lastT = 0;
      resetMediaSync();
      state.bodyVariant = bodySelect.value = variant === "source"
        ? groupScene?.body_reference ?? data[0].meta.body_reference ?? "neutral" : variant;
      bodySelect.disabled = false;
      syncSkeletonDisplay();

      setTimeline(meta.num_frames);
      show("viewerEmpty", false);
      show("viewerTools", true);
      show("groundMenu", true);
      if (groupScene) {
        estimatedGround = { height_m: groupScene.ground_m, source: "shared" };
        syncGround();
      } else setText($("groundSource"), m("view.ground_pending"));
      setText($("resultInfo"), () => [
        groupScene ? t("person.count", { count: actors.length }) : "",
        t("view.duration", { frames: meta.num_frames, seconds: (meta.num_frames / meta.fps).toFixed(1) }),
      ].filter(Boolean).join(" · "));
      setAttr($("resultInfo"), "title", m("timeline.source_span", {
        start: (meta.track_start || 0) + 1, end: (meta.track_start || 0) + meta.num_frames,
      }));
      labelBody();
      setFrame(0);
      frameDefaultView();
      setPlaying(false);
      void character.showForJob();
      finishLoading();
      void Promise.all(inspections).then((results) => {
        if (!load.signal.aborted && state.jobId === jobId) results.forEach((info, i) => setInspection(actors[i], info));
        if (loadController === load) loadController = null;
      });
      return meta;
    },
    clear() {
      loadController?.abort();
      loadController = null;
      bodyController?.abort();
      bodyController = null;
      bodySelect.disabled = false;
      state.jobId = null; state.meta = null; state.scene = null;
      removeActors();
      syncSkeletonDisplay();
      estimatedGround = null;
      groundAuto.checked = true;
      syncGround();
      $("groundMenu").open = false;
      show("groundMenu", false);
      video.pause();
      setPlaying(false);
      renderer.shadowMap.needsUpdate = true;
      show("viewerEmpty", true);
      show("viewerTools", false);
      show("dlNpz", false);
      show("dlFbx", false);
      $("menuNpz").disabled = $("menuFbx").disabled = true;
      setTimeline(0);
      setText($("viewportObject"), m("view.scene"));
      setText($("resultInfo"), "");
      setAttr($("resultInfo"), "title", "");
      frameDefaultView();
    },
    setStatus(text) { if (!state.meta) setText($("viewerEmpty"), text); },
    get jobId() { return state.jobId; },
  };
}
