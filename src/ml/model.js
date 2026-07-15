// PoC regression model — architecture definition + compile
//
// A 3-layer dense network maps the 15-feature normalised conjunction vector
// to a single sigmoid output in [0, 1] representing collision probability.
//
// Architecture:
//   Input(15) → Dense(64, ReLU) → Dropout(0.2) → Dense(32, ReLU)
//   → Dropout(0.1) → Dense(1, Sigmoid)
//
// The model is trained offline in Node.js (scripts/trainModel.js) and
// exported as JSON + binary weights for browser inference via WebGL.

import * as tf from '@tensorflow/tfjs';
import { NORM } from './normConstants.js';

/**
 * Builds and compiles the collision probability regression model.
 *
 * @param {Object} [opts]
 * @param {number} [opts.learningRate=1e-3]  Adam optimiser learning rate.
 * @param {number} [opts.inputDim]           Override input dimension (default: NORM.NUM_FEATURES).
 * @returns {tf.Sequential}  Compiled TensorFlow.js model ready for training or inference.
 */
export function buildPoCModel({ learningRate = 1e-3, inputDim } = {}) {
  const features = inputDim ?? NORM.NUM_FEATURES;

  const model = tf.sequential({ name: 'poc-collision-model' });

  // Layer 1 — feature extraction
  model.add(tf.layers.dense({
    inputShape: [features],
    units:      64,
    activation: 'relu',
    kernelInitializer: 'heNormal',
    name: 'dense_1',
  }));
  model.add(tf.layers.dropout({ rate: 0.2, name: 'dropout_1' }));

  // Layer 2 — intermediate representation
  model.add(tf.layers.dense({
    units:      32,
    activation: 'relu',
    kernelInitializer: 'heNormal',
    name: 'dense_2',
  }));
  model.add(tf.layers.dropout({ rate: 0.1, name: 'dropout_2' }));

  // Output — single sigmoid neuron (collision probability 0–1)
  model.add(tf.layers.dense({
    units:      1,
    activation: 'sigmoid',
    name: 'output',
  }));

  model.compile({
    optimizer: tf.train.adam(learningRate),
    loss:      'binaryCrossentropy',
    metrics:   ['accuracy'],
  });

  return model;
}
