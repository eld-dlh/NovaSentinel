// App entry — wires all modules together

import { loginSpaceTrack, startNormalPolling, onCDMUpdate } from './data/cdmFetch.js';

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
