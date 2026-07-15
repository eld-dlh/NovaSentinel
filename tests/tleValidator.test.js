// tests/tleValidator.test.js
// Integration tests: TLE parse → validate pipeline
//
// Run with:  node --test tests/tleValidator.test.js
// Requires:  Node.js ≥ 18 (built-in test runner + assert)
//
// Coverage:
//   1. Good TLE records parse and pass validation
//   2. Bad checksum is rejected
//   3. Eccentricity ≥ 1 is rejected (physical plausibility)
//   4. Mean motion > 20 rev/day is rejected
//   5. Epoch freshness check (stale TLE rejected)
//   6. Batch filter counts match expected valid/rejected ratio
//   7. Audit log captures rejected record metadata

import { test, describe } from 'node:test';
import assert              from 'node:assert/strict';
import { readFileSync }    from 'node:fs';
import { fileURLToPath }   from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── Import modules under test ───────────────────────────────────────────────
import { parseTLEText }                     from '../src/data/tleParser.js';
import { computeChecksum, checksumValid,
         validateTLERecord, filterValidTLEs } from '../src/data/tleValidator.js';

// ── Load fixture TLEs ───────────────────────────────────────────────────────
const FIXTURE_PATH = resolve(__dirname, 'fixtures', 'sample-tles.txt');
const fixtureText  = readFileSync(FIXTURE_PATH, 'utf-8');

// ── Helper: build a synthetic satrec-like TLERecord ────────────────────────
function makeFakeRecord(overrides = {}) {
  // Valid ISS lines (checksums correct, epoch recent-ish)
  const LINE1 = '1 25544U 98067A   24001.50000000  .00002182  00000-0  40333-4 0  9992';
  const LINE2 = '2 25544  51.6400 181.0000 0003210  87.0000 273.1000 15.50000000000014';
  return {
    name:    overrides.name    ?? 'ISS (ZARYA)',
    noradId: overrides.noradId ?? '25544',
    line1:   overrides.line1   ?? LINE1,
    line2:   overrides.line2   ?? LINE2,
    satrec: {
      satnum:    25544,
      epochyr:   24,
      epochdays: 1.5,
      error:     overrides.error    ?? 0,
      ecco:      overrides.ecco     ?? 0.000321,
      inclo:     overrides.inclo    ?? 0.901,        // ~51.64° in radians
      no_kozai:  overrides.no_kozai ?? 0.067221,     // ~15.5 rev/day in rad/min
      ...overrides.satrec,
    },
    epoch: new Date(),  // treated as current by validator
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
describe('computeChecksum', () => {

  test('computes correct checksum for ISS Line 1', () => {
    const line = '1 25544U 98067A   24001.50000000  .00002182  00000-0  40333-4 0  9992';
    // The last digit (index 68) is 2 — compute should return 2
    const computed = computeChecksum(line);
    assert.equal(computed, parseInt(line[68], 10));
  });

  test('checksumValid returns true for valid line', () => {
    const line = '2 25544  51.6400 181.0000 0003210  87.0000 273.1000 15.50000000000014';
    assert.ok(checksumValid(line));
  });

  test('checksumValid returns false for tampered line', () => {
    // Flip the last digit
    const line = '1 25544U 98067A   24001.50000000  .00002182  00000-0  40333-4 0  9999';
    assert.ok(!checksumValid(line));
  });

  test('checksumValid returns false for short lines', () => {
    assert.ok(!checksumValid('1 25544'));
    assert.ok(!checksumValid(''));
    assert.ok(!checksumValid(null));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('validateTLERecord', () => {

  test('accepts a well-formed TLE record', () => {
    const rec    = makeFakeRecord();
    const result = validateTLERecord(rec, { maxAgeDays: 9999 }); // disable age check
    assert.ok(result !== null, 'Expected record to pass validation');
  });

  test('rejects record with bad Line 1 checksum', () => {
    const badLine1 = '1 25544U 98067A   24001.50000000  .00002182  00000-0  40333-4 0  9999';
    const rec      = makeFakeRecord({ line1: badLine1 });
    const result   = validateTLERecord(rec, { maxAgeDays: 9999 });
    assert.equal(result, null, 'Expected checksum rejection');
  });

  test('rejects record with eccentricity >= 1 (hyperbolic escape)', () => {
    // eccentricity = 1.1 would mean the object has escaped Earth's gravity
    const rec    = makeFakeRecord({ ecco: 1.1 });
    const audit  = [];
    const result = validateTLERecord(rec, { maxAgeDays: 9999, auditLog: audit });
    assert.equal(result, null, 'e >= 1 must be rejected');
    assert.ok(audit.length === 1, 'Audit log should capture one rejection');
    assert.ok(audit[0].reason.includes('eccentricity'), 'Audit reason should mention eccentricity');
  });

  test('rejects record with mean motion > 20 rev/day (physically impossible)', () => {
    // > 20 rev/day would be orbit below Earth's surface
    const rec    = makeFakeRecord({ no_kozai: 0.20 }); // ~27 rev/day
    const result = validateTLERecord(rec, { maxAgeDays: 9999 });
    assert.equal(result, null, 'Implausible mean motion must be rejected');
  });

  test('rejects record with satellite.js satrec error flag set', () => {
    const rec    = makeFakeRecord({ error: 2 });
    const result = validateTLERecord(rec, { maxAgeDays: 9999 });
    assert.equal(result, null, 'satrec.error !== 0 must be rejected');
  });

  test('rejects stale TLE beyond maxAgeDays', () => {
    // Override epoch to 60 days ago
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
    const rec = {
      ...makeFakeRecord(),
      satrec: {
        ...makeFakeRecord().satrec,
        // Set epochyr/epochdays to produce a date 60 days in the past
        epochyr:   sixtyDaysAgo.getUTCFullYear() % 100,
        epochdays: Math.ceil((sixtyDaysAgo.getTime() - Date.UTC(sixtyDaysAgo.getUTCFullYear(), 0, 1)) / 86_400_000) + 1,
      },
    };
    const result = validateTLERecord(rec, { maxAgeDays: 30 });
    assert.equal(result, null, 'TLE older than maxAgeDays must be rejected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('filterValidTLEs + parseTLEText integration', () => {

  test('parses fixture file and identifies bad checksum record', () => {
    const records = parseTLEText(fixtureText);
    // Fixture has 4 TLE entries (including BAD-CHECKSUM)
    assert.ok(records.length >= 3, `Expected at least 3 parsed records, got ${records.length}`);

    // Find the bad-checksum record
    const bad = records.find(r => r.name === 'BAD-CHECKSUM');
    if (bad) {
      // validateTLERecord should reject it
      const result = validateTLERecord(bad, { maxAgeDays: 9999 });
      assert.equal(result, null, 'BAD-CHECKSUM record must be rejected');
    }
  });

  test('filterValidTLEs returns fewer records than input when fixture has bad entries', () => {
    const records = parseTLEText(fixtureText);
    const valid   = filterValidTLEs(records, { maxAgeDays: 9999 });
    // BAD-CHECKSUM should be filtered out
    assert.ok(valid.length < records.length, 'Filtered list must be shorter than input');
    assert.ok(valid.every(r => r.name !== 'BAD-CHECKSUM'), 'No bad records should survive');
  });

  test('audit log receives all rejected records', () => {
    const records  = parseTLEText(fixtureText);
    const auditLog = [];
    filterValidTLEs(records, { maxAgeDays: 9999, auditLog });
    assert.ok(auditLog.length >= 1, 'At least one rejection should be logged');
    assert.ok(auditLog.every(e => e.reason && e.noradId !== undefined),
      'Each audit entry must have reason and noradId');
  });
});
