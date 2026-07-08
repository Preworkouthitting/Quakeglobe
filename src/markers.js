import * as THREE from 'three';
import { R, latLonToVec3 } from './scene.js';

const CAPACITY = 15000; // all_month is ~10k events; leave headroom
const FLASH_MS = 1400;  // how long a quake glows after "occurring" in playback
// Material-level HDR multiplier: pushes marker colors past BLOOM_THRESHOLD
// so spikes/points glow while the globe beneath them stays bloom-free
const GLOW = 1.9;

export function magColor(m) {
  if (m >= 6) return 0xef4444;
  if (m >= 4.5) return 0xfb923c;
  if (m >= 3) return 0xfacc15;
  return 0x4ade80;
}

// Depth of the deepest quakes on Earth is ~700 km; ramp shallow→deep
const DEPTH_STOPS = [0xff8c42, 0xfacc15, 0x4ade80, 0x38bdf8, 0x8b5cf6].map(c => new THREE.Color(c));
export function depthColor(km, target = new THREE.Color()) {
  const t = Math.min(Math.max(km, 0) / 660, 1) * (DEPTH_STOPS.length - 1);
  const i = Math.min(Math.floor(t), DEPTH_STOPS.length - 2);
  return target.lerpColors(DEPTH_STOPS[i], DEPTH_STOPS[i + 1], t - i);
}

// 1 globe unit = 63.7 km at true scale; exaggerate 3× so subduction
// slabs read clearly without leaving the globe's silhouette
const KM_PER_UNIT = 6371 / R;
const DEPTH_EXAGGERATION = 3;

const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const WHITE = new THREE.Color(0xffffff);
const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

// All quake spikes live in a single InstancedMesh; per-quake records keep the
// feature data and the instanceId ↔ quake mapping for raycast picking.
// Visibility = mag ≥ minMag AND event time ≤ timeCutoff (timeline scrubber).
export class QuakeMarkers {
  constructor(parent) {
    // Unit cone, base at origin, tip at +Y — per-instance scale sets width/height
    const geo = new THREE.ConeGeometry(1, 1, 6);
    geo.translate(0, 0.5, 0);
    this.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.92 });
    this.material.color.setScalar(GLOW); // diffuse = color × instanceColor
    this.mesh = new THREE.InstancedMesh(geo, this.material, CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    parent.add(this.mesh);

    // Depth mode: spheres below the surface at (exaggerated) true depth
    const depthGeo = new THREE.SphereGeometry(1, 8, 6);
    this.depthMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85 });
    this.depthMaterial.color.setScalar(GLOW * 0.8); // deep violets need less push
    this.depthMesh = new THREE.InstancedMesh(depthGeo, this.depthMaterial, CAPACITY);
    this.depthMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.depthMesh.count = 0;
    this.depthMesh.visible = false;
    parent.add(this.depthMesh);
    this.mode = 'surface'; // 'surface' | 'depth'

    this.ringGroup = new THREE.Group();
    parent.add(this.ringGroup);
    this.ringGeo = new THREE.RingGeometry(1, 1.35, 32);

    this.quakes = [];      // per-instance records, index === instanceId
    this.pulseRings = [];
    this.minMag = 0;
    this.timeCutoff = Infinity;
    this.flashing = new Set(); // instanceIds currently flashing
    this.hoveredId = null;
  }

  setData(features) {
    this.clearRings();
    this.hoveredId = null;
    this.flashing.clear();
    const now = Date.now();

    this.quakes = features.slice(0, CAPACITY).map(f => {
      const [lon, lat, depth] = f.geometry.coordinates;
      const mag = Math.max(f.properties.mag, 0.1);
      const normal = latLonToVec3(lat, lon, 1);
      return {
        feature: f,
        time: f.properties.time,
        mag, lat, lon, depth: depth || 0,
        normal,
        h: Math.max(1.5, mag * mag * 0.55),
        w: Math.max(0.4, mag * 0.28),
        color: magColor(mag),
        recent: now - f.properties.time < 2 * 3600 * 1000,
        shown: true,
        flashUntil: 0,
      };
    });

    this.mesh.count = this.quakes.length;
    this.depthMesh.count = this.quakes.length;
    this.quakes.forEach((q, i) => {
      this.mesh.setColorAt(i, _color.set(q.color));
      this.depthMesh.setColorAt(i, depthColor(q.depth, _color));
      if (q.recent) this.addPulseRing(q);
    });
    this.timeCutoff = Infinity;
    this.updateVisibility();
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.depthMesh.instanceColor) this.depthMesh.instanceColor.needsUpdate = true;
  }

  get activeMesh() {
    return this.mode === 'depth' ? this.depthMesh : this.mesh;
  }

  writeMatrix(i, q, boost = 1) {
    if (this.mode === 'depth') {
      const r = R - (q.depth / KM_PER_UNIT) * DEPTH_EXAGGERATION;
      const s = Math.max(0.45, q.mag * 0.3) * boost;
      _scale.set(s, s, s);
      _mat4.compose(q.normal.clone().multiplyScalar(Math.max(r, 5)), _quat.identity(), _scale);
      this.depthMesh.setMatrixAt(i, _mat4);
    } else {
      _quat.setFromUnitVectors(UP, q.normal);
      _scale.set(q.w * boost, q.h * boost, q.w * boost);
      _mat4.compose(q.normal.clone().multiplyScalar(R), _quat, _scale);
      this.mesh.setMatrixAt(i, _mat4);
    }
  }

  setMode(mode) {
    if (this.mode === mode) return;
    // settle any active flashes in the old mode before switching
    for (const i of this.flashing) {
      const q = this.quakes[i];
      this.activeMesh.setColorAt(i, this.mode === 'depth' ? depthColor(q.depth, _color) : _color.set(q.color));
      q.flashUntil = 0;
    }
    this.flashing.clear();
    this.setHovered(null);
    this.mode = mode;
    this.mesh.visible = mode === 'surface';
    this.depthMesh.visible = mode === 'depth';
    this.ringGroup.visible = mode === 'surface';
    this.updateVisibility();
  }

  setMinMag(v) {
    this.minMag = v;
    this.updateVisibility();
  }

  // Move the timeline cutoff. flash=true (playback, not seek) makes quakes
  // whose time was just crossed glow bright, then settle.
  setTimeCutoff(t, { flash = false } = {}) {
    const prev = this.timeCutoff;
    this.timeCutoff = t;
    if (flash && t > prev) {
      const nowMs = performance.now();
      this.quakes.forEach((q, i) => {
        if (q.time > prev && q.time <= t && q.mag >= this.minMag) {
          q.flashUntil = nowMs + FLASH_MS;
          this.flashing.add(i);
        }
      });
    }
    this.updateVisibility();
  }

  // Hidden instances get a zero-scale matrix: not rendered, not raycast-hittable
  updateVisibility() {
    const mesh = this.activeMesh;
    this.quakes.forEach((q, i) => {
      q.shown = q.mag >= this.minMag && q.time <= this.timeCutoff;
      if (q.shown) this.writeMatrix(i, q);
      else mesh.setMatrixAt(i, ZERO);
      if (q.ring) q.ring.visible = q.shown;
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }

  addPulseRing(q) {
    const ring = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(q.color).multiplyScalar(1.7), // HDR → blooms
        transparent: true, opacity: 0.8, side: THREE.DoubleSide,
      })
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

  baseColor(q, target = _color) {
    return this.mode === 'depth' ? depthColor(q.depth, target) : target.set(q.color);
  }

  // → { id, quake } or null. instanceId indexes straight into this.quakes.
  pick(raycaster) {
    const hits = raycaster.intersectObject(this.activeMesh);
    if (!hits.length) return null;
    const id = hits[0].instanceId;
    const q = this.quakes[id];
    return q && q.shown ? { id, quake: q } : null;
  }

  setHovered(id) {
    if (this.hoveredId === id) return;
    const mesh = this.activeMesh;
    if (this.hoveredId !== null && !this.flashing.has(this.hoveredId)) {
      const prev = this.quakes[this.hoveredId];
      if (prev) mesh.setColorAt(this.hoveredId, this.baseColor(prev));
    }
    this.hoveredId = id;
    if (id !== null) {
      const q = this.quakes[id];
      mesh.setColorAt(id, this.baseColor(q).lerp(WHITE, 0.45));
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  update(t) {
    this.pulseRings.forEach((r, i) => {
      const s = r.userData.baseScale * (1 + 0.5 * Math.sin(t * 3 + i));
      r.scale.set(s, s, s);
      r.material.opacity = 0.35 + 0.35 * Math.sin(t * 3 + i);
    });

    if (this.flashing.size) {
      const mesh = this.activeMesh;
      const nowMs = performance.now();
      let colorDirty = false;
      for (const i of this.flashing) {
        const q = this.quakes[i];
        const remain = (q.flashUntil - nowMs) / FLASH_MS;
        if (remain <= 0 || !q.shown) {
          this.flashing.delete(i);
          mesh.setColorAt(i, this.baseColor(q));
          if (q.shown) this.writeMatrix(i, q);
        } else {
          // bright white + oversized at birth, easing back to normal
          mesh.setColorAt(i, this.baseColor(q).lerp(WHITE, remain * 0.9));
          this.writeMatrix(i, q, 1 + remain * 1.6);
        }
        colorDirty = true;
      }
      if (colorDirty) {
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
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

  // [earliest, latest] event time in the loaded window
  timeExtent() {
    if (!this.quakes.length) return null;
    let min = Infinity, max = -Infinity;
    for (const q of this.quakes) {
      if (q.time < min) min = q.time;
      if (q.time > max) max = q.time;
    }
    return [min, max];
  }
}
