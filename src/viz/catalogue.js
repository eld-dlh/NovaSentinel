// BufferGeometry point cloud for 8k objects
//
// Converts propagated geodetic positions (lat/lon/alt) into Three.js
// world-space coordinates on a unit-sphere globe and renders them as an
// instanced point cloud using THREE.Points + BufferGeometry.
//
// Coordinate convention (matches earth.js globe):
//   Globe radius = 1.0 (Earth's surface)
//   Satellite altitude is scaled: worldRadius = 1 + altKm / EARTH_RADIUS_KM
//   Latitude → polar angle (φ = 90° − lat), Longitude → azimuth (θ = lon)
//   Three.js Y-up: x = r·sinφ·cosθ,  y = r·cosφ,  z = r·sinφ·sinθ
//
// Usage:
//   import { createCatalogueCloud, updateCataloguePositions } from './catalogue.js';
//   const cloud = createCatalogueCloud(scene, { maxObjects: 10000 });
//   propagator.start(positions => updateCataloguePositions(cloud, positions));

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mean Earth radius in km (WGS-84 volumetric) */
const EARTH_RADIUS_KM = 6371;

/** Default maximum objects the buffer can hold */
const DEFAULT_MAX_OBJECTS = 10_000;

/** Degrees → radians multiplier */
const DEG2RAD = Math.PI / 180;

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
  const r   = globeRadius * (1 + altKm / EARTH_RADIUS_KM);
  const phi = (90 - latDeg) * DEG2RAD;   // polar angle from +Y
  const theta = lonDeg * DEG2RAD;         // azimuth from +X toward +Z

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
 * @property {THREE.Points}          points       - The Three.js Points mesh.
 * @property {THREE.BufferGeometry}  geometry     - Underlying buffer geometry.
 * @property {Float32Array}          positionBuf  - Raw position buffer (xyz interleaved).
 * @property {Float32Array}          colorBuf     - Raw color buffer (rgb interleaved).
 * @property {number}                maxObjects   - Buffer capacity.
 * @property {number}                activeCount  - Currently populated count.
 * @property {Map<string, number>}   indexMap     - NORAD ID → buffer index.
 */

/**
 * Creates a GPU-backed point cloud capable of rendering up to `maxObjects`
 * satellite dots on the Three.js globe.
 *
 * @param {THREE.Scene} scene - Scene to add the cloud to.
 * @param {{
 *   maxObjects?: number,
 *   pointSize?:  number,
 *   defaultColor?: THREE.Color,
 * }} [opts]
 * @returns {CatalogueCloud}
 */
export function createCatalogueCloud(scene, opts = {}) {
  const {
    maxObjects   = DEFAULT_MAX_OBJECTS,
    pointSize    = 2.5,
    defaultColor = new THREE.Color(0x00ffcc),
  } = opts;

  // Pre-allocate typed arrays
  const positionBuf = new Float32Array(maxObjects * 3);
  const colorBuf    = new Float32Array(maxObjects * 3);

  // Fill colours with default
  for (let i = 0; i < maxObjects; i++) {
    colorBuf[i * 3]     = defaultColor.r;
    colorBuf[i * 3 + 1] = defaultColor.g;
    colorBuf[i * 3 + 2] = defaultColor.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positionBuf, 3));
  geometry.setAttribute('color',    new THREE.BufferAttribute(colorBuf, 3));

  // Start with 0 visible points
  geometry.setDrawRange(0, 0);

  const material = new THREE.PointsMaterial({
    size:             pointSize,
    vertexColors:     true,
    sizeAttenuation:  true,
    transparent:      true,
    opacity:          0.85,
    depthWrite:       false,
    blending:         THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.name  = 'satellite-catalogue';
  points.frustumCulled = false; // always render — globe fills the frustum

  scene.add(points);

  return {
    points,
    geometry,
    positionBuf,
    colorBuf,
    maxObjects,
    activeCount: 0,
    indexMap: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Batch position update
// ---------------------------------------------------------------------------

/**
 * Updates the point cloud with new propagated positions.
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
  } = opts;

  const { positionBuf, colorBuf, geometry, maxObjects, indexMap } = cloud;

  let idx = 0;
  indexMap.clear();

  for (const [noradId, pos] of positionMap) {
    if (idx >= maxObjects) break;

    const world = geoToWorld(pos.lat, pos.lon, pos.altKm, globeRadius);

    const base = idx * 3;
    positionBuf[base]     = world.x;
    positionBuf[base + 1] = world.y;
    positionBuf[base + 2] = world.z;

    // Apply per-satellite colouring if provided
    if (colorFn) {
      const c = colorFn(pos, noradId);
      colorBuf[base]     = c.r;
      colorBuf[base + 1] = c.g;
      colorBuf[base + 2] = c.b;
    }

    indexMap.set(noradId, idx);
    idx++;
  }

  cloud.activeCount = idx;

  // Flag GPU buffers for upload
  geometry.attributes.position.needsUpdate = true;
  if (colorFn) geometry.attributes.color.needsUpdate = true;

  // Only draw the active range
  geometry.setDrawRange(0, idx);
}

// ---------------------------------------------------------------------------
// Single-satellite update (for real-time tracking highlights)
// ---------------------------------------------------------------------------

/**
 * Updates a single satellite's position in the point cloud without
 * re-uploading the entire buffer.
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
