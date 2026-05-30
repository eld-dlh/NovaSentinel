// Batched catalogue propagation + caching
//
// Orchestrates SGP4 propagation for the full ~8,000-object satellite catalogue.
// Two execution strategies are provided:
//
//   1. **Web Worker** (preferred) — spawns a dedicated Worker thread for
//      propagation so the main thread stays responsive for Three.js rendering.
//
//   2. **Main-thread fallback** — uses requestAnimationFrame-batched propagation
//      when Workers are unavailable (e.g. some test environments).
//
// The propagation loop runs on a configurable timer (default 30 s).
// Results are cached by NORAD ID so only changed TLEs trigger re-init.
//
// Usage:
//   import { createPropagator } from './batchPropagator.js';
//   const propagator = createPropagator();
//   propagator.load(tleRecords);        // from tleParser / tleFetch
//   propagator.start(positions => {     // callback with Map<noradId, position>
//     updateThreeJsScene(positions);
//   });
//   propagator.stop();

import { propagateAt } from './propagate.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to re-propagate the entire catalogue (ms) */
const DEFAULT_INTERVAL_MS = 30_000; // 30 seconds

/** Batch size for main-thread fallback (objects per animation frame) */
const MAIN_THREAD_BATCH = 200;

/** Stride per satellite in the Worker Float64Array */
const STRIDE = 7;

// ---------------------------------------------------------------------------
// Position cache
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CachedPosition
 * @property {number}  lat
 * @property {number}  lon
 * @property {number}  altKm
 * @property {number}  speed
 * @property {{x:number,y:number,z:number}} eciPos
 * @property {number}  timestamp
 */

/** @type {Map<string, CachedPosition>} NORAD ID → latest propagated position */
const _positionCache = new Map();

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Creates a propagation controller.
 *
 * @param {{
 *   intervalMs?:    number,
 *   useWorker?:     boolean,
 *   onError?:       (errors: string[]) => void,
 * }} [opts]
 * @returns {Propagator}
 *
 * @typedef {Object} Propagator
 * @property {(records: TLERecord[]) => void}                       load
 * @property {(onPositions: (map: Map<string,CachedPosition>) => void) => void} start
 * @property {() => void}                                            stop
 * @property {() => Map<string,CachedPosition>}                     getCache
 * @property {(records: TLERecord[]) => void}                       update
 * @property {() => void}                                            propagateOnce
 */
export function createPropagator(opts = {}) {
  const {
    intervalMs = DEFAULT_INTERVAL_MS,
    useWorker  = typeof Worker !== 'undefined',
    onError    = (errors) => {
      if (errors.length > 0) {
        console.warn(`[batchPropagator] ${errors.length} propagation errors`);
      }
    },
  } = opts;

  // Internal state
  let _worker          = null;
  let _timerId         = null;
  let _onPositions     = null;
  let _records         = [];    // current TLE records
  let _workerReady     = false;
  let _propagating     = false;

  // -----------------------------------------------------------------------
  // Worker strategy
  // -----------------------------------------------------------------------

  function _initWorker() {
    if (_worker) _worker.terminate();

    // Vite resolves `new Worker(new URL(...), { type: 'module' })` at build time
    _worker = new Worker(
      new URL('./worker.js', import.meta.url),
      { type: 'module' }
    );

    _worker.onmessage = (evt) => {
      const { type } = evt.data;

      switch (type) {
        case 'READY':
          _workerReady = true;
          console.info(
            `[batchPropagator] Worker ready — ${evt.data.count} satellites loaded` +
            (evt.data.errors?.length ? `, ${evt.data.errors.length} errors` : '')
          );
          if (evt.data.errors?.length) onError(evt.data.errors);
          break;

        case 'POSITIONS':
          _handleWorkerPositions(evt.data);
          break;

        case 'ERROR':
          console.error('[batchPropagator] Worker error:', evt.data.message);
          break;
      }
    };

    _worker.onerror = (err) => {
      console.error('[batchPropagator] Worker crashed:', err.message);
      _workerReady = false;
    };
  }

  function _handleWorkerPositions({ data, ids, objectTypes, errors, time }) {
    const buffer = new Float64Array(data);

    for (let i = 0; i < ids.length; i++) {
      const base = i * STRIDE;
      _positionCache.set(ids[i], {
        lat:        buffer[base],
        lon:        buffer[base + 1],
        altKm:      buffer[base + 2],
        speed:      buffer[base + 3],
        eciPos:     {
          x: buffer[base + 4],
          y: buffer[base + 5],
          z: buffer[base + 6],
        },
        objectType: objectTypes?.[i] ?? '',   // debris / payload / rocket body
        timestamp:  time,
      });
    }

    if (errors.length > 0) onError(errors);

    _propagating = false;

    if (_onPositions) _onPositions(_positionCache);
  }

  function _workerPropagate() {
    if (!_worker || !_workerReady || _propagating) return;
    _propagating = true;
    _worker.postMessage({ type: 'PROPAGATE', time: Date.now() });
  }

  // -----------------------------------------------------------------------
  // Main-thread fallback (requestAnimationFrame batching)
  // -----------------------------------------------------------------------

  async function _mainThreadPropagate() {
    if (_propagating) return;
    _propagating = true;

    const date   = new Date();
    const errors = [];

    for (let i = 0; i < _records.length; i += MAIN_THREAD_BATCH) {
      const batch = _records.slice(i, i + MAIN_THREAD_BATCH);

      for (const rec of batch) {
        try {
          const pos = propagateAt(rec.satrec, date);
          if (pos) {
            _positionCache.set(rec.noradId, {
              lat:        pos.lat,
              lon:        pos.lon,
              altKm:      pos.altKm,
              speed:      pos.speed,
              eciPos:     pos.eciPos,
              objectType: rec.objectType ?? '',   // carry debris/payload type
              timestamp:  pos.timestamp,
            });
          } else {
            errors.push(rec.noradId);
          }
        } catch {
          errors.push(rec.noradId);
        }
      }

      // Yield to the render loop between batches
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    if (errors.length > 0) onError(errors);

    _propagating = false;

    if (_onPositions) _onPositions(_positionCache);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    /**
     * Loads (or replaces) the full catalogue of TLE records.
     * Initialises the Worker if using the worker strategy.
     *
     * @param {TLERecord[]} records
     */
    load(records) {
      _records = records;

      if (useWorker) {
        _initWorker();
        _worker.postMessage({
          type: 'INIT',
          tles: records.map((r) => ({
            noradId:    r.noradId,
            line1:      r.line1,
            line2:      r.line2,
            objectType: r.objectType ?? '',   // DEBRIS / PAYLOAD / ROCKET BODY
          })),
        });
      }
    },

    /**
     * Incrementally updates the catalogue with new/changed TLEs.
     * Only sends the delta to the Worker; main-thread strategy replaces inline.
     *
     * @param {TLERecord[]} records - Changed or new TLE records.
     */
    update(records) {
      // Merge into local record list
      const idMap = new Map(_records.map((r) => [r.noradId, r]));
      for (const rec of records) {
        idMap.set(rec.noradId, rec);
      }
      _records = [...idMap.values()];

      if (useWorker && _worker) {
        _worker.postMessage({
          type: 'UPDATE',
          tles: records.map((r) => ({
            noradId:    r.noradId,
            line1:      r.line1,
            line2:      r.line2,
            objectType: r.objectType ?? '',
          })),
        });
      }
    },

    /**
     * Starts the periodic propagation loop.
     *
     * @param {(positions: Map<string,CachedPosition>) => void} onPositions
     *        — Called after each propagation cycle with the full position map.
     */
    start(onPositions) {
      this.stop(); // idempotent restart
      _onPositions = onPositions;

      const tick = useWorker ? _workerPropagate : _mainThreadPropagate;

      // Immediate first propagation
      tick();

      _timerId = setInterval(tick, intervalMs);

      console.info(
        `[batchPropagator] Started — strategy: ${useWorker ? 'Worker' : 'main-thread'}, ` +
        `interval: ${intervalMs / 1000}s, catalogue: ${_records.length} objects`
      );
    },

    /**
     * Triggers a single propagation cycle outside the interval timer.
     */
    propagateOnce() {
      const tick = useWorker ? _workerPropagate : _mainThreadPropagate;
      tick();
    },

    /**
     * Stops the propagation loop and terminates the Worker.
     */
    stop() {
      if (_timerId !== null) {
        clearInterval(_timerId);
        _timerId = null;
      }
      if (_worker) {
        _worker.terminate();
        _worker      = null;
        _workerReady = false;
      }
      _propagating = false;
      console.info('[batchPropagator] Stopped');
    },

    /**
     * Returns the current position cache (read-only snapshot).
     * @returns {Map<string, CachedPosition>}
     */
    getCache() {
      return new Map(_positionCache);
    },
  };
}

// ---------------------------------------------------------------------------
// Standalone convenience — propagate a catalogue on the main thread
// ---------------------------------------------------------------------------

/**
 * One-shot main-thread propagation of a full catalogue using
 * requestAnimationFrame batching to keep the browser interactive.
 *
 * @param {TLERecord[]} records  - Parsed TLE records (with satrec).
 * @param {(batch: {noradId:string, pos:object}[]) => void} onBatch
 *        — Called incrementally as batches complete (stream to Three.js).
 * @returns {Promise<{noradId:string, pos:object}[]>} All successful results.
 */
export async function propagateCatalogue(records, onBatch) {
  const date    = new Date();
  const results = [];

  for (let i = 0; i < records.length; i += MAIN_THREAD_BATCH) {
    const batch     = records.slice(i, i + MAIN_THREAD_BATCH);
    const positions = [];

    for (const r of batch) {
      const pos = propagateAt(r.satrec, date);
      if (pos) {
        positions.push({ noradId: r.noradId, pos });
      }
    }

    results.push(...positions);
    if (onBatch) onBatch(positions);

    // Yield to render loop between batches
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  return results;
}
