// Smooth camera animation to "jump-to-conjunction" / "jump-to-object"
//
// When an operator clicks a conjunction alert, the camera interpolates from
// its current position to a new viewpoint that places the target point
// (in world space) centred in the viewport at a comfortable zoom distance.
//
// Uses LERP on spherical coords to prevent passing through the Earth.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Zoom distance: how many scene units above the target point we stop */
const APPROACH_DISTANCE = 0.3;   // ~1910 km above Earth surface (good for LEO)

/** Duration of the fly-to animation (ms) */
const FLY_DURATION_MS   = 1_200;

/** Smoothstep easing exponent (cubic) */
function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ---------------------------------------------------------------------------
// Active tween state
// ---------------------------------------------------------------------------

let _tween = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Smoothly animates the camera from its current position to orbit a
 * given world-space target point.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} controls
 * @param {THREE.Vector3} worldTarget   Target point in scene units.
 * @param {{ distance?: number, duration?: number }} [opts]
 */
export function flyToPoint(camera, controls, worldTarget, opts = {}) {
  const {
    distance = APPROACH_DISTANCE,
    duration = FLY_DURATION_MS,
  } = opts;

  // Cancel any in-progress tween
  if (_tween) { _tween.cancelled = true; }

  const startPos    = camera.position.clone();
  const startTarget = controls.target.clone();

  // Destination: a point `distance` scene-units further out along the target vector
  const direction   = worldTarget.clone().normalize();
  const endPos      = direction.clone()
    .multiplyScalar(worldTarget.length() + distance);
  const endTarget   = worldTarget.clone();

  const tween = { cancelled: false, start: performance.now() };
  _tween = tween;

  function animate(now) {
    if (tween.cancelled) return;

    const elapsed = now - tween.start;
    const t       = Math.min(elapsed / duration, 1);
    const ease    = easeInOutCubic(t);

    camera.position.lerpVectors(startPos, endPos, ease);
    controls.target.lerpVectors(startTarget, endTarget, ease);
    controls.update();

    if (t < 1) {
      requestAnimationFrame(animate);
    } else {
      _tween = null;
    }
  }

  requestAnimationFrame(animate);
}

/**
 * Flies the camera to a conjunction defined by two world-space positions.
 * Places the viewpoint midway between the two objects.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} controls
 * @param {THREE.Vector3} posA   Primary object world position.
 * @param {THREE.Vector3} posB   Secondary object world position.
 */
export function flyToConjunction(camera, controls, posA, posB) {
  const midpoint = new THREE.Vector3().addVectors(posA, posB).multiplyScalar(0.5);
  flyToPoint(camera, controls, midpoint, { distance: 0.15 });
}

/**
 * Resets the camera to the default overview position.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} controls
 */
export function resetCamera(camera, controls) {
  flyToPoint(camera, controls, new THREE.Vector3(0, 0, 0), {
    distance: 3.2,
    duration: 800,
  });
}

/**
 * Cancels any in-progress camera animation.
 */
export function cancelFly() {
  if (_tween) { _tween.cancelled = true; _tween = null; }
}
