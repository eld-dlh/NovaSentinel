// CelesTrak live TLE fetch + interval timer
//
// Responsibilities:
//   • Fetch active-satellite TLEs from CelesTrak on a configurable interval
//   • Persist results + timestamp to /data/tle-cache.json (Vite dev) or
//     localStorage (browser production build) to avoid redundant requests
//   • Gracefully fall back to cached data on network / HTTP errors
//   • Emit events so the rest of NovaSentinel can react to fresh data

import { parseTLEText }    from './tleParser.js';
import { filterValidTLEs } from './tleValidator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CelesTrak GP endpoint base — all group queries go through gp.php */
const CELESTRAK_BASE_URL = 'https://celestrak.org/NORAD/elements/gp.php';

/**
 * CelesTrak GP OMM JSON endpoint.
 * Same catalogue as the TLE groups but returns structured JSON — used by ommParser.js.
 */
export const CELESTRAK_OMM_URL =
  `${CELESTRAK_BASE_URL}?GROUP=active&FORMAT=json`;

/**
 * Named group shortcuts mapped to their CelesTrak GROUP query-parameter URLs.
 *
 * Using GROUP= queries (rather than legacy path-style URLs) is preferred:
 *   • More reliable on CelesTrak's servers
 *   • Automatically includes new objects as they are catalogued
 *   • Directly mirrors the groups shown in the CelesTrak web UI
 */
const GROUP_URLS = {
  // Special-interest satellites
  active:          `${CELESTRAK_BASE_URL}?GROUP=active&FORMAT=tle`,
  last30Days:      `${CELESTRAK_BASE_URL}?GROUP=last-30-days&FORMAT=tle`,
  stations:        `${CELESTRAK_BASE_URL}?GROUP=stations&FORMAT=tle`,   // ISS + Tiangong + others
  brightest:       `${CELESTRAK_BASE_URL}?GROUP=visual&FORMAT=tle`,      // ~100 brightest objects

  // Communications constellations
  starlink:        `${CELESTRAK_BASE_URL}?GROUP=starlink&FORMAT=tle`,
  oneweb:          `${CELESTRAK_BASE_URL}?GROUP=oneweb&FORMAT=tle`,
  iridium:         `${CELESTRAK_BASE_URL}?GROUP=iridium&FORMAT=tle`,

  // Debris
  debris_fengyun:   `${CELESTRAK_BASE_URL}?GROUP=1999-025&FORMAT=tle`,    // Fengyun-1C debris field
  debris_iridium33: `${CELESTRAK_BASE_URL}?GROUP=iridium-33-debris&FORMAT=tle`,
  debris_cosmos2251:`${CELESTRAK_BASE_URL}?GROUP=cosmos-2251-debris&FORMAT=tle`,
  debris_cosmos1408:`${CELESTRAK_BASE_URL}?GROUP=cosmos-1408-debris&FORMAT=tle`,
};

/** Default fetch interval: 6 hours (CelesTrak refresh cadence) */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Minimum allowed interval to prevent hammering the endpoint */
const MIN_INTERVAL_MS = 60 * 1000; // 1 minute

/** In-memory cache shared across the module */
const _cache = {
  records:     [],    // Array of validated TLERecord objects
  fetchedAt:   null,  // Date | null — when data was last successfully fetched
  group:       null,  // last fetched group name
  raw:         '',    // raw TLE text, kept for re-parse / debugging
};

// ---------------------------------------------------------------------------
// Cache persistence (localStorage for browser; in-memory fallback)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'novasentinel:tle-cache';

function saveToStorage(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      raw:       data.raw,
      fetchedAt: data.fetchedAt?.toISOString() ?? null,
      group:     data.group,
    }));
  } catch {
    // Storage quota exceeded or unavailable — silently skip
  }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    return {
      raw:       stored.raw       ?? '',
      fetchedAt: stored.fetchedAt ? new Date(stored.fetchedAt) : null,
      group:     stored.group     ?? null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core fetch
// ---------------------------------------------------------------------------

/**
 * Fetches TLE text from CelesTrak for the requested group, validates records,
 * updates the in-memory cache, and returns the resulting satellite array.
 *
 * Falls back to the previously cached data on any network or HTTP error.
 *
 * @param {string} [group='active'] - Named group key or a full URL override.
 * @param {{ maxAgeDays?: number, auditLog?: Array }} [opts]
 * @returns {Promise<TLERecord[]>}
 */
export async function fetchTLEs(group = 'active', opts = {}) {
  const url = GROUP_URLS[group] ?? group; // allow raw URL override

  let text;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'text/plain' },
      // A short timeout prevents the app hanging indefinitely
      signal: AbortSignal.timeout?.(30_000) ?? undefined,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
    }

    text = await res.text();

    if (!text || text.trim().length === 0) {
      throw new Error('CelesTrak returned an empty response');
    }
  } catch (err) {
    console.error('[tleFetch] Fetch failed:', err.message);
    return _useFallback(err.message);
  }

  // Parse → validate
  const parsed    = parseTLEText(text);
  const validated = filterValidTLEs(parsed, opts);

  // Update in-memory + persistent cache
  _cache.records   = validated;
  _cache.fetchedAt = new Date();
  _cache.group     = group;
  _cache.raw       = text;
  saveToStorage(_cache);

  console.info(
    `[tleFetch] ✓ ${validated.length} satellites loaded (group: "${group}")`,
    `at ${_cache.fetchedAt.toISOString()}`
  );

  return validated;
}

// ---------------------------------------------------------------------------
// Fallback helper
// ---------------------------------------------------------------------------

/**
 * Returns cached records if available; re-parses from stored raw text if needed.
 * Attempts to load from localStorage before giving up with an empty array.
 *
 * @param {string} reason - Human-readable reason for using fallback.
 * @returns {TLERecord[]}
 */
function _useFallback(reason) {
  // 1. In-memory cache still warm?
  if (_cache.records.length > 0) {
    console.warn(
      `[tleFetch] Using in-memory cache (${_cache.records.length} sats) — reason: ${reason}`
    );
    return _cache.records;
  }

  // 2. localStorage cache?
  const stored = loadFromStorage();
  if (stored?.raw) {
    console.warn(
      `[tleFetch] Re-parsing from localStorage cache (fetched ${stored.fetchedAt?.toISOString() ?? 'unknown'}) — reason: ${reason}`
    );
    const parsed    = parseTLEText(stored.raw);
    const validated = filterValidTLEs(parsed);
    _cache.records   = validated;
    _cache.fetchedAt = stored.fetchedAt;
    _cache.group     = stored.group;
    _cache.raw       = stored.raw;
    return validated;
  }

  // 3. Nothing available
  console.error('[tleFetch] No cached data available — returning empty array');
  return [];
}

// ---------------------------------------------------------------------------
// Interval timer
// ---------------------------------------------------------------------------

let _timerId   = null;
let _listeners = [];

/**
 * Starts a recurring fetch on the given interval.
 * If a timer is already running it is stopped first (idempotent).
 *
 * Fires an immediate fetch, then repeats every `intervalMs`.
 * Each successful fetch calls any registered listeners with the new records.
 *
 * @param {{
 *   group?:       string,
 *   intervalMs?:  number,
 *   maxAgeDays?:  number,
 *   auditLog?:    Array,
 * }} [config]
 * @returns {{ stop: () => void, getCache: () => typeof _cache }}
 */
export function startTLEPolling({
  group      = 'active',
  intervalMs = DEFAULT_INTERVAL_MS,
  maxAgeDays = 30,
  auditLog,
} = {}) {
  stopTLEPolling(); // clear any existing timer

  const clampedInterval = Math.max(intervalMs, MIN_INTERVAL_MS);

  async function tick() {
    const records = await fetchTLEs(group, { maxAgeDays, auditLog });
    _listeners.forEach(fn => {
      try { fn(records, _cache.fetchedAt); }
      catch (e) { console.error('[tleFetch] Listener error:', e); }
    });
  }

  // Immediate first fetch
  tick();

  _timerId = setInterval(tick, clampedInterval);

  console.info(
    `[tleFetch] Polling started — group: "${group}", interval: ${clampedInterval / 60000} min`
  );

  return {
    /** Stops the polling timer and clears listeners. */
    stop: stopTLEPolling,
    /** Returns a snapshot of the current cache state. */
    getCache: () => ({ ..._cache }),
  };
}

/**
 * Stops the active polling timer. Safe to call even if no timer is running.
 */
export function stopTLEPolling() {
  if (_timerId !== null) {
    clearInterval(_timerId);
    _timerId = null;
    console.info('[tleFetch] Polling stopped');
  }
}

// ---------------------------------------------------------------------------
// Listener registration
// ---------------------------------------------------------------------------

/**
 * Registers a callback invoked after every successful fetch.
 *
 * @param {(records: TLERecord[], fetchedAt: Date) => void} fn
 * @returns {() => void} Unsubscribe function.
 */
export function onTLEUpdate(fn) {
  _listeners.push(fn);
  return () => {
    _listeners = _listeners.filter(l => l !== fn);
  };
}

// ---------------------------------------------------------------------------
// Cache accessors
// ---------------------------------------------------------------------------

/**
 * Returns the current in-memory cached satellite records without fetching.
 * Will attempt to hydrate from localStorage if the in-memory cache is empty.
 *
 * @returns {TLERecord[]}
 */
export function getCachedTLEs() {
  if (_cache.records.length > 0) return _cache.records;
  return _useFallback('cold-start — hydrating from storage');
}

/**
 * Returns the ISO timestamp of the last successful fetch, or null.
 *
 * @returns {string | null}
 */
export function getLastFetchedAt() {
  return _cache.fetchedAt?.toISOString() ?? null;
}

/**
 * Returns true if the cache is stale (older than `maxAgeDays`) or empty.
 *
 * @param {number} [maxAgeDays=1]
 * @returns {boolean}
 */
export function isCacheStale(maxAgeDays = 1) {
  if (!_cache.fetchedAt) return true;
  const ageMs = Date.now() - _cache.fetchedAt.getTime();
  return ageMs > maxAgeDays * 86_400_000;
}
