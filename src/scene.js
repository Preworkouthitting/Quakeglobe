import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const R = 100; // globe radius

// Renderer, camera, lights, stars, controls, and the render loop.
export function createScene(container) {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 2000);
  camera.position.z = 320;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // r155+ uses physical light units; ~π multiplier restores the r128 look
  scene.add(new THREE.AmbientLight(0xffffff, 0.9 * Math.PI));
  const sun = new THREE.DirectionalLight(0xffffff, 0.6 * Math.PI);
  sun.position.set(300, 200, 300);
  scene.add(sun);

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

  // Star field
  {
    const pts = [];
    for (let i = 0; i < 1200; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u), d = 800 + Math.random() * 400;
      pts.push(s * Math.cos(a) * d, s * Math.sin(a) * d, u * d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8899bb, size: 1.2, sizeAttenuation: true })));
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  const tickers = [];
  const timer = new THREE.Timer(); // THREE.Clock is deprecated as of r185
  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = timer.getDelta();
    const t = timer.getElapsed();
    controls.update();
    for (const fn of tickers) fn(t, dt);
    renderer.render(scene, camera);
  });

  return {
    scene, camera, renderer, controls,
    // register a per-frame callback(elapsed, delta)
    onTick(fn) { tickers.push(fn); },
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
