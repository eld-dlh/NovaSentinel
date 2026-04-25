// Space-Track CDM endpoint fetch
//
// Space-Track.org requires a free account. Authentication is handled via a
// session cookie obtained after POSTing credentials to /ajaxauth/login.
// This module assumes the cookie is already set in the browser session
// (via a separate login flow or proxy server) and sends it with credentials:'include'.
//
// Endpoint reference:
//   https://www.space-track.org/basicspacedata/query/class/cdm_public
//
// CDM field reference (selected):
//   CDM_ID       — unique conjunction event identifier
//   TCA          — Time of Closest Approach (ISO 8601 UTC)
//   PC           — Probability of Collision (float, 0–1)
//   MISS_DISTANCE — metres
//   SAT1_*/SAT2_* — primary/secondary object metadata & covariance elements

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPACETRACK_BASE = 'https://www.space-track.org/basicspacedata/query';
const CDM_CLASS       = 'cdm_public';

/** Default minimum PoC — filters out negligible conjunctions */
const DEFAULT_MIN_POC = 1e-6;

/** Maximum records per request (Space-Track server limit) */
const MAX_LIMIT = 1000;

/** Fetch interval — CDMs are posted when computed, so poll every 30 min */
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const MIN_INTERVAL_MS     =  5 * 60 * 1000;

const STORAGE_KEY = 'novasentinel:cdm-cache';

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const _cache = {
  records:   [],    // Array of raw CDM JSON objects
  fetchedAt: null,  // Date
};

// ---------------------------------------------------------------------------
// Cache persistence
// ---------------------------------------------------------------------------

function saveCDMCache(records) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      records,
      fetchedAt: new Date().toISOString(),
    }));
  } catch { /* quota or unavailable */ }
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
// URL builder
// ---------------------------------------------------------------------------

/**
 * Builds a Space-Track CDM query URL.
 *
 * @param {{
 *   minPoc?:     number,   - Minimum probability of collision (default 1e-6)
 *   maxRecords?: number,   - Max records to return (default 1000)
 *   tcaFrom?:    Date,     - TCA window start (optional)
 *   tcaTo?:      Date,     - TCA window end   (optional)
 * }} opts
 * @returns {string}
 */
function buildCDMUrl({ minPoc = DEFAULT_MIN_POC, maxRecords = MAX_LIMIT, tcaFrom, tcaTo } = {}) {
  const parts = [
    SPACETRACK_BASE,
    'class', CDM_CLASS,
    'PC', `%3E${minPoc}`,          // PC > minPoc
  ];

  if (tcaFrom || tcaTo) {
    const from = tcaFrom ? tcaFrom.toISOString().replace(/\.\d+Z$/, '') : '';
    const to   = tcaTo   ? tcaTo.toISOString().replace(/\.\d+Z$/, '') : '';
    parts.push('TCA', `${from}--${to}`);
  }

  parts.push(
    'orderby', 'TCA%20asc',
    'limit',   String(maxRecords),
    'format',  'json',
  );

  return parts.join('/');
}

// ---------------------------------------------------------------------------
// Core fetch
// ---------------------------------------------------------------------------

/**
 * Fetches CDM records from Space-Track.org.
 *
 * Authentication: relies on the browser session cookie set after calling
 * the Space-Track login endpoint. The module itself does not handle login —
 * call `loginSpaceTrack()` first if needed.
 *
 * Falls back to the in-memory → localStorage cache on any error.
 *
 * @param {{
 *   minPoc?:     number,
 *   maxRecords?: number,
 *   tcaFrom?:    Date,
 *   tcaTo?:      Date,
 * }} [opts]
 * @returns {Promise<Object[]>} Array of raw CDM JSON records.
 */
export async function fetchCDMs(opts = {}) {
  const url = buildCDMUrl({ minPoc: DEFAULT_MIN_POC, ...opts });

  let records;
  try {
    const res = await fetch(url, {
      credentials: 'include',                          // send session cookie
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

  // Update caches
  _cache.records   = records;
  _cache.fetchedAt = new Date();
  saveCDMCache(records);

  console.info(
    `[cdmFetch] ✓ ${records.length} CDM records loaded at ${_cache.fetchedAt.toISOString()}`
  );
  return records;
}

// ---------------------------------------------------------------------------
// Space-Track session login helper
// ---------------------------------------------------------------------------

/**
 * POSTs credentials to Space-Track to establish a session cookie.
 * Must be called before fetchCDMs() in environments where no existing
 * session exists (e.g. a Node.js backend proxy).
 *
 * NOTE: Never embed credentials in client-side code. Use environment
 * variables or a server-side proxy for production deployments.
 *
 * @param {string} identity - Space-Track account email.
 * @param {string} password - Space-Track account password.
 * @returns {Promise<boolean>} true if login succeeded.
 */
export async function loginSpaceTrack(identity, password) {
  try {
    const res = await fetch('https://www.space-track.org/ajaxauth/login', {
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
// Fallback
// ---------------------------------------------------------------------------

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
// Interval polling
// ---------------------------------------------------------------------------

let _cdmTimerId   = null;
let _cdmListeners = [];

/**
 * Starts periodic CDM polling. Fires an immediate fetch, then repeats.
 *
 * @param {{
 *   intervalMs?: number,
 *   minPoc?:     number,
 *   maxRecords?: number,
 * }} [config]
 * @returns {{ stop: () => void }}
 */
export function startCDMPolling(config = {}) {
  stopCDMPolling();

  const {
    intervalMs = DEFAULT_INTERVAL_MS,
    ...fetchOpts
  } = config;

  const interval = Math.max(intervalMs, MIN_INTERVAL_MS);

  async function tick() {
    const records = await fetchCDMs(fetchOpts);
    _cdmListeners.forEach(fn => {
      try { fn(records, _cache.fetchedAt); }
      catch (e) { console.error('[cdmFetch] Listener error:', e); }
    });
  }

  tick();
  _cdmTimerId = setInterval(tick, interval);
  console.info(`[cdmFetch] CDM polling started — interval: ${interval / 60000} min`);

  return { stop: stopCDMPolling };
}

/** Stops the CDM polling timer. */
export function stopCDMPolling() {
  if (_cdmTimerId !== null) {
    clearInterval(_cdmTimerId);
    _cdmTimerId = null;
    console.info('[cdmFetch] CDM polling stopped');
  }
}

/**
 * Registers a callback invoked after every successful CDM fetch.
 * @param {(records: Object[], fetchedAt: Date) => void} fn
 * @returns {() => void} Unsubscribe function.
 */
export function onCDMUpdate(fn) {
  _cdmListeners.push(fn);
  return () => { _cdmListeners = _cdmListeners.filter(l => l !== fn); };
}

/** Returns cached CDM records without fetching. */
export function getCachedCDMs() {
  if (_cache.records.length > 0) return _cache.records;
  return _useCDMFallback('cold-start hydration');
}

/** Returns ISO string of last successful CDM fetch, or null. */
export function getCDMFetchedAt() {
  return _cache.fetchedAt?.toISOString() ?? null;
}
