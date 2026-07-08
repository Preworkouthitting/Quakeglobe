import * as THREE from 'three';
import { R } from './scene.js';
import { fetchFeed } from './data.js';

const REFRESH_MS = 5 * 60 * 1000; // USGS feeds regenerate ~every 5 min

// Periodic refetch of the active feed; diffs by event id and reports new ones.
export class LiveUpdater {
  constructor({ getFeed, canApply, onUpdate }) {
    this.getFeed = getFeed;   // () => current feed name
    this.canApply = canApply; // () => false to skip a cycle (e.g. mid-playback)
    this.onUpdate = onUpdate; // (buf, freshIndices) =>
    this.knownIds = new Set();
    this.timer = null;
  }

  rememberIds(buf) {
    this.knownIds = new Set(buf.props.map(p => p.id));
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh() {
    if (!this.canApply()) return;
    try {
      const buf = await fetchFeed(this.getFeed(), { force: true });
      const fresh = [];
      for (let i = 0; i < buf.count; i++) {
        if (!this.knownIds.has(buf.props[i].id)) fresh.push(i);
      }
      this.rememberIds(buf);
      this.onUpdate(buf, fresh);
    } catch (e) {
      console.warn('Live refresh failed, will retry next cycle:', e);
    }
  }
}

// Expanding one-shot shockwave rings for newly arrived quakes.
// ONE InstancedMesh with round-robin slots; expansion + fade run in the
// vertex shader off a uTime uniform — one draw call, zero per-frame CPU.
const SHOCK_CAP = 64;
const SHOCK_LIFE = 2.8;

export class Shockwaves {
  constructor(parent) {
    const geo = new THREE.RingGeometry(0.96, 1, 48);
    geo.setAttribute('birth', new THREE.InstancedBufferAttribute(new Float32Array(SHOCK_CAP).fill(-1e9), 1));
    geo.setAttribute('maxScale', new THREE.InstancedBufferAttribute(new Float32Array(SHOCK_CAP), 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute float birth;
        attribute float maxScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = instanceColor;
          float t = clamp((uTime - birth) / ${SHOCK_LIFE}, 0.0, 1.0);
          float e = 1.0 - pow(1.0 - t, 2.2); // fast start, gentle finish
          vAlpha = 0.95 * (1.0 - t);
          vec3 p = position;
          p.xy *= 1.0 + e * maxScale;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() { gl_FragColor = vec4(vColor, vAlpha); }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, SHOCK_CAP);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SHOCK_CAP * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // shader-scaled; bounds are stale
    parent.add(this.mesh);
    this.nextSlot = 0;
    this.now = 0;
    this.activeUntil = -1; // for the idle-render activity predicate
  }

  spawn(normal, color, mag = 4) {
    const slot = this.nextSlot;
    this.nextSlot = (this.nextSlot + 1) % SHOCK_CAP;
    this.mesh.count = Math.max(this.mesh.count, slot + 1);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    const m = new THREE.Matrix4().compose(
      normal.clone().multiplyScalar(R + 0.4), q, new THREE.Vector3(1, 1, 1)
    );
    this.mesh.setMatrixAt(slot, m);
    this.mesh.setColorAt(slot, new THREE.Color(color).multiplyScalar(2.2)); // HDR → strong bloom
    const attrs = this.mesh.geometry.attributes;
    attrs.birth.setX(slot, this.now);
    attrs.maxScale.setX(slot, Math.max(8, mag * 3.5));
    attrs.birth.needsUpdate = true;
    attrs.maxScale.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.activeUntil = this.now + SHOCK_LIFE;
  }

  isActive() {
    return this.now < this.activeUntil;
  }

  update(t) {
    this.now = t;
    this.material.uniforms.uTime.value = t;
  }
}

// Short WebAudio ping — no assets, no dependencies.
export class Ping {
  constructor() {
    this.ctx = null;
    this.enabled = false;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on && !this.ctx) this.ctx = new AudioContext();
    if (on && this.ctx.state === 'suspended') this.ctx.resume();
  }

  play() {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t0);
    osc.frequency.exponentialRampToValueAtTime(440, t0 + 0.18);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.4);
  }
}
