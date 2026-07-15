// Web Worker entry — keeps UI thread free
//
// Receives TLE line pairs from the main thread, initialises satrec objects
// once, then propagates the full catalogue on demand. Results are posted
// back as transferable ArrayBuffers for zero-copy handoff.
//
// Message protocol:
//   Main → Worker:
//     { type: 'INIT',      tles: [{ noradId, line1, line2 }, ...] }
//     { type: 'PROPAGATE', time: <number ms epoch> }
//     { type: 'UPDATE',    tles: [{ noradId, line1, line2 }, ...] }  // delta update
//
//   Worker → Main:
//     { type: 'READY',     count: <number> }
//     { type: 'POSITIONS', data: Float64Array, ids: string[], errors: string[], time: <number> }
//     { type: 'ERROR',     message: <string> }
//
// Float64Array layout per satellite (stride = 7):
//   [lat, lon, altKm, speed, eciX, eciY, eciZ]

import * as satellite from 'satellite.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, { satrec: object, objectType: string }>} NORAD ID → { satrec, objectType } */
const _satrecs = new Map();

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = function (evt) {
  const { type } = evt.data;

  try {
    switch (type) {
      case 'INIT':
        handleInit(evt.data.tles);
        break;

      case 'PROPAGATE':
        handlePropagate(evt.data.time);
        break;

      case 'UPDATE':
        handleUpdate(evt.data.tles);
        break;

      default:
        self.postMessage({ type: 'ERROR', message: `Unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', message: err.message ?? String(err) });
  }
};

// ---------------------------------------------------------------------------
// INIT — build satrec objects from TLE line pairs
// ---------------------------------------------------------------------------

function handleInit(tles) {
  _satrecs.clear();

  const errors = [];

  for (const { noradId, line1, line2, objectType } of tles) {
    try {
      const satrec = satellite.twoline2satrec(line1, line2);
      if (satrec.error !== 0) {
        errors.push(`NORAD ${noradId}: SGP4 init error ${satrec.error}`);
        continue;
      }
      _satrecs.set(String(noradId), { satrec, objectType: objectType ?? '' });
    } catch (e) {
      errors.push(`NORAD ${noradId}: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    console.warn(`[worker] ${errors.length} TLE init errors:`, errors.slice(0, 10));
  }

  self.postMessage({ type: 'READY', count: _satrecs.size, errors });
}

// ---------------------------------------------------------------------------
// UPDATE — incremental satrec update (only changed TLEs)
// ---------------------------------------------------------------------------

function handleUpdate(tles) {
  let added = 0;
  let updated = 0;
  const errors = [];

  for (const { noradId, line1, line2, objectType } of tles) {
    try {
      const satrec = satellite.twoline2satrec(line1, line2);
      if (satrec.error !== 0) {
        errors.push(`NORAD ${noradId}: SGP4 init error ${satrec.error}`);
        continue;
      }
      if (_satrecs.has(String(noradId))) {
        updated++;
      } else {
        added++;
      }
      _satrecs.set(String(noradId), { satrec, objectType: objectType ?? '' });
    } catch (e) {
      errors.push(`NORAD ${noradId}: ${e.message}`);
    }
  }

  self.postMessage({
    type:  'READY',
    count: _satrecs.size,
    added,
    updated,
    errors,
  });
}

// ---------------------------------------------------------------------------
// PROPAGATE — compute positions for all tracked objects
// ---------------------------------------------------------------------------

/**
 * Stride per satellite in the output Float64Array.
 * [lat, lon, altKm, speed, eciX, eciY, eciZ]
 */
const STRIDE = 7;

function handlePropagate(timeMs) {
  const date = new Date(timeMs);
  const gmst = satellite.gstime(date);

  const ids         = [];
  const objectTypes = [];   // parallel array — carries debris/payload type per id
  const errors      = [];

  // Pre-allocate output buffer (may be slightly oversized if some fail)
  const buffer = new Float64Array(_satrecs.size * STRIDE);
  let   writeIdx = 0;

  for (const [noradId, { satrec, objectType }] of _satrecs) {
    const pv = satellite.propagate(satrec, date);

    if (!pv.position || pv.position === false) {
      errors.push(noradId);
      continue;
    }

    const geo = satellite.eciToGeodetic(pv.position, gmst);
    const lat = satellite.degreesLat(geo.latitude);
    const lon = satellite.degreesLong(geo.longitude);
    const alt = geo.height;

    const vx = pv.velocity.x;
    const vy = pv.velocity.y;
    const vz = pv.velocity.z;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);

    const base = writeIdx * STRIDE;
    buffer[base]     = lat;
    buffer[base + 1] = lon;
    buffer[base + 2] = alt;
    buffer[base + 3] = speed;
    buffer[base + 4] = pv.position.x;
    buffer[base + 5] = pv.position.y;
    buffer[base + 6] = pv.position.z;

    ids.push(noradId);
    objectTypes.push(objectType);
    writeIdx++;
  }

  // Trim buffer to actual size and transfer ownership (zero-copy)
  const trimmed = buffer.slice(0, writeIdx * STRIDE);

  self.postMessage(
    { type: 'POSITIONS', data: trimmed.buffer, ids, objectTypes, errors, time: timeMs },
    [trimmed.buffer]   // transferable — avoids structured clone overhead
  );
}
