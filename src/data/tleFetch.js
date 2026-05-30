// CelesTrak live TLE fetch + interval timer
//
// Responsibilities:
//   • Fetch active-satellite TLEs from CelesTrak on a configurable interval
//   • Persist results + timestamp to /data/tle-cache.json (Vite dev) or
//     localStorage (browser production build) to avoid redundant requests
//   • Gracefully fall back to cached data on network / HTTP errors
//   • Emit events so the rest of NovaSentinel can react to fresh data

import { parseTLEText } from './tleParser.js';
import { filterValidTLEs } from './tleValidator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CelesTrak GP endpoint base — all group queries go through gp.php */
const CELESTRAK_BASE_URL = 'https://celestrak.org/NORAD/elements/gp.php';

/**
 * Proxy-safe base URL for CelesTrak requests that must avoid CORS.
 * In Vite dev, /celestrak/* is proxied to celestrak.org by vite.config.js.
 * In production (served by Django), use the full URL (CORS is server-side).
 */
const CELESTRAK_PROXY_BASE = (typeof window !== 'undefined' && window.location?.hostname === 'localhost')
  ? '/celestrak/NORAD/elements/gp.php'
  : CELESTRAK_BASE_URL;

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
  active: `${CELESTRAK_BASE_URL}?GROUP=active&FORMAT=tle`,
  last30Days: `${CELESTRAK_BASE_URL}?GROUP=last-30-days&FORMAT=tle`,
  stations: `${CELESTRAK_BASE_URL}?GROUP=stations&FORMAT=tle`,   // ISS + Tiangong + others
  brightest: `${CELESTRAK_BASE_URL}?GROUP=visual&FORMAT=tle`,      // ~100 brightest objects

  // Communications constellations
  starlink: `${CELESTRAK_BASE_URL}?GROUP=starlink&FORMAT=tle`,
  oneweb: `${CELESTRAK_BASE_URL}?GROUP=oneweb&FORMAT=tle`,
  iridium: `${CELESTRAK_BASE_URL}?GROUP=iridium&FORMAT=tle`,

  // ── Debris groups (OMM JSON format) ─────────────────────────────────────
  // Each group corresponds to a major historic fragmentation event.
  // These use CELESTRAK_PROXY_BASE so requests go through the Vite /celestrak proxy,
  // avoiding CORS errors in the browser dev environment.
  debris_fengyun:   `${CELESTRAK_PROXY_BASE}?GROUP=1999-025&FORMAT=json`,         // Fengyun-1C ASAT (2007)
  debris_iridium33: `${CELESTRAK_PROXY_BASE}?GROUP=iridium-33-debris&FORMAT=json`,  // Iridium-33 collision (2009)
  debris_cosmos2251:`${CELESTRAK_PROXY_BASE}?GROUP=cosmos-2251-debris&FORMAT=json`, // Cosmos-2251 collision (2009)
  debris_cosmos1408:`${CELESTRAK_PROXY_BASE}?GROUP=cosmos-1408-debris&FORMAT=json`, // Cosmos-1408 ASAT (2021)
};

/**
 * Keys inside GROUP_URLS that represent debris fragmentation event groups.
 * Used by fetchAllDebris() to fan-out requests in parallel.
 */
export const DEBRIS_GROUPS = [
  'debris_fengyun',
  'debris_iridium33',
  'debris_cosmos2251',
  'debris_cosmos1408',
];

/**
 * CelesTrak SPECIAL=DECAYING endpoint — objects actively re-entering.
 * Returns a mix of rocket bodies, dead payloads, and fragments.
 * Filter by name suffix ('DEB', 'R/B') or OBJECT_TYPE for pure debris.
 * Routes through /celestrak proxy to avoid CORS in the browser.
 */
export const CELESTRAK_DECAYING_URL = `${CELESTRAK_PROXY_BASE}?SPECIAL=DECAYING&FORMAT=json`;

/** Default fetch interval: 6 hours (CelesTrak refresh cadence) */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Minimum allowed interval to prevent hammering the endpoint */
const MIN_INTERVAL_MS = 60 * 1000; // 1 minute

/** In-memory cache shared across the module */
const _cache = {
  records: [],    // Array of validated TLERecord objects
  fetchedAt: null,  // Date | null — when data was last successfully fetched
  group: null,  // last fetched group name
  raw: '',    // raw TLE text, kept for re-parse / debugging
};

// ---------------------------------------------------------------------------
// Cache persistence (localStorage for browser; in-memory fallback)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'novasentinel:tle-cache';

/** localStorage key for persisting the merged debris catalogue between sessions */
const DEBRIS_STORAGE_KEY = 'novasentinel:debris-cache';

/** Max age (hours) before a debris cache entry is considered stale and re-fetched */
const DEBRIS_CACHE_MAX_AGE_H = 24;

/**
 * Persists debris records to localStorage so they are available instantly
 * on the next app load (avoiding 4 parallel CelesTrak requests on every visit).
 *
 * Only the fields needed by the propagator + renderer are stored (no satrec —
 * that is rebuilt from line1/line2 by parseTLEText on restore).
 *
 * @param {import('./tleParser.js').TLERecord[]} records
 */
function saveDebrisCache(records) {
  try {
    // Rebuild a compact TLE text block from stored line1/line2 pairs
    const text = records
      .filter(r => r.line1 && r.line2)
      .map(r => `${r.name}\n${r.line1}\n${r.line2}`)
      .join('\n');
    localStorage.setItem(DEBRIS_STORAGE_KEY, JSON.stringify({
      text,
      fetchedAt: new Date().toISOString(),
    }));
  } catch { /* quota exceeded — silently skip */ }
}

/**
 * Loads the debris cache from localStorage.
 * Returns null if the cache is missing, empty, or older than DEBRIS_CACHE_MAX_AGE_H.
 *
 * @returns {{ records: import('./tleParser.js').TLERecord[], fetchedAt: Date } | null}
 */
function loadDebrisCache() {
  try {
    const raw = localStorage.getItem(DEBRIS_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    if (!stored.text || !stored.fetchedAt) return null;

    const fetchedAt = new Date(stored.fetchedAt);
    const ageH = (Date.now() - fetchedAt.getTime()) / 3_600_000;
    if (ageH > DEBRIS_CACHE_MAX_AGE_H) return null;   // stale — trigger background refresh

    const records = parseTLEText(stored.text);
    // Re-tag every record as DEBRIS (tag is not stored in TLE text)
    records.forEach(r => { r.objectType = 'DEBRIS'; r.debrisSource = 'cache'; });
    return { records, fetchedAt };
  } catch {
    return null;
  }
}

/**
 * Returns debris records from localStorage cache synchronously (no network).
 * Use this for instant cold-start — kick off fetchAllDebris() in the background
 * to refresh the cache for next time.
 *
 * @returns {import('./tleParser.js').TLERecord[]}
 */
export function getCachedDebris() {
  return loadDebrisCache()?.records ?? [];
}

function saveToStorage(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      raw: data.raw,
      fetchedAt: data.fetchedAt?.toISOString() ?? null,
      group: data.group,
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
      raw: stored.raw ?? '',
      fetchedAt: stored.fetchedAt ? new Date(stored.fetchedAt) : null,
      group: stored.group ?? null,
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
  const _cfg = (typeof window !== 'undefined' && window.NOVA_CONFIG) || {};
  let url = GROUP_URLS[group] ?? group; // allow raw URL override

  if (_cfg.tleEndpoint) {
    // Route through Django proxy
    url = `${_cfg.tleEndpoint}?group=${encodeURIComponent(group)}&format=tle`;
  }

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
  const parsed = parseTLEText(text);
  const validated = filterValidTLEs(parsed, opts);

  // Update in-memory + persistent cache
  _cache.records = validated;
  _cache.fetchedAt = new Date();
  _cache.group = group;
  _cache.raw = text;
  saveToStorage(_cache);

  console.info(
    `[tleFetch] ✓ ${validated.length} satellites loaded (group: "${group}")`,
    `at ${_cache.fetchedAt.toISOString()}`
  );

  return validated;
}

// ---------------------------------------------------------------------------
// OMM JSON parser
// ---------------------------------------------------------------------------

/**
 * Parses a CelesTrak OMM JSON response (FORMAT=json) into the same
 * TLERecord shape produced by parseTLEText(), so the rest of the pipeline
 * (filterValidTLEs, propagation, etc.) works without modification.
 *
 * OMM JSON records expose TLE_LINE1 / TLE_LINE2 alongside structured
 * orbital elements, so we delegate to parseTLEText() on the reconstructed
 * 3-line block for checksum / satrec consistency.
 *
 * @param {Object[]} ommArray  — Parsed JSON array from CelesTrak.
 * @param {string}   source    — Human-readable group label for tagging.
 * @returns {import('./tleParser.js').TLERecord[]}
 */
function parseOMMJson(ommArray, source) {
  if (!Array.isArray(ommArray) || ommArray.length === 0) return [];

  // Rebuild the classic 3-line TLE text block from the OMM fields so that
  // parseTLEText (+ satellite.js) can validate checksums and build satrecs.
  const tleText = ommArray
    .filter(o => o.TLE_LINE1 && o.TLE_LINE2)
    .map(o => `${o.OBJECT_NAME ?? o.SATNAME ?? 'UNKNOWN'}\n${o.TLE_LINE1}\n${o.TLE_LINE2}`)
    .join('\n');

  const records = parseTLEText(tleText);

  // Stamp every record with its debris source group so callers can tell
  // which fragmentation event it came from (useful for colouring the 3D scene).
  records.forEach(r => { r.debrisSource = source; r.objectType = 'DEBRIS'; });

  return records;
}

// ---------------------------------------------------------------------------
// Debris-specific fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetches a single CelesTrak debris group by its GROUP_URLS key.
 * Returns validated TLERecords tagged with `debrisSource` and `objectType`.
 *
 * @param {string} groupKey  — Key from GROUP_URLS (e.g. 'debris_fengyun').
 * @param {{ maxAgeDays?: number, auditLog?: Array }} [opts]
 * @returns {Promise<import('./tleParser.js').TLERecord[]>}
 */
export async function fetchDebrisGroup(groupKey, opts = {}) {
  const url = GROUP_URLS[groupKey];
  if (!url) throw new Error(`[tleFetch] Unknown debris group key: "${groupKey}"`);

  let json;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout?.(30_000) ?? undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    json = await res.json();
  } catch (err) {
    console.error(`[tleFetch] fetchDebrisGroup("${groupKey}") failed:`, err.message);
    return [];
  }

  const records = parseOMMJson(json, groupKey);
  // Debris TLEs from historic fragmentation events are often months or years old.
  // Pass maxAgeDays: Infinity so the epoch-freshness check does not reject them.
  // Checksum and physical-plausibility checks still apply.
  const validated = filterValidTLEs(records, { ...opts, maxAgeDays: Infinity });
  console.info(`[tleFetch] ✓ ${validated.length} debris records loaded (group: "${groupKey}")`);
  return validated;
}

/**
 * Fetches actively-decaying objects (debris, rocket bodies, dead payloads)
 * from CelesTrak's SPECIAL=DECAYING endpoint.
 * Name-based filtering is applied to return only objects whose name ends
 * in ' DEB' or ' R/B', or whose OBJECT_TYPE field is 'DEBRIS'.
 *
 * @returns {Promise<import('./tleParser.js').TLERecord[]>}
 */
export async function fetchDecayingDebris() {
  let json;
  try {
    const res = await fetch(CELESTRAK_DECAYING_URL, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout?.(30_000) ?? undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    json = await res.json();
  } catch (err) {
    console.error('[tleFetch] fetchDecayingDebris() failed:', err.message);
    return [];
  }

  // Filter to debris & rocket bodies by OBJECT_TYPE or name suffix
  const debrisOnly = json.filter(o => {
    const type = (o.OBJECT_TYPE ?? '').toUpperCase();
    const name = (o.OBJECT_NAME ?? o.SATNAME ?? '').toUpperCase();
    return type === 'DEBRIS' || type === 'ROCKET BODY' ||
           name.endsWith(' DEB') || name.endsWith(' R/B');
  });

  const records   = parseOMMJson(debrisOnly, 'decaying');
  const validated = filterValidTLEs(records);
  console.info(`[tleFetch] ✓ ${validated.length} decaying-debris records loaded`);
  return validated;
}

/**
 * Aggregates all major debris groups into a single deduplicated array.
 *
 * Strategy:
 *   1. Fan-out requests for all DEBRIS_GROUPS in parallel (Promise.allSettled
 *      so one failing group doesn't block the rest).
 *   2. Optionally include the DECAYING endpoint (disabled by default to keep
 *      request count low — enable with { includeDecaying: true }).
 *   3. Deduplicate by NORAD_CAT_ID (last-write wins, preserving debrisSource).
 *
 * @param {{
 *   groups?:          string[],   — subset of DEBRIS_GROUPS to fetch (default: all)
 *   includeDecaying?: boolean,    — also fetch SPECIAL=DECAYING (default: false)
 *   maxAgeDays?:      number,
 *   auditLog?:        Array,
 * }} [opts]
 * @returns {Promise<import('./tleParser.js').TLERecord[]>}
 */
export async function fetchAllDebris({
  groups          = DEBRIS_GROUPS,
  includeDecaying = false,
  maxAgeDays      = 30,
  auditLog,
} = {}) {
  // Fan-out: fetch all requested debris groups concurrently
  const groupPromises = groups.map(key =>
    fetchDebrisGroup(key, { maxAgeDays, auditLog })
  );

  const decayingPromise = includeDecaying
    ? fetchDecayingDebris()
    : Promise.resolve([]);

  const settled = await Promise.allSettled([...groupPromises, decayingPromise]);

  // Flatten fulfilled results; log any rejections
  const allRecords = settled.flatMap(result => {
    if (result.status === 'fulfilled') return result.value;
    console.error('[tleFetch] fetchAllDebris: a group fetch rejected —', result.reason);
    return [];
  });

  // Deduplicate by NORAD ID (Map preserves insertion order; later entries win
  // so debrisSource from the last-fetched group survives)
  const uniqueMap   = new Map(allRecords.map(r => [r.noradId, r]));
  const unique      = Array.from(uniqueMap.values());

  if (unique.length > 0) {
    saveDebrisCache(unique);   // persist for instant next-load hydration
  }

  console.info(
    `[tleFetch] fetchAllDebris complete — ${unique.length} unique debris objects` +
    ` (${allRecords.length - unique.length} duplicates removed)`
  );

  return unique;
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
    const parsed = parseTLEText(stored.raw);
    const validated = filterValidTLEs(parsed);
    _cache.records = validated;
    _cache.fetchedAt = stored.fetchedAt;
    _cache.group = stored.group;
    _cache.raw = stored.raw;
    return validated;
  }

  // 3. Nothing available
  console.error('[tleFetch] No cached data available — returning empty array');
  return [];
}

// ---------------------------------------------------------------------------
// Interval timer
// ---------------------------------------------------------------------------

let _timerId = null;
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
  group = 'active',
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
