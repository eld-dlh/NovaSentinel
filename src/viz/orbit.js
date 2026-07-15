import * as THREE from 'three';
import * as satellite from 'satellite.js';

const EARTH_RADIUS_KM = 6371;

/**
 * Computes 120 points along the satellite's orbit for a closed loop in world space.
 * Uses the constant GMST of the current time to freeze Earth rotation for the loop.
 *
 * @param {object} satrec - satellite.js satrec object
 * @param {Date} currentDate - current epoch
 * @param {number} pointsCount - number of points (default 120)
 * @returns {THREE.Vector3[]}
 */
export function getOrbitPoints(satrec, currentDate = new Date(), pointsCount = 120) {
  const points = [];
  if (!satrec || satrec.error !== 0) return points;

  // Orbital period in minutes: T = 2*pi / no (radians/min)
  const periodMin = (2 * Math.PI) / satrec.no;
  const stepMs = (periodMin * 60 * 1000) / pointsCount;
  const startMs = currentDate.getTime();
  const gmst = satellite.gstime(currentDate); // freeze GMST to make a closed loop

  for (let i = 0; i <= pointsCount; i++) {
    const time = new Date(startMs + i * stepMs);
    const pv = satellite.propagate(satrec, time);
    if (pv.position && pv.position !== false) {
      const geo = satellite.eciToGeodetic(pv.position, gmst);
      const latDeg = satellite.degreesLat(geo.latitude);
      const lonDeg = satellite.degreesLong(geo.longitude);
      const altKm = geo.height;

      // Convert to Three.js world space coordinates (globe radius = 1)
      const r = 1 + altKm / EARTH_RADIUS_KM;
      const phi = (90 - latDeg) * (Math.PI / 180);
      const theta = lonDeg * (Math.PI / 180);

      points.push(new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta)
      ));
    }
  }
  return points;
}

/**
 * Creates a glowing, transparent LineLoop for the orbit.
 *
 * @returns {THREE.Line}
 */
export function createOrbitLine() {
  const geometry = new THREE.BufferGeometry();
  // Initialize with empty array
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));

  const material = new THREE.LineBasicMaterial({
    color: 0x00ffff,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    linewidth: 2,
  });

  const line = new THREE.Line(geometry, material);
  line.name = 'selected-satellite-orbit';
  line.visible = false;
  return line;
}

/**
 * Updates the orbit line geometry with the points for a selected satellite.
 *
 * @param {THREE.Line} line
 * @param {object} satrec
 * @param {Date} currentDate
 */
export function updateOrbitLineGeometry(line, satrec, currentDate = new Date()) {
  if (!satrec) {
    line.visible = false;
    return;
  }

  const points = getOrbitPoints(satrec, currentDate);
  if (points.length === 0) {
    line.visible = false;
    return;
  }

  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints(points);
  line.visible = true;
}
