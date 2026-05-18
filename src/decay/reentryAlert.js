// Reentry alert logic — flags objects predicted below 200 km
//
// Objects below 200 km experience severe aerodynamic drag and typically
// reenter within days. This module scans predicted altitudes from the
// Brain.js decay model and produces structured alert objects for the UI.
//
// Threshold: 200 km matches NORM.ALT_MIN_KM in normConstants.js — both use
// 200 km as the "rapid decay zone" boundary per standard astrodynamics
// practice (e.g. ESA Space Debris Mitigation Guidelines).

// ---------------------------------------------------------------------------
// Alert severity levels
// ---------------------------------------------------------------------------

export const REENTRY_SEVERITY = Object.freeze({
  CRITICAL: 'CRITICAL',   // predicted altitude < 150 km  — reentry within hours–days
  WARNING:  'WARNING',    // predicted altitude 150–200 km — reentry within days–weeks
  WATCH:    'WATCH',      // predicted altitude 200–250 km — elevated risk, monitor
});

/**
 * Maps a predicted altitude to a severity level.
 *
 * @param {number} alt  Altitude in km.
 * @returns {string|null}  Severity constant, or null if no alert warranted.
 */
export function altitudeToSeverity(alt) {
  if (!isFinite(alt)) return null;
  if (alt < 150)      return REENTRY_SEVERITY.CRITICAL;
  if (alt < 200)      return REENTRY_SEVERITY.WARNING;
  if (alt < 250)      return REENTRY_SEVERITY.WATCH;
  return null;
}

// ---------------------------------------------------------------------------
// Alert builder
// ---------------------------------------------------------------------------

/**
 * Scans all per-object predictions and returns an alert for every object
 * whose minimum predicted altitude is below `thresholdKm`.
 *
 * @param {import('./sequences.js').DecaySequence[]} sequences
 *   All decay sequences (for name/noradId lookup).
 *
 * @param {Map<string, import('./decayModel.js').PredictedStep[]>} predictionsMap
 *   Map of noradId → predicted steps array (from predictDecay()).
 *
 * @param {number} [thresholdKm=250]
 *   Objects whose minimum predicted altitude is below this will generate
 *   an alert.  Default 250 includes the WATCH zone for early notice.
 *
 * @returns {ReentryAlert[]}
 *
 * @typedef {Object} ReentryAlert
 * @property {string}   noradId         NORAD catalog number
 * @property {string}   name            Satellite name
 * @property {number}   currentAlt      Latest observed altitude (km)
 * @property {number}   minPredAlt      Minimum predicted altitude across all steps (km)
 * @property {number}   minPredStep     Step index at which minimum occurs (1-based)
 * @property {string}   severity        One of REENTRY_SEVERITY values
 * @property {import('./decayModel.js').PredictedStep[]} predictions  Full step array
 */
export function buildReentryAlerts(sequences, predictionsMap, thresholdKm = 250) {
  const alerts = [];

  for (const seq of sequences) {
    const preds = predictionsMap.get(seq.noradId);
    if (!preds || preds.length === 0) continue;

    // Find minimum predicted altitude
    let minAlt  = Infinity;
    let minStep = 1;
    for (const p of preds) {
      if (p.altitude < minAlt) {
        minAlt  = p.altitude;
        minStep = p.step;
      }
    }

    if (minAlt >= thresholdKm) continue;       // well above danger zone — skip

    const severity = altitudeToSeverity(minAlt);
    if (!severity) continue;

    // Current altitude from the last observed point in the sequence
    const lastPt     = seq.points[seq.points.length - 1];
    const currentAlt = lastPt?.altitude ?? NaN;

    alerts.push({
      noradId:     seq.noradId,
      name:        seq.name,
      currentAlt,
      minPredAlt:  minAlt,
      minPredStep: minStep,
      severity,
      predictions: preds,
    });
  }

  // Sort: CRITICAL first, then WARNING, then WATCH; within severity → ascending altitude
  const order = { CRITICAL: 0, WARNING: 1, WATCH: 2 };
  alerts.sort((a, b) =>
    order[a.severity] - order[b.severity] || a.minPredAlt - b.minPredAlt
  );

  return alerts;
}

// ---------------------------------------------------------------------------
// Batch convenience
// ---------------------------------------------------------------------------

/**
 * One-shot: given sequences and the trained net, predicts and builds alerts.
 *
 * @param {import('./sequences.js').DecaySequence[]} sequences
 * @param {import('brain.js').LSTMTimeStep}          net
 * @param {Function}                                 predictDecayFn
 * @param {object} [opts]
 * @param {number} [opts.steps=3]
 * @param {number} [opts.thresholdKm=250]
 * @returns {{ predictionsMap: Map<string, any[]>, alerts: ReentryAlert[] }}
 */
export function detectReentryThreats(sequences, net, predictDecayFn, {
  steps       = 3,
  thresholdKm = 250,
} = {}) {
  const predictionsMap = new Map();

  for (const seq of sequences) {
    try {
      const preds = predictDecayFn(net, seq.points, steps);
      predictionsMap.set(seq.noradId, preds);
    } catch (err) {
      console.warn(`[reentryAlert] Prediction failed for NORAD ${seq.noradId}:`, err.message);
    }
  }

  const alerts = buildReentryAlerts(sequences, predictionsMap, thresholdKm);
  return { predictionsMap, alerts };
}
