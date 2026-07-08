import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const R = 100; // globe radius

// Colors above this luminance bloom; markers are boosted past it (HDR),
// so the earth itself stays clean without a second "selective" render pass.
export const BLOOM_THRESHOLD = 1.0;

// Small screens = mobile GPUs: lighter geometry, fewer stars, dpr ≤ 1.5.
// Evaluated once at boot — real devices don't change class mid-session.
export const LOW_POWER = matchMedia('(max-width: 820px)').matches;

// Renderer, camera, lights, stars, controls, and the render loop.
export function createScene(container) {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 2000);
  camera.position.z = 320;

  // Cap dpr at 2; drop to 1.5 on very dense screens or very wide canvases —
  // with MSAA + bloom the fill-rate cost outruns any visible gain up there
  function targetPixelRatio() {
    if (LOW_POWER || devicePixelRatio >= 3 || innerWidth > 2560) return Math.min(devicePixelRatio, 1.5);
    return Math.min(devicePixelRatio, 2);
  }
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(targetPixelRatio());
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  container.appendChild(renderer.domElement);

  // HDR target (half-float, MSAA) so boosted marker colors survive to the
  // bloom pass; OutputPass applies ACES + sRGB at the end of the chain.
  const renderTarget = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, renderTarget);

  // r155+ uses physical light units; ~π multiplier restores the r128 look
  scene.add(new THREE.AmbientLight(0xffffff, 0.55 * Math.PI));
  const sun = new THREE.DirectionalLight(0xfff4e0, 0.85 * Math.PI); // warm key
  sun.position.set(300, 200, 300);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x5a78b8, 0.18 * Math.PI); // cool fill
  fill.position.set(-300, -150, -300);
  scene.add(fill);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.45;
  controls.zoomSpeed = 0.8;
  controls.minDistance = 130;
  controls.maxDistance = 600;
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;

  // Star field — three brightness/size tiers in ONE draw call via a
  // per-vertex size attribute (PointsMaterial only supports a single size)
  const starScale = { value: innerHeight / 2 }; // sizeAttenuation factor
  {
    const q = LOW_POWER ? 0.5 : 1; // half the stars on small screens
    const tiers = [
      { count: 750 * q | 0, size: 0.8, color: 0x6b7a99 },  // faint background dust
      { count: 350 * q | 0, size: 1.4, color: 0x9fb0cc },  // mid stars
      { count: 120 * q | 0, size: 2.2, color: 0xd8e2f5 },  // a few bright ones
    ];
    const total = tiers.reduce((s, t) => s + t.count, 0);
    const pos = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const size = new Float32Array(total);
    let i = 0;
    const c = new THREE.Color();
    for (const tier of tiers) {
      c.set(tier.color);
      for (let k = 0; k < tier.count; k++, i++) {
        const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u), d = 800 + Math.random() * 400;
        pos[i * 3] = s * Math.cos(a) * d;
        pos[i * 3 + 1] = s * Math.sin(a) * d;
        pos[i * 3 + 2] = u * d;
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        size[i] = tier.size;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: starScale },
      vertexColors: true,
      vertexShader: /* glsl */ `
        attribute float size;
        uniform float uScale;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (uScale / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() { gl_FragColor = vec4(vColor, 1.0); }`,
    });
    scene.add(new THREE.Points(g, mat));
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(targetPixelRatio());
    composer.setPixelRatio(targetPixelRatio());
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    starScale.value = innerHeight / 2;
  });

  // Smooth great-circle camera flight: slerp the view direction, ease the
  // distance. controls.target stays at the origin, so only position moves.
  let flight = null;
  const _q = new THREE.Quaternion();
  const _qe = new THREE.Quaternion();
  const IDENTITY = new THREE.Quaternion();
  function flyTo(normal, { duration = 1.6 } = {}) {
    const from = camera.position.clone().normalize();
    const d0 = camera.position.length();
    flight = {
      from,
      rot: _q.setFromUnitVectors(from, normal.clone().normalize()).clone(),
      d0,
      d1: Math.min(Math.max(d0, 190), 320), // land at a readable distance
      t: 0,
      duration,
      resumeAutoRotate: controls.autoRotate,
    };
    controls.autoRotate = false;
  }
  const easeInOut = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

  // user grabbing the globe cancels an in-progress flight
  controls.addEventListener('start', () => {
    if (flight) {
      controls.autoRotate = flight.resumeAutoRotate;
      flight = null;
    }
  });

  // Post chain: scene → bloom (only HDR colors past the threshold) → ACES/sRGB
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(innerWidth, innerHeight),
    0.85,             // strength
    0.45,             // radius
    BLOOM_THRESHOLD
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Idle rendering: tickers run every rAF (cheap), but the actual render is
  // skipped down to ~30 fps when nothing is animating. Any activity source
  // returning true restores full rate on the very next frame. When the tab
  // is hidden the loop stops completely.
  const tickers = [];
  const activitySources = [];
  // dev meter counts real renders; idleInterval ≈ 30 fps floor (vsync margin)
  const frameStats = { renders: 0, idleInterval: 1000 / 30 - 2 };
  let lastRender = 0;

  const timer = new THREE.Timer(); // THREE.Clock is deprecated as of r185
  function frame() {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1); // clamp resume-from-hidden spikes
    const t = timer.getElapsed();
    if (flight) {
      flight.t += dt / flight.duration;
      const e = easeInOut(Math.min(flight.t, 1));
      _qe.slerpQuaternions(IDENTITY, flight.rot, e);
      const dist = flight.d0 + (flight.d1 - flight.d0) * e;
      camera.position.copy(flight.from).applyQuaternion(_qe).multiplyScalar(dist);
      if (flight.t >= 1) {
        controls.autoRotate = flight.resumeAutoRotate;
        flight = null;
        controls.dispatchEvent({ type: 'end' }); // camera landed — listeners sync
      }
    }
    const cameraMoved = controls.update(); // true while dragging/damping/auto-rotating
    for (const fn of tickers) fn(t, dt);

    let active = cameraMoved || flight !== null;
    for (let i = 0; !active && i < activitySources.length; i++) active = !!activitySources[i]();
    const now = performance.now();
    if (active || now - lastRender >= frameStats.idleInterval) {
      composer.render();
      frameStats.renders++;
      lastRender = now;
    }
  }
  renderer.setAnimationLoop(frame);

  document.addEventListener('visibilitychange', () => {
    renderer.setAnimationLoop(document.hidden ? null : frame);
  });

  return {
    scene, camera, renderer, controls, composer, bloom, sun, fill, flyTo, frameStats,
    // render one frame through the full post chain (for captures)
    render() { composer.render(); },
    // register a per-frame callback(elapsed, delta)
    onTick(fn) { tickers.push(fn); },
    // register an "is something animating?" predicate for the idle limiter
    addActivity(fn) { activitySources.push(fn); },
    get flying() { return flight !== null; },
  };
}

// lat/lon (degrees) + radius → world position
export function latLonToVec3(lat, lon, r) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  );
}
