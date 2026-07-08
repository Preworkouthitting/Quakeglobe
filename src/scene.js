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

// Renderer, camera, lights, stars, controls, and the render loop.
export function createScene(container) {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 2000);
  camera.position.z = 320;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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

  // Star field — three brightness/size tiers so it reads as depth, not noise
  {
    const tiers = [
      { count: 750, size: 0.8, color: 0x6b7a99 },  // faint background dust
      { count: 350, size: 1.4, color: 0x9fb0cc },  // mid stars
      { count: 120, size: 2.2, color: 0xd8e2f5 },  // a few bright ones
    ];
    for (const tier of tiers) {
      const pts = [];
      for (let i = 0; i < tier.count; i++) {
        const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u), d = 800 + Math.random() * 400;
        pts.push(s * Math.cos(a) * d, s * Math.sin(a) * d, u * d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: tier.color, size: tier.size, sizeAttenuation: true })));
    }
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
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

  const tickers = [];
  const timer = new THREE.Timer(); // THREE.Clock is deprecated as of r185
  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = timer.getDelta();
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
    controls.update();
    for (const fn of tickers) fn(t, dt);
    composer.render();
  });

  return {
    scene, camera, renderer, controls, composer, bloom, sun, fill, flyTo,
    // render one frame through the full post chain (for captures)
    render() { composer.render(); },
    // register a per-frame callback(elapsed, delta)
    onTick(fn) { tickers.push(fn); },
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
