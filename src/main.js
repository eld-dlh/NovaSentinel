// App entry — wires all modules together
//
// Pipeline: TLE/OMM Fetch → Parse/Validate → SGP4 Propagation → Three.js Globe
//
// Data flow:
//   1. CelesTrak TLE poll (6-hour interval) → tleParser → tleValidator
//   2. Space-Track CDM poll (8-hour interval) → cdmFetch → risk engine
//   3. Batch propagator (30-second SGP4 cycle) → lat/lon/alt → point cloud
//
// The propagation runs in a Web Worker to keep the Three.js render loop at 60 fps.

import { loginSpaceTrack, startNormalPolling, onCDMUpdate } from './data/cdmFetch.js';
import { startTLEPolling, onTLEUpdate }                     from './data/tleFetch.js';
import { createPropagator }                                  from './propagation/index.js';

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
    // Register a global CDM update listener (wire to your UI/risk engine here)
    onCDMUpdate((records, fetchedAt) => {
      console.info(`[main] CDM update — ${records.length} records as of ${fetchedAt?.toISOString()}`);
      // TODO: pass records to your risk predictor / visualisation layer
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
});
