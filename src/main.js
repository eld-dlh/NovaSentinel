// App entry — wires all modules together
//
// Pipeline: TLE/OMM Fetch → Parse/Validate → SGP4 Propagation → Three.js Globe
//           CDM Fetch → ML Feature Extraction → PoC Inference (TensorFlow.js)
//
// Data flow:
//   1. CelesTrak TLE poll (6-hour interval) → tleParser → tleValidator
//   2. Space-Track CDM poll (8-hour interval) → cdmFetch → risk engine
//   3. Batch propagator (30-second SGP4 cycle) → lat/lon/alt → point cloud
//   4. CDM update → buildFeatureVector() → batchInferPoC() → risk scores
//
// The propagation runs in a Web Worker to keep the Three.js render loop at 60 fps.
// ML inference runs on the client GPU via WebGL — no Python backend needed.

import { loginSpaceTrack, startNormalPolling, onCDMUpdate } from './data/cdmFetch.js';
import { startTLEPolling, onTLEUpdate }                     from './data/tleFetch.js';
import { createPropagator }                                  from './propagation/index.js';
import { loadModel, batchInferPoC, disposeModel }            from './ml/index.js';
import { buildFeatureVector }                                from './ml/index.js';

// ---------------------------------------------------------------------------
// ML model — loaded once at startup, reused for all CDM inference cycles
// ---------------------------------------------------------------------------

let pocModel = null;

async function initMLModel() {
  try {
    pocModel = await loadModel();
    console.info('[main] PoC ML model loaded — ready for inference');
  } catch (err) {
    console.warn('[main] ML model not available — running without risk scoring:', err.message);
  }
}

// Start loading immediately (non-blocking)
const modelReady = initMLModel();

// ---------------------------------------------------------------------------
// Propagator instance (Web Worker–backed, 30-second refresh)
// ---------------------------------------------------------------------------

const propagator = createPropagator({
  intervalMs: 30_000,
  useWorker:  typeof Worker !== 'undefined',
  onError(errors) {
    if (errors.length > 0) {
      console.warn(`[main] ${errors.length} propagation errors this cycle`);
    }
  },
});

// ---------------------------------------------------------------------------
// CDM → ML inference pipeline
// ---------------------------------------------------------------------------

/**
 * Extracts features from a raw CDM record and builds a conjunction object
 * suitable for buildFeatureVector().
 *
 * @param {Object} cdm  Raw CDM JSON record from Space-Track.
 * @returns {Object}     Conjunction data ready for feature extraction.
 */
function cdmToConjunction(cdm) {
  return {
    missDistanceKm:      parseFloat(cdm.MISS_DISTANCE ?? 0),
    relVelocityKms:      parseFloat(cdm.RELATIVE_SPEED ?? 0),
    mahalanobisDistance:  cdm.MAHALANOBIS_DISTANCE ? parseFloat(cdm.MAHALANOBIS_DISTANCE) : null,
    combinedCovBplane:   null, // Would be populated from cdmCovariance.js if available
    incPrimaryDeg:       parseFloat(cdm.SAT1_INCLINATION ?? 0),
    incSecondaryDeg:     parseFloat(cdm.SAT2_INCLINATION ?? 0),
    raanDiffDeg:         Math.abs(
      parseFloat(cdm.SAT1_RAAN ?? 0) - parseFloat(cdm.SAT2_RAAN ?? 0)
    ),
    altPrimaryKm:        parseFloat(cdm.SAT1_ALTITUDE ?? 500),
    altSecondaryKm:      parseFloat(cdm.SAT2_ALTITUDE ?? 500),
    bstarPrimary:        parseFloat(cdm.SAT1_BSTAR ?? 0),
    tleAgeDays:          cdm.TLE_AGE ? parseFloat(cdm.TLE_AGE) : 1,
    isDebris:            (cdm.SAT2_OBJECT_TYPE ?? '').toUpperCase().includes('DEBRIS'),
  };
}

/**
 * Runs batch PoC inference on an array of CDM records.
 * Requires the ML model to be loaded first.
 *
 * @param {Object[]} cdmRecords  Array of raw CDM JSON records.
 * @returns {Promise<Array<{cdm: Object, pocScore: number}>>}
 */
async function scoreCDMRecords(cdmRecords) {
  if (!pocModel || cdmRecords.length === 0) return [];

  const conjunctions = cdmRecords.map(cdmToConjunction);
  const featureVectors = conjunctions.map(buildFeatureVector);
  const scores = await batchInferPoC(pocModel, featureVectors);

  return cdmRecords.map((cdm, i) => ({
    cdm,
    pocScore: scores[i],
  }));
}

// ---------------------------------------------------------------------------
// TLE catalogue → propagation pipeline
// ---------------------------------------------------------------------------

// React to fresh TLE data — load into propagator (first fetch or refresh)
onTLEUpdate((records, fetchedAt) => {
  console.info(
    `[main] TLE update — ${records.length} satellites as of ${fetchedAt?.toISOString()}`
  );

  // Load the full catalogue into the propagator (Worker will build satrecs)
  propagator.load(records);

  // Start (or restart) the 30-second propagation loop
  propagator.start((positionMap) => {
    console.info(
      `[main] Propagation cycle complete — ${positionMap.size} active positions`
    );

    // TODO: wire to Three.js point cloud via updateCataloguePositions()
    // import { updateCataloguePositions } from './viz/catalogue.js';
    // updateCataloguePositions(cloud, positionMap);
  });
});

// Start CelesTrak TLE polling (immediate first fetch + 6-hour interval)
startTLEPolling({ group: 'active', maxAgeDays: 30 });

// ---------------------------------------------------------------------------
// Space-Track authentication + CDM polling bootstrap
// ---------------------------------------------------------------------------
// Credentials are loaded from .env (VITE_ prefix = exposed to Vite bundle).
// Never hardcode credentials here — edit .env instead.

const identity = import.meta.env.VITE_SPACETRACK_IDENTITY;
const password  = import.meta.env.VITE_SPACETRACK_PASSWORD;

if (!identity || !password) {
  console.error(
    '[main] Space-Track credentials missing. ' +
    'Add VITE_SPACETRACK_IDENTITY and VITE_SPACETRACK_PASSWORD to your .env file.'
  );
} else {
  const loggedIn = await loginSpaceTrack(identity, password);

  if (loggedIn) {
    // Register a global CDM update listener — runs ML inference on each update
    onCDMUpdate(async (records, fetchedAt) => {
      console.info(`[main] CDM update — ${records.length} records as of ${fetchedAt?.toISOString()}`);

      // Wait for model to be ready before scoring
      await modelReady;

      const scored = await scoreCDMRecords(records);
      if (scored.length > 0) {
        // Log top-5 highest risk conjunctions
        const sorted = [...scored].sort((a, b) => b.pocScore - a.pocScore);
        const top5 = sorted.slice(0, 5);
        console.info('[main] Top-5 collision risks:');
        for (const { cdm, pocScore } of top5) {
          console.info(
            `  PoC=${pocScore.toExponential(3)} ` +
            `SAT1=${cdm.SAT1_NAME ?? cdm.SAT1_NORAD_CAT_ID ?? '?'} ` +
            `SAT2=${cdm.SAT2_NAME ?? cdm.SAT2_NORAD_CAT_ID ?? '?'} ` +
            `miss=${cdm.MISS_DISTANCE ?? '?'} km`
          );
        }
      }

      // TODO: pass scored results to visualisation layer
    });

    // Start the 8-hour constellation sweep (Space-Track: 3 requests/day)
    startNormalPolling();
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

window.addEventListener('beforeunload', () => {
  propagator.stop();
  disposeModel(pocModel);
});
