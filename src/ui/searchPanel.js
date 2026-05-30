// searchPanel.js — Satellite search by NORAD ID or name
//
// Features:
//   • Instant fuzzy match against TLE catalogue (name or NORAD ID)
//   • Dropdown suggestions limited to 8 entries
//   • Result card shows: name, NORAD ID, altitude, inclination, PoC badge
//   • Camera fly-to via custom event  `novasentinel:search-fly`
//   • Keyboard navigation (↑ ↓ Enter Escape)

import { pocToCSS, pocToTier } from '../viz/riskColors.js';

// ── Internal state ────────────────────────────────────────────────────────────

let _tleMap  = null;   // Map<noradId, TLERecord>
let _pocMap  = null;   // Map<noradId, number>
let _posMap  = null;   // Map<noradId, CachedPosition>

let _inputEl        = null;
let _dropEl         = null;
let _resultCardEl   = null;
let _clearBtnEl     = null;
let _activeIdx      = -1;
let _suggestions    = [];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call once after TLE / PoC / position maps are ready.
 * Maps are live references — no need to call again on update.
 *
 * @param {Map<string, object>} tleMap   NORAD→TLERecord
 * @param {Map<string, number>} pocMap   NORAD→PoC score
 * @param {Map<string, object>} posMap   NORAD→CachedPosition
 */
export function updateSearchData(tleMap, pocMap, posMap) {
  _tleMap = tleMap;
  _pocMap = pocMap;
  _posMap = posMap;
}

/**
 * Wire up the search bar DOM elements and attach event listeners.
 * Must be called after DOMContentLoaded.
 */
export function initSearch() {
  _inputEl      = document.getElementById('search-input');
  _dropEl       = document.getElementById('search-dropdown');
  _resultCardEl = document.getElementById('search-result-card');
  _clearBtnEl   = document.getElementById('search-clear-btn');

  if (!_inputEl) return;

  _inputEl.addEventListener('input',   _onInput);
  _inputEl.addEventListener('keydown', _onKeydown);
  _inputEl.addEventListener('focus',   () => { if (_inputEl.value.trim()) _onInput(); });
  document.addEventListener('click',   _onDocClick);
  _clearBtnEl?.addEventListener('click', _clearAll);

  // Make the result card draggable
  _initDraggable(_resultCardEl);

  // Live track updates — update altitude/speed on every propagation cycle
  document.addEventListener('novasentinel:track-update', (e) => {
    const { altKm, speed, lat, lon } = e.detail ?? {};
    const altEl  = document.getElementById('src-live-alt');
    const spdEl  = document.getElementById('src-live-spd');
    const latEl  = document.getElementById('src-live-lat');
    const lonEl  = document.getElementById('src-live-lon');
    if (altEl  && altKm  != null) altEl.textContent  = altKm.toFixed(1);
    if (spdEl  && speed  != null) spdEl.textContent  = speed.toFixed(3);
    if (latEl  && lat    != null) latEl.textContent  = lat.toFixed(2) + '°';
    if (lonEl  && lon    != null) lonEl.textContent  = lon.toFixed(2) + '°';
  });

  // Listen to 3D canvas selection clicks
  document.addEventListener('novasentinel:satellite-clicked', (e) => {
    const rec = e.detail?.record;
    if (rec) {
      _selectRecord(rec);
    }
  });
}

// ── Search logic ──────────────────────────────────────────────────────────────

function _search(query) {
  if (!_tleMap || !query) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results = [];
  for (const [id, rec] of _tleMap) {
    const nameMatch  = rec.name?.toLowerCase().includes(q);
    const noradMatch = id.toLowerCase().includes(q);
    if (nameMatch || noradMatch) {
      results.push(rec);
      if (results.length >= 8) break;
    }
  }
  return results;
}

// ── Input handler ─────────────────────────────────────────────────────────────

function _onInput() {
  const q = _inputEl.value;
  _clearBtnEl && (_clearBtnEl.style.display = q ? 'flex' : 'none');

  if (!q.trim()) {
    _hideDrop();
    return;
  }

  _suggestions = _search(q);
  _activeIdx   = -1;

  if (_suggestions.length === 0) {
    _showNoDrop();
    return;
  }

  _renderDrop(_suggestions);
  _showDrop();
}

// ── Keyboard navigation ───────────────────────────────────────────────────────

function _onKeydown(e) {
  if (!_dropEl || _dropEl.classList.contains('hidden')) {
    if (e.key === 'Enter') _triggerSearch();
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _activeIdx = Math.min(_activeIdx + 1, _suggestions.length - 1);
    _highlightDrop();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _activeIdx = Math.max(_activeIdx - 1, -1);
    _highlightDrop();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (_activeIdx >= 0 && _suggestions[_activeIdx]) {
      _selectRecord(_suggestions[_activeIdx]);
    } else {
      _triggerSearch();
    }
  } else if (e.key === 'Escape') {
    _hideDrop();
    _clearBtnEl && (_clearBtnEl.style.display = 'none');
    _inputEl.blur();
  }
}

function _triggerSearch() {
  if (_suggestions.length > 0) _selectRecord(_suggestions[0]);
}

// ── Dropdown rendering ────────────────────────────────────────────────────────

function _renderDrop(records) {
  _dropEl.innerHTML = records.map((rec, i) => {
    const poc  = _pocMap?.get(rec.noradId) ?? null;
    const tier = pocToTier(poc);
    const dot  = _tierDotStyle(tier);
    return `
      <div class="search-drop-item" data-idx="${i}" role="option" aria-selected="false">
        <span class="sdrop-dot" style="${dot}"></span>
        <span class="sdrop-name">${_hl(rec.name ?? '–', _inputEl.value)}</span>
        <span class="sdrop-id">${rec.noradId}</span>
      </div>`;
  }).join('');

  // Click on suggestion
  _dropEl.querySelectorAll('.search-drop-item').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent blur before click
      const idx = parseInt(el.dataset.idx, 10);
      if (_suggestions[idx]) _selectRecord(_suggestions[idx]);
    });
  });
}

function _showNoDrop() {
  _dropEl.innerHTML = `<div class="sdrop-empty">No matches found</div>`;
  _showDrop();
}

function _showDrop()  { _dropEl.classList.remove('hidden'); }
function _hideDrop()  { _dropEl.classList.add('hidden'); _activeIdx = -1; }

function _highlightDrop() {
  _dropEl.querySelectorAll('.search-drop-item').forEach((el, i) => {
    el.classList.toggle('active', i === _activeIdx);
    el.setAttribute('aria-selected', String(i === _activeIdx));
  });
}

// ── Highlight query match in text ─────────────────────────────────────────────

function _hl(text, query) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

// ── Result card ───────────────────────────────────────────────────────────────

function _selectRecord(rec) {
  _hideDrop();
  _inputEl.value = rec.name ?? rec.noradId;
  _clearBtnEl && (_clearBtnEl.style.display = 'flex');
  _showResultCard(rec);

  // Dispatch fly-to event so main.js can animate the camera
  document.dispatchEvent(new CustomEvent('novasentinel:search-fly', {
    detail: { noradId: rec.noradId }
  }));
}

function _showResultCard(rec) {
  if (!_resultCardEl) return;

  const noradId = rec.noradId;
  const poc     = _pocMap?.get(noradId) ?? null;
  const pos     = _posMap?.get(noradId) ?? null;
  const tier    = pocToTier(poc);
  const color   = pocToCSS(poc);
  const tierLabel = _tierLabel(tier);
  const tierKey   = tier.toLowerCase();  // 'red' | 'amber' | 'green' | 'unknown'

  const alt  = pos?.altKm?.toFixed(1)   ?? '—';
  const spd  = pos?.speed?.toFixed(3)   ?? '—';
  const inc  = rec.inclination != null   ? `${rec.inclination.toFixed(2)}°`  : '—';
  const ecc  = rec.eccentricity != null  ? rec.eccentricity.toFixed(5)        : '—';
  const lat  = pos?.lat != null          ? `${pos.lat.toFixed(2)}°`          : '—';
  const lon  = pos?.lon != null          ? `${pos.lon.toFixed(2)}°`          : '—';
  const period = rec.meanMotion
    ? `${(1440 / rec.meanMotion).toFixed(1)} min` : '—';

  const pocDisplay = poc != null ? poc.toExponential(3) : 'N/A';
  const pocBadgeBg = poc != null
    ? `background:${color}22; border-color:${color}; color:${color};`
    : `background:transparent; border-color:var(--text-dim); color:var(--text-dim);`;

  const contentHtml = `
    <div class="src-card-header">
      <div class="src-card-tier" style="background:${color}; box-shadow: 0 0 8px ${color}"></div>
      <div class="src-card-title-group">
        <div class="src-card-name">${rec.name ?? `NORAD ${noradId}`}</div>
        <div class="src-card-id">NORAD&nbsp;<strong>${noradId}</strong></div>
      </div>
      <button id="search-fly-btn" class="src-fly-btn" title="Fly to this satellite" aria-label="Fly to satellite ${rec.name ?? noradId}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
          <path d="M5 12h14M12 5l7 7-7 7"/>
        </svg>
        Track
      </button>
    </div>

    <div class="src-card-poc-row">
      <span class="src-poc-label">Probability of Collision</span>
      <span class="src-poc-badge" style="${pocBadgeBg}">
        ${pocDisplay}
      </span>
      <span class="src-tier-label" style="color:${color}">${tierLabel}</span>
    </div>

    <div class="src-card-risk-bar-wrap">
      <div class="src-card-risk-bar" style="${_riskBarStyle(poc)}"></div>
    </div>

    <div class="src-card-stats">
      <div class="src-stat">
        <span class="src-stat-label">Altitude</span>
        <span class="src-stat-val"><span id="src-live-alt">${alt}</span> <span class="src-stat-unit">km</span></span>
      </div>
      <div class="src-stat">
        <span class="src-stat-label">Speed</span>
        <span class="src-stat-val"><span id="src-live-spd">${spd}</span> <span class="src-stat-unit">km/s</span></span>
      </div>
      <div class="src-stat">
        <span class="src-stat-label">Inclination</span>
        <span class="src-stat-val">${inc}</span>
      </div>
      <div class="src-stat">
        <span class="src-stat-label">Eccentricity</span>
        <span class="src-stat-val">${ecc}</span>
      </div>
      <div class="src-stat">
        <span class="src-stat-label">Period</span>
        <span class="src-stat-val">${period}</span>
      </div>
      <div class="src-stat">
        <span class="src-stat-label">Latitude</span>
        <span class="src-stat-val"><span id="src-live-lat">${lat}</span></span>
      </div>
      <div class="src-stat">
        <span class="src-stat-label">Longitude</span>
        <span class="src-stat-val"><span id="src-live-lon">${lon}</span></span>
      </div>
    </div>

    <div class="src-card-actions">
      <button type="button" id="src-follow-btn" class="src-follow-btn" title="Toggle camera follow" aria-pressed="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
          <circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
        </svg>
        Follow Camera
      </button>
    </div>
  `;

  // Inject into the content area (after the drag handle), preserving the handle
  let contentDiv = _resultCardEl.querySelector('#src-card-content');
  if (!contentDiv) {
    contentDiv = document.createElement('div');
    contentDiv.id = 'src-card-content';
    _resultCardEl.appendChild(contentDiv);
  }
  contentDiv.innerHTML = contentHtml;

  _resultCardEl.classList.remove('hidden');

  // Wire drag-handle close button
  const closeBtn = _resultCardEl.querySelector('#src-card-close-btn');
  closeBtn?.addEventListener('click', () => {
    _clearAll();
  });

  // Wire fly/track button
  document.getElementById('search-fly-btn')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('novasentinel:search-fly', {
      detail: { noradId }
    }));
  });

  // Wire follow button
  const followBtn = document.getElementById('src-follow-btn');
  followBtn?.addEventListener('click', () => {
    const isFollowing = followBtn.getAttribute('aria-pressed') === 'true';
    const nowFollowing = !isFollowing;
    followBtn.setAttribute('aria-pressed', String(nowFollowing));
    followBtn.classList.toggle('active', nowFollowing);
    document.dispatchEvent(new CustomEvent('novasentinel:follow-toggle', {
      detail: { follow: nowFollowing }
    }));
    // Also re-fly to current satellite position when enabling follow
    if (nowFollowing) {
      document.dispatchEvent(new CustomEvent('novasentinel:search-fly', {
        detail: { noradId }
      }));
    }
  });
}

// ── Risk bar gradient ─────────────────────────────────────────────────────────

function _riskBarStyle(poc) {
  if (poc == null) {
    return 'width: 0%; background: var(--text-dim);';
  }
  // Map PoC from 1e-6 → 1e-3 to 0% → 100% on log scale
  const logVal  = Math.log10(Math.max(poc, 1e-8));
  const logMin  = -8;
  const logMax  = -3;
  const pct     = Math.max(0, Math.min(100, ((logVal - logMin) / (logMax - logMin)) * 100));
  const color   = pocToCSS(poc);
  return `width:${pct.toFixed(1)}%; background: linear-gradient(90deg, var(--green) 0%, ${color} 100%);`;
}

// ── Tier helpers ──────────────────────────────────────────────────────────────

function _tierLabel(tier) {
  return { RED: 'HIGH RISK', AMBER: 'ELEVATED', GREEN: 'LOW RISK', UNKNOWN: 'UNKNOWN' }[tier] ?? 'UNKNOWN';
}

function _tierDotStyle(tier) {
  const colors = { RED: 'var(--red)', AMBER: 'var(--amber)', GREEN: 'var(--green)', UNKNOWN: 'var(--text-dim)' };
  const c = colors[tier] ?? colors.UNKNOWN;
  return `background:${c}; box-shadow: 0 0 4px ${c};`;
}

// ── Close result card on outside click ───────────────────────────────────────

function _onDocClick(e) {
  const wrapper = document.getElementById('search-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    _hideDrop();
  }
}


function _clearAll() {
  _inputEl.value = '';
  _clearBtnEl && (_clearBtnEl.style.display = 'none');
  _hideDrop();
  _resultCardEl?.classList.add('hidden');
  document.dispatchEvent(new CustomEvent('novasentinel:search-clear'));
  _inputEl.focus();
}

// ── Draggable card ────────────────────────────────────────────────────────────

function _initDraggable(el) {
  if (!el) return;
  const handle = document.getElementById('src-card-drag-handle');
  if (!handle) return;

  let startX = 0, startY = 0, origLeft = 0, origTop = 0;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    startX  = e.clientX;
    startY  = e.clientY;
    origLeft = rect.left;
    origTop  = rect.top;

    // Switch from default CSS position to explicit pixel position
    el.style.left = origLeft + 'px';
    el.style.top  = origTop  + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  origLeft + dx));
      const newTop  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, origTop  + dy));
      el.style.left = newLeft + 'px';
      el.style.top  = newTop  + 'px';
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}
