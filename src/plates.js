import * as THREE from 'three';
import { R, latLonToVec3 } from './scene.js';
import boundaries from './assets/plate-boundaries.json';

// One LineSegments object for every plate boundary — a single draw call.
export function createPlateBoundaries() {
  const positions = [];

  const addLine = coords => {
    for (let i = 0; i < coords.length - 1; i++) {
      const a = latLonToVec3(coords[i][1], coords[i][0], R * 1.002);
      const b = latLonToVec3(coords[i + 1][1], coords[i + 1][0], R * 1.002);
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  };

  for (const f of boundaries.features) {
    const { type, coordinates } = f.geometry;
    if (type === 'LineString') addLine(coordinates);
    else if (type === 'MultiLineString') coordinates.forEach(addLine);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: 0xff8c42, transparent: true, opacity: 0.4 })
  );
  lines.visible = true;
  return lines;
}
