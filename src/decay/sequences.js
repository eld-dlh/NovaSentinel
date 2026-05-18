// Per-NORAD TLE history → decay sequences
//
// Collects the last N TLE epochs per object, sorted chronologically.
// Mean motion (no_kozai, rad/min) is the primary decay proxy — it increases
// as altitude falls — and is the scalar that Brain.js LSTMTimeStep trains on.
//
// References:
//  - Liu et al. [9]: single-point B* unreliable; sequence-based approach preferred.
//  - satellite.js satrec.no_kozai is the Kozai-corrected mean motion in rad/min.

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

const GM_KM3_S2   = 398_600.4418;   // Earth's gravitational parameter  km³/s²
const EARTH_RAD   = 6_371.0;        // Mean Earth radius                km
const TWO_PI      = 2 * Math.PI;
const SECS_PER_MIN = 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts no_kozai (rad/min) to approximate circular-orbit altitude (km).
 *
 * Derivation:
 *   n  = sqrt(GM / a³)  →  a = (GM / n²)^(1/3)
 *   where n must be in rad/s.
 *
 * @param {number} noKozai  Mean motion in rad/min.
 * @returns {number}         Altitude above mean Earth radius (km).
 */
export function meanMotionToAlt(noKozai) {
  if (!noKozai || noKozai <= 0) return NaN;
  const n_rad_s = noKozai / SECS_PER_MIN;                  // rad/s
  const a       = Math.cbrt(GM_KM3_S2 / (n_rad_s * n_rad_s)); // semi-major axis (km)
  return a - EARTH_RAD;                                    // altitude (km)
}

/**
 * Extracts the epoch Date from a satellite.js satrec object.
 * Mirrors epochFromSatrec() in tleParser.js — kept local to avoid
 * a circular dependency between decay/ and data/.
 *
 * @param {object} satrec  satellite.js satrec
 * @returns {Date}
 */
export function epochToDate(satrec) {
  const year2    = satrec.epochyr;
  const fullYear = year2 >= 57 ? 1900 + year2 : 2000 + year2;
  const jan1     = new Date(Date.UTC(fullYear, 0, 1));
  const msOff    = (satrec.epochdays - 1) * 86_400_000;
  return new Date(jan1.getTime() + msOff);
}

// ---------------------------------------------------------------------------
// Sequence builder
// ---------------------------------------------------------------------------

const MS_PER_DAY        = 86_400_000;
const MAX_GAP_DAYS      = 7;           // reject sequences with gaps > 7 days
const MAX_GAP_MS        = MAX_GAP_DAYS * MS_PER_DAY;

/**
 * Groups all TLE records by NORAD ID, sorts by epoch, and slices the most
 * recent `seqLen` points into training-ready sequences.
 *
 * Each returned sequence contains:
 *  - noradId: NORAD catalog number (string)
 *  - name:    Satellite name
 *  - points:  Array of { epoch: ms, meanMotion: rad/min, altitude: km }
 *
 * Quality filters applied:
 *  1. Sequences with fewer than `seqLen` epochs are discarded.
 *  2. Sequences where any consecutive epoch gap exceeds MAX_GAP_DAYS are
 *     discarded (object was untracked — the time series has a hole).
 *
 * @param {Array<TLERecord>} allTLEs  Parsed TLE records (from tleParser.js).
 * @param {number}           seqLen   Minimum / window length (default 10).
 * @returns {Array<DecaySequence>}
 *
 * @typedef {Object} DecaySequence
 * @property {string}          noradId
 * @property {string}          name
 * @property {DecayPoint[]}    points   Length === seqLen
 *
 * @typedef {Object} DecayPoint
 * @property {number} epoch       Unix timestamp (ms)
 * @property {number} meanMotion  Kozai mean motion (rad/min)
 * @property {number} altitude    Circular-orbit altitude (km)
 */
export function buildDecaySequences(allTLEs, seqLen = 10) {
  // ── 1. Group by NORAD ID ─────────────────────────────────────────────────
  const byId = new Map();

  for (const rec of allTLEs) {
    const id = String(rec.satrec?.satnum ?? rec.noradId ?? '').trim();
    if (!id) continue;

    const no_kozai = rec.satrec?.no_kozai;
    if (!no_kozai || no_kozai <= 0) continue;   // skip records without mean motion

    const epoch = epochToDate(rec.satrec).getTime();
    if (!isFinite(epoch)) continue;

    if (!byId.has(id)) byId.set(id, { name: rec.name ?? `NORAD ${id}`, pts: [] });
    byId.get(id).pts.push({
      epoch,
      meanMotion: no_kozai,
      altitude:   meanMotionToAlt(no_kozai),
    });
  }

  // ── 2. Sort, filter, slice ────────────────────────────────────────────────
  const sequences = [];

  for (const [noradId, { name, pts }] of byId) {
    pts.sort((a, b) => a.epoch - b.epoch);

    if (pts.length < seqLen) continue;           // need at least seqLen points

    // Take the most-recent seqLen points
    const window = pts.slice(-seqLen);

    // Reject if any consecutive gap > MAX_GAP_DAYS
    let hasGap = false;
    for (let i = 1; i < window.length; i++) {
      if (window[i].epoch - window[i - 1].epoch > MAX_GAP_MS) {
        hasGap = true;
        break;
      }
    }
    if (hasGap) continue;

    sequences.push({ noradId, name, points: window });
  }

  return sequences;
}
