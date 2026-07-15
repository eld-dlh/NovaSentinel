// Browser-side model loading and inference
//
// Loads a pre-trained TensorFlow.js model from bundled JSON weights or from
// localStorage.  All inference runs on the client GPU via the WebGL backend —
// no Python server required.
//
// Usage:
//   import { loadModel, inferPoC, batchInferPoC } from './ml/inference.js';
//   const model = await loadModel();
//   const score = await inferPoC(model, featureVector);      // single
//   const scores = await batchInferPoC(model, allFeatures);  // batch

import * as tf from '@tensorflow/tfjs';
import { NORM } from './normConstants.js';

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

/** Default path to the bundled model manifest (served by Vite from /public). */
const DEFAULT_MODEL_URL = '/model/poc-model.json';

/** localStorage key used by model.save('localstorage://poc-model'). */
const LS_MODEL_KEY = 'localstorage://poc-model';

/**
 * Loads the pre-trained PoC model.  Tries bundled weights first, then
 * falls back to localStorage (useful after in-browser fine-tuning).
 *
 * @param {Object}  [opts]
 * @param {string}  [opts.modelUrl]      Override URL for the model manifest.
 * @param {boolean} [opts.preferLocal]   If true, try localStorage first.
 * @returns {Promise<tf.LayersModel>}    Loaded model ready for predict().
 */
export async function loadModel({ modelUrl, preferLocal = false } = {}) {
  // Ensure WebGL backend is ready
  await tf.ready();
  console.info(`[inference] TF.js backend: ${tf.getBackend()}`);

  // Attempt localStorage first if requested
  if (preferLocal) {
    try {
      const localModel = await tf.loadLayersModel(LS_MODEL_KEY);
      console.info('[inference] Model loaded from localStorage');
      return localModel;
    } catch {
      console.info('[inference] No localStorage model — falling back to bundled weights');
    }
  }

  // Load from bundled weights (public/model/)
  const url = modelUrl ?? DEFAULT_MODEL_URL;
  try {
    const model = await tf.loadLayersModel(url);
    console.info(`[inference] Model loaded from ${url}`);
    return model;
  } catch (err) {
    // Final fallback: try localStorage
    try {
      const localModel = await tf.loadLayersModel(LS_MODEL_KEY);
      console.info('[inference] Bundled model failed — loaded from localStorage fallback');
      return localModel;
    } catch {
      throw new Error(
        `[inference] Failed to load model from both ${url} and localStorage: ${err.message}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Single-conjunction inference
// ---------------------------------------------------------------------------

/**
 * Predicts collision probability for a single conjunction.
 *
 * @param {tf.LayersModel} model         Loaded PoC model.
 * @param {number[]}       featureVector 15-element normalised feature vector.
 * @returns {Promise<number>}            Collision probability score [0, 1].
 */
export async function inferPoC(model, featureVector) {
  const inputTensor  = tf.tensor2d([featureVector], [1, NORM.NUM_FEATURES]);
  const outputTensor = model.predict(inputTensor);
  const [score]      = await outputTensor.data();

  // Eager disposal to prevent GPU memory leaks
  inputTensor.dispose();
  outputTensor.dispose();

  return score;
}

// ---------------------------------------------------------------------------
// Batch inference (GPU-efficient)
// ---------------------------------------------------------------------------

/**
 * Predicts collision probability for multiple conjunctions in a single
 * forward pass.  This is significantly faster than calling inferPoC() in a
 * loop because it batches all feature vectors into one tensor — the GPU
 * processes them in parallel.
 *
 * @param {tf.LayersModel} model           Loaded PoC model.
 * @param {number[][]}     featureVectors  Array of 15-element feature vectors.
 * @returns {Promise<number[]>}            Array of collision probability scores.
 */
export async function batchInferPoC(model, featureVectors) {
  if (!featureVectors.length) return [];

  const inputTensor  = tf.tensor2d(featureVectors, [featureVectors.length, NORM.NUM_FEATURES]);
  const outputTensor = model.predict(inputTensor);
  const scores       = await outputTensor.data();

  inputTensor.dispose();
  outputTensor.dispose();

  return Array.from(scores);
}

// ---------------------------------------------------------------------------
// Model persistence helpers
// ---------------------------------------------------------------------------

/**
 * Saves the current model to localStorage for offline use or after
 * in-browser fine-tuning.
 *
 * @param {tf.LayersModel} model  Model to save.
 * @returns {Promise<void>}
 */
export async function saveModelToLocalStorage(model) {
  await model.save(LS_MODEL_KEY);
  console.info('[inference] Model saved to localStorage');
}

/**
 * Disposes the model and frees GPU memory.
 * Call this when the model is no longer needed (e.g. page unload).
 *
 * @param {tf.LayersModel} model
 */
export function disposeModel(model) {
  if (model) {
    model.dispose();
    console.info('[inference] Model disposed');
  }
}
