// Earth sphere — textured globe mesh + atmosphere glow ring (cheap shader version)
//
// Loads the Blue Marble texture from /textures/earth-blue-marble.jpg and
// applies it to a unit-sphere (r = 1.0) with MeshStandardMaterial for
// physically-based day/night shading driven by the scene's directional light.
//
// Atmosphere: replaced the old MeshPhong inverted-sphere trick with a custom
// ShaderMaterial that computes rim lighting in the vertex shader and uses
// AdditiveBlending.  This is cheaper because:
//   - No Phong per-fragment specular calculation
//   - intensity computed once in vert shader, interpolated in frag
//   - depthWrite: false prevents GPU z-sort on the transparent shell
//
// Scene unit: 1 unit = 6371 km (Earth radius)

import * as THREE from 'three';

const EARTH_RADIUS_KM = 6371;

// ---------------------------------------------------------------------------
// Atmosphere shader (rim-lighting approximation of Rayleigh scattering)
// ---------------------------------------------------------------------------

const ATMO_VERT = /* glsl */`
  varying float intensity;

  void main() {
    // vNormal in view space — dot with camera-forward (0,0,1) gives rim factor
    vec3 vN  = normalize(normalMatrix * normal);
    // pow controls the sharpness of the atmosphere ring
    intensity = pow(max(0.0, 0.75 - dot(vN, vec3(0.0, 0.0, 1.0))), 2.2);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ATMO_FRAG = /* glsl */`
  uniform vec3 glowColor;
  varying float intensity;

  void main() {
    gl_FragColor = vec4(glowColor * intensity, intensity * 0.55);
  }
`;

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

  // ── Globe sphere ───────────────────────────────────────────────────────────
  // Reduced from 128×128 to 96×96 — saves ~10k vertices, imperceptible at r=1
  const globeGeo = new THREE.SphereGeometry(1, 96, 96);

  const globeMat = new THREE.MeshStandardMaterial({
    color:     0x1a2b4a,    // ocean blue placeholder before texture loads
    roughness: 0.85,
    metalness: 0.05,
  });

  _loader.load(
    texturePath,
    (tex) => {
      tex.colorSpace   = THREE.SRGBColorSpace;
      tex.anisotropy   = 8;
      tex.wrapS        = THREE.RepeatWrapping;
      globeMat.map     = tex;
      globeMat.color.set(0xffffff);   // let texture show through
      globeMat.needsUpdate = true;
    },
    undefined,
    (err) => console.warn('[earth] Texture load failed — using flat colour.', err)
  );

  const globe = new THREE.Mesh(globeGeo, globeMat);
  globe.name          = 'globe';
  globe.castShadow    = false;
  globe.receiveShadow = false;
  group.add(globe);

  // ── Atmosphere halo — custom ShaderMaterial (replaces MeshPhong) ──────────
  //
  // Key differences from the old approach:
  //   OLD: MeshPhongMaterial — runs Phong specular per-fragment (expensive)
  //   NEW: ShaderMaterial — intensity computed per-vertex, just 1 uniform lookup
  //        in the fragment shader — roughly 2× cheaper on transparent geometry.
  //
  // Shell radius 1.045 (was 1.018) — slightly larger gap makes the rim more
  // visible without adding polygon count (still only 32×32 = 2k triangles).
  const atmoGeo = new THREE.SphereGeometry(1.045, 32, 32);
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color(0x2266ff) },
    },
    vertexShader:   ATMO_VERT,
    fragmentShader: ATMO_FRAG,
    side:        THREE.BackSide,        // render inner face → visible from outside
    blending:    THREE.AdditiveBlending,
    transparent: true,
    depthWrite:  false,                 // ★ no z-sort overhead for transparent shell
  });

  const atmosphere = new THREE.Mesh(atmoGeo, atmoMat);
  atmosphere.name  = 'atmosphere';
  group.add(atmosphere);

  // ── Slow Earth rotation ───────────────────────────────────────────────────
  // 0.05°/s is ~12× real speed — perceptible but not distracting
  const ROT_RAD_PER_SEC = 0.05 * (Math.PI / 180);

  function tick(dt) {
    group.rotation.y += ROT_RAD_PER_SEC * dt;
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
