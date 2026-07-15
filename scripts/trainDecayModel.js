#!/usr/bin/env node
// scripts/trainDecayModel.js
//
// Offline Node.js trainer for the Brain.js LSTM orbital-decay model.
//
// Usage:
//   node scripts/trainDecayModel.js [--tle-file data/tle-cache.json] [--out data/decayNet.json]
//
// What it does:
//   1. Loads TLE records from a JSON file (produced by tleFetch or omm-cache).
//   2. Builds per-object decay sequences (buildDecaySequences).
//   3. Trains a Brain.js LSTMTimeStep network.
//   4. Evaluates autoregressive 3-step predictions on held-out sequences.
//   5. Saves the serialised network to disk for optional browser pre-loading.
//
// Note: brain.js must be installed: npm install brain.js

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve }                                  from 'path';
import { fileURLToPath }                            from 'url';
import { dirname }                                  from 'path';

// --- Resolve project root ---
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..');

// --- Parse CLI args ---
const args        = process.argv.slice(2);
const tleFilePath = resolve(ROOT, argValue(args, '--tle-file') ?? 'data/tle-cache.json');
const outPath     = resolve(ROOT, argValue(args, '--out')      ?? 'data/decayNet.json');

function argValue(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

// --- Import decay pipeline (ES module) ---
const { buildDecaySequences }   = await import('../src/decay/sequences.js');
const { trainDecayModel, predictDecay, serializeDecayNet } = await import('../src/decay/decayModel.js');

// ---------------------------------------------------------------------------
// 1. Load TLE records
// ---------------------------------------------------------------------------

if (!existsSync(tleFilePath)) {
  console.error(`[train-decay] TLE file not found: ${tleFilePath}`);
  console.error('  Run `npm run generate-data` first, or specify --tle-file <path>');
  process.exit(1);
}

let allTLEs;
try {
  const raw = readFileSync(tleFilePath, 'utf-8');
  allTLEs   = JSON.parse(raw);
  if (!Array.isArray(allTLEs)) throw new TypeError('Expected array');
} catch (err) {
  console.error(`[train-decay] Failed to parse TLE file: ${err.message}`);
  process.exit(1);
}

console.log(`[train-decay] Loaded ${allTLEs.length} TLE records from ${tleFilePath}`);

// ---------------------------------------------------------------------------
// 2. Build sequences
// ---------------------------------------------------------------------------

const SEQ_LEN = 10;
const sequences = buildDecaySequences(allTLEs, SEQ_LEN);
console.log(`[train-decay] ${sequences.length} valid decay sequences (≥${SEQ_LEN} epochs, gap ≤7 days)`);

if (sequences.length === 0) {
  console.error('[train-decay] No sequences — cannot train. Check TLE file has multi-epoch data per object.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Train/Val split (80/20 by sequence)
// ---------------------------------------------------------------------------

// Shuffle sequences deterministically for reproducibility
function shuffle(arr, seed = 42) {
  // Simple seeded LCG shuffle
  let s = seed;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const shuffled   = shuffle([...sequences]);
const trainEnd   = Math.floor(shuffled.length * 0.8);
const trainSeqs  = shuffled.slice(0, trainEnd);
const valSeqs    = shuffled.slice(trainEnd);

console.log(`[train-decay] Train: ${trainSeqs.length}  Val: ${valSeqs.length}`);

// ---------------------------------------------------------------------------
// 4. Train
// ---------------------------------------------------------------------------

console.log('[train-decay] Training Brain.js LSTMTimeStep...');
const t0 = Date.now();

const { net, trainLog } = trainDecayModel(trainSeqs, {
  iterations:   500,
  learningRate: 0.01,
  log:          true,
});

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[train-decay] Done — ${elapsed}s, final error=${trainLog.error?.toFixed(6) ?? 'N/A'}`);

// ---------------------------------------------------------------------------
// 5. Evaluate on validation sequences (MAE in km)
// ---------------------------------------------------------------------------

let totalMAE = 0;
let evalCount = 0;

for (const seq of valSeqs) {
  // Use first seqLen-1 points as seed, last point as ground truth
  const seed     = seq.points.slice(0, -1);
  const truth    = seq.points[seq.points.length - 1];
  const [pred]   = predictDecay(net, seed, 1);

  if (pred && isFinite(pred.altitude) && isFinite(truth.altitude)) {
    totalMAE += Math.abs(pred.altitude - truth.altitude);
    evalCount++;
  }
}

if (evalCount > 0) {
  console.log(`[train-decay] Validation MAE: ${(totalMAE / evalCount).toFixed(2)} km (n=${evalCount})`);
} else {
  console.warn('[train-decay] No valid eval pairs — skipping MAE.');
}

// ---------------------------------------------------------------------------
// 6. Reentry alert summary
// ---------------------------------------------------------------------------

const REENTRY_KM = 250;
let alertCount   = 0;

for (const seq of sequences) {
  const preds = predictDecay(net, seq.points, 3);
  const minAlt = Math.min(...preds.map(p => p.altitude));
  if (minAlt < REENTRY_KM) {
    alertCount++;
    console.warn(
      `  ⚠ NORAD ${seq.noradId} (${seq.name}) ` +
      `pred-min=${minAlt.toFixed(1)} km`
    );
  }
}
console.log(`[train-decay] ${alertCount} object(s) predicted below ${REENTRY_KM} km.`);

// ---------------------------------------------------------------------------
// 7. Save model to disk
// ---------------------------------------------------------------------------

const json = serializeDecayNet(net);
writeFileSync(outPath, JSON.stringify(json, null, 2));
console.log(`[train-decay] Model saved → ${outPath}`);
