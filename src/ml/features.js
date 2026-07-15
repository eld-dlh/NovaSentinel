// Build + normalise 15-feature conjunction vectors
//
// Each conjunction at closest approach is represented by 15 normalised orbital
// features derived from TLE/OMM + CDM data.  These proxy the quantities that
// appear in the B-plane PoC integral described in the NovaSentinel paper.
//
// Feature list (post-normalisation):
//   0  miss_distance_km         — log1p / log1p(50)
//   1  rel_velocity_km_s        — log1p / log1p(15)
//   2  mahalanobis_distance     — log1p / log1p(20)  (−1 sentinel if absent)
//   3–8  combined_cov_bplane[6] — signed log10 scaling
//   9  mutual_inclination       — spherical cosines / π
//  10  altitude_primary_km      — linear [200, 2000] → [0, 1]
//  11  altitude_secondary_km    — linear [200, 2000] → [0, 1]
//  12  bstar_primary            — clip ±0.1 → [0, 1]
//  13  tle_age_days             — linear / 30
//  14  object_type_debris       — binary 0 | 1

import { NORM } from './normConstants.js';

// ---------------------------------------------------------------------------
// Individual normalisation functions
// ---------------------------------------------------------------------------

/**
 * Miss distance — right-skewed, use log1p to preserve the dangerous low tail.
 * log1p handles zero safely (no −∞).
 * @param {number} km  Miss distance in kilometres.
 * @returns {number}    Normalised value, roughly [0, 1].
 */
export function normMissDistance(km) {
  return Math.log1p(Math.max(0, km)) / Math.log1p(NORM.MISS_DIST_MAX_KM);
}

/**
 * Relative velocity — LEO encounters top out ~15 km/s (head-on).
 * @param {number} kms  Relative speed in km/s.
 * @returns {number}
 */
export function normRelVelocity(kms) {
  return Math.log1p(Math.max(0, kms)) / Math.log1p(NORM.REL_VEL_MAX_KMS);
}

/**
 * Mahalanobis distance — dimensionless, heavy-tailed.
 * Returns −1 when covariance data is unavailable (sentinel value).
 * @param {number|null} d  Mahalanobis distance.
 * @returns {number}
 */
export function normMahalanobis(d) {
  if (d === null || d === undefined) return -1;
  return Math.log1p(Math.max(0, d)) / Math.log1p(NORM.MAHAL_SOFT_CAP);
}

/**
 * Single covariance element — log10 scaling with sign preservation.
 *
 * Diagonal elements (variance) are always positive → simple log10.
 * Off-diagonal elements (covariance) can be negative → signed log10.
 *
 * @param {number}  val         Covariance value in km².
 * @param {boolean} isDiagonal  True for variance elements (C_RR, C_TT, C_NN).
 * @returns {number}            Normalised value, roughly [0, 1] or [−1, 1].
 */
export function normCovElement(val, isDiagonal) {
  if (isDiagonal) {
    const logVal = Math.log10(Math.max(val, 1e-6));
    return (logVal - NORM.COV_LOG_MIN) / NORM.COV_LOG_RANGE;
  }
  // Off-diagonal: preserve sign
  const sign   = Math.sign(val) || 1;
  const logMag = Math.log10(Math.max(Math.abs(val), 1e-6));
  const normMag = (logMag - NORM.COV_LOG_MIN) / NORM.COV_LOG_RANGE;
  return sign * normMag;
}

/**
 * Normalises all 6 upper-triangle covariance elements.
 * Order: [C_RR, C_TR, C_NR, C_TT, C_NT, C_NN]
 * Diagonal indices: 0 (C_RR), 3 (C_TT), 5 (C_NN).
 *
 * @param {number[]} cov6  Six covariance elements in km².
 * @returns {number[]}     Six normalised values.
 */
export function normCovVector(cov6) {
  const diagonalIndices = new Set([0, 3, 5]);
  return cov6.map((v, i) => normCovElement(v, diagonalIndices.has(i)));
}

/**
 * Collapses two raw inclinations into a single mutual-inclination feature
 * using the spherical law of cosines.  Physically more meaningful than
 * passing raw inclinations — captures the crossing angle that drives
 * relative velocity.
 *
 * @param {number} inc1Deg      Primary inclination (degrees).
 * @param {number} inc2Deg      Secondary inclination (degrees).
 * @param {number} raanDiffDeg  Difference in RAAN (degrees). 0 if unknown.
 * @returns {number}            Normalised mutual inclination [0, 1].
 */
export function relativeInclinationFeature(inc1Deg, inc2Deg, raanDiffDeg = 0) {
  const i1    = inc1Deg    * Math.PI / 180;
  const i2    = inc2Deg    * Math.PI / 180;
  const dRaan = raanDiffDeg * Math.PI / 180;

  const cosIM = Math.cos(i1) * Math.cos(i2) +
                Math.sin(i1) * Math.sin(i2) * Math.cos(dRaan);

  // Clamp to [−1, 1] to guard against floating-point overshoot in acos
  const iMutual = Math.acos(Math.min(1, Math.max(-1, cosIM)));

  return iMutual / Math.PI;   // 0–π → 0–1
}

/**
 * Altitude — linear normalisation, clipped to LEO range.
 * GEO objects should be excluded upstream before reaching this function.
 *
 * @param {number} altKm  Altitude in kilometres.
 * @returns {number}       Normalised value [0, 1].
 */
export function normAltitude(altKm) {
  const clipped = Math.min(Math.max(altKm, NORM.ALT_MIN_KM), NORM.ALT_MAX_KM);
  return (clipped - NORM.ALT_MIN_KM) / (NORM.ALT_MAX_KM - NORM.ALT_MIN_KM);
}

/**
 * B* drag term — centred near zero, occasional large values.
 * Clip to ±0.1 then map to [0, 1].
 *
 * @param {number} bstar  SGP4 B* value.
 * @returns {number}
 */
export function normBstar(bstar) {
  const clipped = Math.min(Math.max(bstar, -NORM.BSTAR_CLIP), NORM.BSTAR_CLIP);
  return (clipped + NORM.BSTAR_CLIP) / (2 * NORM.BSTAR_CLIP);
}

/**
 * TLE age — linear, capped at 30 days.
 * @param {number} ageDays  Age of TLE in days.
 * @returns {number}
 */
export function normTLEAge(ageDays) {
  return Math.min(Math.max(ageDays, 0), NORM.TLE_AGE_MAX_DAYS) / NORM.TLE_AGE_MAX_DAYS;
}

// ---------------------------------------------------------------------------
// Complete feature vector builder
// ---------------------------------------------------------------------------

/**
 * Assembles and normalises a full 15-element feature vector from a
 * conjunction data object.
 *
 * @param {Object} conjunction  Conjunction data with the following fields:
 *   - missDistanceKm      {number}
 *   - relVelocityKms      {number}
 *   - mahalanobisDistance  {number|null}  — null when CDM covariance absent
 *   - combinedCovBplane   {number[6]|null}  — 6 upper-triangle covariance elems
 *   - incPrimaryDeg       {number}
 *   - incSecondaryDeg     {number}
 *   - raanDiffDeg         {number}        — 0 if unknown
 *   - altPrimaryKm        {number}
 *   - altSecondaryKm      {number}
 *   - bstarPrimary        {number}
 *   - tleAgeDays          {number}
 *   - isDebris            {boolean}
 *
 * @returns {number[]}  15-element normalised feature vector.
 */
export function buildFeatureVector(conjunction) {
  const {
    missDistanceKm,
    relVelocityKms,
    mahalanobisDistance = null,
    combinedCovBplane  = null,
    incPrimaryDeg,
    incSecondaryDeg,
    raanDiffDeg = 0,
    altPrimaryKm,
    altSecondaryKm,
    bstarPrimary,
    tleAgeDays,
    isDebris,
  } = conjunction;

  const hasCov = mahalanobisDistance !== null && combinedCovBplane !== null;

  const covFeatures = hasCov
    ? normCovVector(combinedCovBplane)
    : [0, 0, 0, 0, 0, 0];   // zero-fill when no CDM covariance

  return [
    normMissDistance(missDistanceKm),                               // 0
    normRelVelocity(relVelocityKms),                                // 1
    normMahalanobis(hasCov ? mahalanobisDistance : null),            // 2
    ...covFeatures,                                                  // 3–8
    relativeInclinationFeature(incPrimaryDeg, incSecondaryDeg, raanDiffDeg), // 9
    normAltitude(altPrimaryKm),                                     // 10
    normAltitude(altSecondaryKm),                                   // 11
    normBstar(bstarPrimary),                                        // 12
    normTLEAge(tleAgeDays),                                         // 13
    isDebris ? 1 : 0,                                               // 14
  ];
  // Total: 1+1+1+6+1+1+1+1+1+1 = 15 features
}
