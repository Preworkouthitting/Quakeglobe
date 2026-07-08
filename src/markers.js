import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { R } from './scene.js';

const CAPACITY = 15000; // all_month is ~10k events; leave headroom
const FLASH_MS = 1400;  // how long a quake glows after "occurring" in playback
// Material-level HDR multiplier: pushes marker colors past BLOOM_THRESHOLD
// so spikes/points glow while the globe beneath them stays bloom-free
const GLOW = 1.9;

// Hex ramps kept for the legend/charts; per-instance linear colors are
// precomputed in the feed worker.
export function magColor(m) {
  if (m >= 6) return 0xef4444;
  if (m >= 4.5) return 0xfb923c;
  if (m >= 3) return 0xfacc15;
  return 0x4ade80;
}

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
const _inv = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _color = new THREE.Color();
const _sphere = new THREE.Sphere();
const _ray = new THREE.Ray();
const _wp = new THREE.Vector3();
const WHITE = new THREE.Color(0xffffff);
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

// All quake data lives in typed arrays straight from the feed worker (SoA).
// Instance i of the InstancedMesh IS quake i — picking, filtering and the
// timeline all work on indices; view(i) builds a UI-shaped object on demand.
// Visibility = mag ≥ minMag AND event time ≤ timeCutoff (timeline scrubber).
export class QuakeMarkers {
  constructor(parent) {
    // Unit cone, base at origin, tip at +Y — per-instance scale sets width/height
    const geo = new THREE.ConeGeometry(1, 1, 6);
    geo.translate(0, 0.5, 0);
    this.coneBVH = new MeshBVH(geo); // narrow-phase raycast in unit space
    this.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.92 });
    this.material.color.setScalar(GLOW); // diffuse = color × instanceColor
    this.mesh = new THREE.InstancedMesh(geo, this.material, CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    parent.add(this.mesh);

    // Depth mode: spheres below the surface at (exaggerated) true depth
    const depthGeo = new THREE.SphereGeometry(1, 8, 6);
    this.sphereBVH = new MeshBVH(depthGeo);
    this.depthMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85 });
    this.depthMaterial.color.setScalar(GLOW * 0.8); // deep violets need less push
    this.depthMesh = new THREE.InstancedMesh(depthGeo, this.depthMaterial, CAPACITY);
    this.depthMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.depthMesh.count = 0;
    this.depthMesh.visible = false;
    parent.add(this.depthMesh);
    this.mode = 'surface'; // 'surface' | 'depth'

    // Pulse rings for recent quakes: ONE InstancedMesh, animated entirely in
    // the vertex shader (uTime uniform + per-instance phase) — one draw call
    // and zero per-frame CPU, however many rings exist.
    const RING_CAP = 256;
    const ringGeo = new THREE.RingGeometry(1, 1.35, 32);
    ringGeo.setAttribute('phase', new THREE.InstancedBufferAttribute(new Float32Array(RING_CAP), 1));
    this.ringMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute float phase;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = instanceColor;
          float w = sin(uTime * 3.0 + phase);
          vAlpha = 0.35 + 0.35 * w;
          vec3 p = position;
          p.xy *= 1.0 + 0.5 * w;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() { gl_FragColor = vec4(vColor, vAlpha); }`,
    });
    this.ringMesh = new THREE.InstancedMesh(ringGeo, this.ringMaterial, RING_CAP);
    this.ringMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(RING_CAP * 3), 3);
    this.ringMesh.count = 0;
    this.ringMesh.frustumCulled = false; // shader-scaled; bounds are stale
    parent.add(this.ringMesh);
    this.ringIndex = []; // ring slot → quake index
    this.shownRings = 0;

    this.buf = null;          // SoA arrays from the worker
    this.shown = new Uint8Array(0);
    this.minMag = 0;
    this.timeCutoff = Infinity;
    this.flashing = new Set(); // instance ids currently flashing
    this.hoveredId = null;
    this._pickCache = { id: -1, result: null }; // hover hits reuse the view
    this._stats = { count: 0, max: -Infinity, maxPlace: '' };
  }

  get count() {
    return this.buf ? this.buf.count : 0;
  }

  setBuffer(buf) {
    this.clearRings();
    this.hoveredId = null;
    this.flashing.clear();
    this.buf = buf;
    this.shown = new Uint8Array(buf.count);

    this._pickCache.id = -1;
    this._pickCache.result = null;
    this.mesh.count = buf.count;
    this.depthMesh.count = buf.count;
    // mutable copies — hover/flash restore from the pristine buf arrays
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(buf.surfColors.slice(), 3);
    this.depthMesh.instanceColor = new THREE.InstancedBufferAttribute(buf.depthColors.slice(), 3);

    for (let i = 0; i < buf.count; i++) if (buf.recent[i]) this.addPulseRing(i);

    // Broad-phase pick spheres, one per instance per mode (static per buffer)
    const n = buf.count;
    this.surfCenters = new Float32Array(n * 3);
    this.surfRadii = new Float32Array(n);
    this.depthCenters = new Float32Array(n * 3);
    this.depthRadii = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const nx = buf.normals[i * 3], ny = buf.normals[i * 3 + 1], nz = buf.normals[i * 3 + 2];
      const h = buf.heights[i];
      const rs = R + h / 2; // cone spans R..R+h along the normal
      this.surfCenters[i * 3] = nx * rs;
      this.surfCenters[i * 3 + 1] = ny * rs;
      this.surfCenters[i * 3 + 2] = nz * rs;
      this.surfRadii[i] = h / 2 + buf.widths[i];
      const rd = Math.max(R - (buf.depths[i] / KM_PER_UNIT) * DEPTH_EXAGGERATION, 5);
      this.depthCenters[i * 3] = nx * rd;
      this.depthCenters[i * 3 + 1] = ny * rd;
      this.depthCenters[i * 3 + 2] = nz * rd;
      this.depthRadii[i] = Math.max(0.45, buf.mags[i] * 0.3);
    }

    this.timeCutoff = Infinity;
    this.updateVisibility();
  }

  // UI-shaped object for a single quake (only built for picks/sidebar/toasts)
  view(i) {
    const b = this.buf, p = b.props[i];
    return {
      index: i,
      mag: b.mags[i],
      depth: b.depths[i],
      lat: b.lats[i],
      lon: b.lons[i],
      time: b.times[i],
      normal: new THREE.Vector3(b.normals[i * 3], b.normals[i * 3 + 1], b.normals[i * 3 + 2]),
      feature: {
        id: p.id,
        properties: { place: p.place, url: p.url, tsunami: p.tsunami, felt: p.felt, time: b.times[i], mag: b.mags[i] },
      },
    };
  }

  indexOfId(id) {
    return this.buf ? this.buf.props.findIndex(p => p.id === id) : -1;
  }

  get activeMesh() {
    return this.mode === 'depth' ? this.depthMesh : this.mesh;
  }

  // No allocation: scratch vectors only (runs count× per visibility pass)
  writeMatrix(i, boost = 1) {
    const b = this.buf;
    _normal.set(b.normals[i * 3], b.normals[i * 3 + 1], b.normals[i * 3 + 2]);
    if (this.mode === 'depth') {
      const r = Math.max(R - (b.depths[i] / KM_PER_UNIT) * DEPTH_EXAGGERATION, 5);
      const s = Math.max(0.45, b.mags[i] * 0.3) * boost;
      _mat4.compose(_pos.copy(_normal).multiplyScalar(r), _quat.identity(), _scale.setScalar(s));
      this.depthMesh.setMatrixAt(i, _mat4);
    } else {
      _quat.setFromUnitVectors(UP, _normal);
      _scale.set(b.widths[i] * boost, b.heights[i] * boost, b.widths[i] * boost);
      _mat4.compose(_pos.copy(_normal).multiplyScalar(R), _quat, _scale);
      this.mesh.setMatrixAt(i, _mat4);
    }
  }

  setMode(mode) {
    if (this.mode === mode) return;
    // settle any active flashes in the old mode before switching
    for (const i of this.flashing) this.restoreColor(i);
    this.flashing.clear();
    this.setHovered(null);
    this.mode = mode;
    this.mesh.visible = mode === 'surface';
    this.depthMesh.visible = mode === 'depth';
    this.ringMesh.visible = mode === 'surface';
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
    if (flash && t > prev && this.buf) {
      const nowMs = performance.now();
      const b = this.buf;
      for (let i = 0; i < b.count; i++) {
        if (b.times[i] > prev && b.times[i] <= t && b.mags[i] >= this.minMag) {
          this.flashUntil ??= new Float64Array(CAPACITY);
          this.flashUntil[i] = nowMs + FLASH_MS;
          this.flashing.add(i);
        }
      }
    }
    this.updateVisibility();
  }

  // Hidden instances get a zero-scale matrix: not rendered, not raycast-hittable
  updateVisibility() {
    if (!this.buf) return;
    const b = this.buf, mesh = this.activeMesh;
    for (let i = 0; i < b.count; i++) {
      const on = b.mags[i] >= this.minMag && b.times[i] <= this.timeCutoff;
      this.shown[i] = on ? 1 : 0;
      if (on) this.writeMatrix(i);
      else mesh.setMatrixAt(i, ZERO);
    }
    // rings of filtered-out quakes collapse to zero scale
    this.shownRings = 0;
    for (let slot = 0; slot < this.ringIndex.length; slot++) {
      if (this.shown[this.ringIndex[slot]]) {
        this.writeRingMatrix(slot);
        this.shownRings++;
      } else {
        this.ringMesh.setMatrixAt(slot, ZERO);
      }
    }
    if (this.ringIndex.length) this.ringMesh.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }

  addPulseRing(i) {
    const slot = this.ringIndex.length;
    if (slot >= this.ringMesh.instanceMatrix.count) return; // capacity guard
    this.ringIndex.push(i);
    this.ringMesh.count = this.ringIndex.length;
    const b = this.buf;
    _color.setRGB(b.surfColors[i * 3], b.surfColors[i * 3 + 1], b.surfColors[i * 3 + 2]).multiplyScalar(1.7); // HDR → blooms
    this.ringMesh.setColorAt(slot, _color);
    this.ringMesh.geometry.attributes.phase.setX(slot, slot); // matches old per-ring offset
    this.ringMesh.geometry.attributes.phase.needsUpdate = true;
    this.writeRingMatrix(slot);
    this.ringMesh.instanceColor.needsUpdate = true;
  }

  writeRingMatrix(slot) {
    const i = this.ringIndex[slot];
    const b = this.buf;
    _normal.set(b.normals[i * 3], b.normals[i * 3 + 1], b.normals[i * 3 + 2]);
    _quat.setFromUnitVectors(FORWARD, _normal);
    const s = Math.max(1.5, b.mags[i] * 1.2);
    _mat4.compose(_pos.copy(_normal).multiplyScalar(R + 0.3), _quat, _scale.setScalar(s));
    this.ringMesh.setMatrixAt(slot, _mat4);
  }

  clearRings() {
    this.ringIndex = [];
    this.ringMesh.count = 0;
    this.shownRings = 0;
  }

  // true while any visible ring is pulsing (idle limiter hook)
  ringsAnimating() {
    return this.ringMesh.visible && this.shownRings > 0;
  }

  // write the pristine (worker-computed) color for instance i back into the
  // active mesh's color attribute
  restoreColor(i) {
    const src = this.mode === 'depth' ? this.buf.depthColors : this.buf.surfColors;
    const attr = this.activeMesh.instanceColor;
    attr.array[i * 3] = src[i * 3];
    attr.array[i * 3 + 1] = src[i * 3 + 1];
    attr.array[i * 3 + 2] = src[i * 3 + 2];
    attr.needsUpdate = true;
  }

  baseColor(i, target = _color) {
    const src = this.mode === 'depth' ? this.buf.depthColors : this.buf.surfColors;
    return target.setRGB(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
  }

  writeColor(i, c) {
    const attr = this.activeMesh.instanceColor;
    attr.array[i * 3] = c.r;
    attr.array[i * 3 + 1] = c.g;
    attr.array[i * 3 + 2] = c.b;
    attr.needsUpdate = true;
  }

  // → { id, quake } or null. Two phases: a typed-array bounding-sphere scan
  // (no matrix inverts for the ~10k misses), then BVH raycast in unit space
  // for the handful of candidates. Allocation-free until a hit builds a view.
  // fatWorld > 0 (touch taps) pads every pick sphere by that many world
  // units; if no precise geometry hit lands, the nearest padded-sphere
  // candidate wins — fingers aren't pixel-precise.
  pick(raycaster, fatWorld = 0) {
    if (!this.buf) return null;
    const depth = this.mode === 'depth';
    const centers = depth ? this.depthCenters : this.surfCenters;
    const radii = depth ? this.depthRadii : this.surfRadii;
    const bvh = depth ? this.sphereBVH : this.coneBVH;
    const mesh = this.activeMesh;
    const ray = raycaster.ray;
    let bestId = -1, bestDistSq = Infinity;
    let nearId = -1, nearDist = Infinity; // fat fallback: closest sphere graze
    for (let i = 0; i < this.buf.count; i++) {
      if (!this.shown[i]) continue;
      _sphere.center.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]);
      _sphere.radius = radii[i] + fatWorld;
      if (!ray.intersectsSphere(_sphere)) continue;
      if (fatWorld > 0) {
        const d = ray.distanceSqToPoint(_sphere.center);
        if (d < nearDist) { nearDist = d; nearId = i; }
      }
      mesh.getMatrixAt(i, _mat4);
      _ray.copy(ray).applyMatrix4(_inv.copy(_mat4).invert());
      const hit = bvh.raycastFirst(_ray, THREE.DoubleSide);
      if (hit) {
        _wp.copy(hit.point).applyMatrix4(_mat4);
        const d = _wp.distanceToSquared(ray.origin);
        if (d < bestDistSq) { bestDistSq = d; bestId = i; }
      }
    }
    if (bestId < 0 && fatWorld > 0) bestId = nearId;
    if (bestId < 0) return null;
    // hovering the same quake across frames reuses the built view
    if (this._pickCache.id !== bestId) {
      this._pickCache.id = bestId;
      this._pickCache.result = { id: bestId, quake: this.view(bestId) };
    }
    return this._pickCache.result;
  }

  setHovered(id) {
    if (this.hoveredId === id) return;
    if (this.hoveredId !== null && !this.flashing.has(this.hoveredId)) {
      this.restoreColor(this.hoveredId);
    }
    this.hoveredId = id;
    if (id !== null) this.writeColor(id, this.baseColor(id).lerp(WHITE, 0.45));
  }

  update(t) {
    // sin(3t+φ) is periodic in t with period 2π/3 — wrap before upload, or
    // after hours of session time fp32 sin() precision collapses on the GPU
    // and the rings warp and fade out
    this.ringMaterial.uniforms.uTime.value = t % (Math.PI * 2 / 3);

    if (this.flashing.size) {
      const mesh = this.activeMesh;
      const nowMs = performance.now();
      for (const i of this.flashing) {
        const remain = (this.flashUntil[i] - nowMs) / FLASH_MS;
        if (remain <= 0 || !this.shown[i]) {
          this.flashing.delete(i);
          this.restoreColor(i);
          if (this.shown[i]) this.writeMatrix(i);
        } else {
          // bright white + oversized at birth, easing back to normal
          this.writeColor(i, this.baseColor(i).lerp(WHITE, remain * 0.9));
          this.writeMatrix(i, 1 + remain * 1.6);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // returns a reused object — read it before the next call (runs per frame
  // during timeline playback)
  visibleStats() {
    let count = 0, max = -Infinity, maxIdx = -1;
    const b = this.buf;
    if (b) for (let i = 0; i < b.count; i++) {
      if (!this.shown[i]) continue;
      count++;
      if (b.mags[i] > max) { max = b.mags[i]; maxIdx = i; }
    }
    this._stats.count = count;
    this._stats.max = max;
    this._stats.maxPlace = maxIdx >= 0 ? b.props[maxIdx].place : '';
    return this._stats;
  }

  // [earliest, latest] event time in the loaded window
  timeExtent() {
    const b = this.buf;
    if (!b || !b.count) return null;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < b.count; i++) {
      if (b.times[i] < min) min = b.times[i];
      if (b.times[i] > max) max = b.times[i];
    }
    return [min, max];
  }

  // top-k views by magnitude (built once per data load for the sidebar)
  topByMag(k = 10) {
    const b = this.buf;
    if (!b) return [];
    const idx = Array.from({ length: b.count }, (_, i) => i)
      .sort((a, c) => b.mags[c] - b.mags[a])
      .slice(0, k);
    return idx.map(i => this.view(i));
  }
}
