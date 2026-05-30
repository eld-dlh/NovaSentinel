// NovaSentinel — application entry point
//
// Full pipeline:
//   TLE Fetch  → SGP4 Propagation → Three.js Globe (point cloud)
//   CDM Fetch  → ML PoC Inference → Alert Panel + CDM Ellipsoids
//   TLE Decay  → Brain.js LSTM    → Reentry Alert Panel
//
// Architecture:
//   - Three.js render loop: 60 fps via requestAnimationFrame
//   - SGP4 propagation:     Web Worker (30-second cycle)
//   - TLE polling:          6-hour interval (CelesTrak)
//   - CDM polling:          8-hour interval (Space-Track)
//   - Brain.js training:    setTimeout (deferred after TLE load)

import './style.css';

// ── Data layer ────────────────────────────────────────────────────────────
import { startTLEPolling, onTLEUpdate, fetchAllDebris, getCachedDebris } from './data/tleFetch.js';
import { loginSpaceTrack, startNormalPolling,
         onCDMUpdate,
         postRejectionToDjango,
         postConjunctionToDjango }                    from './data/cdmFetch.js';
import { cdmToEllipsoidAxes }                         from './data/cdmCovariance.js';

// ── Propagation ───────────────────────────────────────────────────────────
import { createPropagator }                           from './propagation/index.js';

// ── ML (TF.js PoC model) ──────────────────────────────────────────────────
import { loadModel, batchInferPoC, disposeModel,
         buildFeatureVector }                         from './ml/index.js';

// ── Brain.js LSTM decay model ─────────────────────────────────────────────
import { buildDecaySequences, trainDecayModel,
         predictDecay, detectReentryThreats,
         REENTRY_SEVERITY }                           from './decay/index.js';

// ── Three.js visualisation ────────────────────────────────────────────────
import { initScene, startRenderLoop }                 from './viz/scene.js';
import { createEarth }                                from './viz/earth.js';
import { createCatalogueCloud, updateCataloguePositions, geoToWorld } from './viz/catalogue.js';
import { createUncertaintyEllipsoid, orientEllipsoidRTN,
         clearEllipsoids }                            from './viz/ellipsoid.js';
import { pocToColor }                                 from './viz/riskColors.js';
import { flyToConjunction, flyToPoint, resetCamera } from './viz/cameraControls.js';
import { createOrbitLine, updateOrbitLineGeometry }   from './viz/orbit.js';
import * as THREE                                     from 'three';

// ── UI ────────────────────────────────────────────────────────────────────
import { initAlertPanel, updateAlertPanel }           from './ui/alertPanel.js';
import { initDecayPanel, updateDecayPanel }           from './ui/decayPanel.js';
import { initTooltip, registerTooltipData }           from './ui/objectTooltip.js';
import { initSearch, updateSearchData }               from './ui/searchPanel.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Bootstrap Three.js scene
// ═══════════════════════════════════════════════════════════════════════════

const canvas = document.getElementById('globe-canvas');
const ctx    = initScene(canvas);
const { renderer, scene, camera, controls } = ctx;

// Earth globe + atmosphere
const earth = createEarth(scene);

// Satellite point cloud (up to 12k objects)
// pointSize removed — per-satellite sizes now set via sizeBuf in updateCataloguePositions()
const cloud = createCatalogueCloud(scene, {
  maxObjects:   12_000,
  defaultColor: new THREE.Color(0x4fc3f7),
});

// Group for CDM ellipsoids
const ellipsoidGroup = new THREE.Group();
ellipsoidGroup.name  = 'ellipsoids';
scene.add(ellipsoidGroup);

// Orbit path for the selected satellite
const orbitLine = createOrbitLine();
scene.add(orbitLine);

// ── State ────────────────────────────────────────────────────────────────
let _pocMap      = new Map();  // noradId → PoC score
let _tleMap      = new Map();  // noradId → TLERecord
let _posMap      = new Map();  // noradId → CachedPosition (live reference from propagator)
let _cdmRecords  = [];
let _ellipsoids  = [];         // THREE.Mesh[] parallel to _cdmRecords
let _showEllipsoids = true;
let _pocModel    = null;
let _selectedNoradId = null;
let _followCamera    = false;  // camera-follow mode

// ── Colour palette per object type ──────────────────────────────────────────
const COLOR_PAYLOAD  = new THREE.Color(0x4fc3f7);   // cyan-blue  — active satellites
const COLOR_DEBRIS   = new THREE.Color(0xff6b35);   // orange-red — debris (most common)
const COLOR_ROCKET   = new THREE.Color(0xb39ddb);   // soft purple — rocket bodies
const COLOR_UNKNOWN  = new THREE.Color(0x78909c);   // blue-grey  — unclassified

// ── Colour function for updateCataloguePositions ─────────────────────────
function satelliteColor(pos, noradId) {
  if (_selectedNoradId != null) {
    if (noradId !== _selectedNoradId) {
      // Dimmed color: let's get the base color and scale it down
      let base;
      const poc = _pocMap.get(noradId) ?? null;
      if (poc != null) {
        base = pocToColor(poc);
      } else {
        const type = (pos.objectType ?? '').toUpperCase();
        if (type.includes('DEBRIS'))  base = COLOR_DEBRIS;
        else if (type.includes('ROCKET'))  base = COLOR_ROCKET;
        else if (type.includes('PAYLOAD')) base = COLOR_PAYLOAD;
        else {
          const alt = pos.altKm ?? 400;
          const t   = Math.max(0, Math.min(1, (alt - 200) / 1800));
          base = new THREE.Color().setHSL(0.56 + t * 0.08, 0.85, 0.50 + t * 0.08);
        }
      }
      return base.clone().multiplyScalar(0.12);
    } else {
      // Selected satellite: return yellow highlight color
      return new THREE.Color(0xffea00);
    }
  }

  // 1. PoC-flagged objects override type colour with risk colour
  const poc = _pocMap.get(noradId) ?? null;
  if (poc != null) return pocToColor(poc);

  // 2. Colour by object type for quick visual differentiation
  const type = (pos.objectType ?? '').toUpperCase();
  if (type.includes('DEBRIS'))  return COLOR_DEBRIS;
  if (type.includes('ROCKET'))  return COLOR_ROCKET;
  if (type.includes('PAYLOAD')) return COLOR_PAYLOAD;

  // 3. Altitude-tinted fallback for unknown types (lower = warmer)
  const alt = pos.altKm ?? 400;
  const t   = Math.max(0, Math.min(1, (alt - 200) / 1800));
  return new THREE.Color().setHSL(0.56 + t * 0.08, 0.85, 0.50 + t * 0.08);
}

// ── Render loop ───────────────────────────────────────────────────────────
const stopLoop = startRenderLoop(ctx, (dt) => {
  earth.tick(dt);  // slow Earth rotation

  // Real-time selected satellite visual pulse!
  if (_selectedNoradId != null) {
    const idx = cloud.indexMap.get(_selectedNoradId);
    if (idx != null) {
      const base = idx * 3;
      const pulse = 0.85 + 0.15 * Math.sin(performance.now() * 0.009);
      const color = new THREE.Color(0xffea00).multiplyScalar(pulse);
      cloud.colorBuf[base]     = color.r;
      cloud.colorBuf[base + 1] = color.g;
      cloud.colorBuf[base + 2] = color.b;
      cloud.geometry.attributes.color.needsUpdate = true;

      const sizePulse = 9.0 + 3.0 * Math.sin(performance.now() * 0.009);
      cloud.sizeBuf[idx] = sizePulse;
      cloud.geometry.attributes.size.needsUpdate = true;
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Propagation pipeline
// ═══════════════════════════════════════════════════════════════════════════

const propagator = createPropagator({
  intervalMs: 30_000,
  useWorker:  typeof Worker !== 'undefined' && !import.meta.env.DEV,
  onError(errors) {
    if (errors.length > 0)
      console.warn(`[main] ${errors.length} propagation errors`);
  },
});

propagator.start((positionMap) => {
  _posMap = positionMap;

  updateCataloguePositions(cloud, positionMap, {
    colorFn: satelliteColor,
    selectedNoradId: _selectedNoradId,
  });

  // Keep search panel position data live
  updateSearchData(_tleMap, _pocMap, _posMap);

  // Live-update the tracking card if a satellite is selected
  if (_selectedNoradId) {
    const pos = positionMap.get(_selectedNoradId);
    if (pos) {
      // Refresh the orbit path with current epoch
      const record = _tleMap.get(_selectedNoradId);
      if (record?.satrec) updateOrbitLineGeometry(orbitLine, record.satrec, new Date());

      // Dispatch live data to update the result card fields
      document.dispatchEvent(new CustomEvent('novasentinel:track-update', {
        detail: {
          noradId: _selectedNoradId,
          altKm:   pos.altKm,
          speed:   pos.speed,
          lat:     pos.lat,
          lon:     pos.lon,
        }
      }));

      // Camera follow mode — smoothly nudge camera toward new satellite position
      if (_followCamera && pos.lat != null) {
        const satWorldObj = geoToWorld(pos.lat, pos.lon, pos.altKm, 1);
        const satWorld = new THREE.Vector3(satWorldObj.x, satWorldObj.y, satWorldObj.z);
        // Gently slide the orbit controls target toward the satellite
        controls.target.lerp(satWorld, 0.08);
        controls.update();
      }
    }
  }

  // Update header stat
  const statEl = document.getElementById('stat-objects');
  if (statEl) statEl.textContent = positionMap.size.toLocaleString();
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. TLE polling → load propagator + decay model
// ═══════════════════════════════════════════════════════════════════════════

onTLEUpdate((records, fetchedAt) => {
  console.info(`[main] TLE update — ${records.length} objects @ ${fetchedAt?.toISOString()}`);

  // Build NORAD → record lookup for tooltip
  _tleMap.clear();
  for (const r of records) _tleMap.set(r.noradId, r);

  // Register with tooltip picker
  registerTooltipData(cloud, _tleMap, _pocMap);

  // Update search panel with fresh TLE catalogue
  updateSearchData(_tleMap, _pocMap, _posMap);

  // Load into propagator (active satellites first)
  propagator.load(records);

  // ── Instant debris hydration from localStorage ────────────────────────────
  // getCachedDebris() is synchronous and zero-network. It immediately adds
  // debris to the propagator so dots appear on the globe without waiting for
  // the background fetch below. The background fetch (5 s delay) will refresh
  // the cache silently for the next session.
  const cachedDebris = getCachedDebris();
  if (cachedDebris.length > 0) {
    for (const r of cachedDebris) _tleMap.set(r.noradId, r);
    propagator.update(cachedDebris);
    console.info(`[main] ⚡ ${cachedDebris.length} debris objects loaded from cache (instant)`);
  }

  // Hide loading overlay on first TLE load
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.add('hidden');

  // Status dot → online
  const dot = document.getElementById('status-dot');
  if (dot) { dot.classList.add('online'); dot.setAttribute('aria-label', 'Status: online'); }

  // Update header timestamp
  const tsEl = document.getElementById('stat-updated');
  if (tsEl && fetchedAt) tsEl.textContent = fetchedAt.toUTCString().slice(17, 25) + ' UTC';

  // Defer Brain.js LSTM — give Three.js several frames before blocking the thread
  setTimeout(() => _runDecayPipeline(records), 500);
});

startTLEPolling({
  group: 'active', maxAgeDays: 30,
  // auditLog array: every rejected TLE entry is forwarded to the Django DB
  auditLog: {
    push(entry) {
      postRejectionToDjango({
        noradId: entry.noradId,
        name:    entry.name,
        reason:  entry.reason,
      });
    }
  },
});

// ── Debris fetch — deferred background refresh ────────────────────────────
// The globe is already populated from localStorage cache (above).
// We wait 5 s before starting network fetches so the active-TLE download and
// initial SGP4 propagation finish first without bandwidth/CPU contention.
// On first ever load (no cache), debris appears after ~5-10 s total.
setTimeout(() => {
  fetchAllDebris({ includeDecaying: false }).then((debrisRecords) => {
    if (debrisRecords.length === 0) {
      console.warn('[main] fetchAllDebris returned 0 records — check CelesTrak connectivity');
      return;
    }

    // Merge into TLE map so tooltip + search panel can identify debris objects
    for (const r of debrisRecords) _tleMap.set(r.noradId, r);

    // Incrementally add to propagator without wiping active-satellite satrecs
    propagator.update(debrisRecords);

    // Update search data with the expanded catalogue
    updateSearchData(_tleMap, _pocMap, _posMap);

    console.info(`[main] ✓ ${debrisRecords.length} debris objects refreshed from network`);
  }).catch((err) => {
    console.error('[main] fetchAllDebris failed:', err.message);
  });
}, 5_000);  // 5-second delay — lets active TLE load + first propagation complete first

// ═══════════════════════════════════════════════════════════════════════════
// 4. Brain.js LSTM decay pipeline
// ═══════════════════════════════════════════════════════════════════════════

let _decayNet = null;

async function _runDecayPipeline(records) {
  const loaderSub = document.getElementById('loader-sub');
  if (loaderSub) loaderSub.textContent = 'Training decay model…';

  // Cap at 200 sequences — training time is O(n × iterations), and LSTM
  // generalises well from a representative subset for altitude-decay detection.
  const sequences = buildDecaySequences(records, 10).slice(0, 200);
  console.info(`[decay] ${sequences.length} sequences built (capped at 200)`);

  if (sequences.length === 0) return;

  // Yield one more frame so the globe is definitely rendered before the
  // synchronous Brain.js training loop starts.
  await new Promise(resolve => requestAnimationFrame(resolve));

  const { net, trainLog } = trainDecayModel(sequences, {
    iterations: 200,   // reduced from 500 — converges in <1 s for 200 sequences
    learningRate: 0.01,
  });
  _decayNet = net;

  const { alerts } = detectReentryThreats(sequences, net, predictDecay, {
    steps: 3, thresholdKm: 250,
  });

  // Update decay sidebar
  updateDecayPanel(alerts);

  // Dispatch for decayPanel listener
  document.dispatchEvent(
    new CustomEvent('novasentinel:decay-update', { detail: { alerts } })
  );

  // Update header reentry stat
  const rEl = document.getElementById('stat-reentry');
  if (rEl) rEl.textContent = alerts.length > 0 ? `⚠ ${alerts.length}` : '0';

  console.info(`[decay] ${alerts.length} reentry alerts | LSTM error=${trainLog.error?.toFixed(5) ?? 'N/A'}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. TF.js PoC model
// ═══════════════════════════════════════════════════════════════════════════

async function _initMLModel() {
  try {
    _pocModel = await loadModel();
    console.info('[main] PoC model loaded');
  } catch (err) {
    console.warn('[main] PoC model unavailable:', err.message);
  }
}
_initMLModel();

// ═══════════════════════════════════════════════════════════════════════════
// 6. CDM polling → ellipsoids + alert panel
// ═══════════════════════════════════════════════════════════════════════════

function _cdmToConjunction(cdm) {
  return {
    missDistanceKm:     parseFloat(cdm.MISS_DISTANCE ?? 0),
    relVelocityKms:     parseFloat(cdm.RELATIVE_SPEED ?? 0),
    mahalanobisDistance: cdm.MAHALANOBIS_DISTANCE ? parseFloat(cdm.MAHALANOBIS_DISTANCE) : null,
    combinedCovBplane:  null,
    incPrimaryDeg:      parseFloat(cdm.SAT1_INCLINATION ?? 0),
    incSecondaryDeg:    parseFloat(cdm.SAT2_INCLINATION ?? 0),
    raanDiffDeg:        Math.abs(parseFloat(cdm.SAT1_RAAN ?? 0) - parseFloat(cdm.SAT2_RAAN ?? 0)),
    altPrimaryKm:       parseFloat(cdm.SAT1_ALTITUDE ?? 500),
    altSecondaryKm:     parseFloat(cdm.SAT2_ALTITUDE ?? 500),
    bstarPrimary:       parseFloat(cdm.SAT1_BSTAR ?? 0),
    tleAgeDays:         cdm.TLE_AGE ? parseFloat(cdm.TLE_AGE) : 1,
    isDebris:           (cdm.SAT2_OBJECT_TYPE ?? '').toUpperCase().includes('DEBRIS'),
  };
}

async function _scoreCDMs(records) {
  if (!_pocModel || records.length === 0) return [];
  const conjs   = records.map(_cdmToConjunction);
  const vectors = conjs.map(buildFeatureVector);
  const scores  = await batchInferPoC(_pocModel, vectors);
  return records.map((cdm, i) => ({ cdm, pocScore: scores[i] }));
}

function _rebuildEllipsoids(records) {
  clearEllipsoids(ellipsoidGroup);
  _ellipsoids = [];

  for (const rec of records.slice(0, 50)) {  // cap at 50 for performance
    try {
      const poc  = parseFloat(rec.PC ?? 'NaN') || null;
      const { axes } = cdmToEllipsoidAxes(rec);
      const mesh = createUncertaintyEllipsoid(axes, poc);
      mesh.visible = _showEllipsoids;

      // Position at primary object's current location
      const norad = rec.SAT1_NORAD_CAT_ID;
      const pos   = _posMap.get(String(norad));
      if (pos) {
        const world = new THREE.Vector3(pos.eciPos.x, pos.eciPos.y, pos.eciPos.z)
          .multiplyScalar(1 / 6371);          // ECI km → scene units
        mesh.position.copy(world);

        if (pos.eciPos) {
          // Approximate RTN orientation from radial direction
          orientEllipsoidRTN(
            mesh,
            world,
            new THREE.Vector3(0, 0.001, 0)   // placeholder velocity; real vel needs worker data
          );
        }
      }

      ellipsoidGroup.add(mesh);
      _ellipsoids.push(mesh);
    } catch (err) {
      console.warn('[main] Ellipsoid build failed:', err.message);
    }
  }
}

onCDMUpdate(async (records, fetchedAt) => {
  console.info(`[main] CDM update — ${records.length} records`);
  _cdmRecords = records;

  // ML scoring
  const scored = await _scoreCDMs(records);
  for (const { cdm, pocScore } of scored) {
    const id1 = String(cdm.SAT1_NORAD_CAT_ID ?? '');
    const id2 = String(cdm.SAT2_NORAD_CAT_ID ?? '');
    if (id1) _pocMap.set(id1, Math.max(_pocMap.get(id1) ?? 0, pocScore));
    if (id2) _pocMap.set(id2, Math.max(_pocMap.get(id2) ?? 0, pocScore));

    // Persist to Django when PoC exceeds the minimum threshold (1e-6)
    if (pocScore >= 1e-6) {
      postConjunctionToDjango({
        noradPrimary:   String(cdm.SAT1_NORAD_CAT_ID ?? ''),
        namePrimary:    cdm.SAT1_OBJECT_DESIGNATOR ?? '',
        noradSecondary: String(cdm.SAT2_NORAD_CAT_ID ?? ''),
        nameSecondary:  cdm.SAT2_OBJECT_DESIGNATOR ?? '',
        pocScore:       pocScore,
        missDistance:   parseFloat(cdm.MISS_DISTANCE ?? 0),
        relVelocity:    parseFloat(cdm.RELATIVE_SPEED ?? 0),
        tca:            cdm.TCA ?? new Date().toISOString(),
        isDebris:       (cdm.SAT2_OBJECT_TYPE ?? '').toUpperCase().includes('DEBRIS'),
        cdmId:          cdm.CDM_ID ?? '',
      });
    }
  }

  // Sync updated PoC scores to search panel (after all CDMs processed)
  updateSearchData(_tleMap, _pocMap, _posMap);

  // Patch CDM records with ML PoC where CDM field is missing
  const enriched = records.map(r => ({
    ...r,
    PC: r.PC ?? scored.find(s => s.cdm === r)?.pocScore?.toExponential(4) ?? null,
  }));

  updateAlertPanel(enriched);

  // Update conjunction stat
  const cEl = document.getElementById('stat-conjunctions');
  if (cEl) cEl.textContent = records.length;

  // Rebuild CDM ellipsoids
  _rebuildEllipsoids(enriched);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. UI initialisation
// ═══════════════════════════════════════════════════════════════════════════

// Alert panel
initAlertPanel({
  onSelect(cdmRec) {
    // Fly camera to conjunction midpoint
    const n1  = String(cdmRec.SAT1_NORAD_CAT_ID ?? '');
    const n2  = String(cdmRec.SAT2_NORAD_CAT_ID ?? '');
    const p1  = _posMap.get(n1);
    const p2  = _posMap.get(n2);
    if (p1 && p2) {
      const toScene = (p) => new THREE.Vector3(p.eciPos.x, p.eciPos.y, p.eciPos.z)
        .multiplyScalar(1 / 6371);
      flyToConjunction(camera, controls, toScene(p1), toScene(p2));
    }
  },
  onEllipsoidToggle(visible) {
    _showEllipsoids = visible;
    _ellipsoids.forEach(m => { m.visible = visible; });
  },
});

// Decay panel
initDecayPanel();

// Tooltip
initTooltip(canvas, camera, _posMap);

// Search panel
initSearch();

// Reset camera button (guards against clicks before scene loads)
document.getElementById('reset-camera-btn')?.addEventListener('click', () => {
  if (camera && controls) {
    resetCamera(camera, controls);
  }
});

// ── Notification bell toggle ──────────────────────────────────────────────
(function _initNotifBell() {
  const btn       = document.getElementById('notif-btn');
  const popup     = document.getElementById('notif-popup');
  const inner     = document.getElementById('notif-popup-inner');
  const decayEl   = document.getElementById('decay-panel');
  const alertEl   = document.getElementById('alert-panel');
  const badge     = document.getElementById('notif-badge');

  if (!btn || !popup || !inner) return;

  let open = false;

  function _mount() {
    if (decayEl) { decayEl.classList.remove('panel-hidden'); inner.appendChild(decayEl); }
    if (alertEl) { alertEl.classList.remove('panel-hidden'); inner.appendChild(alertEl); }
  }

  function _unmount() {
    if (decayEl) { document.body.appendChild(decayEl); decayEl.classList.add('panel-hidden'); }
    if (alertEl) { document.body.appendChild(alertEl); alertEl.classList.add('panel-hidden'); }
  }

  btn.addEventListener('click', () => {
    open = !open;
    if (open) {
      _mount();
      popup.classList.remove('hidden');
      btn.classList.add('active');
    } else {
      _unmount();
      popup.classList.add('hidden');
      btn.classList.remove('active');
    }
  });

  // Update badge count from decay alerts
  document.addEventListener('novasentinel:decay-update', (e) => {
    const count = (e.detail?.alerts?.length ?? 0);
    if (badge) {
      if (count > 0) {
        badge.textContent = count;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
  });
})();

// Ellipsoid visibility event (from alert panel toggle)
document.addEventListener('novasentinel:ellipsoid-toggle', (e) => {
  _showEllipsoids = e.detail.visible;
  _ellipsoids.forEach(m => { m.visible = e.detail.visible; });
});

// Search fly-to event — camera zooms to the selected satellite
document.addEventListener('novasentinel:search-fly', (e) => {
  const noradId = String(e.detail?.noradId ?? '');
  _selectedNoradId = noradId;
  _followCamera    = false;   // reset follow on new selection

  if (!camera || !controls || !cloud) return; // Guard against early clicks

  // Immediately update colors and sizes in the point cloud
  updateCataloguePositions(cloud, _posMap, {
    colorFn: satelliteColor,
    selectedNoradId: _selectedNoradId,
  });

  // Calculate and display the orbital trajectory line
  const record = _tleMap.get(noradId);
  if (record?.satrec) {
    updateOrbitLineGeometry(orbitLine, record.satrec, new Date());
    const pos = _posMap.get(noradId);
    if (pos) orbitLine.material.color.copy(satelliteColor(pos, noradId));
  } else {
    orbitLine.visible = false;
  }

  // Guard: need a valid propagated position with lat/lon
  const pos = _posMap.get(noradId);
  if (!pos || pos.lat == null) {
    console.warn('[main] No lat/lon position for satellite', noradId, '— skipping fly-to');
    return;
  }

  // Convert geodetic lat/lon → scene units (globe radius = 1)
  const satWorldObj = geoToWorld(pos.lat, pos.lon, pos.altKm, 1);
  const satWorld = new THREE.Vector3(satWorldObj.x, satWorldObj.y, satWorldObj.z);

  // Fly camera to a point above the satellite using the dedicated flyToPoint helper
  flyToPoint(camera, controls, satWorld, { distance: 0.45 });
});

// Follow-mode toggle from the result card
document.addEventListener('novasentinel:follow-toggle', (e) => {
  _followCamera = e.detail?.follow ?? false;
});

// Search clear event — restores all satellites to original visibility and hides orbit path
document.addEventListener('novasentinel:search-clear', () => {
  _selectedNoradId = null;
  orbitLine.visible = false;
  
  // Immediately update colors and sizes back to normal
  updateCataloguePositions(cloud, _posMap, {
    colorFn: satelliteColor,
    selectedNoradId: null,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Space-Track CDM polling
// ═══════════════════════════════════════════════════════════════════════════

const identity = import.meta.env.VITE_SPACETRACK_IDENTITY;
const password = import.meta.env.VITE_SPACETRACK_PASSWORD;

if (!identity || !password) {
  console.warn('[main] Space-Track credentials missing — CDM panel will be empty.');
} else {
  const ok = await loginSpaceTrack(identity, password);
  if (ok) startNormalPolling();
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Graceful shutdown
// ═══════════════════════════════════════════════════════════════════════════

window.addEventListener('beforeunload', () => {
  stopLoop();
  propagator.stop();
  disposeModel(_pocModel);
  earth.dispose();
  ctx.dispose();
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Service Worker — offline TLE/CDM caching
// ═══════════════════════════════════════════════════════════════════════════

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => console.info('[SW] Registered, scope:', reg.scope))
      .catch(err => console.warn('[SW] Registration failed:', err.message));
  });
}

