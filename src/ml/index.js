// ML module — public API re-exports
//
// Import everything you need from one place:
//   import { loadModel, inferPoC, buildFeatureVector } from './ml/index.js';

export { NORM }                                          from './normConstants.js';
export { buildFeatureVector }                            from './features.js';
export { buildPoCModel }                                 from './model.js';
export { loadModel, inferPoC, batchInferPoC,
         saveModelToLocalStorage, disposeModel }         from './inference.js';
export { groupedSplit, computeClassWeights,
         shuffle, computeMetrics }                       from './train.js';
