// OMM JSON → structured record
// Parses Orbit Mean-elements Message (OMM) JSON records as served by CelesTrak.
// OMM is the modern CCSDS standard replacing raw TLE text, providing named
// fields and richer metadata not available in the 2-line format.
//
// Fetch endpoint: https://celestrak.org/SOCRATES/query.php?format=json
// (or the GP endpoint: https://celestrak.org/SPACETRACK/query/class/gp/CURRENT/1/format/json/)
//
// CelesTrak OMM JSON includes TLE_LINE1 / TLE_LINE2 fields, which we feed
// to satellite.js twoline2satrec() so OMM records are SGP4-propagatable
// exactly like native TLE records.

import * as satellite from 'satellite.js';

// ---------------------------------------------------------------------------
// Single-record parser
// ---------------------------------------------------------------------------

/**
 * Parses one OMM JSON record into a structured NovaSentinel object.
 *
 * OMM-exclusive fields not derivable from raw TLE:
 *   - semiMajorAxis : derived semi-major axis in km
 *   - period        : orbital period in minutes
 *   - apogee        : apogee altitude in km (feeds Three.js orbit height scaling)
 *   - perigee       : perigee altitude in km
 *   - objectType    : 'PAYLOAD' | 'ROCKET BODY' | 'DEBRIS' | 'UNKNOWN'
 *                     → use for risk weighting in conjunction assessment
 *   - rcsSize       : 'SMALL' | 'MEDIUM' | 'LARGE' | null
 *                     → drives Three.js dot/sphere scale
 *
 * @param {Object} omm - Raw OMM JSON record from CelesTrak API.
 * @returns {OMMRecord | null} Parsed record, or null if required fields are missing.
 *
 * @typedef {Object} OMMRecord
 * @property {string}      noradId        - NORAD catalog number
 * @property {string}      name           - Object name
 * @property {Date}        epoch          - Epoch UTC
 * @property {number}      meanMotion     - Mean motion (rev/day)
 * @property {number}      eccentricity   - Eccentricity (0–1)
 * @property {number}      inclination    - Inclination (degrees)
 * @property {number}      raan           - RA of ascending node (degrees)
 * @property {number}      argPerigee     - Argument of perigee (degrees)
 * @property {number}      meanAnomaly    - Mean anomaly (degrees)
 * @property {number}      bstar          - B* drag term (1/earth-radii)
 * @property {number|null} semiMajorAxis  - Semi-major axis (km), if present
 * @property {number|null} period         - Orbital period (minutes), if present
 * @property {number|null} apogee         - Apogee altitude (km), if present
 * @property {number|null} perigee        - Perigee altitude (km), if present
 * @property {string|null} objectType     - Object classification
 * @property {string|null} rcsSize        - Radar cross-section size class
 * @property {string|null} classification - Security classification marker
 * @property {string}      source         - Always 'OMM'
 */
export function parseOMM(omm) {
  // Validate mandatory fields
  const requiredFields = ['NORAD_CAT_ID', 'OBJECT_NAME', 'EPOCH', 'MEAN_MOTION',
                          'ECCENTRICITY', 'INCLINATION'];
  for (const field of requiredFields) {
    if (omm[field] == null || omm[field] === '') {
      console.warn(`[ommParser] Skipping record — missing required field: ${field}`, omm);
      return null;
    }
  }

  const epoch = new Date(omm.EPOCH);
  if (isNaN(epoch.getTime())) {
    console.warn('[ommParser] Skipping record — unparseable EPOCH:', omm.EPOCH);
    return null;
  }

  // --- Build satrec from embedded TLE lines (present in CelesTrak GP JSON) ---
  const line1  = omm.TLE_LINE1 ?? null;
  const line2  = omm.TLE_LINE2 ?? null;
  let   satrec = null;

  if (line1 && line2) {
    try {
      satrec = satellite.twoline2satrec(line1, line2);
      if (satrec.error !== 0) {
        console.warn(
          `[ommParser] satrec init error ${satrec.error} for NORAD ${omm.NORAD_CAT_ID}`
        );
        satrec = null; // keep the record but mark as non-propagatable
      }
    } catch (e) {
      console.warn(
        `[ommParser] twoline2satrec failed for NORAD ${omm.NORAD_CAT_ID}:`, e.message
      );
    }
  }

  return {
    // Identity
    noradId:       String(omm.NORAD_CAT_ID).trim(),
    name:          String(omm.OBJECT_NAME).trim(),

    // Temporal
    epoch,

    // SGP4 propagation support (null if TLE lines were absent or invalid)
    satrec,
    line1,
    line2,

    // Keplerian elements (standard units matching TLE output)
    meanMotion:    parseFloat(omm.MEAN_MOTION),         // rev/day
    eccentricity:  parseFloat(omm.ECCENTRICITY),        // dimensionless
    inclination:   parseFloat(omm.INCLINATION),         // degrees
    raan:          parseFloat(omm.RA_OF_ASC_NODE ?? 0), // degrees
    argPerigee:    parseFloat(omm.ARG_OF_PERICENTER ?? 0), // degrees
    meanAnomaly:   parseFloat(omm.MEAN_ANOMALY ?? 0),   // degrees
    bstar:         parseFloat(omm.BSTAR ?? 0),          // 1/earth-radii

    // OMM-exclusive derived fields
    semiMajorAxis: omm.SEMIMAJOR_AXIS != null ? parseFloat(omm.SEMIMAJOR_AXIS) : null, // km
    period:        omm.PERIOD         != null ? parseFloat(omm.PERIOD)         : null, // min
    apogee:        omm.APOGEE         != null ? parseFloat(omm.APOGEE)         : null, // km
    perigee:       omm.PERIGEE        != null ? parseFloat(omm.PERIGEE)        : null, // km

    // Classification / sizing metadata
    objectType:    omm.OBJECT_TYPE     ?? null,  // PAYLOAD | ROCKET BODY | DEBRIS | UNKNOWN
    rcsSize:       omm.RCS_SIZE        ?? null,  // SMALL | MEDIUM | LARGE
    classification: omm.CLASSIFICATION ?? null,

    // Source tag so consumers can distinguish OMM vs TLE records downstream
    source: 'OMM',
  };
}

// ---------------------------------------------------------------------------
// Batch parser
// ---------------------------------------------------------------------------

/**
 * Parses an array of raw OMM JSON records, skipping any that fail validation.
 *
 * @param {Object[]} ommArray - Array of raw OMM records from the API.
 * @returns {OMMRecord[]} Array of successfully parsed records.
 */
export function parseOMMArray(ommArray) {
  if (!Array.isArray(ommArray)) {
    console.error('[ommParser] Expected an array, got:', typeof ommArray);
    return [];
  }

  const results = ommArray
    .map(parseOMM)
    .filter(Boolean);

  const skipped = ommArray.length - results.length;
  console.info(
    `[ommParser] Parsed ${results.length} OMM records` +
    (skipped > 0 ? ` (${skipped} skipped due to missing fields)` : '')
  );
  return results;
}

// ---------------------------------------------------------------------------
// RCS size → Three.js scale helper
// ---------------------------------------------------------------------------

/** Maps RCS size string to a relative sphere radius multiplier. */
const RCS_SCALE = { SMALL: 0.5, MEDIUM: 1.0, LARGE: 2.5 };

/**
 * Returns a Three.js object scale factor for a given OMM record.
 *
 * @param {OMMRecord} rec
 * @param {number} [baseRadius=1] - Base radius in scene units.
 * @returns {number}
 */
export function rcsToScale(rec, baseRadius = 1) {
  return baseRadius * (RCS_SCALE[rec.rcsSize] ?? 1.0);
}

// ---------------------------------------------------------------------------
// Object-type risk weight helper
// ---------------------------------------------------------------------------

/** Risk weight by object type for conjunction assessment. */
const RISK_WEIGHT = {
  'PAYLOAD':      1.0,
  'ROCKET BODY':  1.5,
  'DEBRIS':       2.0,
  'UNKNOWN':      1.2,
};

/**
 * Returns a risk multiplier for a given OMM record based on its object type.
 * Higher values increase conjunction probability severity scoring.
 *
 * @param {OMMRecord} rec
 * @returns {number}
 */
export function objectTypeRiskWeight(rec) {
  return RISK_WEIGHT[rec.objectType] ?? 1.0;
}
