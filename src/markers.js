import * as THREE from 'three';
import { R, latLonToVec3 } from './scene.js';

const CAPACITY = 15000; // all_month is ~10k events; leave headroom

export function magColor(m) {
  if (m >= 6) return 0xef4444;
  if (m >= 4.5) return 0xfb923c;
  if (m >= 3) return 0xfacc15;
  return 0x4ade80;
}

const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const WHITE = new THREE.Color(0xffffff);
const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

// All quake spikes live in a single InstancedMesh; per-quake records keep the
// feature data and the instanceId ↔ quake mapping for raycast picking.
export class QuakeMarkers {
  constructor(parent) {
    // Unit cone, base at origin, tip at +Y — per-instance scale sets width/height
    const geo = new THREE.ConeGeometry(1, 1, 6);
    geo.translate(0, 0.5, 0);
    this.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.92 });
    this.mesh = new THREE.InstancedMesh(geo, this.material, CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    parent.add(this.mesh);

    this.ringGroup = new THREE.Group();
    parent.add(this.ringGroup);
    this.ringGeo = new THREE.RingGeometry(1, 1.35, 32);

    this.quakes = [];      // per-instance records, index === instanceId
    this.pulseRings = [];
    this.minMag = 0;
    this.hoveredId = null;
  }

  setData(features) {
    this.clearRings();
    this.hoveredId = null;
    const now = Date.now();

    this.quakes = features.slice(0, CAPACITY).map(f => {
      const [lon, lat, depth] = f.geometry.coordinates;
      const mag = Math.max(f.properties.mag, 0.1);
      const normal = latLonToVec3(lat, lon, 1);
      return {
        feature: f,
        mag, lat, lon, depth: depth || 0,
        normal,
        h: Math.max(1.5, mag * mag * 0.55),
        w: Math.max(0.4, mag * 0.28),
        color: magColor(mag),
        recent: now - f.properties.time < 2 * 3600 * 1000,
        shown: true,
      };
    });

    this.mesh.count = this.quakes.length;
    this.quakes.forEach((q, i) => {
      this.mesh.setColorAt(i, _color.set(q.color));
      if (q.recent) this.addPulseRing(q);
    });
    this.applyFilter(this.minMag);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  writeMatrix(i, q) {
    _quat.setFromUnitVectors(UP, q.normal);
    _scale.set(q.w, q.h, q.w);
    _mat4.compose(q.normal.clone().multiplyScalar(R), _quat, _scale);
    this.mesh.setMatrixAt(i, _mat4);
  }

  // Hidden instances get a zero-scale matrix: not rendered, not raycast-hittable
  applyFilter(minMag) {
    this.minMag = minMag;
    this.quakes.forEach((q, i) => {
      q.shown = q.mag >= minMag;
      if (q.shown) this.writeMatrix(i, q);
      else this.mesh.setMatrixAt(i, ZERO);
      if (q.ring) q.ring.visible = q.shown;
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
  }

  addPulseRing(q) {
    const ring = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({ color: q.color, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    );
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), q.normal);
    ring.position.copy(q.normal).multiplyScalar(R + 0.3);
    ring.userData.baseScale = Math.max(1.5, q.mag * 1.2);
    this.ringGroup.add(ring);
    this.pulseRings.push(ring);
    q.ring = ring;
  }

  clearRings() {
    this.pulseRings.forEach(r => r.material.dispose());
    this.ringGroup.clear();
    this.pulseRings = [];
  }

  // → quake record or null. instanceId indexes straight into this.quakes.
  pick(raycaster) {
    const hits = raycaster.intersectObject(this.mesh);
    if (!hits.length) return null;
    const id = hits[0].instanceId;
    const q = this.quakes[id];
    return q && q.shown ? { id, quake: q } : null;
  }

  setHovered(id) {
    if (this.hoveredId === id) return;
    if (this.hoveredId !== null) {
      const prev = this.quakes[this.hoveredId];
      if (prev) this.mesh.setColorAt(this.hoveredId, _color.set(prev.color));
    }
    this.hoveredId = id;
    if (id !== null) {
      const q = this.quakes[id];
      this.mesh.setColorAt(id, _color.set(q.color).lerp(WHITE, 0.45));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(t) {
    this.pulseRings.forEach((r, i) => {
      const s = r.userData.baseScale * (1 + 0.5 * Math.sin(t * 3 + i));
      r.scale.set(s, s, s);
      r.material.opacity = 0.35 + 0.35 * Math.sin(t * 3 + i);
    });
  }

  visibleStats() {
    let count = 0, max = -Infinity, maxPlace = '';
    for (const q of this.quakes) {
      if (!q.shown) continue;
      count++;
      if (q.mag > max) { max = q.mag; maxPlace = q.feature.properties.place || ''; }
    }
    return { count, max, maxPlace };
  }
}
