import * as THREE from 'three';
import { R } from './scene.js';
import { fetchFeed } from './data.js';

const REFRESH_MS = 5 * 60 * 1000; // USGS feeds regenerate ~every 5 min

// Periodic refetch of the active feed; diffs by event id and reports new ones.
export class LiveUpdater {
  constructor({ getFeed, canApply, onUpdate }) {
    this.getFeed = getFeed;   // () => current feed name
    this.canApply = canApply; // () => false to skip a cycle (e.g. mid-playback)
    this.onUpdate = onUpdate; // (features, newFeatures) =>
    this.knownIds = new Set();
    this.timer = null;
  }

  rememberIds(features) {
    this.knownIds = new Set(features.map(f => f.id));
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
      const features = await fetchFeed(this.getFeed(), { force: true });
      const fresh = features.filter(f => !this.knownIds.has(f.id));
      this.rememberIds(features);
      this.onUpdate(features, fresh);
    } catch (e) {
      console.warn('Live refresh failed, will retry next cycle:', e);
    }
  }
}

// Expanding one-shot shockwave rings for newly arrived quakes.
export class Shockwaves {
  constructor(parent) {
    this.group = new THREE.Group();
    parent.add(this.group);
    this.geo = new THREE.RingGeometry(0.96, 1, 48);
    this.active = []; // { mesh, age, life, maxScale }
  }

  spawn(normal, color, mag = 4) {
    const mesh = new THREE.Mesh(
      this.geo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide })
    );
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.position.copy(normal).multiplyScalar(R + 0.4);
    this.group.add(mesh);
    this.active.push({ mesh, age: 0, life: 2.8, maxScale: Math.max(8, mag * 3.5) });
  }

  update(_, dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const w = this.active[i];
      w.age += dt;
      const t = w.age / w.life;
      if (t >= 1) {
        this.group.remove(w.mesh);
        w.mesh.material.dispose();
        this.active.splice(i, 1);
        continue;
      }
      const eased = 1 - Math.pow(1 - t, 2.2); // fast start, gentle finish
      const s = 1 + eased * w.maxScale;
      w.mesh.scale.set(s, s, s);
      w.mesh.material.opacity = 0.95 * (1 - t);
    }
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
