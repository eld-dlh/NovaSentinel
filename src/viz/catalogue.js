// BufferGeometry point cloud for 8k objects — optimised ShaderMaterial renderer
//
// Performance characteristics (post-optimisation):
//   • ONE draw call for the entire catalogue (regardless of object count)
//   • Custom vertex/fragment shaders: perspective-correct point sizes,
//     circular soft-glow dots, hardware `discard` on corners (no overdraw)
//   • `depthWrite: false` eliminates GPU depth-sort passes on transparent geometry
//   • `computeBoundingSphere()` enables Three.js frustum culling by bounding sphere
//   • Size per-satellite via BufferAttribute — debris dots smaller than payloads
//
// Coordinate convention (matches earth.js globe):
//   Globe radius = 1.0 (Earth's surface)
//   Satellite altitude scaled: worldRadius = 1 + altKm / EARTH_RADIUS_KM
//   Y-up: x = r·sinφ·cosθ,  y = r·cosφ,  z = r·sinφ·sinθ

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mean Earth radius in km (WGS-84 volumetric) */
const EARTH_RADIUS_KM = 6371;

/** Default maximum objects the buffer can hold */
const DEFAULT_MAX_OBJECTS = 12_000;

/** Degrees → radians multiplier */
const DEG2RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// GLSL shaders
// ---------------------------------------------------------------------------

/**
 * Vertex shader — perspective-correct point sizes with per-satellite size attr.
 *
 * Perspective scale (300 / -mvPos.z) keeps dots roughly constant in pixels
 * regardless of zoom level, just like THREE.PointsMaterial sizeAttenuation.
 * The constant 300 matches a ~45° FOV at zoom ≈ 3 Earth radii out.
 */
const SAT_VERT = /* glsl */`
  attribute float size;
  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vColor  = color;
    vAlpha  = 0.82;   // slightly transparent — lets Earth show through overlap

    vec4 mvPos  = modelViewMatrix * vec4(position, 1.0);
    // Perspective point-size: keep dots small enough that Earth is visible
    gl_PointSize = size * (40.0 / -mvPos.z);  // small dots — prevents overlap at 12k objects
    gl_Position  = projectionMatrix * mvPos;
  }
`;

/**
 * Fragment shader — circular soft-glow dot.
 *
 * gl_PointCoord goes [0,1] over the point quad.  We remap to [-0.5, 0.5],
 * compute the radial distance, discard the corners (no overdraw on empty
 * transparent pixels), and apply a smooth edge falloff for a glow effect.
 */
const SAT_FRAG = /* glsl */`
  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec2  uv = gl_PointCoord - 0.5;
    float d  = length(uv);

    // Hard discard outside the circle
    if (d > 0.5) discard;

    // Hard circle — no soft bloom, no bleed between neighbouring dots
    float alpha = vAlpha;

    gl_FragColor = vec4(vColor, alpha);
  }
`;

// ---------------------------------------------------------------------------
// Geodetic → Three.js world-space conversion
// ---------------------------------------------------------------------------

/**
 * Converts geodetic coordinates (lat/lon/alt) to Three.js world-space {x, y, z}
 * on a unit-radius globe (Y-up convention).
 *
 * @param {number} latDeg  - Geodetic latitude  (degrees, −90 … +90)
 * @param {number} lonDeg  - Geodetic longitude  (degrees, −180 … +180)
 * @param {number} altKm   - Altitude above WGS-84 ellipsoid (km)
 * @param {number} [globeRadius=1] - Globe mesh radius in scene units.
 * @returns {{ x: number, y: number, z: number }}
 */
export function geoToWorld(latDeg, lonDeg, altKm, globeRadius = 1) {
  const r     = globeRadius * (1 + altKm / EARTH_RADIUS_KM);
  const phi   = (90 - latDeg) * DEG2RAD;   // polar angle from +Y
  const theta = lonDeg * DEG2RAD;           // azimuth from +X toward +Z

  return {
    x:  r * Math.sin(phi) * Math.cos(theta),
    y:  r * Math.cos(phi),
    z:  r * Math.sin(phi) * Math.sin(theta),
  };
}

// ---------------------------------------------------------------------------
// Point-cloud factory
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CatalogueCloud
 * @property {THREE.Points}          points       - The Three.js Points mesh (ONE draw call).
 * @property {THREE.BufferGeometry}  geometry     - Underlying buffer geometry.
 * @property {Float32Array}          positionBuf  - Raw position buffer (xyz interleaved).
 * @property {Float32Array}          colorBuf     - Raw color buffer (rgb interleaved).
 * @property {Float32Array}          sizeBuf      - Raw per-point size buffer.
 * @property {number}                maxObjects   - Buffer capacity.
 * @property {number}                activeCount  - Currently populated count.
 * @property {Map<string, number>}   indexMap     - NORAD ID → buffer index.
 */

/**
 * Creates a GPU-backed point cloud capable of rendering up to `maxObjects`
 * satellite dots on the Three.js globe.
 *
 * Uses a custom ShaderMaterial for:
 *   - Perspective-correct point sizes (not possible with PointsMaterial)
 *   - Circular soft-glow via GLSL `discard` (eliminates corner overdraw)
 *   - Per-satellite dot size via a `size` BufferAttribute
 *   - `depthWrite: false` — eliminates GPU z-sort on transparent geometry
 *
 * @param {THREE.Scene} scene - Scene to add the cloud to.
 * @param {{
 *   maxObjects?:   number,
 *   defaultColor?: THREE.Color,
 * }} [opts]
 * @returns {CatalogueCloud}
 */
export function createCatalogueCloud(scene, opts = {}) {
  const {
    maxObjects   = DEFAULT_MAX_OBJECTS,
    defaultColor = new THREE.Color(0x4fc3f7),
  } = opts;

  // ── Pre-allocate typed arrays ─────────────────────────────────────────────
  const positionBuf = new Float32Array(maxObjects * 3);
  const colorBuf    = new Float32Array(maxObjects * 3);
  const sizeBuf     = new Float32Array(maxObjects);

  // Fill with default colour and size
  for (let i = 0; i < maxObjects; i++) {
    colorBuf[i * 3]     = defaultColor.r;
    colorBuf[i * 3 + 1] = defaultColor.g;
    colorBuf[i * 3 + 2] = defaultColor.b;
    sizeBuf[i]          = 0.9;   // tighter default size
  }

  // ── BufferGeometry ─────────────────────────────────────────────────────────
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positionBuf, 3));
  geometry.setAttribute('color',    new THREE.BufferAttribute(colorBuf, 3));
  geometry.setAttribute('size',     new THREE.BufferAttribute(sizeBuf, 1));

  // Start with zero visible points
  geometry.setDrawRange(0, 0);

  // ── Custom ShaderMaterial ─────────────────────────────────────────────────
  const material = new THREE.ShaderMaterial({
    vertexShader:   SAT_VERT,
    fragmentShader: SAT_FRAG,
    vertexColors:   true,           // reads the 'color' attribute
    transparent:    true,
    depthWrite:     false,
    // NormalBlending (NOT AdditiveBlending) — additive causes thousands of
    // overlapping transparent dots to SUM to pure white, hiding the Earth.
    blending:       THREE.NormalBlending,
  });

  // ── Points mesh ──────────────────────────────────────────────────────────
  const points = new THREE.Points(geometry, material);
  points.name  = 'satellite-catalogue';
  // Do NOT set frustumCulled = false — let Three.js cull by bounding sphere.
  // computeBoundingSphere() is called after the first batch update.

  scene.add(points);

  return {
    points,
    geometry,
    positionBuf,
    colorBuf,
    sizeBuf,
    maxObjects,
    activeCount: 0,
    indexMap:    new Map(),
    _boundsDirty: true,   // flag: recompute bounding sphere after first fill
  };
}

// ---------------------------------------------------------------------------
// Batch position update
// ---------------------------------------------------------------------------

/**
 * Updates the point cloud with new propagated positions.
 * Called every 30 seconds from the propagation callback.
 * Only modifies the typed arrays in-place and marks GPU buffers dirty —
 * no geometry recreation, no GC pressure.
 *
 * @param {CatalogueCloud} cloud - Cloud object from createCatalogueCloud().
 * @param {Map<string, import('../propagation/propagate.js').CachedPosition>} positionMap
 *        — NORAD ID → { lat, lon, altKm, speed, ... } from the batch propagator.
 * @param {{ globeRadius?: number, colorFn?: (pos: object, noradId: string) => THREE.Color }} [opts]
 */
export function updateCataloguePositions(cloud, positionMap, opts = {}) {
  const {
    globeRadius = 1,
    colorFn     = null,   // optional per-satellite color callback
    selectedNoradId = null,
  } = opts;

  const { positionBuf, colorBuf, sizeBuf, geometry, maxObjects, indexMap } = cloud;

  let idx = 0;
  indexMap.clear();

  for (const [noradId, pos] of positionMap) {
    if (idx >= maxObjects) break;

    const world = geoToWorld(pos.lat, pos.lon, pos.altKm, globeRadius);

    const base = idx * 3;
    positionBuf[base]     = world.x;
    positionBuf[base + 1] = world.y;
    positionBuf[base + 2] = world.z;

    // Per-satellite colour
    if (colorFn) {
      const c = colorFn(pos, noradId);
      colorBuf[base]     = c.r;
      colorBuf[base + 1] = c.g;
      colorBuf[base + 2] = c.b;
    }

    // Per-satellite dot size: debris tiny, rocket body medium, payloads small
    const type = (pos.objectType ?? '').toUpperCase();
    const isSelected = selectedNoradId != null && noradId === selectedNoradId;
    const isAnySelected = selectedNoradId != null;

    if (isAnySelected) {
      if (isSelected) {
        sizeBuf[idx] = 6.0; // selected satellite highlight
      } else {
        // Dim all other satellites down
        sizeBuf[idx] = type.includes('DEBRIS') ? 0.7
                     : type.includes('ROCKET') ? 0.6
                     : 0.8;
      }
    } else {
      sizeBuf[idx] = type.includes('DEBRIS') ? 1.8
                   : type.includes('ROCKET') ? 1.4
                   : 1.0;
    }

    indexMap.set(noradId, idx);
    idx++;
  }

  cloud.activeCount = idx;

  // ── Flag GPU buffers for upload ─────────────────────────────────────────
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.size.needsUpdate     = true;
  if (colorFn) geometry.attributes.color.needsUpdate = true;

  // Only render the populated range (hides uninitialised slots)
  geometry.setDrawRange(0, idx);

  // ── Compute bounding sphere once after first real fill ──────────────────
  // Three.js uses this for frustum culling — must be called after positions land.
  if (cloud._boundsDirty && idx > 0) {
    geometry.computeBoundingSphere();
    cloud._boundsDirty = false;
  }
}

// ---------------------------------------------------------------------------
// Single-satellite update (for real-time tracking highlights)
// ---------------------------------------------------------------------------

/**
 * Updates a single satellite's position without re-uploading the entire buffer.
 *
 * @param {CatalogueCloud} cloud
 * @param {string}         noradId
 * @param {{ lat: number, lon: number, altKm: number }} pos
 * @param {{ globeRadius?: number }} [opts]
 * @returns {boolean} true if the satellite was found and updated.
 */
export function updateSinglePosition(cloud, noradId, pos, opts = {}) {
  const idx = cloud.indexMap.get(noradId);
  if (idx == null) return false;

  const { globeRadius = 1 } = opts;
  const world = geoToWorld(pos.lat, pos.lon, pos.altKm, globeRadius);

  const base = idx * 3;
  cloud.positionBuf[base]     = world.x;
  cloud.positionBuf[base + 1] = world.y;
  cloud.positionBuf[base + 2] = world.z;

  cloud.geometry.attributes.position.needsUpdate = true;
  return true;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Removes the point cloud from the scene and disposes GPU resources.
 *
 * @param {CatalogueCloud} cloud
 * @param {THREE.Scene}    scene
 */
export function disposeCatalogueCloud(cloud, scene) {
  scene.remove(cloud.points);
  cloud.geometry.dispose();
  cloud.points.material.dispose();
  cloud.indexMap.clear();
}
