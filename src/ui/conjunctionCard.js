// CDM conjunction detail card
//
// A floating DOM card that appears when the user clicks an uncertainty ellipsoid.
// Shows all fields returned by buildEllipsoidTooltip(): CDM ID, TCA, PoC (risk
// coloured), miss distance, satellite names, and 1-sigma σR/σT/σN.
//
// The card is a singleton (one element, reused per click) to avoid DOM churn.

// ---------------------------------------------------------------------------
// Card element (lazily created)
// ---------------------------------------------------------------------------

let _cardEl = null;

function _ensureCard() {
  if (_cardEl) return _cardEl;
  _cardEl = document.getElementById('conjunction-card');
  return _cardEl;
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<import('../viz/ellipsoid.js').buildEllipsoidTooltip>} tip
 */
function _buildHTML(tip) {
  const pocStyle = `color:${tip.tierColor}`;
  const missDist = Number.isFinite(tip.missDistM)
    ? `${tip.missDistM.toFixed(0)} m`
    : '—';

  // Format TCA as a compact UTC string
  let tcaStr = '—';
  try {
    const d = new Date(tip.tca);
    if (!isNaN(d)) tcaStr = d.toUTCString().replace(' GMT', ' UTC').slice(5);
  } catch (_) { /* keep '—' */ }

  const fmt = (v) => (Number.isFinite(v) ? v.toFixed(0) + ' m' : '—');

  return `
    <div class="cjcard-drag-handle" id="cjcard-drag-handle" aria-label="Drag to move">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11">
        <circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/>
        <circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>
        <circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>
      </svg>
      <span>Conjunction Detail</span>
      <button id="cjcard-close-btn" aria-label="Close conjunction detail" title="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="11" height="11">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <div class="cjcard-poc-row">
      <span class="cjcard-poc-badge" style="${pocStyle}; border-color:${tip.tierColor}">
        ${tip.pocFormatted}
      </span>
      <span class="cjcard-tier-label" style="${pocStyle}">${tip.tier}</span>
      <span class="cjcard-cdmid">${tip.cdmId}</span>
    </div>

    <div class="cjcard-sats">
      <span class="cjcard-sat primary" title="${tip.sat1Name}">${tip.sat1Name}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           width="10" height="10" class="cjcard-vs-icon">
        <line x1="5" y1="12" x2="19" y2="12"/>
        <polyline points="12 5 19 12 12 19"/>
      </svg>
      <span class="cjcard-sat secondary" title="${tip.sat2Name}">${tip.sat2Name}</span>
    </div>

    <div class="cjcard-ids">
      <span class="cjcard-id-primary" title="Primary NORAD / Designator">
        NORAD ${tip.sat1Id ?? tip.sat1Designator ?? '—'}
      </span>
      <span class="cjcard-id-secondary" title="Secondary NORAD / Designator">
        NORAD ${tip.sat2Id ?? tip.sat2Designator ?? '—'}
      </span>
    </div>

    <div class="cjcard-stats">
      <div class="cjcard-stat">
        <span class="cjcard-stat-label">TCA</span>
        <span class="cjcard-stat-val cjcard-tca">${tcaStr}</span>
      </div>
      <div class="cjcard-stat">
        <span class="cjcard-stat-label">Miss Dist</span>
        <span class="cjcard-stat-val">${missDist}</span>
      </div>
    </div>

    <div class="cjcard-sigma-row">
      <div class="cjcard-sigma">
        <span class="cjcard-sigma-label">σR</span>
        <span class="cjcard-sigma-val">${fmt(tip.sigmaR)}</span>
      </div>
      <div class="cjcard-sigma">
        <span class="cjcard-sigma-label">σT</span>
        <span class="cjcard-sigma-val">${fmt(tip.sigmaT)}</span>
      </div>
      <div class="cjcard-sigma">
        <span class="cjcard-sigma-label">σN</span>
        <span class="cjcard-sigma-val">${fmt(tip.sigmaN)}</span>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Drag logic (simple pointer-event drag)
// ---------------------------------------------------------------------------

function _attachDrag(card) {
  const handle = card.querySelector('#cjcard-drag-handle');
  if (!handle) return;

  let dragging = false;
  let ox = 0, oy = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#cjcard-close-btn')) return;
    dragging = true;
    const rect = card.getBoundingClientRect();
    ox = e.clientX - rect.left;
    oy = e.clientY - rect.top;
    handle.setPointerCapture(e.pointerId);
    card.style.right = 'auto';  // switch from right-anchored to left-anchored
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    card.style.left = `${e.clientX - ox}px`;
    card.style.top = `${e.clientY - oy}px`;
  });

  handle.addEventListener('pointerup', () => { dragging = false; });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Shows the conjunction card near (x, y) viewport coordinates with `tip` data.
 *
 * @param {ReturnType<import('../viz/ellipsoid.js').buildEllipsoidTooltip>} tip
 * @param {number} x  - clientX of click
 * @param {number} y  - clientY of click
 */
export function showConjunctionCard(tip, x, y) {
  const card = _ensureCard();
  if (!card) return;

  card.innerHTML = _buildHTML(tip);

  // Close button
  card.querySelector('#cjcard-close-btn')?.addEventListener('click', hideConjunctionCard);

  // Clamp position: keep card inside viewport
  card.classList.remove('hidden');
  card.style.left = 'auto';
  card.style.top = 'auto';

  // Initially position, then clamp after layout
  card.style.right = 'auto';
  card.style.bottom = 'auto';

  // Apply initial position (offset from click)
  const offsetX = 14;
  const offsetY = 14;
  requestAnimationFrame(() => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const CW = card.offsetWidth + 16;
    const CH = card.offsetHeight + 16;
    card.style.left = `${Math.min(x + offsetX, W - CW)}px`;
    card.style.top = `${Math.min(y + offsetY, H - CH)}px`;
  });

  _attachDrag(card);
}

/**
 * Hides the conjunction card.
 */
export function hideConjunctionCard() {
  _ensureCard()?.classList.add('hidden');
}

/**
 * Returns true if the conjunction card is currently visible.
 * @returns {boolean}
 */
export function isConjunctionCardVisible() {
  const card = _ensureCard();
  return !!card && !card.classList.contains('hidden');
}
