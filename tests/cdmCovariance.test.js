// tests/cdmCovariance.test.js
// Integration tests: CDM covariance parse → eigendecompose → ellipsoid axes
//
// Run with:  node --test tests/cdmCovariance.test.js
// Requires:  Node.js ≥ 18
//
// Validation strategy:
//   - Semi-axes computed from known 3×3 matrices are checked against
//     hand-computed eigenvalues (diagonal matrices have trivial eigenvalues).
//   - The fixture CDMs are tested for physical realism: axes must be positive,
//     finite, and within plausible physical bounds.
//   - The combined covariance must equal the element-wise sum of C1 + C2.
//   - covarianceSummary sigma values must be consistent with matrix diagonals.

import { test, describe } from 'node:test';
import assert              from 'node:assert/strict';
import { readFileSync }    from 'node:fs';
import { fileURLToPath }   from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  buildCovMatrix,
  matAdd,
  eigenvalues3x3,
  semiAxes,
  parseCombinedCovariance,
  cdmToEllipsoidAxes,
  covarianceSummary,
} from '../src/data/cdmCovariance.js';

const CDM_FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures', 'sample-cdms.json'), 'utf-8')
);

// ── Tolerance helper ────────────────────────────────────────────────────────
const EPSILON = 1e-8;
function approxEq(a, b, tol = EPSILON) {
  return Math.abs(a - b) <= tol;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('buildCovMatrix', () => {

  test('builds correct symmetric 3×3 from 6 elements', () => {
    const M = buildCovMatrix(1, 2, 3, 4, 5, 6);
    // Row 0: [1, 2, 3]
    assert.deepEqual(M[0], [1, 2, 3]);
    // Row 1: [2, 4, 5] — symmetric
    assert.deepEqual(M[1], [2, 4, 5]);
    // Row 2: [3, 5, 6]
    assert.deepEqual(M[2], [3, 5, 6]);
  });

  test('coerces string inputs to numbers', () => {
    const M = buildCovMatrix('1e-4', '2e-5', '1e-6', '4e-3', '3e-6', '9e-5');
    assert.ok(typeof M[0][0] === 'number');
    assert.ok(approxEq(M[0][0], 1e-4));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('eigenvalues3x3', () => {

  test('diagonal matrix has trivial eigenvalues', () => {
    // A diagonal matrix's eigenvalues are its diagonal entries
    const D   = [[4, 0, 0], [0, 9, 0], [0, 0, 16]];
    const evs = eigenvalues3x3(D).sort((a, b) => a - b);
    assert.ok(approxEq(evs[0], 4,  1e-6), `Expected λ1≈4, got ${evs[0]}`);
    assert.ok(approxEq(evs[1], 9,  1e-6), `Expected λ2≈9, got ${evs[1]}`);
    assert.ok(approxEq(evs[2], 16, 1e-6), `Expected λ3≈16, got ${evs[2]}`);
  });

  test('symmetric matrix with known eigenvalues', () => {
    // [[2, 1, 0], [1, 2, 0], [0, 0, 3]] has eigenvalues 1, 3, 3
    const M   = [[2, 1, 0], [1, 2, 0], [0, 0, 3]];
    const evs = eigenvalues3x3(M).sort((a, b) => a - b);
    assert.ok(approxEq(evs[0], 1, 1e-6), `Expected λ1=1, got ${evs[0]}`);
    assert.ok(approxEq(evs[1], 3, 1e-5), `Expected λ2=3, got ${evs[1]}`);
    assert.ok(approxEq(evs[2], 3, 1e-5), `Expected λ3=3, got ${evs[2]}`);
  });

  test('eigenvalues sum equals matrix trace', () => {
    const M    = [[3, 1, 0.5], [1, 5, 0.2], [0.5, 0.2, 7]];
    const evs  = eigenvalues3x3(M);
    const evSum = evs.reduce((s, v) => s + v, 0);
    const trace = M[0][0] + M[1][1] + M[2][2];
    assert.ok(approxEq(evSum, trace, 1e-6), `Eigenvalue sum ${evSum} ≠ trace ${trace}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('semiAxes', () => {

  test('semi-axes of diagonal covariance are sqrt of diagonal × 1000', () => {
    // Diagonal: variances 1e-4, 4e-3, 9e-5 km²
    // Semi-axes (m): sqrt(1e-4)*1000=10, sqrt(4e-3)*1000≈63.25, sqrt(9e-5)*1000≈9.49
    const D    = [[1e-4, 0, 0], [0, 4e-3, 0], [0, 0, 9e-5]];
    const axes = semiAxes(D).sort((a, b) => a - b);
    assert.ok(approxEq(axes[0], Math.sqrt(9e-5) * 1000, 0.01));
    assert.ok(approxEq(axes[1], Math.sqrt(1e-4)  * 1000, 0.01));
    assert.ok(approxEq(axes[2], Math.sqrt(4e-3)  * 1000, 0.01));
  });

  test('semi-axes are always non-negative (guard against negative eigenvalues from rounding)', () => {
    // Nearly-zero off-diagonal can produce tiny negative eigenvalues via FP errors
    const M = [[1e-10, 1e-11, 0], [1e-11, 1e-10, 0], [0, 0, 1e-10]];
    const axes = semiAxes(M);
    assert.ok(axes.every(a => a >= 0), 'All semi-axes must be ≥ 0');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('parseCombinedCovariance', () => {

  test('combined covariance = C1 + C2 element-wise', () => {
    const cdm = CDM_FIXTURES[0];
    const { C1, C2, combined } = parseCombinedCovariance(cdm);

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const expected = C1[i][j] + C2[i][j];
        assert.ok(
          approxEq(combined[i][j], expected, 1e-12),
          `combined[${i}][${j}] = ${combined[i][j]}, expected ${expected}`
        );
      }
    }
  });

  test('C1 and C2 are symmetric matrices', () => {
    const cdm = CDM_FIXTURES[0];
    const { C1, C2 } = parseCombinedCovariance(cdm);
    for (const M of [C1, C2]) {
      assert.ok(approxEq(M[0][1], M[1][0]), 'Matrix not symmetric at [0][1]/[1][0]');
      assert.ok(approxEq(M[0][2], M[2][0]), 'Matrix not symmetric at [0][2]/[2][0]');
      assert.ok(approxEq(M[1][2], M[2][1]), 'Matrix not symmetric at [1][2]/[2][1]');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('cdmToEllipsoidAxes (full pipeline) — fixture benchmarks', () => {

  for (const [i, cdm] of CDM_FIXTURES.entries()) {
    test(`Fixture ${i} — axes are finite, positive, within physical bounds`, () => {
      const { axes } = cdmToEllipsoidAxes(cdm);
      assert.equal(axes.length, 3, 'Must return exactly 3 semi-axes');
      for (const a of axes) {
        assert.ok(isFinite(a),   `Semi-axis is not finite: ${a}`);
        assert.ok(a >= 0,        `Semi-axis is negative: ${a}`);
        // Physical upper bound: no CDM uncertainty > 1000 km = 1e6 m
        assert.ok(a < 1_000_000, `Semi-axis implausibly large: ${a} m`);
        // Physical lower bound: should be at least 1 m for any real conjunction
        assert.ok(a >= 1,        `Semi-axis implausibly small: ${a} m`);
      }
    });
  }

  test('Fixture A (AMBER) — sigmaR < sigmaT (radial uncertainty << transverse)', () => {
    // In LEO, along-track (transverse) uncertainty is typically 10-100× radial
    const cdm     = CDM_FIXTURES[0];
    const summary = covarianceSummary(cdm);
    // sigmaT (transverse) should exceed sigmaR (radial) for well-behaved LEO CDMs
    assert.ok(
      summary.sigmaT > summary.sigmaR,
      `Expected sigmaT(${summary.sigmaT.toFixed(0)}m) > sigmaR(${summary.sigmaR.toFixed(0)}m)`
    );
  });

  test('Fixture C (RED, high-risk) — axes are larger than Fixture B (GREEN, low-risk)', () => {
    // Higher-risk conjunctions typically have larger combined covariance
    const axesC = cdmToEllipsoidAxes(CDM_FIXTURES[2]).axes;
    const axesB = cdmToEllipsoidAxes(CDM_FIXTURES[1]).axes;
    const maxC  = Math.max(...axesC);
    const maxB  = Math.max(...axesB);
    assert.ok(maxC > maxB, `RED fixture max axis (${maxC.toFixed(0)}m) should exceed GREEN (${maxB.toFixed(0)}m)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Performance benchmark — covariance + eigenvalue < 5 ms per CDM', () => {

  test('processes all 3 fixture CDMs under 5 ms each', () => {
    for (const [i, cdm] of CDM_FIXTURES.entries()) {
      const t0 = performance.now();
      cdmToEllipsoidAxes(cdm);
      const elapsed = performance.now() - t0;
      assert.ok(
        elapsed < 5,
        `Fixture ${i} took ${elapsed.toFixed(2)} ms — exceeds 5 ms target`
      );
    }
  });

  test('batch of 1000 CDM covariance operations completes < 500 ms', () => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      cdmToEllipsoidAxes(CDM_FIXTURES[i % CDM_FIXTURES.length]);
    }
    const elapsed = performance.now() - t0;
    assert.ok(
      elapsed < 500,
      `1000 covariance ops took ${elapsed.toFixed(0)} ms — exceeds 500 ms target`
    );
  });
});
