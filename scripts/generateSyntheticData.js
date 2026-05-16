// Synthetic CARA-style conjunction data generator
//
// Generates physically realistic conjunction events for training when
// real ESA Collision Avoidance Challenge data is unavailable.
//
// Run:  node scripts/generateSyntheticData.js
//
// Distributions modelled:
//   - Miss distance:  log-normal (mode ~5 km, tail to <0.01 km)
//   - Altitude:       bimodal peaks at 550 km and 850 km (McKnight et al.)
//   - Rel velocity:   10–14 km/s for head-on LEO encounters
//   - PoC label:      ~5% high-risk (score > 0.5) to model class imbalance

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

function randNormal(mean = 0, std = 1) {
  // Box-Muller transform
  const u1 = Math.random() || 1e-10;
  const u2 = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function randLogNormal(mu, sigma) {
  return Math.exp(randNormal(mu, sigma));
}

function randBimodal(peak1, peak2, std, mix = 0.5) {
  return Math.random() < mix
    ? randNormal(peak1, std)
    : randNormal(peak2, std);
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

// ---------------------------------------------------------------------------
// Generate a single conjunction event
// ---------------------------------------------------------------------------

function generateEvent(id) {
  // Miss distance: log-normal with most values 1–20 km, tail to near-zero
  const missDistanceKm = clamp(randLogNormal(1.2, 1.0), 0.001, 50);

  // Relative velocity: LEO head-on encounters cluster 7–15 km/s
  const relVelocityKms = clamp(randNormal(10, 3), 0.5, 15);

  // Altitude: bimodal at 550 and 850 km
  const altPrimaryKm   = clamp(randBimodal(550, 850, 80), 200, 2000);
  const altSecondaryKm = clamp(randBimodal(550, 850, 80), 200, 2000);

  // Inclinations: SSO cluster ~97°, also significant population at 51–53°
  const incPrimaryDeg   = Math.random() < 0.6
    ? clamp(randNormal(97, 3), 0, 180)
    : clamp(randNormal(52, 5), 0, 180);
  const incSecondaryDeg = Math.random() < 0.6
    ? clamp(randNormal(97, 3), 0, 180)
    : clamp(randNormal(52, 5), 0, 180);
  const raanDiffDeg = rand(0, 360);

  // B* drag term: near-zero for most objects, occasional high-drag
  const bstarPrimary = clamp(randNormal(0, 0.0005), -0.1, 0.1);

  // TLE age: exponential-ish, most < 5 days
  const tleAgeDays = clamp(Math.abs(randNormal(2, 5)), 0, 30);

  // Debris fraction: ~40% of trackable objects
  const isDebris = Math.random() < 0.4;

  // Mahalanobis distance — correlated with miss distance / covariance size
  const hasCov = Math.random() < 0.7; // 70% have CDM covariance
  let mahalanobisDistance = null;
  let combinedCovBplane  = null;

  if (hasCov) {
    // Covariance diagonal elements: variance in km², log-scale
    const crr = randLogNormal(-2, 2); // radial variance
    const ctt = randLogNormal(0, 2);  // transverse (largest)
    const cnn = randLogNormal(-1, 2); // normal
    // Off-diagonal: small fraction of geometric mean
    const ctr = (Math.random() - 0.5) * 0.3 * Math.sqrt(crr * ctt);
    const cnr = (Math.random() - 0.5) * 0.2 * Math.sqrt(crr * cnn);
    const cnt = (Math.random() - 0.5) * 0.2 * Math.sqrt(ctt * cnn);

    combinedCovBplane = [crr, ctr, cnr, ctt, cnt, cnn];

    // Mahalanobis ~ missDistance / sqrt(trace)
    const trace = crr + ctt + cnn;
    mahalanobisDistance = clamp(
      missDistanceKm / Math.sqrt(Math.max(trace, 1e-6)) + randNormal(0, 0.5),
      0, 50
    );
  }

  // ---- Label: collision probability score ----
  // Physics-inspired: PoC increases with lower miss distance, higher velocity,
  // lower Mahalanobis, and debris involvement.
  // Calibrated to produce ~5-10% positive labels (pocScore > 0.5).
  let logitScore = 1.0; // start slightly positive
  // Miss distance is the dominant factor: low = dangerous
  // log1p(missDistanceKm) ranges ~0 (near miss) to ~3.9 (50 km)
  // Subtract a scaled version so small miss distances push logit up
  logitScore -= 1.5 * Math.log1p(missDistanceKm);
  // Relative velocity: head-on encounters are more dangerous
  logitScore += 0.4 * (relVelocityKms / 15);
  if (mahalanobisDistance !== null) {
    logitScore -= 0.5 * Math.log1p(mahalanobisDistance);
  }
  if (isDebris) logitScore += 0.6;
  logitScore += 0.2 * (tleAgeDays / 30);
  // Altitude risk bands (550 km and 850 km per McKnight)
  const altAvg = (altPrimaryKm + altSecondaryKm) / 2;
  if (altAvg > 500 && altAvg < 600) logitScore += 0.4;
  if (altAvg > 800 && altAvg < 900) logitScore += 0.4;
  // Noise to avoid a perfectly learnable boundary
  logitScore += randNormal(0, 0.8);

  const pocScore = 1 / (1 + Math.exp(-logitScore));
  // Binary label: threshold at 0.5 for training
  const label = pocScore > 0.5 ? 1 : 0;

  return {
    id:                  `SYN-${String(id).padStart(6, '0')}`,
    eventId:             `SYN-${String(id).padStart(6, '0')}`,
    cdmId:               `SYN-${String(id).padStart(6, '0')}`,
    missDistanceKm,
    relVelocityKms,
    mahalanobisDistance,
    combinedCovBplane,
    incPrimaryDeg,
    incSecondaryDeg,
    raanDiffDeg,
    altPrimaryKm,
    altSecondaryKm,
    bstarPrimary,
    tleAgeDays,
    isDebris,
    pocScore,            // continuous 0–1 for regression
    label,               // binary for classification
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const NUM_EVENTS = 10_000;
const outputPath = join(__dirname, '..', 'data', 'cara-events.json');

console.info(`[generate] Creating ${NUM_EVENTS} synthetic conjunction events...`);

const events = [];
for (let i = 0; i < NUM_EVENTS; i++) {
  events.push(generateEvent(i));
}

const nPos = events.filter(e => e.label === 1).length;
console.info(`[generate] Class distribution: ${events.length - nPos} neg / ${nPos} pos (${(100 * nPos / events.length).toFixed(1)}% positive)`);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(events, null, 2));
console.info(`[generate] Wrote ${outputPath}`);
