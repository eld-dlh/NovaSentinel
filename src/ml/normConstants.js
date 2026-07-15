// Normalisation constants — single source of truth
//
// These constants define the clipping bounds and scaling factors for every
// feature in the conjunction feature vector.  They are imported by BOTH the
// offline training script (Node.js) and the browser inference module so that
// training and inference normalisation are guaranteed identical.
//
// If you change a constant here, you MUST retrain the model — otherwise the
// saved weights will be interpreting differently-scaled inputs.

export const NORM = Object.freeze({
  // ── Continuous features (log1p scaling) ─────────────────────────────────
  MISS_DIST_MAX_KM:   50,      // ~50 km upper bound for LEO conjunctions
  REL_VEL_MAX_KMS:    15,      // ~15 km/s head-on LEO encounter ceiling
  MAHAL_SOFT_CAP:     20,      // Mahalanobis values above 20 are rare outliers

  // ── Covariance elements (log10 scaling) ─────────────────────────────────
  COV_LOG_MIN:        -4,      // log10 floor  → 1e-4 km²
  COV_LOG_RANGE:      10,      // log10 range  → [-4, 6] maps to [0, 1]

  // ── Altitude (linear, LEO-scoped) ──────────────────────────────────────
  ALT_MIN_KM:         200,     // below 200 km → rapid decay
  ALT_MAX_KM:         2000,    // LEO ceiling

  // ── B* drag term (linear, clipped) ─────────────────────────────────────
  BSTAR_CLIP:         0.1,     // ±0.1 range (negative is a known SGP4 artefact)

  // ── TLE age (linear) ──────────────────────────────────────────────────
  TLE_AGE_MAX_DAYS:   30,      // reject TLEs older than 30 days per paper

  // ── Model architecture ─────────────────────────────────────────────────
  NUM_FEATURES:       15,      // total feature vector length
});
