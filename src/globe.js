import * as THREE from 'three';
import { R } from './scene.js';

const TEXTURE_URL = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg';

export function createGlobe() {
  const group = new THREE.Group();

  const material = new THREE.MeshPhongMaterial({ color: 0x1b2a4a, shininess: 8 });
  const globe = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 64), material);
  group.add(globe);

  new THREE.TextureLoader().load(
    TEXTURE_URL,
    tex => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      material.map = tex;
      material.color.set(0xffffff);
      material.needsUpdate = true;
    },
    undefined,
    () => {} // fallback: plain dark-blue sphere
  );

  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.04, 64, 64),
    new THREE.MeshBasicMaterial({ color: 0x3b6fd4, transparent: true, opacity: 0.12, side: THREE.BackSide })
  );
  group.add(atmosphere);

  // Depth mode: translucent wireframe shell so sub-surface points read in 3D
  const wireMaterial = new THREE.MeshBasicMaterial({
    color: 0x3b6fd4, wireframe: true, transparent: true, opacity: 0.14,
  });
  // dark core hides far-side wireframe clutter; must stay smaller than the
  // deepest exaggerated quake radius (~67 units for 700 km) so points show
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(R * 0.6, 48, 48),
    new THREE.MeshBasicMaterial({ color: 0x05070d })
  );
  core.visible = false;
  group.add(core);

  function setDepthMode(on) {
    globe.material = on ? wireMaterial : material;
    core.visible = on;
  }

  return { group, globe, material, atmosphere, setDepthMode };
}
