import { computeChecksum } from './src/data/tleValidator.js';
console.log('ISS 1:', computeChecksum('1 25544U 98067A   24001.50000000  .00002182  00000-0  40333-4 0  9990'));
console.log('ISS 2:', computeChecksum('2 25544  51.6400 181.0000 0003210  87.0000 273.1000 15.50000000000012'));
console.log('STARLINK 1:', computeChecksum('1 44713U 19074A   24001.50000000  .00001234  00000-0  90123-4 0  9998'));
