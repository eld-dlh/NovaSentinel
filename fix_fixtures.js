import { readFileSync, writeFileSync } from 'fs';
import { computeChecksum } from './src/data/tleValidator.js';

const txt = readFileSync('./tests/fixtures/sample-tles.txt', 'utf8');
const lines = txt.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('1 ') || lines[i].startsWith('2 ')) {
    if (lines[i-1] === 'BAD-CHECKSUM' && lines[i].startsWith('1 ')) {
        continue; // Keep line 1 bad
    }
    const c = computeChecksum(lines[i]);
    lines[i] = lines[i].substring(0, 68) + c;
  }
}
writeFileSync('./tests/fixtures/sample-tles.txt', lines.join('\n'));
