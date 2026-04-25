// PoC score → colour mapping
// Centralises all risk-based colour decisions so ellipsoid, catalogue dot,
// and alert panel renderers stay consistent with one source of truth.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Thresholds (18th SCS operational definitions)
// ---------------------------------------------------------------------------

/**
 * Probability-of-Collision thresholds used by 18th Space Control Squadron.
 *
 *   GREEN  : PC < 1e-4   — routine tracking
 *   AMBER  : 1e-4 ≤ PC < 1e-3  — elevated concern
 *   RED    : PC ≥ 1e-3   — high risk, manoeuvre recommended
 */
export const POC_THRESHOLDS = {
  GREEN_LIMIT: 1e-4,
  AMBER_LIMIT: 1e-3,
};

// Hex colours (also expressed as THREE.Color for GPU use)
export const RISK_COLORS_HEX = {
  GREEN:   0x00e676,   // vivid green
  AMBER:   0xffa726,   // amber / orange
  RED:     0xff1744,   // vivid red
  UNKNOWN: 0x90a4ae,   // blue-grey (no PoC available)
};

// ---------------------------------------------------------------------------
// Core mapping helpers
// ---------------------------------------------------------------------------

/**
 * Returns the risk tier string for a given probability of collision.
 *
 * @param {number|null|undefined} poc
 * @returns {'GREEN' | 'AMBER' | 'RED' | 'UNKNOWN'}
 */
export function pocToTier(poc) {
  if (poc == null || isNaN(poc)) return 'UNKNOWN';
  if (poc < POC_THRESHOLDS.GREEN_LIMIT) return 'GREEN';
  if (poc < POC_THRESHOLDS.AMBER_LIMIT) return 'AMBER';
  return 'RED';
}

/**
 * Returns a 0xRRGGBB hex integer for a given PoC value.
 * Suitable for use as `new THREE.Color(pocToHex(poc))`.
 *
 * @param {number|null} poc
 * @returns {number}
 */
export function pocToHex(poc) {
  return RISK_COLORS_HEX[pocToTier(poc)];
}

/**
 * Returns a THREE.Color instance for a given PoC value.
 *
 * @param {number|null} poc
 * @returns {THREE.Color}
 */
export function pocToColor(poc) {
  return new THREE.Color(pocToHex(poc));
}

/**
 * Returns the ellipsoid opacity for a given PoC.
 * Higher risk → slightly more opaque so serious events are more visible.
 *
 * @param {number|null} poc
 * @returns {number} Opacity in [0, 1].
 */
export function pocToOpacity(poc) {
  const tier = pocToTier(poc);
  return { GREEN: 0.18, AMBER: 0.28, RED: 0.42, UNKNOWN: 0.12 }[tier];
}

// ---------------------------------------------------------------------------
// CSS colour strings (for HTML overlays / alert panels)
// ---------------------------------------------------------------------------

const CSS_COLORS = {
  GREEN:   '#00e676',
  AMBER:   '#ffa726',
  RED:     '#ff1744',
  UNKNOWN: '#90a4ae',
};

/**
 * Returns a CSS colour string for use in HTML tooltip / alert panel.
 *
 * @param {number|null} poc
 * @returns {string}
 */
export function pocToCSS(poc) {
  return CSS_COLORS[pocToTier(poc)];
}

// ---------------------------------------------------------------------------
// Miss-distance colour (independent secondary indicator)
// ---------------------------------------------------------------------------

/**
 * Returns a risk hex colour based on miss distance in metres.
 * Used as a secondary indicator alongside PoC.
 *
 *   GREEN : dist > 5000 m
 *   AMBER : 200–5000 m
 *   RED   : < 200 m  (hard-body radius overlap territory)
 *
 * @param {number} distMetres
 * @returns {number} Hex colour integer.
 */
export function missDistanceToHex(distMetres) {
  if (distMetres > 5000) return RISK_COLORS_HEX.GREEN;
  if (distMetres > 200)  return RISK_COLORS_HEX.AMBER;
  return RISK_COLORS_HEX.RED;
}
