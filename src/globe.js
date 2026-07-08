import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { R, latLonToVec3 } from './scene.js';

// Self-hosted, 2048px max. KTX2 (Basis ETC1S — stays compressed on the GPU)
// with plain JPEG as fallback; scripts/encode-ktx2.js regenerates the .ktx2
// files. The .ktx2 variants are pre-flipped (KTX2 can't flipY at load time).
const TEX_BASE = import.meta.env.BASE_URL + 'textures/';
const BASIS_PATH = import.meta.env.BASE_URL + 'basis/';

// Subsolar point from UTC time: solar declination (±23.44° over the year)
// and the longitude where it is currently solar noon. Good to ~1°, which is
// plenty for a terminator.
export function sunDirection(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - start) / 86400000;
  const decl = -23.44 * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365.25);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const subsolarLon = (12 - utcHours) * 15;
  return latLonToVec3(decl, subsolarLon, 1);
}

// NOTE: these shaders render into the EffectComposer's HDR target, where
// three.js skips per-material tone mapping — OutputPass applies ACES + sRGB
// at the end of the chain. Do not add tonemapping/colorspace chunks here.
const GLOBE_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const GLOBE_FRAG = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D waterMap;
  uniform vec3 sunDir;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vec3 n = normalize(vNormal);
    float ndl = dot(n, sunDir);
    // soft terminator band
    float dayAmt = smoothstep(-0.12, 0.25, ndl);

    vec3 day = texture2D(dayMap, vUv).rgb;
    vec3 night = texture2D(nightMap, vUv).rgb;
    vec3 dayLit = day * (0.18 + 1.05 * max(ndl, 0.0));
    vec3 nightLit = night * 1.5 + day * 0.02; // city lights + faint earthshine
    vec3 color = mix(nightLit, dayLit, dayAmt);

    // sun glint on water only; land stays matte
    float water = texture2D(waterMap, vUv).r;
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 h = normalize(sunDir + viewDir);
    float sunUp = smoothstep(0.03, 0.3, ndl); // glint only once the sun is up
    // tight lobe — at planetary scale the glint is a small bright spot,
    // with a faint wide sheen underneath
    float facing = max(dot(n, h), 0.0);
    float spec = pow(facing, 320.0) * 0.55 + pow(facing, 24.0) * 0.06;
    color += vec3(1.0, 0.93, 0.82) * spec * water * sunUp;

    gl_FragColor = vec4(color, 1.0);
  }
`;

const ATMO_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const ATMO_FRAG = /* glsl */ `
  uniform vec3 atmoColor;
  uniform vec3 sunDir;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorldPos);
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);   // strongest at grazing
    float lit = 0.35 + 0.65 * smoothstep(-0.2, 0.3, dot(n, sunDir));
    gl_FragColor = vec4(atmoColor * rim * lit * 1.5, 1.0);
  }
`;

function loadJPEG(url, srgb) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, tex => {
      if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      resolve(tex);
    }, undefined, reject);
  });
}

// [day, night, water] — KTX2 first, JPEG fallback, null if both tiers fail
async function loadTextureSet(renderer) {
  const ktx2 = new KTX2Loader().setTranscoderPath(BASIS_PATH).detectSupport(renderer);
  const loadK = url => new Promise((resolve, reject) => {
    ktx2.load(url, tex => { tex.anisotropy = 8; resolve(tex); }, undefined, reject);
  });
  try {
    return await Promise.all([
      loadK(TEX_BASE + 'earth-day.ktx2'),
      loadK(TEX_BASE + 'earth-night.ktx2'),
      loadK(TEX_BASE + 'earth-water.ktx2'),
    ]);
  } catch (e) {
    console.warn('KTX2 textures unavailable, falling back to JPEG:', e);
  } finally {
    ktx2.dispose();
  }
  try {
    return await Promise.all([
      loadJPEG(TEX_BASE + 'earth-day.jpg', true),
      loadJPEG(TEX_BASE + 'earth-night.jpg', true),
      loadJPEG(TEX_BASE + 'earth-water.jpg', false),
    ]);
  } catch (e) {
    console.warn('JPEG textures unavailable, keeping plain globe:', e);
    return null;
  }
}

export function createGlobe(renderer) {
  const group = new THREE.Group();

  // Phong fallback: shown until textures arrive, kept if the CDN is down
  const material = new THREE.MeshPhongMaterial({ color: 0x1b2a4a, shininess: 8 });
  const globe = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 64), material);
  group.add(globe);

  const sunUniform = { value: sunDirection() };

  let surfaceMaterial = material; // whatever depth-mode should restore to
  let dayNightMaterial = null;

  loadTextureSet(renderer).then(textures => {
    if (!textures) return; // keep plain dark-blue fallback
    const [day, night, water] = textures;
    dayNightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: day },
        nightMap: { value: night },
        waterMap: { value: water },
        sunDir: sunUniform,
      },
      vertexShader: GLOBE_VERT,
      fragmentShader: GLOBE_FRAG,
    });
    surfaceMaterial = dayNightMaterial;
    if (globe.material === material) globe.material = dayNightMaterial;
  });

  // Fresnel rim atmosphere — thin halo at grazing angles, brighter on the
  // sunlit limb, additive so it never muddies the surface
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.045, 64, 64),
    new THREE.ShaderMaterial({
      uniforms: {
        atmoColor: { value: new THREE.Color(0x4a7fdc) },
        sunDir: sunUniform,
      },
      vertexShader: ATMO_VERT,
      fragmentShader: ATMO_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
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
    globe.material = on ? wireMaterial : surfaceMaterial;
    core.visible = on;
    atmosphere.visible = !on; // rim glow fights the wireframe read
  }

  // Recompute the subsolar point about once a minute (also aligns the
  // scene's key/fill lights so the Phong fallback and glint agree)
  let sunAge = Infinity;
  function updateSun(dt, sunLight, fillLight) {
    sunAge += dt;
    if (sunAge < 60) return;
    sunAge = 0;
    sunUniform.value.copy(sunDirection());
    if (sunLight) sunLight.position.copy(sunUniform.value).multiplyScalar(400);
    if (fillLight) fillLight.position.copy(sunUniform.value).multiplyScalar(-400);
  }

  return { group, globe, material, atmosphere, setDepthMode, updateSun, sunUniform };
}
