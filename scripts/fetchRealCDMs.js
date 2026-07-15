import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as satellite from 'satellite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const envStr = fs.existsSync(path.join(ROOT, '.env')) 
  ? fs.readFileSync(path.join(ROOT, '.env'), 'utf-8')
  : '';

const env = {};
for (const line of envStr.split('\n')) {
  if (line.trim() === '' || line.startsWith('#')) continue;
  if (line.includes('=')) {
    const [k, ...v] = line.split('=');
    env[k.trim()] = v.join('=').trim();
  }
}

const MAX_CDMS = 2000;
const PC_THRESHOLD = 1e-4;

async function loginSpaceTrack() {
  const identity = env.VITE_SPACETRACK_IDENTITY;
  const password = env.VITE_SPACETRACK_PASSWORD;
  
  if (!identity || !password) {
    throw new Error('Missing Space-Track credentials in .env');
  }

  const loginRes = await fetch('https://www.space-track.org/ajaxauth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `identity=${encodeURIComponent(identity)}&password=${encodeURIComponent(password)}`
  });
  
  if (!loginRes.ok) throw new Error('Space-Track login failed');
  return loginRes.headers.get('set-cookie');
}

async function fetchCDMs(cookies) {
  console.log(`[fetch] Downloading up to ${MAX_CDMS} recent CDMs...`);
  const url = `https://www.space-track.org/basicspacedata/query/class/cdm_public/orderby/TCA%20desc/limit/${MAX_CDMS}/format/json`;
  const res = await fetch(url, { headers: { 'Cookie': cookies } });
  if (!res.ok) throw new Error('Failed to fetch CDMs');
  const data = await res.json();
  console.log(`[fetch] Downloaded ${data.length} CDMs.`);
  return data;
}

async function fetchTLEs(cookies, noradIds) {
  const uniqueIds = [...new Set(noradIds)];
  console.log(`[fetch] Fetching TLEs for ${uniqueIds.length} unique satellites...`);
  
  let results = [];
  // Batch requests in chunks of 200
  for (let i = 0; i < uniqueIds.length; i += 200) {
    const batch = uniqueIds.slice(i, i + 200).join(',');
    const url = `https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/${batch}/orderby/EPOCH%20desc/format/json`;
    const res = await fetch(url, { headers: { 'Cookie': cookies } });
    if (res.ok) {
      const data = await res.json();
      results = results.concat(data);
    }
  }
  
  const latestTLEs = {};
  for (const t of results) {
    if (!latestTLEs[t.NORAD_CAT_ID] || new Date(t.EPOCH) > new Date(latestTLEs[t.NORAD_CAT_ID].EPOCH)) {
      latestTLEs[t.NORAD_CAT_ID] = t;
    }
  }
  return latestTLEs;
}

function computeDerivedFeatures(cdm, tle1, tle2) {
  const tca = new Date(cdm.TCA);
  
  // Propagate to TCA
  const satrec1 = satellite.twoline2satrec(tle1.TLE_LINE1, tle1.TLE_LINE2);
  const satrec2 = satellite.twoline2satrec(tle2.TLE_LINE1, tle2.TLE_LINE2);
  
  const pv1 = satellite.propagate(satrec1, tca);
  const pv2 = satellite.propagate(satrec2, tca);
  
  let relVelocityKms = 10; // Default fallback
  let altPrimaryKm = 500;
  let altSecondaryKm = 500;

  if (pv1.position && pv2.position && pv1.velocity && pv2.velocity) {
    // Relative velocity
    const vx = pv1.velocity.x - pv2.velocity.x;
    const vy = pv1.velocity.y - pv2.velocity.y;
    const vz = pv1.velocity.z - pv2.velocity.z;
    relVelocityKms = Math.sqrt(vx*vx + vy*vy + vz*vz);
    
    // Altitude
    const gmst = satellite.gstime(tca);
    const gd1 = satellite.eciToGeodetic(pv1.position, gmst);
    const gd2 = satellite.eciToGeodetic(pv2.position, gmst);
    altPrimaryKm = gd1.height;
    altSecondaryKm = gd2.height;
  }

  const epoch1 = new Date(tle1.EPOCH);
  const tleAgeDays = Math.max(0, (tca - epoch1) / (1000 * 60 * 60 * 24));
  
  const raan1 = parseFloat(tle1.RA_OF_ASC_NODE);
  const raan2 = parseFloat(tle2.RA_OF_ASC_NODE);
  let raanDiffDeg = Math.abs(raan1 - raan2);
  if (raanDiffDeg > 180) raanDiffDeg = 360 - raanDiffDeg;

  return {
    relVelocityKms,
    altPrimaryKm,
    altSecondaryKm,
    tleAgeDays,
    raanDiffDeg
  };
}

async function main() {
  console.log('=== NovaSentinel Real Data Fetcher ===\n');
  const cookies = await loginSpaceTrack();
  console.log('[fetch] Authenticated with Space-Track.');

  const cdms = await fetchCDMs(cookies);
  
  const noradIds = [];
  for (const c of cdms) {
    if (c.SAT_1_ID) noradIds.push(c.SAT_1_ID);
    if (c.SAT_2_ID) noradIds.push(c.SAT_2_ID);
  }
  
  const tles = await fetchTLEs(cookies, noradIds);
  
  const events = [];
  let validCount = 0;

  for (const cdm of cdms) {
    const pc = parseFloat(cdm.PC || 0);
    const id1 = cdm.SAT_1_ID;
    const id2 = cdm.SAT_2_ID;
    
    const tle1 = tles[id1];
    const tle2 = tles[id2];
    
    if (!tle1 || !tle2) continue; // Skip if missing TLE
    validCount++;

    const derived = computeDerivedFeatures(cdm, tle1, tle2);
    const isDebris = (cdm.SAT1_OBJECT_TYPE === 'DEBRIS' || cdm.SAT2_OBJECT_TYPE === 'DEBRIS');
    
    events.push({
      id: cdm.CDM_ID,
      eventId: cdm.CDM_ID,
      cdmId: cdm.CDM_ID,
      missDistanceKm: parseFloat(cdm.MIN_RNG || 0) / 1000,
      relVelocityKms: derived.relVelocityKms,
      mahalanobisDistance: null, // Not in public CDM
      combinedCovBplane: null,   // Not in public CDM
      incPrimaryDeg: parseFloat(tle1.INCLINATION),
      incSecondaryDeg: parseFloat(tle2.INCLINATION),
      raanDiffDeg: derived.raanDiffDeg,
      altPrimaryKm: derived.altPrimaryKm,
      altSecondaryKm: derived.altSecondaryKm,
      bstarPrimary: parseFloat(tle1.BSTAR),
      tleAgeDays: derived.tleAgeDays,
      isDebris,
      pocScore: pc,
      label: pc > PC_THRESHOLD ? 1 : 0
    });
  }
  
  console.log(`[fetch] Successfully processed ${validCount} valid conjunctions.`);
  
  const nPos = events.filter(e => e.label === 1).length;
  console.log(`[fetch] Class distribution: ${events.length - nPos} neg / ${nPos} pos (${(100 * nPos / events.length).toFixed(1)}% positive)`);
  
  const outPath = path.join(ROOT, 'data', 'cara-events.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(events, null, 2));
  console.log(`[fetch] Wrote ${outPath}`);
}

main().catch(err => {
  console.error('[fetch] Fatal error:', err);
  process.exit(1);
});
