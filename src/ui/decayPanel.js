// Decay prediction sidebar panel
//
// Shows the Brain.js LSTM reentry forecast: objects predicted below 250 km,
// sorted by severity (CRITICAL → WARNING → WATCH), with sparkline-style
// altitude bars representing the 3-step predicted trajectory.
//
// Listens to the custom event 'novasentinel:decay-update' dispatched by main.js
// after each Brain.js training cycle.

import { REENTRY_SEVERITY }     from '../decay/index.js';
import { altitudeToSeverity }   from '../decay/index.js';

// ---------------------------------------------------------------------------
// Severity → CSS colour
// ---------------------------------------------------------------------------

const SEV_COLOR = {
  [REENTRY_SEVERITY.CRITICAL]: '#ff1744',
  [REENTRY_SEVERITY.WARNING]:  '#ffa726',
  [REENTRY_SEVERITY.WATCH]:    '#ffee58',
};

const SEV_ICON = {
  [REENTRY_SEVERITY.CRITICAL]: '🔴',
  [REENTRY_SEVERITY.WARNING]:  '🟠',
  [REENTRY_SEVERITY.WATCH]:    '🟡',
};

// ---------------------------------------------------------------------------
// DOM reference
// ---------------------------------------------------------------------------

let _panelEl  = null;
let _countEl  = null;
let _listEl   = null;

function _resolve() {
  _panelEl = _panelEl ?? document.getElementById('decay-panel');
  _listEl  = _listEl  ?? document.getElementById('decay-list');
  _countEl = _countEl ?? document.getElementById('decay-count');
}

// ---------------------------------------------------------------------------
// Altitude mini-bar (shows current + 3 predicted steps as a tiny bar chart)
// ---------------------------------------------------------------------------

function _altBar(currentAlt, predictions, color) {
  const all    = [currentAlt, ...predictions.map(p => p.altitude)].filter(isFinite);
  const minA   = Math.min(...all);
  const maxA   = Math.max(...all);
  const range  = Math.max(maxA - minA, 1);

  const bars = all.map((alt, i) => {
    const h    = Math.max(4, Math.round(((alt - minA) / range) * 28));
    const w    = i === 0 ? 7 : 5;
    const op   = i === 0 ? 1 : 0.5 + (i / all.length) * 0.1;
    const bg   = i === 0 ? '#aabbcc' : color;
    return `<div style="width:${w}px;height:${h}px;background:${bg};opacity:${op};border-radius:2px;align-self:flex-end"></div>`;
  }).join('');

  return `<div style="display:flex;gap:2px;align-items:flex-end;height:32px;margin-top:6px">${bars}</div>`;
}

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------

function _buildRow(alert) {
  const color   = SEV_COLOR[alert.severity] ?? '#ffffff';
  const icon    = SEV_ICON[alert.severity]  ?? '⚪';
  const curAlt  = isFinite(alert.currentAlt)  ? alert.currentAlt.toFixed(1) : '—';
  const minAlt  = isFinite(alert.minPredAlt)  ? alert.minPredAlt.toFixed(1) : '—';
  const bar     = _altBar(alert.currentAlt, alert.predictions, color);

  const row = document.createElement('div');
  row.className = 'decay-row';
  row.style.borderLeftColor = color;
  row.setAttribute('aria-label', `${alert.name} predicted reentry: ${alert.severity}`);

  row.innerHTML = `
    <div class="decay-header">
      <span class="decay-sev">${icon} ${alert.severity}</span>
      <span class="decay-norad">NORAD ${alert.noradId}</span>
    </div>
    <div class="decay-name">${alert.name}</div>
    <div class="decay-altrow">
      <span class="decay-alt-label">Now</span>
      <span class="decay-alt-val">${curAlt} km</span>
      <span class="decay-arrow">→</span>
      <span class="decay-alt-label">Min pred</span>
      <span class="decay-alt-val" style="color:${color}">${minAlt} km</span>
    </div>
    ${bar}
    <div class="decay-steps">
      ${alert.predictions.map((p, i) =>
        `<span class="decay-step" style="color:${SEV_COLOR[altitudeToSeverity(p.altitude)] ?? '#8899aa'}">
          +${i + 1}: ${isFinite(p.altitude) ? p.altitude.toFixed(0) : '?'} km
        </span>`
      ).join('')}
    </div>
  `;

  return row;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders the decay panel with a new set of alerts.
 * Called by main.js after each Brain.js training cycle.
 *
 * @param {import('../decay/reentryAlert.js').ReentryAlert[]} alerts
 */
export function updateDecayPanel(alerts) {
  _resolve();
  if (!_listEl) return;

  _listEl.innerHTML = '';

  if (!alerts || alerts.length === 0) {
    _listEl.innerHTML = `
      <div class="decay-empty">
        <div class="decay-empty-icon">🛸</div>
        <div>No predicted reentries<br><small>LSTM model training…</small></div>
      </div>`;
    if (_countEl) _countEl.textContent = '0 alerts';
    return;
  }

  alerts.forEach(a => _listEl.appendChild(_buildRow(a)));

  if (_countEl) {
    _countEl.textContent = `${alerts.length} alert${alerts.length !== 1 ? 's' : ''}`;
  }
}

/**
 * Initialises the decay panel (attaches event listener for main.js dispatch).
 */
export function initDecayPanel() {
  _resolve();

  document.addEventListener('novasentinel:decay-update', (e) => {
    updateDecayPanel(e.detail?.alerts ?? []);
  });
}
