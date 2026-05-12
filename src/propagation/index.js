// Propagation barrel export
//
// Re-exports all public APIs from the propagation subsystem so consumers
// can import from a single path:
//
//   import { propagateNow, createPropagator } from './propagation/index.js';

export {
  propagateNow,
  propagateAt,
  propagateBatch,
  sgp4ErrorMessage,
} from './propagate.js';

export {
  createPropagator,
  propagateCatalogue,
} from './batchPropagator.js';
