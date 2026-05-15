// Training utilities — shared between Node.js offline training and (optional)
// browser-side fine-tuning.
//
// Key functions:
//   - groupedSplit()       — splits by conjunction event ID (no data leakage)
//   - computeClassWeights() — handles severe class imbalance
//   - shuffle()            — Fisher-Yates in-place shuffle
//   - computeMetrics()     — precision / recall / F1

// ---------------------------------------------------------------------------
// Grouped K-fold split (per Tsaprailis et al. [7])
// ---------------------------------------------------------------------------

/**
 * Splits conjunction records into train/val/test sets by event ID.
 *
 * @param {Object[]} records     Each must have cdmId / eventId / id.
 * @param {number}   trainFrac   Training fraction (default 0.8).
 * @param {number}   valFrac     Validation fraction (default 0.1).
 * @returns {{ train: Object[], val: Object[], test: Object[] }}
 */
export function groupedSplit(records, trainFrac = 0.8, valFrac = 0.1) {
  const byEvent = {};
  for (const r of records) {
    const id = r.cdmId ?? r.eventId ?? r.id;
    (byEvent[id] = byEvent[id] || []).push(r);
  }

  const eventIds = Object.keys(byEvent);
  shuffle(eventIds);

  const n        = eventIds.length;
  const trainEnd = Math.floor(n * trainFrac);
  const valEnd   = Math.floor(n * (trainFrac + valFrac));

  const trainIds = new Set(eventIds.slice(0, trainEnd));
  const valIds   = new Set(eventIds.slice(trainEnd, valEnd));

  return {
    train: records.filter(r => trainIds.has(r.cdmId ?? r.eventId ?? r.id)),
    val:   records.filter(r => valIds.has(r.cdmId ?? r.eventId ?? r.id)),
    test:  records.filter(r => {
      const id = r.cdmId ?? r.eventId ?? r.id;
      return !trainIds.has(id) && !valIds.has(id);
    }),
  };
}

// ---------------------------------------------------------------------------
// Class weighting
// ---------------------------------------------------------------------------

/**
 * Computes inverse-frequency class weights for binary labels.
 *
 * @param {number[]} labels  Binary labels (0 or 1).
 * @returns {{ 0: number, 1: number }}
 */
export function computeClassWeights(labels) {
  const nPos = labels.reduce((s, l) => s + l, 0);
  const nNeg = labels.length - nPos;

  if (nPos === 0 || nNeg === 0) {
    return { 0: 1, 1: 1 };
  }

  const total = labels.length;
  return {
    0: total / (2 * nNeg),
    1: total / (2 * nPos),
  };
}

// ---------------------------------------------------------------------------
// Fisher-Yates shuffle
// ---------------------------------------------------------------------------

/**
 * In-place Fisher-Yates shuffle.
 * @param {any[]} arr
 * @returns {any[]}
 */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Computes precision, recall, F1 from continuous predictions and binary labels.
 *
 * @param {number[]} predictions  Model outputs (0–1).
 * @param {number[]} labels       Ground truth (0 or 1).
 * @param {number}   threshold    Classification threshold (default 0.5).
 * @returns {{ precision: number, recall: number, f1: number, tp: number, fp: number, fn: number, tn: number }}
 */
export function computeMetrics(predictions, labels, threshold = 0.5) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < labels.length; i++) {
    const pred  = predictions[i] >= threshold ? 1 : 0;
    const label = labels[i];
    if (pred === 1 && label === 1) tp++;
    else if (pred === 1 && label === 0) fp++;
    else if (pred === 0 && label === 1) fn++;
    else tn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall    = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1        = precision + recall > 0
    ? 2 * precision * recall / (precision + recall) : 0;
  return { precision, recall, f1, tp, fp, fn, tn };
}
