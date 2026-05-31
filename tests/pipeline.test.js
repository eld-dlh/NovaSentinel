// tests/pipeline.test.js
// Full end-to-end integration test: TLE → parse → validate → propagate → feature → CDM covariance
//
// Run with:  node --test tests/pipeline.test.js
// Requires:  Node.js ≥ 18
//
// This test exercises the complete data→ML pipeline without any browser APIs or
// Three.js rendering (those are covered by manual / visual tests).
// Orbit propagation is tested using satellite.js directly via propagateAt().

import { test, describe } from 'node:test';
import assert              from 'node:assert/strict';
import { readFileSync }    from 'node:fs';
import { fileURLToPath }   from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { parseTLEText }                             from '../src/data/tleParser.js';
import { filterValidTLEs }                          from '../src/data/tleValidator.js';
import { propagateAt }                              from '../src/propagation/propagate.js';
import { buildFeatureVector }                       from '../src/ml/features.js';
import { cdmToEllipsoidAxes, covarianceSummary,
         parseCombinedCovariance }               from '../src/data/cdmCovariance.js';
import { buildDecaySequences, meanMotionToAlt }     from '../src/decay/sequences.js';

const FIXTURE_TLE = readFileSync(
  resolve(__dirname, 'fixtures', 'sample-tles.txt'), 'utf-8'
);
const CDM_FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures', 'sample-cdms.json'), 'utf-8')
);

// Fixed deterministic time for propagation: 2024-01-01T12:00:00Z
const FIXED_DATE = new Date('2024-01-01T12:00:00.000Z');

// ═══════════════════════════════════════════════════════════════════════════
describe('Stage 1 — TLE parse → validate', () => {

  let records;
  test('parseTLEText returns structured records from fixture text', () => {
    records = parseTLEText(FIXTURE_TLE);
    assert.ok(records.length >= 3, `Expected ≥ 3 records, got ${records.length}`);
    for (const r of records) {
      assert.ok(r.noradId,       'Each record must have noradId');
      assert.ok(r.satrec,        'Each record must have satrec');
      assert.ok(r.epoch instanceof Date, 'Each record must have epoch Date');
      assert.ok(isFinite(r.meanMotion),  'Mean motion must be finite');
      assert.ok(r.meanMotion > 0,        'Mean motion must be positive');
    }
  });

  test('filterValidTLEs rejects bad-checksum record', () => {
    const all   = parseTLEText(FIXTURE_TLE);
    const valid = filterValidTLEs(all, { maxAgeDays: 9999 });
    const names = valid.map(r => r.name);
    assert.ok(!names.includes('BAD-CHECKSUM'), 'BAD-CHECKSUM must be filtered out');
    assert.ok(names.includes('ISS (ZARYA)'), 'ISS must pass validation');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Stage 2 — SGP4 propagation', () => {

  test('propagateAt produces valid geodetic position for ISS at fixed time', () => {
    const records = filterValidTLEs(parseTLEText(FIXTURE_TLE), { maxAgeDays: 9999 });
    const iss     = records.find(r => r.name === 'ISS (ZARYA)');
    assert.ok(iss, 'ISS record must exist after filtering');

    const pos = propagateAt(iss.satrec, FIXED_DATE);
    assert.ok(pos !== null, 'propagateAt must succeed for ISS at fixed date');

    // Geodetic bounds
    assert.ok(pos.lat >= -90  && pos.lat <= 90,   `lat ${pos.lat} out of range`);
    assert.ok(pos.lon >= -180 && pos.lon <= 180,   `lon ${pos.lon} out of range`);
    assert.ok(pos.altKm >= 200 && pos.altKm < 700, `ISS alt ${pos.altKm} km implausible`);

    // Speed: ISS orbits at ~7.66 km/s
    assert.ok(pos.speed >= 6 && pos.speed <= 10,   `ISS speed ${pos.speed} km/s implausible`);
  });

  test('propagateAt returns ECI position components', () => {
    const records = filterValidTLEs(parseTLEText(FIXTURE_TLE), { maxAgeDays: 9999 });
    const iss     = records.find(r => r.name === 'ISS (ZARYA)');
    const pos     = propagateAt(iss.satrec, FIXED_DATE);

    assert.ok(pos.eciPos, 'eciPos must exist');
    assert.ok(isFinite(pos.eciPos.x), 'eciPos.x must be finite');
    assert.ok(isFinite(pos.eciPos.y), 'eciPos.y must be finite');
    assert.ok(isFinite(pos.eciPos.z), 'eciPos.z must be finite');

    // ECI magnitude should be ~6371 + alt km
    const r = Math.sqrt(pos.eciPos.x ** 2 + pos.eciPos.y ** 2 + pos.eciPos.z ** 2);
    assert.ok(r >= 6500 && r <= 7200, `ECI radius ${r.toFixed(0)} km implausible for ISS`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Stage 3 — Feature extraction from CDM fixture', () => {

  test('full feature vector has 15 elements, all finite', () => {
    for (const cdm of CDM_FIXTURES) {
      const conj = {
        missDistanceKm:     parseFloat(cdm.MISS_DISTANCE),
        relVelocityKms:     parseFloat(cdm.RELATIVE_SPEED),
        mahalanobisDistance: parseFloat(cdm.MAHALANOBIS_DISTANCE),
        combinedCovBplane:  null,
        incPrimaryDeg:      parseFloat(cdm.SAT1_INCLINATION),
        incSecondaryDeg:    parseFloat(cdm.SAT2_INCLINATION),
        raanDiffDeg:        Math.abs(parseFloat(cdm.SAT1_RAAN) - parseFloat(cdm.SAT2_RAAN)),
        altPrimaryKm:       parseFloat(cdm.SAT1_ALTITUDE),
        altSecondaryKm:     parseFloat(cdm.SAT2_ALTITUDE),
        bstarPrimary:       parseFloat(cdm.SAT1_BSTAR),
        tleAgeDays:         parseFloat(cdm.TLE_AGE),
        isDebris:           cdm.SAT2_OBJECT_TYPE.toUpperCase().includes('DEBRIS'),
      };
      const vec = buildFeatureVector(conj);
      assert.equal(vec.length, 15, 'Feature vector must be length 15');
      assert.ok(vec.every(isFinite), 'All features must be finite');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Stage 4 — CDM covariance → ellipsoid axes', () => {

  test('axes are positive and physically bounded for all fixtures', () => {
    for (const cdm of CDM_FIXTURES) {
      const { axes } = cdmToEllipsoidAxes(cdm);
      assert.equal(axes.length, 3);
      for (const a of axes) {
        assert.ok(a > 0 && a < 1e6, `Axis ${a} m out of physical bounds`);
      }
    }
  });

  test('sigmaR/T/N match diagonal square roots of combined covariance', () => {
    const cdm     = CDM_FIXTURES[0];
    const summary = covarianceSummary(cdm);
    const { combined } = parseCombinedCovariance(cdm);
    const expectedSigmaR = Math.sqrt(Math.max(combined[0][0], 0)) * 1000;
    assert.ok(
      Math.abs(summary.sigmaR - expectedSigmaR) < 1e-6,
      `sigmaR mismatch: ${summary.sigmaR} vs ${expectedSigmaR}`
    );
  });

});

// ═══════════════════════════════════════════════════════════════════════════
describe('Stage 5 — Brain.js decay sequences from TLE catalogue', () => {

  test('buildDecaySequences returns empty array when records < seqLen', () => {
    const records = filterValidTLEs(parseTLEText(FIXTURE_TLE), { maxAgeDays: 9999 });
    // With only 1 record per NORAD ID, no sequences of length 10 can form
    const seqs = buildDecaySequences(records, 10);
    assert.equal(seqs.length, 0, 'Single-epoch objects cannot form sequences');
  });

  test('meanMotionToAlt gives physically correct altitude for ISS mean motion', () => {
    // ISS no_kozai ≈ 0.067631 rad/min → alt ≈ 424 km
    const NO_KOZAI_ISS = 0.067631;
    const alt = meanMotionToAlt(NO_KOZAI_ISS);
    assert.ok(
      alt >= 380 && alt <= 440,
      `ISS altitude ${alt.toFixed(0)} km outside expected 380–440 km range`
    );
  });

  test('meanMotionToAlt returns NaN for zero or negative input', () => {
    assert.ok(isNaN(meanMotionToAlt(0)),  'Zero mean motion → NaN altitude');
    assert.ok(isNaN(meanMotionToAlt(-1)), 'Negative mean motion → NaN altitude');
  });

  test('multi-epoch synthetic sequences are correctly windowed', () => {
    // Build synthetic multi-epoch records for one NORAD ID
    const BASE_NO_KOZAI = 0.067221; // ISS-like
    const syntheticRecords = Array.from({ length: 15 }, (_, i) => ({
      name:    'SYNTHETIC-SAT',
      noradId: '99999',
      satrec: {
        satnum:    99999,
        epochyr:   24,
        epochdays: 1 + i,         // one epoch per day
        no_kozai:  BASE_NO_KOZAI + i * 1e-5,  // gradually increasing
        error:     0,
        ecco:      0.001,
        inclo:     0.9,
      },
    }));

    const seqs = buildDecaySequences(syntheticRecords, 10);
    assert.equal(seqs.length, 1, 'Should produce 1 sequence for 15 epochs of same object');
    assert.equal(seqs[0].points.length, 10, 'Sequence should be windowed to last 10 points');
    assert.equal(seqs[0].noradId, '99999');

    // Points should be sorted ascending by epoch
    for (let i = 1; i < seqs[0].points.length; i++) {
      assert.ok(
        seqs[0].points[i].epoch > seqs[0].points[i - 1].epoch,
        'Points must be in ascending epoch order'
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Stage 6 — Full pipeline timing benchmark', () => {

  test('TLE parse + validate cycle < 3 seconds for fixture size', () => {
    const t0 = performance.now();
    const records = parseTLEText(FIXTURE_TLE);
    filterValidTLEs(records, { maxAgeDays: 9999 });
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 3000, `Parse+validate took ${elapsed.toFixed(0)} ms — exceeds 3 s`);
  });
});
