// Hover tooltip — appears near the cursor when mousing over a satellite dot
//
// Shows: object name, NORAD ID, altitude, speed, PoC (if available)
// Implemented as a fixed-position DOM card that follows the mouse.
//
// Uses THREE.Raycaster against the catalogue Points cloud for picking.

import * as THREE from 'three';
import { pocToCSS, pocToTier } from '../viz/riskColors.js';

// ---------------------------------------------------------------------------
// DOM element (created once)
// ---------------------------------------------------------------------------

let _tooltipEl = null;

function _getTooltip() {
  if (_tooltipEl) return _tooltipEl;
  _tooltipEl = document.getElementById('object-tooltip');
  return _tooltipEl;
}

// ---------------------------------------------------------------------------
// Raycaster
// ---------------------------------------------------------------------------

const _raycaster = new THREE.Raycaster();
const _mouse     = new THREE.Vector2();
_raycaster.params.Points = { threshold: 0.006 };   // ~38 km pick radius in scene units

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _visible       = false;
let _rafScheduled  = false;
let _lastMouseX    = 0;
let _lastMouseY    = 0;
let _catalogue     = null;   // CatalogueCloud object
let _tleRecords    = null;   // Map<noradId, TLERecord>
let _pocMap        = null;   // Map<noradId, number>

// ---------------------------------------------------------------------------
// Tooltip content builder
// ---------------------------------------------------------------------------

function _buildContent(noradId, pos, poc) {
  const name   = _tleRecords?.get(noradId)?.name ?? `NORAD ${noradId}`;
  const alt    = pos?.altKm?.toFixed(1) ?? '—';
  const spd    = pos?.speed?.toFixed(2) ?? '—';
  const pocStr = poc != null ? poc.toExponential(2) : 'N/A';
  const color  = pocToCSS(poc);

  return `
    <div class="tooltip-name">${name}</div>
    <div class="tooltip-meta">
      <span>NORAD&nbsp;<strong>${noradId}</strong></span>
    </div>
    <div class="tooltip-row">
      <span class="tooltip-label">Alt</span>
      <span class="tooltip-value">${alt} km</span>
    </div>
    <div class="tooltip-row">
      <span class="tooltip-label">Speed</span>
      <span class="tooltip-value">${spd} km/s</span>
    </div>
    <div class="tooltip-row">
      <span class="tooltip-label">PoC</span>
      <span class="tooltip-value" style="color:${color}">${pocStr}</span>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Position tooltip near cursor (keep it within the viewport)
// ---------------------------------------------------------------------------

function _positionTooltip(x, y) {
  const el = _getTooltip();
  if (!el) return;
  const W  = window.innerWidth;
  const H  = window.innerHeight;
  const TW = el.offsetWidth  + 16;
  const TH = el.offsetHeight + 16;
  el.style.left = `${Math.min(x + 14, W - TW)}px`;
  el.style.top  = `${Math.min(y + 14, H - TH)}px`;
}

// ---------------------------------------------------------------------------
// Pick logic
// ---------------------------------------------------------------------------

function _pick(camera, canvas) {
  if (!_catalogue || !_catalogue.points) return null;

  const rect = canvas.getBoundingClientRect();
  _mouse.set(
    ((_lastMouseX - rect.left) / rect.width)  *  2 - 1,
    ((_lastMouseY - rect.top)  / rect.height) * -2 + 1,
  );

  _raycaster.setFromCamera(_mouse, camera);
  const hits = _raycaster.intersectObject(_catalogue.points, false);
  if (hits.length === 0) return null;

  // Find which NORAD ID maps to hit buffer index
  const hitIdx = hits[0].index;
  for (const [id, idx] of _catalogue.indexMap) {
    if (idx === hitIdx) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Registers the catalogue cloud and record map for raycasting.
 *
 * @param {import('../viz/catalogue.js').CatalogueCloud} cloud
 * @param {Map<string, import('../data/tleParser.js').TLERecord>} tleMap  NORAD→record
 * @param {Map<string, number>} [pocMap]   NORAD→PoC score (from ML inference)
 */
export function registerTooltipData(cloud, tleMap, pocMap = null) {
  _catalogue  = cloud;
  _tleRecords = tleMap;
  _pocMap     = pocMap;
}

/**
 * Attaches mousemove / mouseleave listeners to the canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {THREE.PerspectiveCamera} camera
 * @param {Map<string, import('../propagation/batchPropagator.js').CachedPosition>} positionMap
 */
export function initTooltip(canvas, camera, positionMap) {
  canvas.addEventListener('mousemove', (e) => {
    _lastMouseX = e.clientX;
    _lastMouseY = e.clientY;

    if (_rafScheduled) return;
    _rafScheduled = true;

    requestAnimationFrame(() => {
      _rafScheduled = false;
      const noradId = _pick(camera, canvas);

      if (!noradId) {
        _hide();
        return;
      }

      const pos = positionMap.get(noradId);
      const poc = _pocMap?.get(noradId) ?? null;
      _show(noradId, pos, poc);
      _positionTooltip(_lastMouseX, _lastMouseY);
    });
  });

  canvas.addEventListener('mouseleave', _hide);

  // Click-to-select interaction
  canvas.addEventListener('click', () => {
    const noradId = _pick(camera, canvas);
    if (noradId) {
      const rec = _tleRecords?.get(noradId);
      if (rec) {
        document.dispatchEvent(new CustomEvent('novasentinel:satellite-clicked', {
          detail: { record: rec }
        }));
      }
    }
  });
}

function _show(noradId, pos, poc) {
  const el = _getTooltip();
  if (!el) return;
  el.innerHTML   = _buildContent(noradId, pos, poc);
  el.style.display = 'block';
  _visible = true;
}

function _hide() {
  const el = _getTooltip();
  if (el) el.style.display = 'none';
  _visible = false;
}
