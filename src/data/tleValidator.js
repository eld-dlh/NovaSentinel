// Checksum, plausibility, epoch freshness
// Validates TLE/satrec records before ingestion into the NovaSentinel pipeline.
// Security note: per Shigol et al. [8] FRAME analysis, model poisoning scores
// 8.41/10 for ground-based ML space-surveillance systems — validate every field
// to neutralise fake-debris injection attacks.

import { epochFromSatrec } from './tleParser.js';

// ---------------------------------------------------------------------------
// TLE line checksum
// ---------------------------------------------------------------------------

/**
 * Computes the TLE checksum for one line.
 * Digits sum to their face value; '-' counts as 1; all others count 0.
 * The result is modulo 10.
 *
 * @param {string} line - Raw TLE line (68+ chars).
 * @returns {number} Computed checksum digit (0–9).
 */
export function computeChecksum(line) {
  let sum = 0;
  for (let i = 0; i < 68 && i < line.length; i++) {
    const ch = line[i];
    if (ch >= '0' && ch <= '9') sum += +ch;
    else if (ch === '-') sum += 1;
  }
  return sum % 10;
}

/**
 * Returns whether the embedded checksum digit (col 69, index 68) matches
 * the computed checksum for the line.
 *
 * @param {string} line - Raw TLE Line 1 or Line 2.
 * @returns {boolean}
 */
export function checksumValid(line) {
  if (!line || line.length < 69) return false;
  return computeChecksum(line) === parseInt(line[68], 10);
}

// ---------------------------------------------------------------------------
// Per-record validation (satrec-based)
// ---------------------------------------------------------------------------

/**
 * Validates a single parsed TLE record against:
 *   1. Line checksum integrity
 *   2. satrec.error flag set by satellite.js
 *   3. Physical plausibility (eccentricity, inclination, mean motion)
 *   4. Epoch freshness (configurable; default 30 days)
 *
 * @param {import('./tleParser.js').TLERecord} rec - Output of parseTLEText().
 * @param {{ maxAgeDays?: number, auditLog?: Array }} [opts]
 *   - maxAgeDays : reject TLEs older than this (default 30)
 *   - auditLog   : array to push rejection records into (optional)
 * @returns {import('./tleParser.js').TLERecord | null}
 *   The record if valid, or null if it should be rejected.
 */
export function validateTLERecord(rec, { maxAgeDays = 30, auditLog } = {}) {
  const { satrec, line1, line2, name, noradId } = rec;
  const reject = (reason) => {
    const entry = { noradId, name, reason, timestamp: new Date().toISOString() };
    console.warn(`[tleValidator] REJECTED ${name ?? noradId}: ${reason}`);
    if (Array.isArray(auditLog)) auditLog.push(entry);
    return null;
  };

  // 1. Checksum integrity
  if (!checksumValid(line1)) return reject('Line 1 checksum mismatch');
  if (!checksumValid(line2)) return reject('Line 2 checksum mismatch');

  // 2. satellite.js internal error flag
  if (satrec.error !== 0) {
    return reject(`satellite.js satrec error code ${satrec.error}`);
  }

  // 3. Physical plausibility (satrec uses radians internally)
  if (satrec.ecco < 0 || satrec.ecco >= 1) {
    return reject(`eccentricity out of range: ${satrec.ecco}`);
  }
  if (satrec.inclo < 0 || satrec.inclo > Math.PI) {
    return reject(`inclination out of range: ${satrec.inclo} rad`);
  }
  // no_kozai is mean motion in rad/min; convert to rev/day for readability
  const revPerDay = (satrec.no_kozai * 1440) / (2 * Math.PI);
  if (satrec.no_kozai <= 0 || revPerDay > 20) {
    return reject(`mean motion implausible: ${revPerDay.toFixed(4)} rev/day`);
  }

  // 4. Epoch freshness
  let epoch;
  try {
    epoch = epochFromSatrec(satrec);
  } catch {
    return reject('epoch could not be parsed from satrec');
  }

  const ageDays = (Date.now() - epoch.getTime()) / 86_400_000;
  if (ageDays > maxAgeDays) {
    return reject(`TLE epoch is ${ageDays.toFixed(1)} days old (max ${maxAgeDays})`);
  }
  if (ageDays < 0) {
    // Don't hard-reject — clock skew is possible — but warn
    console.warn(`[tleValidator] ${name ?? noradId}: epoch is ${Math.abs(ageDays).toFixed(2)} days in the future`);
  }

  return rec; // passes all checks
}

// ---------------------------------------------------------------------------
// Batch filter
// ---------------------------------------------------------------------------

/**
 * Filters an array of parsed TLE records, returning only valid ones.
 * Logs a summary and optionally collects rejection records for audit.
 *
 * @param {Array<import('./tleParser.js').TLERecord>} records
 * @param {{ maxAgeDays?: number, auditLog?: Array }} [opts]
 * @returns {Array<import('./tleParser.js').TLERecord>}
 */
export function filterValidTLEs(records, opts = {}) {
  const valid = records
    .map(rec => validateTLERecord(rec, opts))
    .filter(Boolean);

  const rejected = records.length - valid.length;
  console.info(
    `[tleValidator] ${valid.length} valid | ${rejected} rejected | ${records.length} total`
  );
  return valid;
}
