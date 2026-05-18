// Brain.js LSTMTimeStep orbital-decay model
//
// Trains on sequences of normalised mean-motion values (no_kozai, rad/min)
// and predicts the next `steps` values, which are then converted back to
// altitude (km) for display and alerting.
//
// Why Brain.js instead of the existing TF.js model?
//  - LSTMTimeStep is purpose-built for univariate time-step sequences and
//    requires zero data-labelling: the sequence itself is both input + target.
//  - B* (used in the TF.js collision model) is a noisy single-point estimate.
//    A recurrent sequence over 10 TLE epochs captures the actual decay trend.
//  - Brain.js runs fully in the browser (no WebGL required) — lightweight for
//    the short sequences and small hidden layers used here.
//
// References:
//  - Liu et al. [9]: multi-epoch trajectory preferred over single B* estimate.
//  - Brain.js docs: LSTMTimeStep input shape → [[n], [n], ...] (each step is
//    an array of `inputSize` numbers).

import { LSTMTimeStep } from 'brain.js';
import { meanMotionToAlt } from './sequences.js';

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

// Approximate max mean motion for a circular LEO orbit at ~150 km altitude.
// no_kozai for ISS (~410 km) ≈ 0.00113 rad/min; upper LEO bound ≈ 0.015 rad/min.
// We normalise to [0, 1] over this physical range.
export const NO_KOZAI_NORM = 0.015;   // rad/min — normalisation denominator

/**
 * Normalises a no_kozai value to [0, 1].
 * @param {number} n  rad/min
 * @returns {number}
 */
export function normalise(n) {
  return Math.min(1, Math.max(0, n / NO_KOZAI_NORM));
}

/**
 * Denormalises a [0,1] network output back to rad/min.
 * @param {number} v  Normalised value
 * @returns {number}  rad/min
 */
export function denormalise(v) {
  return v * NO_KOZAI_NORM;
}

// ---------------------------------------------------------------------------
// Model factory
// ---------------------------------------------------------------------------

/**
 * Creates a new (untrained) LSTMTimeStep network with the recommended
 * architecture for orbital decay prediction.
 *
 * hiddenLayers [8, 4] is intentionally small to:
 *  a) avoid overfitting on the short (~10 point) sequences,
 *  b) keep browser-side training time under 3 seconds for ~500 iterations.
 *
 * @returns {LSTMTimeStep}
 */
export function createDecayNet() {
  return new LSTMTimeStep({
    inputSize:    1,
    hiddenLayers: [8, 4],
    outputSize:   1,
  });
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

/**
 * Trains the LSTMTimeStep network on all per-object decay sequences.
 *
 * Each sequence is a 2-D array of shape [seqLen][1] — one scalar per time
 * step. Brain.js infers the "next step" target internally from the sequence.
 *
 * @param {import('./sequences.js').DecaySequence[]} sequences
 * @param {object} [opts]
 * @param {number} [opts.iterations=500]
 * @param {number} [opts.learningRate=0.01]
 * @param {boolean} [opts.log=false]
 * @param {Function} [opts.onProgress]   Called each iteration: ({ iterations, error })
 * @returns {{ net: LSTMTimeStep, trainLog: { iterations: number, error: number } }}
 */
export function trainDecayModel(sequences, {
  iterations   = 500,
  learningRate = 0.01,
  log          = false,
  onProgress   = null,
} = {}) {
  const net = createDecayNet();

  // Convert each sequence to normalised [[v], [v], ...] format
  const data = sequences.map(seq =>
    seq.points.map(pt => [normalise(pt.meanMotion)])
  );

  if (data.length === 0) {
    console.warn('[decayModel] No training sequences — model untrained.');
    return { net, trainLog: { iterations: 0, error: Infinity } };
  }

  const logCallback = onProgress
    ? (detail) => onProgress(detail)
    : (log ? (d) => console.log(`[decayModel] iter=${d.iterations} err=${d.error.toFixed(6)}`) : undefined);

  const trainLog = net.train(data, {
    iterations,
    learningRate,
    log:     !!logCallback,
    logPeriod: 50,
    callbackPeriod: onProgress ? 50 : undefined,
    callback: logCallback,
  });

  console.info(
    `[decayModel] Training complete — ` +
    `${sequences.length} sequences, ` +
    `${trainLog.iterations} iterations, ` +
    `final error=${trainLog.error?.toFixed(6) ?? 'N/A'}`
  );

  return { net, trainLog };
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/**
 * Predicts the next `steps` altitudes (km) from the most recent window of
 * mean-motion values using the trained LSTMTimeStep network.
 *
 * Brain.js LSTMTimeStep.run() accepts the seed sequence and returns ONE next
 * step.  For multi-step forecasting we feed back each prediction autoregressively.
 *
 * @param {LSTMTimeStep}                             net        Trained network.
 * @param {import('./sequences.js').DecayPoint[]}    recentSeq  Last N data points.
 * @param {number}                                   steps      Horizon (default 3).
 * @returns {PredictedStep[]}
 *
 * @typedef {Object} PredictedStep
 * @property {number} step      1-indexed step number
 * @property {number} meanMotion  Predicted mean motion (rad/min)
 * @property {number} altitude    Predicted altitude (km)
 */
export function predictDecay(net, recentSeq, steps = 3) {
  // Build the seed: normalised [[v], [v], ...]
  let seed = recentSeq.map(pt => [normalise(pt.meanMotion)]);

  const predictions = [];

  for (let s = 1; s <= steps; s++) {
    // run() returns a single output step: [v]  (outputSize === 1)
    const output     = net.run(seed);
    const normVal    = Array.isArray(output) ? output[0] : output;
    const rawMM      = denormalise(normVal);
    const alt        = meanMotionToAlt(rawMM);

    predictions.push({ step: s, meanMotion: rawMM, altitude: alt });

    // Feed the prediction back as the next seed point (autoregressive)
    seed = [...seed.slice(1), [normVal]];
  }

  return predictions;
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

/**
 * Serialises a trained network to a plain JSON object for
 * localStorage persistence or export.
 *
 * @param {LSTMTimeStep} net
 * @returns {object}
 */
export function serializeDecayNet(net) {
  return net.toJSON();
}

/**
 * Restores a previously serialised decay network.
 *
 * @param {object} json
 * @returns {LSTMTimeStep}
 */
export function deserializeDecayNet(json) {
  const net = createDecayNet();
  net.fromJSON(json);
  return net;
}
