// Space-Track CDM Fetch Module — NovaSentinel
//
// Authentication Flow:
//   1. Call loginSpaceTrack(identity, password) to POST credentials to
//      https://www.space-track.org/ajaxauth/login and obtain a session cookie.
//   2. All subsequent fetch calls include credentials:'include' so the
//      browser (or server-side cookie jar) sends the session cookie automatically.
//
// Polling Modes:
//   NORMAL  — Constellation-wide sweep every 8 hours (Space-Track allows 3/day).
//             Uses CREATED/>now-1 to retrieve only CDMs generated in the last 24 h.
//   ALERT   — Specific conjunction watch every 1 hour (Space-Track allows 1/hour).
//             Queries by CDM_ID to track a single high-probability event.
//
// Rate Limits (Space-Track):
//   < 30 queries / minute
//   < 300 queries / hour
//
// Batching:
//   Pass an array of NORAD catalogue IDs to watchSatellites() — they are
//   joined into a single comma-delimited request to minimise server load.
//
// References:
//   https://www.space-track.org/basicspacedata/query/class/cdm_public
//   https://www.space-track.org/documentation#/api

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// When served by Django, window.NOVA_CONFIG.cdmEndpoint points to the Django
// proxy view (/api/cdm/) which authenticates server-side.  Under Vite dev
// we keep the old /spacetrack/* paths (handled by vite.config.js proxy).
const _cfg              = (typeof window !== 'undefined' && window.NOVA_CONFIG) || {};
const SPACETRACK_BASE  = '/spacetrack/basicspacedata/query';  // Vite dev fallback
const SPACETRACK_LOGIN = _cfg.spacetrackLogin || '/spacetrack/ajaxauth/login';
const CDM_CLASS        = 'cdm_public';

// Django API endpoints (used when NOVA_CONFIG is injected by the template)
const DJANGO_CDM_URL            = _cfg.cdmEndpoint      || null;
const DJANGO_LOG_REJECTED_URL   = _cfg.logRejectedTle   || null;
const DJANGO_LOG_CONJUNCTION_URL = _cfg.logConjunction  || null;

/** Default minimum PoC — filters negligible conjunctions client-side */
const DEFAULT_MIN_POC = 1e-6;

/** Maximum records Space-Track will return in one request */
const MAX_LIMIT = 1000;

// Polling cadences aligned to Space-Track's documented quotas
const NORMAL_INTERVAL_MS = 8 * 60 * 60 * 1000;  // 8 h  — constellation sweep (3/day)
const ALERT_INTERVAL_MS  = 1 * 60 * 60 * 1000;  // 1 h  — specific CDM watch
const MIN_INTERVAL_MS    = 5 * 60 * 1000;        // 5 min hard floor (safety guard)

/** localStorage key for CDM cache persistence */
const STORAGE_KEY = 'novasentinel:cdm-cache';

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const _cache = {
  records:   [],   // Array of raw CDM JSON objects
  fetchedAt: null, // Date of last successful fetch
};

// ---------------------------------------------------------------------------
// Cache persistence (localStorage)
// ---------------------------------------------------------------------------

function saveCDMCache(records) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      records,
      fetchedAt: new Date().toISOString(),
    }));
  } catch { /* quota exceeded or storage unavailable */ }
}

function loadCDMCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    return {
      records:   stored.records   ?? [],
      fetchedAt: stored.fetchedAt ? new Date(stored.fetchedAt) : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

/**
 * Builds the constellation-wide CDM URL.
 * Retrieves all CDMs created in the last 24 hours (CREATED/>now-1).
 * This is the correct incremental pattern — do not re-fetch full history.
 *
 * @param {{ maxRecords?: number }} [opts]
 * @returns {string}
 */
function buildConstellationUrl({ maxRecords = MAX_LIMIT } = {}) {
  // CREATED/%3Enow-1  →  CREATED > now-1 day
  return [
    SPACETRACK_BASE,
    'class', CDM_CLASS,
    'CREATED', '%3Enow-1',
    'orderby', 'TCA%20asc',
    'limit',   String(maxRecords),
    'format',  'json',
  ].join('/');
}

/**
 * Builds a URL to watch a specific conjunction event by CDM_ID.
 * Used in ALERT mode (once per hour).
 *
 * @param {string|number} cdmId  — The CDM_ID of the event to track.
 * @returns {string}
 */
function buildCdmIdUrl(cdmId) {
  return [
    SPACETRACK_BASE,
    'class', CDM_CLASS,
    'CDM_ID', String(cdmId),
    'format', 'json',
  ].join('/');
}

/**
 * Builds a CDM URL filtered by one or more NORAD catalogue IDs.
 * IDs are comma-delimited in a single request to minimise server load.
 *
 * @param {(string|number)[]} noradIds  — Array of NORAD cat IDs.
 * @param {{ maxRecords?: number }}    [opts]
 * @returns {string}
 */
function buildNoradBatchUrl(noradIds, { maxRecords = MAX_LIMIT } = {}) {
  const idList = noradIds.map(String).join(',');
  return [
    SPACETRACK_BASE,
    'class', CDM_CLASS,
    'NORAD_CAT_ID', idList,
    'CREATED', '%3Enow-1',
    'orderby', 'TCA%20asc',
    'limit',   String(maxRecords),
    'format',  'json',
  ].join('/');
}

// ---------------------------------------------------------------------------
// Core fetch helper
// ---------------------------------------------------------------------------

/**
 * Performs an authenticated GET request to Space-Track and returns JSON.
 * Falls back to cache on network errors or auth failures.
 *
 * @param {string} url
 * @returns {Promise<Object[]>}
 */
async function _doFetch(url) {
  let records;
  try {
    const res = await fetch(url, {
      credentials: 'include',                            // send session cookie
      headers:     { 'Accept': 'application/json' },
      signal:      AbortSignal.timeout?.(30_000) ?? undefined,
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'Space-Track authentication required — call loginSpaceTrack() first'
      );
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    records = await res.json();

    if (!Array.isArray(records)) {
      throw new Error('Unexpected CDM response format (expected JSON array)');
    }
  } catch (err) {
    console.error('[cdmFetch] Fetch failed:', err.message);
    return _useCDMFallback(err.message);
  }

  // Persist to caches
  _cache.records   = records;
  _cache.fetchedAt = new Date();
  saveCDMCache(records);

  console.info(
    `[cdmFetch] ✓ ${records.length} CDM records loaded at ${_cache.fetchedAt.toISOString()}`
  );
  return records;
}

// ---------------------------------------------------------------------------
// Public fetch API
// ---------------------------------------------------------------------------

/**
 * Fetches all CDMs created in the last 24 hours (constellation-wide sweep).
 * Intended to run every 8 hours — 3 times per day per Space-Track quota.
 *
 * @param {{ maxRecords?: number }} [opts]
 * @returns {Promise<Object[]>}
 */
export async function fetchConstellationCDMs(opts = {}) {
  // If we're running under Django, use the server-side proxy endpoint directly
  if (DJANGO_CDM_URL) {
    return _doFetch(DJANGO_CDM_URL);
  }
  const url = buildConstellationUrl(opts);
  return _doFetch(url);
}

/**
 * Fetches the latest data for a single conjunction event by its CDM_ID.
 * Intended to run once per hour when tracking a high-risk event (ALERT mode).
 *
 * @param {string|number} cdmId  — CDM_ID of the event to watch.
 * @returns {Promise<Object[]>}
 */
export async function fetchCDMById(cdmId) {
  if (!cdmId) throw new Error('[cdmFetch] fetchCDMById requires a cdmId');
  const url = buildCdmIdUrl(cdmId);
  return _doFetch(url);
}

/**
 * Fetches CDMs for a batch of NORAD catalogue IDs in a single request.
 * Use this instead of sending one query per satellite.
 *
 * @param {(string|number)[]} noradIds  — Array of NORAD cat IDs to batch.
 * @param {{ maxRecords?: number }}     [opts]
 * @returns {Promise<Object[]>}
 */
export async function fetchCDMsByNoradBatch(noradIds, opts = {}) {
  if (!noradIds?.length) throw new Error('[cdmFetch] fetchCDMsByNoradBatch requires at least one NORAD ID');
  const url = buildNoradBatchUrl(noradIds, opts);
  return _doFetch(url);
}

// ---------------------------------------------------------------------------
// Space-Track session login
// ---------------------------------------------------------------------------

/**
 * POSTs credentials to Space-Track to establish a session cookie.
 * Must be called before any fetch function when no existing session exists.
 *
 * ⚠️  Never embed credentials in client-side code. Use environment
 *     variables or a server-side proxy for production deployments.
 *
 * @param {string} identity  — Space-Track account email.
 * @param {string} password  — Space-Track account password.
 * @returns {Promise<boolean>}  true if login succeeded.
 */
export async function loginSpaceTrack(identity, password) {
  try {
    const res = await fetch(SPACETRACK_LOGIN, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:        `identity=${encodeURIComponent(identity)}&password=${encodeURIComponent(password)}`,
    });
    if (!res.ok) throw new Error(`Login HTTP ${res.status}`);
    console.info('[cdmFetch] Space-Track login successful');
    return true;
  } catch (err) {
    console.error('[cdmFetch] Login failed:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Django audit log helpers (Module 5 — jQuery + AJAX bridge)
// ---------------------------------------------------------------------------

/**
 * Posts a TLE rejection record to the Django audit log endpoint.
 * Uses jQuery $.ajax when available (satisfies Module 5), otherwise fetch.
 *
 * @param {{ noradId: string, name?: string, reason: string, line1?: string, line2?: string }} entry
 */
export function postRejectionToDjango(entry) {
  if (!DJANGO_LOG_REJECTED_URL) return;   // no Django — silently skip
  const payload = JSON.stringify(entry);
  if (typeof jQuery !== 'undefined') {
    jQuery.ajax({
      url:         DJANGO_LOG_REJECTED_URL,
      method:      'POST',
      contentType: 'application/json',
      data:        payload,
      error(xhr)   { console.warn('[cdmFetch] Django audit log error:', xhr.status); },
    });
  } else {
    fetch(DJANGO_LOG_REJECTED_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    payload,
    }).catch(err => console.warn('[cdmFetch] Django audit log fetch error:', err.message));
  }
}

/**
 * Posts a scored conjunction event to the Django audit log endpoint.
 *
 * @param {Object} alert  — shaped like the ConjunctionAlert model fields.
 */
export function postConjunctionToDjango(alert) {
  if (!DJANGO_LOG_CONJUNCTION_URL) return;
  const payload = JSON.stringify(alert);
  if (typeof jQuery !== 'undefined') {
    jQuery.ajax({
      url:         DJANGO_LOG_CONJUNCTION_URL,
      method:      'POST',
      contentType: 'application/json',
      data:        payload,
      error(xhr)   { console.warn('[cdmFetch] Django conjunction log error:', xhr.status); },
    });
  } else {
    fetch(DJANGO_LOG_CONJUNCTION_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    payload,
    }).catch(err => console.warn('[cdmFetch] Django conjunction log fetch error:', err.message));
  }
}

function _useCDMFallback(reason) {
  if (_cache.records.length > 0) {
    console.warn(`[cdmFetch] Using in-memory CDM cache (${_cache.records.length} records) — ${reason}`);
    return _cache.records;
  }
  const stored = loadCDMCache();
  if (stored?.records?.length > 0) {
    console.warn(`[cdmFetch] Using localStorage CDM cache (fetched ${stored.fetchedAt?.toISOString()}) — ${reason}`);
    _cache.records   = stored.records;
    _cache.fetchedAt = stored.fetchedAt;
    return stored.records;
  }
  console.error('[cdmFetch] No CDM cache available — returning []');
  return [];
}

// ---------------------------------------------------------------------------
// Polling engine — two modes
// ---------------------------------------------------------------------------

let _normalTimerId = null;  // Constellation sweep timer
let _alertTimerId  = null;  // Specific CDM watch timer
let _cdmListeners  = [];

/**
 * Starts the NORMAL polling mode — constellation-wide CDM sweep every 8 hours.
 * Fires an immediate fetch on start, then repeats at the configured interval.
 *
 * @param {{ intervalMs?: number, maxRecords?: number }} [config]
 * @returns {{ stop: () => void }}
 */
export function startNormalPolling(config = {}) {
  stopNormalPolling();

  const {
    intervalMs = NORMAL_INTERVAL_MS,
    ...fetchOpts
  } = config;

  const interval = Math.max(intervalMs, MIN_INTERVAL_MS);

  async function tick() {
    const records = await fetchConstellationCDMs(fetchOpts);
    _notify(records);
  }

  tick();
  _normalTimerId = setInterval(tick, interval);
  console.info(`[cdmFetch] Normal polling started — interval: ${interval / 3_600_000} h`);

  return { stop: stopNormalPolling };
}

/** Stops the normal constellation sweep timer. */
export function stopNormalPolling() {
  if (_normalTimerId !== null) {
    clearInterval(_normalTimerId);
    _normalTimerId = null;
    console.info('[cdmFetch] Normal polling stopped');
  }
}

/**
 * Starts ALERT mode — polls a specific CDM_ID every 1 hour.
 * Automatically stops any existing alert watch before starting a new one.
 *
 * @param {string|number} cdmId            — The CDM_ID to watch.
 * @param {{ intervalMs?: number }} [config]
 * @returns {{ stop: () => void }}
 */
export function startAlertPolling(cdmId, config = {}) {
  stopAlertPolling();

  if (!cdmId) throw new Error('[cdmFetch] startAlertPolling requires a cdmId');

  const interval = Math.max(config.intervalMs ?? ALERT_INTERVAL_MS, MIN_INTERVAL_MS);

  async function tick() {
    const records = await fetchCDMById(cdmId);
    _notify(records);
  }

  tick();
  _alertTimerId = setInterval(tick, interval);
  console.info(`[cdmFetch] Alert polling started for CDM_ID ${cdmId} — interval: ${interval / 3_600_000} h`);

  return { stop: stopAlertPolling };
}

/** Stops the alert CDM watch timer. */
export function stopAlertPolling() {
  if (_alertTimerId !== null) {
    clearInterval(_alertTimerId);
    _alertTimerId = null;
    console.info('[cdmFetch] Alert polling stopped');
  }
}

/** Stops all active polling timers. */
export function stopAllPolling() {
  stopNormalPolling();
  stopAlertPolling();
}

// ---------------------------------------------------------------------------
// Listener / subscription
// ---------------------------------------------------------------------------

function _notify(records) {
  _cdmListeners.forEach(fn => {
    try { fn(records, _cache.fetchedAt); }
    catch (e) { console.error('[cdmFetch] Listener error:', e); }
  });
}

/**
 * Registers a callback invoked after every successful CDM fetch (any mode).
 *
 * @param {(records: Object[], fetchedAt: Date) => void} fn
 * @returns {() => void}  Unsubscribe function.
 */
export function onCDMUpdate(fn) {
  _cdmListeners.push(fn);
  return () => { _cdmListeners = _cdmListeners.filter(l => l !== fn); };
}

// ---------------------------------------------------------------------------
// Cache accessors
// ---------------------------------------------------------------------------

/**
 * Returns cached CDM records (filtered by minPoc) without triggering a fetch.
 *
 * @param {{ minPoc?: number }} [opts]
 * @returns {Object[]}
 */
export function getCachedCDMs({ minPoc = DEFAULT_MIN_POC } = {}) {
  const source = _cache.records.length > 0
    ? _cache.records
    : _useCDMFallback('cold-start hydration');

  return minPoc > 0
    ? source.filter(r => parseFloat(r.PC ?? 0) >= minPoc)
    : source;
}

/** Returns ISO string of the last successful CDM fetch timestamp, or null. */
export function getCDMFetchedAt() {
  return _cache.fetchedAt?.toISOString() ?? null;
}
