// Conjunction alert panel — right-side overlay
//
// Renders a scrollable list of CDM conjunction events filtered by the
// operator-configured PoC threshold. Each row shows:
//   NORAD IDs, object names, TCA, miss distance, PoC score badge
//
// Controls wired by this module:
//   #threshold-slider  — log slider  1e-6 / 1e-5 / 1e-4
//   #filter-debris     — checkbox    show/hide DEBRIS secondaries
//   #filter-payload    — checkbox    show/hide PAYLOAD secondaries
//   #ellipsoid-toggle  — switch      show/hide CDM uncertainty ellipsoids
//   #export-csv-btn    — button      trigger CSV download
//
// The panel is pure DOM — no Three.js dependency. Emits custom events
// on document for other modules to listen to.

import { pocToCSS, pocToTier } from '../viz/riskColors.js';
import { exportAlertsCSV }     from './exportCSV.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Currently visible CDM records (after filter). */
let _currentRecords = [];

/** Active PoC threshold. */
let _pocThreshold = 1e-4;

/** Whether to show debris secondaries. */
let _showDebris = true;

/** Whether to show payload secondaries. */
let _showPayload = true;

/** Callback: (cdmRecord) → void when a row is clicked. */
let _onSelect = null;

// ---------------------------------------------------------------------------
// DOM references (resolved lazily on first render)
// ---------------------------------------------------------------------------

let _listEl      = null;
let _countEl     = null;
let _threshEl    = null;
let _threshLabel = null;
let _debrisEl    = null;
let _payloadEl   = null;

function _resolve() {
  _listEl      = _listEl      ?? document.getElementById('alert-list');
  _countEl     = _countEl     ?? document.getElementById('alert-count');
  _threshEl    = _threshEl    ?? document.getElementById('threshold-slider');
  _threshLabel = _threshLabel ?? document.getElementById('threshold-label');
  _debrisEl    = _debrisEl    ?? document.getElementById('filter-debris');
  _payloadEl   = _payloadEl   ?? document.getElementById('filter-payload');
}

// ---------------------------------------------------------------------------
// Threshold tick marks (McKnight et al. [6] operational levels)
// ---------------------------------------------------------------------------

const THRESHOLD_TICKS = [1e-6, 1e-5, 1e-4, 1e-3];
const THRESHOLD_LABELS = ['10⁻⁶', '10⁻⁵', '10⁻⁴', '10⁻³'];

function _sliderToThreshold(val) {
  const idx = Math.round(parseFloat(val));
  return THRESHOLD_TICKS[Math.min(idx, THRESHOLD_TICKS.length - 1)];
}

function _thresholdToLabel(poc) {
  const idx = THRESHOLD_TICKS.indexOf(poc);
  return idx >= 0 ? `PoC ≥ ${THRESHOLD_LABELS[idx]}` : `PoC ≥ ${poc.toExponential(0)}`;
}

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------

function _buildRow(rec, index) {
  const poc     = parseFloat(rec.PC ?? 'NaN') || null;
  const tier    = pocToTier(poc);
  const color   = pocToCSS(poc);
  const miss    = parseFloat(rec.MISS_DISTANCE ?? 'NaN');
  const missStr = isFinite(miss) ? `${miss.toFixed(1)} km` : '—';
  const tca     = rec.TCA ? new Date(rec.TCA).toUTCString().replace('GMT', 'UTC') : '—';
  const pocStr  = poc != null ? poc.toExponential(2) : 'N/A';
  const sat1    = rec.SAT1_OBJECT_NAME ?? rec.SAT1_OBJECT_DESIGNATOR ?? `#${rec.SAT1_NORAD_CAT_ID ?? '?'}`;
  const sat2    = rec.SAT2_OBJECT_NAME ?? rec.SAT2_OBJECT_DESIGNATOR ?? `#${rec.SAT2_NORAD_CAT_ID ?? '?'}`;

  const row = document.createElement('div');
  row.className    = `alert-row tier-${tier.toLowerCase()}`;
  row.dataset.idx  = index;
  row.dataset.cdmId = rec.CDM_ID ?? '';
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-label', `Conjunction ${sat1} vs ${sat2}, risk ${tier}`);

  row.innerHTML = `
    <div class="alert-tier-bar" style="background:${color}"></div>
    <div class="alert-body">
      <div class="alert-names">
        <span class="alert-sat primary" title="Primary">${sat1}</span>
        <span class="alert-vs">⟺</span>
        <span class="alert-sat secondary" title="Secondary">${sat2}</span>
      </div>
      <div class="alert-meta">
        <span class="alert-meta-item" title="Time of Closest Approach">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          ${tca.split(',')[1]?.trim() ?? tca}
        </span>
        <span class="alert-meta-item" title="Miss Distance">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          ${missStr}
        </span>
      </div>
      <div class="alert-poc-row">
        <span class="alert-poc-badge" style="background:${color}22;color:${color};border-color:${color}55">
          ${pocStr}
        </span>
        <span class="alert-tier-label" style="color:${color}">${tier}</span>
      </div>
    </div>
  `;

  row.addEventListener('click',  () => _handleSelect(rec, row));
  row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') _handleSelect(rec, row); });

  return row;
}

function _handleSelect(rec, rowEl) {
  // Highlight selected row
  document.querySelectorAll('.alert-row.selected').forEach(r => r.classList.remove('selected'));
  rowEl.classList.add('selected');

  // Emit event for cameraControls.js to consume
  document.dispatchEvent(new CustomEvent('novasentinel:conjunction-select', { detail: rec }));
  if (_onSelect) _onSelect(rec);
}

// ---------------------------------------------------------------------------
// Filter logic
// ---------------------------------------------------------------------------

function _filterRecords(records) {
  return records.filter(rec => {
    const poc  = parseFloat(rec.PC ?? 'NaN') || 0;
    if (poc < _pocThreshold) return false;

    const type = (rec.SAT2_OBJECT_TYPE ?? '').toUpperCase();
    if (!_showDebris  && type.includes('DEBRIS'))  return false;
    if (!_showPayload && type.includes('PAYLOAD'))  return false;

    return true;
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function _render() {
  _resolve();
  if (!_listEl) return;

  const filtered = _filterRecords(_currentRecords);

  // Sorted: highest PoC first
  filtered.sort((a, b) => {
    const pA = parseFloat(a.PC ?? 'NaN') || 0;
    const pB = parseFloat(b.PC ?? 'NaN') || 0;
    return pB - pA;
  });

  _listEl.innerHTML = '';

  if (filtered.length === 0) {
    _listEl.innerHTML = `
      <div class="alert-empty">
        <div class="alert-empty-icon">✓</div>
        <div>No conjunctions above threshold</div>
      </div>`;
  } else {
    filtered.forEach((rec, i) => _listEl.appendChild(_buildRow(rec, i)));
  }

  if (_countEl) {
    _countEl.textContent = `${filtered.length} event${filtered.length !== 1 ? 's' : ''}`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wires up the alert panel controls and renders the initial (empty) state.
 *
 * @param {{
 *   onSelect?: (cdmRecord: object) => void,
 *   onThresholdChange?: (poc: number) => void,
 *   onEllipsoidToggle?: (visible: boolean) => void,
 * }} [callbacks]
 */
export function initAlertPanel(callbacks = {}) {
  _resolve();
  _onSelect = callbacks.onSelect ?? null;

  // ── Threshold slider ─────────────────────────────────────────────────────
  if (_threshEl) {
    _threshEl.min   = '0';
    _threshEl.max   = String(THRESHOLD_TICKS.length - 1);
    _threshEl.step  = '1';
    _threshEl.value = String(THRESHOLD_TICKS.indexOf(_pocThreshold));

    _threshEl.addEventListener('input', () => {
      _pocThreshold = _sliderToThreshold(_threshEl.value);
      if (_threshLabel) _threshLabel.textContent = _thresholdToLabel(_pocThreshold);
      _render();
      if (callbacks.onThresholdChange) callbacks.onThresholdChange(_pocThreshold);
    });

    if (_threshLabel) _threshLabel.textContent = _thresholdToLabel(_pocThreshold);
  }

  // ── Object type filters ───────────────────────────────────────────────────
  if (_debrisEl) {
    _debrisEl.addEventListener('change', () => {
      _showDebris = _debrisEl.checked;
      _render();
    });
  }
  if (_payloadEl) {
    _payloadEl.addEventListener('change', () => {
      _showPayload = _payloadEl.checked;
      _render();
    });
  }

  // ── Ellipsoid toggle ─────────────────────────────────────────────────────
  const ellipsoidToggle = document.getElementById('ellipsoid-toggle');
  if (ellipsoidToggle) {
    let visible = true;
    ellipsoidToggle.addEventListener('change', () => {
      visible = ellipsoidToggle.checked;
      document.dispatchEvent(
        new CustomEvent('novasentinel:ellipsoid-toggle', { detail: { visible } })
      );
      if (callbacks.onEllipsoidToggle) callbacks.onEllipsoidToggle(visible);
    });
  }

  // ── Export button ─────────────────────────────────────────────────────────
  const exportBtn = document.getElementById('export-csv-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      exportAlertsCSV(_filterRecords(_currentRecords));
    });
  }

  _render();
}

/**
 * Updates the panel with a new set of CDM records.
 * Automatically re-applies current threshold + filters.
 *
 * @param {object[]} cdmRecords  Raw CDM JSON records.
 */
export function updateAlertPanel(cdmRecords) {
  _currentRecords = cdmRecords ?? [];
  _render();
}

/**
 * Returns the active PoC threshold value.
 * @returns {number}
 */
export function getActiveThreshold() {
  return _pocThreshold;
}
