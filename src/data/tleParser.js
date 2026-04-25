// twoline2satrec wrapper, epoch extraction
// Parses raw TLE text (3-line or 2-line format) into structured satellite records
// using satellite.js for SGP4-ready satrec objects.

import * as satellite from 'satellite.js';

// ---------------------------------------------------------------------------
// Epoch helpers
// ---------------------------------------------------------------------------

/**
 * Converts a TLE epoch string (YYDDD.DDDDDDDD from Line 1 cols 19-32) to a
 * JavaScript Date in UTC.
 *
 * @param {string} epochStr
 * @returns {Date}
 */
export function parseTLEEpoch(epochStr) {
  const raw     = epochStr.trim();
  const year2   = parseInt(raw.substring(0, 2), 10);
  const dayFrac = parseFloat(raw.substring(2));

  // Two-digit year: ≥57 → 1900s, <57 → 2000s  (Celestrak convention)
  const fullYear = year2 >= 57 ? 1900 + year2 : 2000 + year2;

  const jan1    = new Date(Date.UTC(fullYear, 0, 1)); // 1 Jan 00:00:00 UTC
  const msOff   = (dayFrac - 1) * 86_400_000;         // day-of-year is 1-indexed
  return new Date(jan1.getTime() + msOff);
}

/**
 * Extracts the epoch Date from a satellite.js satrec object.
 * satrec.epochyr is 2-digit year; satrec.epochdays is day-of-year (1-based).
 *
 * @param {object} satrec - satellite.js satrec
 * @returns {Date}
 */
export function epochFromSatrec(satrec) {
  const year2   = satrec.epochyr;
  const fullYear = year2 >= 57 ? 1900 + year2 : 2000 + year2;
  const jan1    = new Date(Date.UTC(fullYear, 0, 1));
  const msOff   = (satrec.epochdays - 1) * 86_400_000;
  return new Date(jan1.getTime() + msOff);
}

// ---------------------------------------------------------------------------
// B* drag term decoder
// ---------------------------------------------------------------------------

/**
 * Decodes the B* drag term from TLE Line 1, columns 54-61 (0-indexed 53-60).
 * Format: ±NNNNN±N  →  ±0.NNNNN × 10^(±N)
 *
 * satellite.js exposes this as satrec.bstar in units of 1/earth-radii,
 * but we also decode from raw text for audit purposes.
 *
 * @param {string} line1 - Raw TLE Line 1 (≥61 chars)
 * @returns {number} B* drag coefficient
 */
export function parseBstar(line1) {
  const raw = line1.substring(53, 61).trim(); // e.g. " 00000-0" or " 12345-4"
  if (!raw || raw === '00000-0' || raw === ' 00000-0') return 0;

  // The field has the form: ±MMMMM±E  (mantissa sign + 5 digits + exp sign + 1 digit)
  const sign     = raw[0] === '-' ? -1 : 1;
  const mantissa = parseInt(raw.substring(1, 6), 10) * 1e-5;
  const expSign  = raw[6] === '-' ? -1 : 1;
  const exp      = parseInt(raw[7], 10) * expSign;

  return sign * mantissa * Math.pow(10, exp);
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parses a block of raw TLE text into an array of structured satellite records.
 *
 * Each record exposes:
 *  - Raw TLE strings (name, line1, line2)
 *  - satellite.js satrec (ready for SGP4 propagation)
 *  - Decoded orbital elements in convenient units
 *  - NORAD catalog ID, international designator, B* drag, epoch Date
 *
 * Supports both 3-line (name + L1 + L2) and 2-line (L1 + L2 only) formats.
 * Blank lines and '#'-prefixed comment lines are skipped.
 *
 * @param {string} text - Raw TLE text from CelesTrak or equivalent source.
 * @returns {Array<TLERecord>}
 *
 * @typedef {Object} TLERecord
 * @property {string}  name             - Satellite name (or "NORAD <id>")
 * @property {string}  line1            - Raw TLE Line 1
 * @property {string}  line2            - Raw TLE Line 2
 * @property {object}  satrec           - satellite.js satrec (SGP4-ready)
 * @property {string}  noradId          - NORAD catalog number (5-char string)
 * @property {string}  intlDesignator   - International designator (cols 10-17 L1)
 * @property {Date}    epoch            - Epoch as UTC Date
 * @property {number}  bstar            - B* drag term (1/earth-radii)
 * @property {number}  inclination      - Inclination (degrees)
 * @property {number}  raan             - Right Ascension of Ascending Node (deg)
 * @property {number}  eccentricity     - Eccentricity (dimensionless, 0–1)
 * @property {number}  argOfPerigee     - Argument of perigee (degrees)
 * @property {number}  meanAnomaly      - Mean anomaly (degrees)
 * @property {number}  meanMotion       - Mean motion (revolutions/day)
 * @property {number}  revAtEpoch       - Revolution number at epoch
 */
export function parseTLEText(text) {
  if (!text || typeof text !== 'string') return [];

  // Normalise: drop empty lines and comment lines
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l.length > 0 && !l.startsWith('#'));

  const records = [];
  let i = 0;

  while (i < lines.length) {
    let name, line1, line2;

    if (lines[i].startsWith('1 ') || lines[i].startsWith('2 ')) {
      // 2-line format: no name header
      line1 = lines[i];
      line2 = lines[i + 1];
      name  = null;
      i    += 2;
    } else {
      // 3-line format: name + Line 1 + Line 2
      name  = lines[i].trim();
      line1 = lines[i + 1];
      line2 = lines[i + 2];
      i    += 3;
    }

    // Guard against ragged end-of-file
    if (!line1 || !line2) continue;
    if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) continue;

    try {
      // --- satellite.js SGP4 record ---
      const satrec = satellite.twoline2satrec(line1, line2);

      // satrec.error !== 0 means satellite.js detected a bad record
      if (satrec.error !== 0) {
        console.warn(`[tleParser] twoline2satrec error ${satrec.error} — skipping`);
        continue;
      }

      // --- Extract fields from Line 1 ---
      const noradId        = line1.substring(2, 7).trim();          // cols 3-7
      const intlDesignator = line1.substring(9, 17).trim();         // cols 10-17
      const epochStr       = line1.substring(18, 32).trim();        // cols 19-32
      const bstar          = parseBstar(line1);                     // cols 54-61

      // --- Extract fields from Line 2 ---
      // All angles in degrees as printed; eccentricity has implied "0." prefix
      const inclination  = parseFloat(line2.substring(8, 16));      // cols 9-16
      const raan         = parseFloat(line2.substring(17, 25));     // cols 18-25
      const eccentricity = parseFloat('0.' + line2.substring(26, 33).trim()); // cols 27-33
      const argOfPerigee = parseFloat(line2.substring(34, 42));     // cols 35-42
      const meanAnomaly  = parseFloat(line2.substring(43, 51));     // cols 44-51
      const meanMotion   = parseFloat(line2.substring(52, 63));     // cols 53-63 (rev/day)
      const revAtEpoch   = parseInt(line2.substring(63, 68).trim(), 10); // cols 64-68

      records.push({
        name:           name ?? `NORAD ${noradId}`,
        line1,
        line2,
        satrec,
        noradId,
        intlDesignator,
        epoch:          parseTLEEpoch(epochStr),
        bstar,
        inclination,
        raan,
        eccentricity,
        argOfPerigee,
        meanAnomaly,
        meanMotion,
        revAtEpoch,
      });
    } catch (err) {
      console.warn('[tleParser] Skipping malformed block:', err.message);
    }
  }

  return records;
}
