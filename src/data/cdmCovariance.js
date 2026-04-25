// 3×3 RTN covariance matrix parse, combine, eigendecomposition
//
// CDM covariance fields use the RTN (Radial-Transverse-Normal) frame.
// The 6 upper-triangle elements per object encode a symmetric 3×3 matrix:
//
//   | CR_R  CT_R  CN_R |
//   | CT_R  CT_T  CN_T |   ← symmetric: lower = upper transpose
//   | CN_R  CN_T  CN_N |
//
// All CDM covariance values are in km² (position) or km²/s² (velocity).
// This module works exclusively with the 3×3 position covariance block.

// ---------------------------------------------------------------------------
// Matrix helpers
// ---------------------------------------------------------------------------

/**
 * Builds a symmetric 3×3 matrix from the 6 upper-triangle CDM elements.
 * All string inputs are coerced to Number — Space-Track returns them as strings.
 *
 * @param {number|string} crr - C_RR (radial variance)
 * @param {number|string} ctr - C_TR (radial-transverse cross)
 * @param {number|string} cnr - C_NR (radial-normal cross)
 * @param {number|string} ctt - C_TT (transverse variance)
 * @param {number|string} cnt - C_NT (transverse-normal cross)
 * @param {number|string} cnn - C_NN (normal variance)
 * @returns {number[][]} 3×3 symmetric matrix.
 */
export function buildCovMatrix(crr, ctr, cnr, ctt, cnt, cnn) {
  const [rr, tr, nr, tt, nt, nn] = [crr, ctr, cnr, ctt, cnt, cnn].map(Number);
  return [
    [rr, tr, nr],
    [tr, tt, nt],
    [nr, nt, nn],
  ];
}

/**
 * Element-wise addition of two 3×3 matrices.
 *
 * @param {number[][]} A
 * @param {number[][]} B
 * @returns {number[][]}
 */
export function matAdd(A, B) {
  return A.map((row, i) => row.map((v, j) => v + B[i][j]));
}

/**
 * Returns a deep copy of a 3×3 matrix.
 * @param {number[][]} M
 * @returns {number[][]}
 */
function matClone(M) {
  return M.map(row => [...row]);
}

// ---------------------------------------------------------------------------
// Combined covariance from a single CDM record
// ---------------------------------------------------------------------------

/**
 * Parses the SAT1 and SAT2 position covariance blocks from a raw CDM record
 * and returns their element-wise sum (the combined covariance C = C1 + C2).
 *
 * Field names follow the Space-Track cdm_public schema exactly.
 *
 * @param {Object} cdm - Raw CDM JSON record from Space-Track.
 * @returns {{ C1: number[][], C2: number[][], combined: number[][] }}
 */
export function parseCombinedCovariance(cdm) {
  // SAT1 upper-triangle elements (RTN position, km²)
  const C1 = buildCovMatrix(
    cdm.SAT1_CR_R,  cdm.SAT1_CT_R,  cdm.SAT1_CN_R,
    cdm.SAT1_CT_T,  cdm.SAT1_CN_T,  cdm.SAT1_CN_N,
  );

  // SAT2 upper-triangle elements
  const C2 = buildCovMatrix(
    cdm.SAT2_CR_R,  cdm.SAT2_CT_R,  cdm.SAT2_CN_R,
    cdm.SAT2_CT_T,  cdm.SAT2_CN_T,  cdm.SAT2_CN_N,
  );

  return {
    C1,
    C2,
    combined: matAdd(C1, C2),
  };
}

// ---------------------------------------------------------------------------
// Eigenvalue decomposition — Jacobi iteration for symmetric 3×3
// ---------------------------------------------------------------------------

/**
 * Computes the three eigenvalues of a real symmetric 3×3 matrix using the
 * Jacobi eigenvalue algorithm (iterative off-diagonal elimination).
 *
 * Convergence is guaranteed for symmetric matrices and is typically reached
 * in <30 sweeps for a 3×3.  We cap at 100 sweeps for safety.
 *
 * @param {number[][]} M - Symmetric 3×3 matrix.
 * @returns {number[]} Array of three eigenvalues, unsorted.
 */
export function eigenvalues3x3(M) {
  // Work on a copy — Jacobi modifies the matrix in place
  const A  = matClone(M);
  const n  = 3;
  const EPS = 1e-12;
  const MAX_SWEEPS = 100;

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    // Sum of squares of off-diagonal elements
    let off = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        off += A[i][j] * A[i][j];
      }
    }
    if (off < EPS) break; // converged

    // One full sweep over all off-diagonal pairs (p,q)
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < EPS) continue;

        // Jacobi rotation angle
        const theta = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]);
        const c = Math.cos(theta);
        const s = Math.sin(theta);

        // Apply rotation J^T A J
        const App = c * c * A[p][p] - 2 * s * c * A[p][q] + s * s * A[q][q];
        const Aqq = s * s * A[p][p] + 2 * s * c * A[p][q] + c * c * A[q][q];
        A[p][q] = 0;
        A[q][p] = 0;

        // Update remaining rows/cols
        for (let r = 0; r < n; r++) {
          if (r === p || r === q) continue;
          const Arp = c * A[r][p] - s * A[r][q];
          const Arq = s * A[r][p] + c * A[r][q];
          A[r][p] = Arp;  A[p][r] = Arp;
          A[r][q] = Arq;  A[q][r] = Arq;
        }

        A[p][p] = App;
        A[q][q] = Aqq;
      }
    }
  }

  // Diagonal entries are now the eigenvalues
  return [A[0][0], A[1][1], A[2][2]];
}

// ---------------------------------------------------------------------------
// Semi-axes (km → m conversion for Three.js)
// ---------------------------------------------------------------------------

/**
 * Derives the 1-sigma ellipsoid semi-axis lengths from a combined covariance
 * matrix and converts from km to metres for Three.js scene units.
 *
 * Semi-axis lengths = √(eigenvalue) × 1000  (km → m)
 * Eigenvalues are clamped to ≥0 to guard against tiny negative values due to
 * floating-point rounding in nearly-singular covariances.
 *
 * @param {number[][]} combinedCov - 3×3 combined RTN covariance (km²).
 * @returns {number[]} [a, b, c] semi-axis lengths in metres (unsorted).
 */
export function semiAxes(combinedCov) {
  const evs = eigenvalues3x3(combinedCov);
  return evs.map(ev => Math.sqrt(Math.max(ev, 0)) * 1000); // km → m
}

// ---------------------------------------------------------------------------
// Convenience: full pipeline from raw CDM record
// ---------------------------------------------------------------------------

/**
 * One-shot helper: raw CDM record → Three.js-ready semi-axis lengths.
 *
 * @param {Object} cdm - Raw Space-Track CDM JSON record.
 * @returns {{
 *   axes:     number[],   - [a, b, c] in metres
 *   combined: number[][], - 3×3 combined covariance (km²)
 *   C1:       number[][], - SAT1 covariance (km²)
 *   C2:       number[][], - SAT2 covariance (km²)
 * }}
 */
export function cdmToEllipsoidAxes(cdm) {
  const { C1, C2, combined } = parseCombinedCovariance(cdm);
  const axes = semiAxes(combined);
  return { axes, combined, C1, C2 };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Returns a plain-language summary of a CDM's covariance properties.
 * Useful for tooltip rendering and audit logs.
 *
 * @param {Object} cdm
 * @returns {{
 *   sigmaR: number, sigmaT: number, sigmaN: number,   - 1-sigma (m) along RTN
 *   axesM:  number[],                                  - ellipsoid semi-axes (m)
 *   traceKm2: number,                                  - trace of combined cov (km²)
 * }}
 */
export function covarianceSummary(cdm) {
  const { combined } = parseCombinedCovariance(cdm);
  const axesM = semiAxes(combined);
  return {
    // Diagonal square roots give per-axis 1-sigma uncertainty in km, ×1000 → m
    sigmaR:   Math.sqrt(Math.max(combined[0][0], 0)) * 1000,
    sigmaT:   Math.sqrt(Math.max(combined[1][1], 0)) * 1000,
    sigmaN:   Math.sqrt(Math.max(combined[2][2], 0)) * 1000,
    axesM,
    traceKm2: combined[0][0] + combined[1][1] + combined[2][2],
  };
}
