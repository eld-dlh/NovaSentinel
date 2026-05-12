// satellite.js wrapper, ECI -> geodetic
//
// Core propagation utility for NovaSentinel.
// Wraps satellite.js SGP4 propagation and ECI → geodetic coordinate conversion
// to produce lat/lon/alt positions consumable by the Three.js globe renderer.
//
// Coordinate pipeline:
//   satrec + Date  →  SGP4  →  ECI {x,y,z} km  →  GMST rotation  →  geodetic {lat,lon,alt}
//
// GMST (Greenwich Mean Sidereal Time) rotates the ECI frame into the
// Earth-fixed (ECEF) frame.  geo.height is altitude above the WGS-84
// ellipsoid in kilometres.

import * as satellite from 'satellite.js';

// ---------------------------------------------------------------------------
// Single-object propagation
// ---------------------------------------------------------------------------

/**
 * Propagates a satellite to the current epoch and returns geodetic coordinates.
 *
 * @param {object} satrec - satellite.js satrec object (from twoline2satrec).
 * @returns {PropagationResult | null}  null if propagation failed (decayed, bad TLE, etc.)
 *
 * @typedef {Object} PropagationResult
 * @property {number}  lat       - Geodetic latitude  (degrees, −90 … +90)
 * @property {number}  lon       - Geodetic longitude  (degrees, −180 … +180)
 * @property {number}  altKm     - Altitude above WGS-84 ellipsoid (km)
 * @property {number}  speed     - Velocity magnitude  (km/s)
 * @property {{x:number, y:number, z:number}} velKmS - Velocity vector (km/s)
 * @property {{x:number, y:number, z:number}} eciPos - ECI position vector (km)
 * @property {number}  timestamp - Propagation epoch (ms since Unix epoch)
 */
export function propagateNow(satrec) {
  return propagateAt(satrec, new Date());
}

/**
 * Propagates a satellite to an arbitrary epoch.
 *
 * @param {object} satrec - satellite.js satrec object.
 * @param {Date}   date   - Target propagation epoch.
 * @returns {PropagationResult | null}
 */
export function propagateAt(satrec, date) {
  // Guard: satrec already flagged as erroneous by satellite.js
  if (satrec.error !== 0) return null;

  const pv = satellite.propagate(satrec, date);

  // propagate returns { position: false, velocity: false } on error
  if (!pv.position || pv.position === false) return null;

  const gmst = satellite.gstime(date);
  const geo  = satellite.eciToGeodetic(pv.position, gmst);

  const vx = pv.velocity.x;
  const vy = pv.velocity.y;
  const vz = pv.velocity.z;

  return {
    lat:       satellite.degreesLat(geo.latitude),
    lon:       satellite.degreesLong(geo.longitude),
    altKm:     geo.height,
    speed:     Math.sqrt(vx * vx + vy * vy + vz * vz),
    velKmS:    { x: vx, y: vy, z: vz },
    eciPos:    { x: pv.position.x, y: pv.position.y, z: pv.position.z },
    timestamp: date.getTime(),
  };
}

// ---------------------------------------------------------------------------
// Batch helper — propagate an array of satrecs at a single epoch
// ---------------------------------------------------------------------------

/**
 * Propagates multiple satrecs at a single epoch, returning only successful results.
 * Lightweight synchronous version for use inside the Web Worker.
 *
 * @param {object[]} satrecs - Array of satellite.js satrec objects.
 * @param {Date}     date    - Target epoch.
 * @returns {{ satnum: string, pos: PropagationResult }[]}
 */
export function propagateBatch(satrecs, date) {
  const results = [];
  for (const satrec of satrecs) {
    const pos = propagateAt(satrec, date);
    if (pos) {
      results.push({ satnum: String(satrec.satnum), pos });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Error-code decoder (useful for diagnostics / ML feature engineering)
// ---------------------------------------------------------------------------

/**
 * Human-readable description of a satellite.js satrec.error code.
 *
 * @param {number} code - satrec.error value.
 * @returns {string}
 */
export function sgp4ErrorMessage(code) {
  switch (code) {
    case 0:  return 'No error';
    case 1:  return 'Mean elements — eccentricity ≥ 1.0 or < −0.001';
    case 2:  return 'Mean motion < 0.0';
    case 3:  return 'Perturbed eccentricity < 0.0 or > 1.0';
    case 4:  return 'Semi-latus rectum < 0.0';
    case 5:  return 'Epoch elements are sub-orbital (decayed)';
    case 6:  return 'Satellite has decayed';
    default: return `Unknown SGP4 error (code ${code})`;
  }
}
