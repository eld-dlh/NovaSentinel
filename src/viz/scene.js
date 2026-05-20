// Three.js scene bootstrap — renderer, camera, OrbitControls, lights, starfield
//
// Scene unit convention: 1 unit = 6371 km (Earth radius)
//   Earth surface  r = 1.0
//   ISS (~410 km)  r = 1.064
//   GPS (~20200 km) r = 4.17
//
// Lighting: ambient (0.4) + directional "sun" light cast from +X axis,
// simulating a day/night terminator visible on the textured Earth sphere.
//
// Performance settings:
//   - powerPreference: 'high-performance' → discrete GPU on laptops
//   - logarithmicDepthBuffer: false       → was true, costs ~5-10% GPU
//   - toneMapping: NoToneMapping          → ACESFilmic adds per-fragment cost
//   - pixelRatio capped at 2×             → 3-4× on Retina kills fill-rate
//   - Stars use ShaderMaterial with discard for circular dots (no overdraw)

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STARFIELD_COUNT  = 6_000;
const STARFIELD_RADIUS = 90;      // far enough never to intersect the globe

// ---------------------------------------------------------------------------
// Starfield helper — custom shader for round star dots
// ---------------------------------------------------------------------------

const STAR_VERT = /* glsl */`
  void main() {
    vec4 mvPos   = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = 1.8;                  // fixed pixel size — stars don't need attenuation
    gl_Position  = projectionMatrix * mvPos;
  }
`;

const STAR_FRAG = /* glsl */`
  void main() {
    vec2  uv = gl_PointCoord - 0.5;
    float d  = length(uv);
    if (d > 0.5) discard;             // circular clip — no corner overdraw
    float a  = smoothstep(0.5, 0.1, d);
    gl_FragColor = vec4(vec3(0.85 + 0.15 * (1.0 - d * 2.0)), a * 0.75);
  }
`;

/**
 * Creates a random point-cloud starfield sphere placed far from the globe.
 *
 * @param {THREE.Scene} scene
 * @returns {THREE.Points}
 */
function createStarfield(scene) {
  const positions = new Float32Array(STARFIELD_COUNT * 3);

  for (let i = 0; i < STARFIELD_COUNT; i++) {
    // Uniform distribution on a sphere (Marsaglia rejection method)
    let x, y, z, d;
    do {
      x = Math.random() * 2 - 1;
      y = Math.random() * 2 - 1;
      z = Math.random() * 2 - 1;
      d = x * x + y * y + z * z;
    } while (d > 1 || d === 0);
    const r = STARFIELD_RADIUS / Math.sqrt(d);
    positions[i * 3]     = x * r;
    positions[i * 3 + 1] = y * r;
    positions[i * 3 + 2] = z * r;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeBoundingSphere();   // needed for frustum culling

  // Custom shader: circular dots, no overdraw, cheaper than PointsMaterial
  const mat = new THREE.ShaderMaterial({
    vertexShader:   STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent:    true,
    depthWrite:     false,
  });

  const stars = new THREE.Points(geo, mat);
  stars.name  = 'starfield';
  // frustumCulled stays true — bounding sphere set above covers it
  scene.add(stars);
  return stars;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Initialises the Three.js WebGL scene and attaches it to the given canvas.
 *
 * @param {HTMLCanvasElement} canvas   The target <canvas> element.
 * @returns {SceneContext}
 *
 * @typedef {Object} SceneContext
 * @property {THREE.WebGLRenderer} renderer
 * @property {THREE.Scene}         scene
 * @property {THREE.PerspectiveCamera} camera
 * @property {OrbitControls}       controls
 * @property {THREE.Points}        stars
 * @property {() => void}          dispose   — releases GPU resources
 */
export function initScene(canvas) {
  // ── Renderer ──────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias:       true,
    powerPreference: 'high-performance',  // ★ use discrete GPU on laptops/desktops
    // logarithmicDepthBuffer: false (default) — was true, costs 5-10% GPU for
    // minimal benefit at our depth ratios (near=0.01, far=200, all > 1 unit)
  });

  // Cap at 2× — 3-4× on high-DPI displays kills fill-rate for no visible gain
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  // NoToneMapping skips the ACES per-fragment curve — saves ~3% GPU
  // The satellite shaders use additive blending which works better untonemapped
  renderer.toneMapping      = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // ── Scene ──────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020409);   // near-black deep space

  // ── Camera ─────────────────────────────────────────────────────────────────
  const aspect = canvas.clientWidth / canvas.clientHeight || 1;
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 200);
  camera.position.set(0, 0, 3.2);                 // start ~2 Earth radii out

  // ── OrbitControls ──────────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping    = true;
  controls.dampingFactor    = 0.07;
  controls.rotateSpeed      = 0.4;
  controls.zoomSpeed        = 0.8;
  controls.panSpeed         = 0.4;
  controls.minDistance      = 1.15;   // just above Earth surface
  controls.maxDistance      = 12;     // GEO belt visible
  controls.enablePan        = false;
  controls.screenSpacePanning = false;

  // ── Lighting ───────────────────────────────────────────────────────────────
  const ambient = new THREE.AmbientLight(0x223355, 0.6);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.position.set(5, 2, 3);
  sun.name = 'sun';
  scene.add(sun);

  // ── Starfield ──────────────────────────────────────────────────────────────
  const stars = createStarfield(scene);

  // ── Resize observer ────────────────────────────────────────────────────────
  let _resizeRafId = null;
  const resizeObs = new ResizeObserver(() => {
    if (_resizeRafId) cancelAnimationFrame(_resizeRafId);
    _resizeRafId = requestAnimationFrame(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
  });
  resizeObs.observe(canvas);

  // ── Dispose ────────────────────────────────────────────────────────────────
  function dispose() {
    resizeObs.disconnect();
    controls.dispose();
    renderer.dispose();
    stars.geometry.dispose();
    stars.material.dispose();
  }

  return { renderer, scene, camera, controls, stars, dispose };
}

// ---------------------------------------------------------------------------
// Animation loop helper
// ---------------------------------------------------------------------------

/**
 * Starts the render loop. Returns a cancel function.
 *
 * The loop only calls controls.update() and renderer.render() — no propagation
 * happens here. Propagation runs in a Web Worker on a 30-second timer and
 * posts results back asynchronously, keeping this loop at a steady 60 fps.
 *
 * @param {SceneContext} ctx
 * @param {(dt: number) => void} [onFrame]  Optional per-frame callback (dt in seconds).
 * @returns {() => void}  Call to stop the loop.
 */
export function startRenderLoop(ctx, onFrame) {
  const { renderer, scene, camera, controls } = ctx;
  let rafId;
  let last = performance.now();

  function frame(now) {
    rafId    = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);  // cap dt at 100ms
    last     = now;
    controls.update();
    if (onFrame) onFrame(dt);
    renderer.render(scene, camera);
  }

  rafId = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(rafId);
}
