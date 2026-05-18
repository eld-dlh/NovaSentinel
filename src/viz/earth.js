// Earth sphere — textured globe mesh + atmosphere glow ring
//
// Loads the Blue Marble texture from /textures/earth-blue-marble.jpg and
// applies it to a unit-sphere (r = 1.0) with MeshStandardMaterial for
// physically-based day/night shading driven by the scene's directional light.
//
// Also creates a subtle atmosphere halo using an inverted-sphere shell
// with AdditiveBlending — cheap approximation of Rayleigh scattering.
//
// Scene unit: 1 unit = 6371 km (Earth radius)

import * as THREE from 'three';

const EARTH_RADIUS_KM = 6371;

// ---------------------------------------------------------------------------
// Texture loader (singleton)
// ---------------------------------------------------------------------------

const _loader = new THREE.TextureLoader();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds and returns the Earth mesh group: globe + atmosphere shell.
 * The group is added to the scene immediately.
 *
 * @param {THREE.Scene} scene
 * @param {{ texturePath?: string }} [opts]
 * @returns {EarthGroup}
 *
 * @typedef {Object} EarthGroup
 * @property {THREE.Group}  group      — The Three.js Group containing globe + atmo.
 * @property {THREE.Mesh}   globe      — Earth sphere mesh.
 * @property {THREE.Mesh}   atmosphere — Atmosphere halo mesh.
 * @property {(dt: number) => void} tick — Call each frame to rotate Earth slowly.
 * @property {() => void}  dispose
 */
export function createEarth(scene, opts = {}) {
  const {
    texturePath = '/textures/earth-blue-marble.jpg',
  } = opts;

  const group = new THREE.Group();
  group.name  = 'earth';

  // ── Globe sphere ──────────────────────────────────────────────────────────
  const globeGeo = new THREE.SphereGeometry(1, 128, 128);

  // Load texture async; apply placeholder colour first so the globe
  // renders immediately without a blank frame.
  const globeMat = new THREE.MeshStandardMaterial({
    color:     0x1a2b4a,    // ocean blue placeholder
    roughness: 0.85,
    metalness: 0.05,
  });

  _loader.load(
    texturePath,
    (tex) => {
      tex.colorSpace     = THREE.SRGBColorSpace;
      tex.anisotropy     = 8;
      tex.wrapS          = THREE.RepeatWrapping;
      globeMat.map       = tex;
      globeMat.color.set(0xffffff);   // let texture show through
      globeMat.needsUpdate = true;
    },
    undefined,
    (err) => console.warn('[earth] Texture load failed — using flat colour.', err)
  );

  const globe = new THREE.Mesh(globeGeo, globeMat);
  globe.name  = 'globe';
  globe.castShadow    = false;
  globe.receiveShadow = false;
  group.add(globe);

  // ── City-lights / night-side texture layer (optional second pass) ─────────
  // We skip a specular ocean map for now to keep the texture count minimal.

  // ── Atmosphere halo ───────────────────────────────────────────────────────
  // Slightly larger inverted sphere with a transparent gradient material.
  const atmoGeo = new THREE.SphereGeometry(1.018, 64, 64);
  const atmoMat = new THREE.MeshPhongMaterial({
    color:         0x4488ff,
    emissive:      0x1133aa,
    emissiveIntensity: 0.4,
    transparent:   true,
    opacity:       0.12,
    side:          THREE.BackSide,     // render inner face → visible from outside
    depthWrite:    false,
    blending:      THREE.AdditiveBlending,
  });

  const atmosphere = new THREE.Mesh(atmoGeo, atmoMat);
  atmosphere.name  = 'atmosphere';
  group.add(atmosphere);

  // ── Slow Earth rotation (optional visual flair) ──────────────────────────
  // Real Earth: 360° / 86400 s ≈ 0.00417 °/s. We speed it up slightly
  // so it's visually perceptible without being distracting.
  const ROTATION_DEG_PER_SEC = 0.05;
  const ROTATION_RAD_PER_SEC = ROTATION_DEG_PER_SEC * (Math.PI / 180);

  function tick(dt) {
    group.rotation.y += ROTATION_RAD_PER_SEC * dt;
  }

  scene.add(group);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  function dispose() {
    globeGeo.dispose();
    globeMat.dispose();
    if (globeMat.map) globeMat.map.dispose();
    atmoGeo.dispose();
    atmoMat.dispose();
    scene.remove(group);
  }

  return { group, globe, atmosphere, tick, dispose };
}

// ---------------------------------------------------------------------------
// Coordinate helper (re-exported for convenience; also in catalogue.js)
// ---------------------------------------------------------------------------

/**
 * Converts geodetic coordinates to Three.js world-space XYZ on the unit globe.
 * Y-up convention, longitude = 0 aligned to +Z.
 *
 * @param {number} latDeg   Geodetic latitude  (deg, −90…+90)
 * @param {number} lonDeg   Geodetic longitude (deg, −180…+180)
 * @param {number} altKm    Altitude above WGS-84 surface (km)
 * @returns {THREE.Vector3}
 */
export function geoToXYZ(latDeg, lonDeg, altKm) {
  const r     = 1 + altKm / EARTH_RADIUS_KM;
  const phi   = (90 - latDeg) * (Math.PI / 180);
  const theta = lonDeg         * (Math.PI / 180);
  return new THREE.Vector3(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}
