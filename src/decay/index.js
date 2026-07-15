// decay/ module — public API re-exports
//
// Usage:
//   import {
//     buildDecaySequences, meanMotionToAlt,
//     trainDecayModel, predictDecay, serializeDecayNet, deserializeDecayNet,
//     detectReentryThreats, buildReentryAlerts, REENTRY_SEVERITY,
//   } from './decay/index.js';

export {
  buildDecaySequences,
  meanMotionToAlt,
  epochToDate,
}                                         from './sequences.js';

export {
  NO_KOZAI_NORM,
  normalise,
  denormalise,
  createDecayNet,
  trainDecayModel,
  predictDecay,
  serializeDecayNet,
  deserializeDecayNet,
}                                         from './decayModel.js';

export {
  REENTRY_SEVERITY,
  altitudeToSeverity,
  buildReentryAlerts,
  detectReentryThreats,
}                                         from './reentryAlert.js';
