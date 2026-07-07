import * as THREE from 'three';
import { createScene } from './scene.js';
import { createGlobe } from './globe.js';
import { QuakeMarkers } from './markers.js';
import { createPlateBoundaries } from './plates.js';
import { fetchFeed } from './data.js';
import { Timeline } from './timeline.js';
import * as ui from './ui.js';

const app = createScene(document.getElementById('canvas-wrap'));
const globe = createGlobe();
app.scene.add(globe.group);

const markers = new QuakeMarkers(app.scene);
app.onTick(t => markers.update(t));

const plates = createPlateBoundaries();
app.scene.add(plates);

// ---------- Timeline ----------
const timeline = new Timeline({
  onTime(cutoff, { flash, atEnd }) {
    markers.setTimeCutoff(cutoff, { flash });
    ui.updateStats(markers.visibleStats());
    ui.els.scrub.value = Math.round(timeline.frac() * 1000);
    ui.els.timeLabel.textContent = atEnd ? 'now' : new Date(cutoff).toLocaleString();
  },
  onPlayState(playing) {
    ui.els.playBtn.textContent = playing ? '❚❚' : '▶';
  },
});
app.onTick((t, dt) => timeline.tick(dt));

ui.els.playBtn.addEventListener('click', () => timeline.toggle());
ui.els.scrub.addEventListener('input', e => timeline.seek(e.target.value / 1000));

// ---------- Data ----------
async function loadFeed(feed) {
  ui.setLoading(true);
  try {
    const features = await fetchFeed(feed);
    markers.setData(features);
    const extent = markers.timeExtent();
    if (extent) timeline.setWindow(extent[0], extent[1]);
    ui.updateStats(markers.visibleStats());
  } catch (e) {
    console.error('Feed error:', e);
    ui.els.count.textContent = 'load failed';
  }
  ui.setLoading(false);
}

// ---------- Hover / click picking ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerPix = { x: 0, y: 0 };
let hoverDirty = false;
let downAt = { x: 0, y: 0 };

function pickAtPointer() {
  raycaster.setFromCamera(pointer, app.camera);
  return markers.pick(raycaster);
}

app.renderer.domElement.addEventListener('pointermove', e => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  pointerPix = { x: e.clientX, y: e.clientY };
  hoverDirty = true;
});

// Raycast at most once per frame, not per pointermove event
app.onTick(() => {
  if (!hoverDirty) return;
  hoverDirty = false;
  const hit = pickAtPointer();
  if (hit) {
    markers.setHovered(hit.id);
    ui.showTooltip(pointerPix.x, pointerPix.y, hit.quake);
    document.body.style.cursor = 'pointer';
  } else {
    markers.setHovered(null);
    ui.hideTooltip();
    document.body.style.cursor = '';
  }
});

app.renderer.domElement.addEventListener('pointerdown', e => {
  downAt = { x: e.clientX, y: e.clientY };
});
app.renderer.domElement.addEventListener('click', e => {
  // distinguish click from drag
  if (Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 6) return;
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  const hit = pickAtPointer();
  if (hit) ui.showDetail(hit.quake);
});

// ---------- UI wiring ----------
ui.els.feed.addEventListener('change', e => loadFeed(e.target.value));
ui.els.minMag.addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  ui.els.magVal.textContent = v.toFixed(1);
  markers.setMinMag(v);
  ui.updateStats(markers.visibleStats());
});
ui.els.spin.addEventListener('change', e => {
  app.controls.autoRotate = e.target.checked;
});
ui.els.plates.addEventListener('change', e => {
  plates.visible = e.target.checked;
});
ui.els.depthMode.addEventListener('change', e => {
  const on = e.target.checked;
  markers.setMode(on ? 'depth' : 'surface');
  globe.setDepthMode(on);
  ui.els.legendMag.style.display = on ? 'none' : '';
  ui.els.legendDepth.style.display = on ? '' : 'none';
});

loadFeed(ui.els.feed.value);

if (import.meta.env.DEV) {
  // dev-only handle for browser-console verification
  window.__quake = { app, globe, markers };
}
