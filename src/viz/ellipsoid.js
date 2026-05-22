// CDM uncertainty ellipsoid mesh builder
//
// Replaces the fixed Hard Body Radius sphere with a dynamically sized
// THREE.Mesh whose scale encodes the 1-sigma position uncertainty ellipsoid
// derived from the CDM combined covariance eigenvalues.
//
// Scene unit convention: 1 scene unit = 6371 km (Earth radius)
// So km → scene units: km / 6371
// And m → scene units: m / 6_371_000

import * as THREE from 'three';
import { cdmToEllipsoidAxes, covarianceSummary } from '../data/cdmCovariance.js';
import { pocToColor, pocToOpacity, pocToTier, pocToCSS } from './riskColors.js';

// ---------------------------------------------------------------------------
// Scene unit conversion
// ---------------------------------------------------------------------------

/** 1 scene unit = Earth radius = 6371 km */
const EARTH_RADIUS_KM = 6371;

/** Converts metres to Three.js scene units */
const metresToScene = (m) => m / (EARTH_RADIUS_KM * 1000);

// ---------------------------------------------------------------------------
// Shared material factory (one material per tier, lazy-created)
// ---------------------------------------------------------------------------

const _materialCache = new Map();

/**
 * Returns a cached MeshPhongMaterial for the given risk tier.
 * Using a shared material per tier avoids GPU state thrashing across
 * thousands of ellipsoid meshes.
 *
 * @param {number|null} poc
 * @returns {THREE.MeshPhongMaterial}
 */
function getEllipsoidMaterial(poc) {
  const tier = pocToTier(poc);
  if (!_materialCache.has(tier)) {
    const col = pocToColor(poc);
    // Very low opacity so the Earth globe remains visible through the ellipsoids.
    // Use DoubleSide + depthWrite:false to avoid Z-fighting artefacts.
    const baseOpacity = { GREEN: 0.04, AMBER: 0.07, RED: 0.12, UNKNOWN: 0.03 }[tier] ?? 0.04;
    _materialCache.set(tier, new THREE.MeshPhongMaterial({
      color:             col,
      emissive:          col,
      emissiveIntensity: 0.6,     // glow-like look without brightness overdose
      transparent:       true,
      opacity:           baseOpacity,
      side:              THREE.DoubleSide,
      depthWrite:        false,   // prevent z-fighting with satellite dots
      wireframe:         false,
    }));
  }
  return _materialCache.get(tier);
}

// ---------------------------------------------------------------------------
// Geometry — unit sphere scaled per-mesh
// ---------------------------------------------------------------------------

/** Shared unit-sphere geometry (r=1, scaled via mesh.scale) */
let _sharedSphereGeo = null;
function getUnitSphere() {
  if (!_sharedSphereGeo) {
    // 32×32 segments gives smooth ellipsoid appearance at typical view distances
    _sharedSphereGeo = new THREE.SphereGeometry(1, 32, 32);
  }
  return _sharedSphereGeo;
}

// ---------------------------------------------------------------------------
// Main ellipsoid factory
// ---------------------------------------------------------------------------

/**
 * Creates a Three.js Mesh representing a 1-sigma position uncertainty ellipsoid.
 *
 * The ellipsoid is built in RTN frame (same as the CDM covariance).
 * Call `orientEllipsoidRTN()` to rotate it into ECI/world frame at the
 * conjunction point.
 *
 * @param {number[]} axes     - [a, b, c] semi-axis lengths in metres (from semiAxes()).
 * @param {number|null} poc   - Probability of Collision (drives colour/opacity).
 * @returns {THREE.Mesh}      Ellipsoid mesh, not yet added to a scene.
 */
export function createUncertaintyEllipsoid(axes, poc = null) {
  const [a, b, c] = axes;

  const mesh = new THREE.Mesh(
    getUnitSphere(),
    getEllipsoidMaterial(poc).clone(),  // clone so per-mesh opacity tweaks work
  );

  // Scale the unit sphere into the ellipsoid shape
  mesh.scale.set(
    metresToScene(a),
    metresToScene(b),
    metresToScene(c),
  );

  // Tag with metadata for raycasting / tooltip lookup
  mesh.userData.isEllipsoid = true;
  mesh.userData.poc         = poc;
  mesh.userData.semiAxesM   = axes;

  return mesh;
}

// ---------------------------------------------------------------------------
// RTN → ECI orientation
// ---------------------------------------------------------------------------

/**
 * Orients an ellipsoid mesh into the RTN frame centred at a given ECI position.
 *
 * RTN basis vectors:
 *   R̂ = r̂            (radial: along position vector)
 *   N̂ = (r × v) / |r × v|  (normal: orbit normal)
 *   T̂ = N̂ × R̂        (transverse: roughly along velocity)
 *
 * @param {THREE.Mesh}    mesh      - Ellipsoid mesh to orient.
 * @param {THREE.Vector3} posECI    - Satellite ECI position (scene units).
 * @param {THREE.Vector3} velECI    - Satellite ECI velocity (scene units/s).
 */
export function orientEllipsoidRTN(mesh, posECI, velECI) {
  const R = posECI.clone().normalize();                     // radial
  const N = new THREE.Vector3().crossVectors(posECI, velECI).normalize(); // normal
  const T = new THREE.Vector3().crossVectors(N, R).normalize();           // transverse

  // Build rotation matrix with columns [R, T, N] matching ellipsoid axes [a, b, c]
  const m = new THREE.Matrix4().makeBasis(R, T, N);
  mesh.setRotationFromMatrix(m);
}

// ---------------------------------------------------------------------------
// Live CDM update
// ---------------------------------------------------------------------------

/**
 * Re-scales and recolours an existing ellipsoid mesh from a fresh CDM record.
 * Call this inside the polling onCDMUpdate() callback.
 *
 * @param {THREE.Mesh} mesh       - Existing ellipsoid mesh.
 * @param {Object}     cdmRecord  - Raw CDM JSON record.
 */
export function updateEllipsoidFromCDM(mesh, cdmRecord) {
  const poc  = parseFloat(cdmRecord.PC ?? 'NaN') || null;
  const { axes } = cdmToEllipsoidAxes(cdmRecord);

  // Re-scale
  mesh.scale.set(
    metresToScene(axes[0]),
    metresToScene(axes[1]),
    metresToScene(axes[2]),
  );

  // Re-colour (swap material clone for new tier)
  mesh.material.dispose();
  mesh.material = getEllipsoidMaterial(poc).clone();

  // Update metadata
  mesh.userData.poc       = poc;
  mesh.userData.semiAxesM = axes;
}

// ---------------------------------------------------------------------------
// Tooltip data builder
// ---------------------------------------------------------------------------

/**
 * Builds a tooltip data object from a CDM record, ready for the UI layer.
 * Does not create DOM — that is the alertPanel's responsibility.
 *
 * @param {Object} cdmRecord - Raw CDM JSON record.
 * @returns {{
 *   cdmId:        string,
 *   tca:          string,   ISO-8601 UTC
 *   poc:          number,
 *   pocFormatted: string,   e.g. "2.34e-5"
 *   tier:         string,   GREEN | AMBER | RED | UNKNOWN
 *   tierColor:    string,   CSS colour
 *   missDistM:    number,   miss distance in metres
 *   sat1Name:     string,
 *   sat2Name:     string,
 *   sigmaR:       number,   1-sigma along R (m)
 *   sigmaT:       number,   1-sigma along T (m)
 *   sigmaN:       number,   1-sigma along N (m)
 * }}
 */
export function buildEllipsoidTooltip(cdmRecord) {
  const poc     = parseFloat(cdmRecord.PC ?? 'NaN') || null;
  const summary = covarianceSummary(cdmRecord);

  return {
    cdmId:        cdmRecord.CDM_ID         ?? '—',
    tca:          cdmRecord.TCA            ?? '—',
    poc:          poc,
    pocFormatted: poc != null ? poc.toExponential(2) : 'N/A',
    tier:         pocToTier(poc),
    tierColor:    pocToCSS(poc),
    missDistM:    parseFloat(cdmRecord.MISS_DISTANCE ?? 'NaN'),
    sat1Name:     cdmRecord.SAT1_OBJECT_NAME ?? cdmRecord.SAT1_OBJECT_DESIGNATOR ?? '—',
    sat2Name:     cdmRecord.SAT2_OBJECT_NAME ?? cdmRecord.SAT2_OBJECT_DESIGNATOR ?? '—',
    sigmaR:       summary.sigmaR,
    sigmaT:       summary.sigmaT,
    sigmaN:       summary.sigmaN,
  };
}

// ---------------------------------------------------------------------------
// Raycasting helper — pick ellipsoid under mouse
// ---------------------------------------------------------------------------

const _raycaster = new THREE.Raycaster();
const _mouse     = new THREE.Vector2();

/**
 * Tests a mouse event against a list of ellipsoid meshes and returns the
 * closest intersected mesh (or null), along with its tooltip data.
 *
 * @param {MouseEvent}     event       - DOM mouse/pointer event.
 * @param {THREE.Mesh[]}   ellipsoids  - Array of ellipsoid meshes to test.
 * @param {THREE.Camera}   camera
 * @param {HTMLCanvasElement} canvas
 * @param {Object[]}       cdmRecords  - Parallel array of CDM records (same order as ellipsoids).
 * @returns {{ mesh: THREE.Mesh, tooltip: Object } | null}
 */
export function pickEllipsoid(event, ellipsoids, camera, canvas, cdmRecords) {
  const rect = canvas.getBoundingClientRect();
  _mouse.set(
    ((event.clientX - rect.left) / rect.width)  *  2 - 1,
    ((event.clientY - rect.top)  / rect.height) * -2 + 1,
  );

  _raycaster.setFromCamera(_mouse, camera);
  const hits = _raycaster.intersectObjects(ellipsoids, false);

  if (hits.length === 0) return null;

  const mesh  = hits[0].object;
  const idx   = ellipsoids.indexOf(mesh);
  const cdm   = cdmRecords[idx];

  return {
    mesh,
    tooltip: cdm ? buildEllipsoidTooltip(cdm) : null,
  };
}

// ---------------------------------------------------------------------------
// Disposal helper
// ---------------------------------------------------------------------------

/**
 * Properly disposes a single ellipsoid mesh (geometry is shared — don't dispose it).
 * @param {THREE.Mesh} mesh
 */
export function disposeEllipsoid(mesh) {
  mesh.material.dispose(); // each mesh has a cloned material
  // Do NOT dispose mesh.geometry — it's the shared unit sphere
}

/**
 * Clears all ellipsoid children from a Three.js Group and disposes materials.
 * @param {THREE.Group} group
 */
export function clearEllipsoids(group) {
  const toRemove = group.children.filter(c => c.userData.isEllipsoid);
  toRemove.forEach(m => {
    group.remove(m);
    disposeEllipsoid(m);
  });
}
