// Offline model training script — Node.js (pure-JS TensorFlow)
//
// Trains the PoC regression model on conjunction event data and exports
// TensorFlow.js-compatible weights to public/model/.
//
// Run:  node scripts/trainModel.js
//
// Uses @tensorflow/tfjs (pure JavaScript — no native C++ bindings required).
// Training is slower than tfjs-node but avoids compilation issues on Windows.
//
// Pipeline:
//   1. Load data/cara-events.json (or generate synthetic if absent)
//   2. Build 15-feature vectors using shared normalisation
//   3. Grouped K-fold split (80/10/10 by event ID)
//   4. Train with class weights + early stopping
//   5. Evaluate precision/recall/F1 on test set
//   6. Export model to public/model/

import * as tf from '@tensorflow/tfjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Inline the shared normalisation (identical to src/ml/features.js)
// ---------------------------------------------------------------------------

const NORM = Object.freeze({
  MISS_DIST_MAX_KM: 50, REL_VEL_MAX_KMS: 15, MAHAL_SOFT_CAP: 20,
  COV_LOG_MIN: -4, COV_LOG_RANGE: 10,
  ALT_MIN_KM: 200, ALT_MAX_KM: 2000, BSTAR_CLIP: 0.1,
  TLE_AGE_MAX_DAYS: 30, NUM_FEATURES: 15,
});

function normMissDistance(km) {
  return Math.log1p(Math.max(0, km)) / Math.log1p(NORM.MISS_DIST_MAX_KM);
}
function normRelVelocity(kms) {
  return Math.log1p(Math.max(0, kms)) / Math.log1p(NORM.REL_VEL_MAX_KMS);
}
function normMahalanobis(d) {
  if (d === null || d === undefined) return -1;
  return Math.log1p(Math.max(0, d)) / Math.log1p(NORM.MAHAL_SOFT_CAP);
}
function normCovElement(val, isDiagonal) {
  if (isDiagonal) {
    const logVal = Math.log10(Math.max(val, 1e-6));
    return (logVal - NORM.COV_LOG_MIN) / NORM.COV_LOG_RANGE;
  }
  const sign   = Math.sign(val) || 1;
  const logMag = Math.log10(Math.max(Math.abs(val), 1e-6));
  return sign * ((logMag - NORM.COV_LOG_MIN) / NORM.COV_LOG_RANGE);
}
function normCovVector(cov6) {
  const diag = new Set([0, 3, 5]);
  return cov6.map((v, i) => normCovElement(v, diag.has(i)));
}
function relativeInclinationFeature(inc1, inc2, raanDiff = 0) {
  const i1 = inc1 * Math.PI / 180, i2 = inc2 * Math.PI / 180;
  const dr = raanDiff * Math.PI / 180;
  const cosIM = Math.cos(i1)*Math.cos(i2) + Math.sin(i1)*Math.sin(i2)*Math.cos(dr);
  return Math.acos(Math.min(1, Math.max(-1, cosIM))) / Math.PI;
}
function normAltitude(alt) {
  const c = Math.min(Math.max(alt, NORM.ALT_MIN_KM), NORM.ALT_MAX_KM);
  return (c - NORM.ALT_MIN_KM) / (NORM.ALT_MAX_KM - NORM.ALT_MIN_KM);
}
function normBstar(b) {
  const c = Math.min(Math.max(b, -NORM.BSTAR_CLIP), NORM.BSTAR_CLIP);
  return (c + NORM.BSTAR_CLIP) / (2 * NORM.BSTAR_CLIP);
}
function normTLEAge(d) {
  return Math.min(Math.max(d, 0), NORM.TLE_AGE_MAX_DAYS) / NORM.TLE_AGE_MAX_DAYS;
}

function buildFeatureVector(c) {
  const hasCov = c.mahalanobisDistance !== null && c.combinedCovBplane !== null;
  const covF = hasCov ? normCovVector(c.combinedCovBplane) : [0,0,0,0,0,0];
  return [
    normMissDistance(c.missDistanceKm),
    normRelVelocity(c.relVelocityKms),
    normMahalanobis(hasCov ? c.mahalanobisDistance : null),
    ...covF,
    relativeInclinationFeature(c.incPrimaryDeg, c.incSecondaryDeg, c.raanDiffDeg || 0),
    normAltitude(c.altPrimaryKm),
    normAltitude(c.altSecondaryKm),
    normBstar(c.bstarPrimary),
    normTLEAge(c.tleAgeDays),
    c.isDebris ? 1 : 0,
  ];
}

// ---------------------------------------------------------------------------
// Training utilities
// ---------------------------------------------------------------------------

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function groupedSplit(records, trainFrac = 0.8, valFrac = 0.1) {
  const byEvent = {};
  for (const r of records) {
    const id = r.cdmId ?? r.eventId ?? r.id;
    (byEvent[id] = byEvent[id] || []).push(r);
  }
  const eventIds = shuffle(Object.keys(byEvent));
  const n = eventIds.length;
  const tEnd = Math.floor(n * trainFrac);
  const vEnd = Math.floor(n * (trainFrac + valFrac));
  const trainIds = new Set(eventIds.slice(0, tEnd));
  const valIds   = new Set(eventIds.slice(tEnd, vEnd));
  const getId = r => r.cdmId ?? r.eventId ?? r.id;
  return {
    train: records.filter(r => trainIds.has(getId(r))),
    val:   records.filter(r => valIds.has(getId(r))),
    test:  records.filter(r => !trainIds.has(getId(r)) && !valIds.has(getId(r))),
  };
}

function computeClassWeights(labels) {
  const nPos = labels.reduce((s, l) => s + l, 0);
  const nNeg = labels.length - nPos;
  if (nPos === 0 || nNeg === 0) return { 0: 1, 1: 1 };
  const total = labels.length;
  return { 0: total / (2 * nNeg), 1: total / (2 * nPos) };
}

function computeMetrics(preds, labels, threshold = 0.5) {
  let tp=0, fp=0, fn=0, tn=0;
  for (let i = 0; i < labels.length; i++) {
    const p = preds[i] >= threshold ? 1 : 0;
    if (p===1 && labels[i]===1) tp++;
    else if (p===1 && labels[i]===0) fp++;
    else if (p===0 && labels[i]===1) fn++;
    else tn++;
  }
  const prec = tp+fp>0 ? tp/(tp+fp) : 0;
  const rec  = tp+fn>0 ? tp/(tp+fn) : 0;
  const f1   = prec+rec>0 ? 2*prec*rec/(prec+rec) : 0;
  return { precision: prec, recall: rec, f1, tp, fp, fn, tn };
}

// ---------------------------------------------------------------------------
// Custom filesystem IOHandler (replaces file:// which requires tfjs-node)
// ---------------------------------------------------------------------------

function fileSystemSaveHandler(modelDir) {
  mkdirSync(modelDir, { recursive: true });

  return {
    async save(modelArtifacts) {
      const weightData = modelArtifacts.weightData;
      const weightBuf = Buffer.from(
        weightData instanceof ArrayBuffer ? weightData : weightData.buffer
      );
      const weightsPath = join(modelDir, 'group1-shard1of1.bin');
      writeFileSync(weightsPath, weightBuf);

      const modelJSON = {
        modelTopology: modelArtifacts.modelTopology,
        weightsManifest: [{
          paths: ['group1-shard1of1.bin'],
          weights: modelArtifacts.weightSpecs,
        }],
        format: modelArtifacts.format,
        generatedBy: modelArtifacts.generatedBy,
        convertedBy: modelArtifacts.convertedBy,
      };
      if (modelArtifacts.trainingConfig) {
        modelJSON.trainingConfig = modelArtifacts.trainingConfig;
      }

      const modelPath = join(modelDir, 'poc-model.json');
      writeFileSync(modelPath, JSON.stringify(modelJSON, null, 2));

      return {
        modelArtifactsInfo: {
          dateSaved: new Date(),
          modelTopologyType: 'JSON',
          weightDataBytes: weightBuf.length,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Main training pipeline
// ---------------------------------------------------------------------------

async function main() {
  console.info('=== NovaSentinel PoC Model Training ===\n');

  // 1. Load or generate data
  const dataPath = join(ROOT, 'data', 'cara-events.json');
  if (!existsSync(dataPath)) {
    console.info('[train] No data found — fetching real CDMs from Space-Track...');
    execSync(`node "${join(ROOT, 'scripts', 'fetchRealCDMs.js')}"`, { stdio: 'inherit' });
  }

  const rawData = JSON.parse(readFileSync(dataPath, 'utf-8'));
  console.info(`[train] Loaded ${rawData.length} conjunction events\n`);

  // 2. Build feature vectors
  const features = rawData.map(buildFeatureVector);
  const labels   = rawData.map(r => r.label);

  // 3. Grouped split
  const indexedRecords = rawData.map((r, i) => ({ ...r, _idx: i }));
  const splits = groupedSplit(indexedRecords);

  const trainX = splits.train.map(r => features[r._idx]);
  const trainY = splits.train.map(r => labels[r._idx]);
  const valX   = splits.val.map(r => features[r._idx]);
  const valY   = splits.val.map(r => labels[r._idx]);
  const testX  = splits.test.map(r => features[r._idx]);
  const testY  = splits.test.map(r => labels[r._idx]);

  console.info(`[train] Split: ${trainX.length} train / ${valX.length} val / ${testX.length} test`);

  // 4. Class weights
  const classWeights = computeClassWeights(trainY);
  console.info(`[train] Class weights: neg=${classWeights[0].toFixed(2)}, pos=${classWeights[1].toFixed(2)}\n`);

  // 5. Create tensors
  const xTrain = tf.tensor2d(trainX);
  const yTrain = tf.tensor2d(trainY, [trainY.length, 1]);
  const xVal   = tf.tensor2d(valX);
  const yVal   = tf.tensor2d(valY, [valY.length, 1]);

  // 6. Build model with weighted binary cross-entropy loss
  // (sampleWeight is not supported in tfjs pure-JS, so we embed weights in the loss)
  const posWeight = classWeights[1];
  const negWeight = classWeights[0];

  function weightedBCE(yTrue, yPred) {
    // Clamp predictions to avoid log(0)
    const eps = 1e-7;
    const clipped = yPred.clipByValue(eps, 1 - eps);
    // Weighted binary cross-entropy
    const posLoss = yTrue.mul(clipped.log()).mul(posWeight);
    const negLoss = yTrue.mul(-1).add(1).mul(tf.sub(1, clipped).log()).mul(negWeight);
    return posLoss.add(negLoss).mul(-1).mean();
  }

  const model = tf.sequential({ name: 'poc-collision-model' });
  model.add(tf.layers.dense({
    inputShape: [NORM.NUM_FEATURES], units: 64, activation: 'relu',
    kernelInitializer: 'heNormal', name: 'dense_1',
  }));
  model.add(tf.layers.dropout({ rate: 0.2, name: 'dropout_1' }));
  model.add(tf.layers.dense({
    units: 32, activation: 'relu',
    kernelInitializer: 'heNormal', name: 'dense_2',
  }));
  model.add(tf.layers.dropout({ rate: 0.1, name: 'dropout_2' }));
  model.add(tf.layers.dense({ units: 1, activation: 'sigmoid', name: 'output' }));

  model.compile({
    optimizer: tf.train.adam(1e-3),
    loss: weightedBCE,
    metrics: ['accuracy'],
  });

  model.summary();

  // 7. Train with early stopping
  console.info('\n[train] Starting training...\n');
  let bestValLoss = Infinity;
  let patience = 10;
  let wait = 0;
  const EPOCHS = 50;
  const BATCH = 64;

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const history = await model.fit(xTrain, yTrain, {
      epochs: 1,
      batchSize: BATCH,
      validationData: [xVal, yVal],
      verbose: 0,
    });

    const tLoss = history.history.loss[0].toFixed(4);
    const vLoss = history.history.val_loss[0].toFixed(4);
    const tAcc  = history.history.acc[0].toFixed(4);
    const vAcc  = history.history.val_acc[0].toFixed(4);

    if ((epoch + 1) % 5 === 0 || epoch === 0) {
      console.info(
        `  Epoch ${String(epoch+1).padStart(3)}: ` +
        `loss=${tLoss}  val_loss=${vLoss}  acc=${tAcc}  val_acc=${vAcc}`
      );
    }

    const currentValLoss = history.history.val_loss[0];
    if (currentValLoss < bestValLoss) {
      bestValLoss = currentValLoss;
      wait = 0;
    } else {
      wait++;
      if (wait >= patience) {
        console.info(`\n[train] Early stopping at epoch ${epoch+1} (patience=${patience})`);
        break;
      }
    }
  }

  // 9. Evaluate on test set
  console.info('\n[train] Evaluating on test set...\n');
  const xTest = tf.tensor2d(testX);
  const predTensor = model.predict(xTest);
  const predValues = await predTensor.data();

  const metrics = computeMetrics(Array.from(predValues), testY, 0.5);
  console.info(`  Precision: ${metrics.precision.toFixed(4)}`);
  console.info(`  Recall:    ${metrics.recall.toFixed(4)}`);
  console.info(`  F1 Score:  ${metrics.f1.toFixed(4)}`);
  console.info(`  TP=${metrics.tp}  FP=${metrics.fp}  FN=${metrics.fn}  TN=${metrics.tn}`);

  const metricsLow = computeMetrics(Array.from(predValues), testY, 0.3);
  console.info(`\n  At threshold 0.3:`);
  console.info(`  Precision: ${metricsLow.precision.toFixed(4)}`);
  console.info(`  Recall:    ${metricsLow.recall.toFixed(4)}`);
  console.info(`  F1 Score:  ${metricsLow.f1.toFixed(4)}`);

  // 10. Save model
  const modelDir = join(ROOT, 'public', 'model');
  await model.save(fileSystemSaveHandler(modelDir));
  console.info(`\n[train] Model saved to ${modelDir}`);
  console.info('[train] Files: poc-model.json + group1-shard1of1.bin');

  // Cleanup
  xTrain.dispose(); yTrain.dispose();
  xVal.dispose(); yVal.dispose();
  xTest.dispose(); predTensor.dispose();

  console.info('\n=== Training complete ===');
}

main().catch(err => {
  console.error('[train] Fatal error:', err);
  process.exit(1);
});
