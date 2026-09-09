#!/usr/bin/env node
// scripts/generateTLECache.js  (v4 — uses satrec.no for mean motion)
//
// Builds data/tle-cache.json with synthetic multi-epoch sequences.
// Each real TLE is replicated 12 times with daily epoch offsets so
// buildDecaySequences() receives sequences of length >= 10 per object.
//
// NOTE: satellite.js stores mean motion as `satrec.no` (rad/min);
//       buildDecaySequences() reads `rec.satrec.no_kozai` — we alias
//       `no_kozai = no` in the serialised record so both paths work.
//
// Usage:  node scripts/generateTLECache.js

import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname }         from 'path';
import { fileURLToPath }            from 'url';
import * as satellite               from 'satellite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..');

const MS_PER_DAY = 86_400_000;
const SEQ_STEPS  = 12;          // epochs per object (needs >= 10 for seqLen=10)

const GROUPS = [
  ['https://celestrak.org/NORAD/elements/gp.php?GROUP=cosmos-2251-debris&FORMAT=tle', 'Cosmos-2251 debris'],
  ['https://celestrak.org/NORAD/elements/gp.php?GROUP=iridium-33-debris&FORMAT=tle',  'Iridium-33 debris'],
  ['https://celestrak.org/NORAD/elements/gp.php?GROUP=fengyun-1c-debris&FORMAT=tle',  'Fengyun-1C debris'],
  ['https://celestrak.org/NORAD/elements/gp.php?GROUP=cosmos-1408-debris&FORMAT=tle', 'Cosmos-1408 debris'],
];

async function fetchGroup(url, label) {
  console.log(`[tle-cache] Fetching ${label}...`);
  try {
    const res = await fetch(url);
    if (!res.ok) { console.warn(`  WARN: HTTP ${res.status}`); return []; }
    const text  = await res.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const out   = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
      const name  = lines[i];
      const line1 = lines[i + 1];
      const line2 = lines[i + 2];
      if (!line1?.startsWith('1 ') || !line2?.startsWith('2 ')) continue;
      try {
        const sr = satellite.twoline2satrec(line1, line2);
        if (sr.error !== 0) continue;
        // satellite.js uses `no` for mean motion (rad/min)
        const no_kozai = sr.no ?? sr.no_kozai;   // handle both API versions
        if (!no_kozai || no_kozai <= 0) continue;
        out.push({ name, line1, line2, sr, no_kozai });
      } catch { /* skip */ }
    }
    console.log(`  → ${out.length} valid records`);
    return out;
  } catch (e) {
    console.warn(`  ERROR: ${e.message}`);
    return [];
  }
}

const allRaw = (await Promise.all(GROUPS.map(([url, lbl]) => fetchGroup(url, lbl)))).flat();
console.log(`[tle-cache] Total raw records: ${allRaw.length}`);

if (allRaw.length === 0) {
  console.error('[tle-cache] No records — cannot generate cache.');
  process.exit(1);
}

// De-duplicate by NORAD ID
const seen   = new Set();
const unique = [];
for (const rec of allRaw) {
  const id = String(rec.sr.satnum).trim();
  if (id && !seen.has(id)) { seen.add(id); unique.push(rec); }
}
console.log(`[tle-cache] Unique objects: ${unique.length}`);

// Generate SEQ_STEPS synthetic epoch records per object
// Each step is 1 day apart; mean motion drifts upward (simulates slow decay).
const records = [];

for (const { name, line1, line2, sr, no_kozai } of unique) {
  const noradId = String(sr.satnum).trim();

  // Small drift: ~1e-7 rad/min/day (typical LEO decay for low-drag debris)
  const drift = Math.max(Math.abs(sr.bstar ?? 1e-4), 1e-5) * 1e-3;

  for (let step = 0; step < SEQ_STEPS; step++) {
    records.push({
      noradId,
      name,
      line1,
      line2,
      satrec: {
        satnum:    sr.satnum,
        epochyr:   sr.epochyr,
        epochdays: sr.epochdays + step,      // 1 day per step
        no_kozai:  no_kozai + drift * step,  // buildDecaySequences reads no_kozai
        no:        no_kozai + drift * step,  // satellite.js field
        bstar:     sr.bstar ?? 0,
        inclo:     sr.inclo,
        nodeo:     sr.nodeo,
        ecco:      sr.ecco,
        error:     0,
      },
    });
  }
}

console.log(`[tle-cache] Generated ${records.length} epoch records for ${unique.length} objects`);

const outPath = resolve(ROOT, 'data', 'tle-cache.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(records, null, 2));
console.log(`[tle-cache] Wrote ${outPath}`);
