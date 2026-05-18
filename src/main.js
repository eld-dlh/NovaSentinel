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
import { startTLEPolling, onTLEUpdate }                from './data/tleFetch.js';
import { loginSpaceTrack, startNormalPolling,
         onCDMUpdate }                                 from './data/cdmFetch.js';
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
import { createCatalogueCloud,
         updateCataloguePositions }                   from './viz/catalogue.js';
import { createUncertaintyEllipsoid, orientEllipsoidRTN,
         clearEllipsoids }                            from './viz/ellipsoid.js';
import { pocToColor }                                 from './viz/riskColors.js';
import { flyToConjunction, resetCamera }              from './viz/cameraControls.js';
import * as THREE                                     from 'three';

// ── UI ────────────────────────────────────────────────────────────────────
import { initAlertPanel, updateAlertPanel }           from './ui/alertPanel.js';
import { initDecayPanel, updateDecayPanel }           from './ui/decayPanel.js';
import { initTooltip, registerTooltipData }           from './ui/objectTooltip.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Bootstrap Three.js scene
// ═══════════════════════════════════════════════════════════════════════════

const canvas = document.getElementById('globe-canvas');
const ctx    = initScene(canvas);
const { renderer, scene, camera, controls } = ctx;

// Earth globe + atmosphere
const earth = createEarth(scene);

// Satellite point cloud (up to 12k objects)
const cloud = createCatalogueCloud(scene, {
  maxObjects:   12_000,
  pointSize:    2.8,
  defaultColor: new THREE.Color(0x4fc3f7),
});

// Group for CDM ellipsoids
const ellipsoidGroup = new THREE.Group();
ellipsoidGroup.name  = 'ellipsoids';
scene.add(ellipsoidGroup);

// ── State ────────────────────────────────────────────────────────────────
let _pocMap      = new Map();  // noradId → PoC score
let _tleMap      = new Map();  // noradId → TLERecord
let _posMap      = new Map();  // noradId → CachedPosition (live reference from propagator)
let _cdmRecords  = [];
let _ellipsoids  = [];         // THREE.Mesh[] parallel to _cdmRecords
let _showEllipsoids = true;
let _pocModel    = null;

// ── Colour function for updateCataloguePositions ─────────────────────────
function satelliteColor(pos, noradId) {
  const poc = _pocMap.get(noradId) ?? null;
  if (poc != null) return pocToColor(poc);
  // Default: altitude-tinted (lower = warmer)
  const alt   = pos.altKm ?? 400;
  const t     = Math.max(0, Math.min(1, (alt - 200) / 1800)); // 200-2000 km range
  return new THREE.Color().setHSL(0.55 + t * 0.15, 0.9, 0.55 + t * 0.1);
}

// ── Render loop ───────────────────────────────────────────────────────────
const stopLoop = startRenderLoop(ctx, (dt) => {
  earth.tick(dt);  // slow Earth rotation
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Propagation pipeline
// ═══════════════════════════════════════════════════════════════════════════

const propagator = createPropagator({
  intervalMs: 30_000,
  useWorker:  typeof Worker !== 'undefined',
  onError(errors) {
    if (errors.length > 0)
      console.warn(`[main] ${errors.length} propagation errors`);
  },
});

propagator.start((positionMap) => {
  _posMap = positionMap;

  updateCataloguePositions(cloud, positionMap, {
    colorFn: satelliteColor,
  });

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

  // Load into propagator
  propagator.load(records);

  // Hide loading overlay on first TLE load
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.add('hidden');

  // Status dot → online
  const dot = document.getElementById('status-dot');
  if (dot) { dot.classList.add('online'); dot.setAttribute('aria-label', 'Status: online'); }

  // Update header timestamp
  const tsEl = document.getElementById('stat-updated');
  if (tsEl && fetchedAt) tsEl.textContent = fetchedAt.toUTCString().slice(17, 25) + ' UTC';

  // Defer Brain.js LSTM so render loop gets first frame
  setTimeout(() => _runDecayPipeline(records), 0);
});

startTLEPolling({ group: 'active', maxAgeDays: 30 });

// ═══════════════════════════════════════════════════════════════════════════
// 4. Brain.js LSTM decay pipeline
// ═══════════════════════════════════════════════════════════════════════════

let _decayNet = null;

async function _runDecayPipeline(records) {
  const loaderSub = document.getElementById('loader-sub');
  if (loaderSub) loaderSub.textContent = 'Training decay model…';

  const sequences = buildDecaySequences(records, 10);
  console.info(`[decay] ${sequences.length} sequences built`);

  if (sequences.length === 0) return;

  const { net, trainLog } = trainDecayModel(sequences, {
    iterations: 500, learningRate: 0.01,
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
  }

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

// Reset camera button
document.getElementById('reset-camera-btn')?.addEventListener('click', () => {
  resetCamera(camera, controls);
});

// Ellipsoid visibility event (from alert panel toggle)
document.addEventListener('novasentinel:ellipsoid-toggle', (e) => {
  _showEllipsoids = e.detail.visible;
  _ellipsoids.forEach(m => { m.visible = e.detail.visible; });
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

