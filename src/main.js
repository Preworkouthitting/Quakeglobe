import * as THREE from 'three';
import { createScene } from './scene.js';
import { createGlobe } from './globe.js';
import { QuakeMarkers } from './markers.js';
import { createPlateBoundaries } from './plates.js';
import { fetchFeed, queryEvents, QUERY_LIMIT } from './data.js';
import { LiveUpdater, Shockwaves, Ping } from './live.js';
import { magColor } from './markers.js';
import { Timeline } from './timeline.js';
import * as ui from './ui.js';

const app = createScene(document.getElementById('canvas-wrap'));
const globe = createGlobe();
app.scene.add(globe.group);

const markers = new QuakeMarkers(app.scene);
app.onTick(t => markers.update(t));
app.onTick((t, dt) => globe.updateSun(dt, app.sun, app.fill));

const plates = createPlateBoundaries();
app.scene.add(plates);

const shockwaves = new Shockwaves(app.scene);
app.onTick((t, dt) => shockwaves.update(t, dt));
const ping = new Ping();

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
function applyFeatures(features) {
  markers.setData(features);
  const extent = markers.timeExtent();
  if (extent) timeline.setWindow(extent[0], extent[1]);
  ui.updateStats(markers.visibleStats());
  ui.renderSigList(markers.quakes, q => {
    app.flyTo(q.normal);
    ui.showDetail(q);
  });
}

// Circular regions for the historical archive (lat, lon, radius km)
const REGIONS = {
  japan: { lat: 38, lon: 142, km: 1500 },
  indonesia: { lat: -2, lon: 120, km: 2000 },
  chile: { lat: -30, lon: -71, km: 1800 },
  california: { lat: 36.5, lon: -119.5, km: 700 },
  alaska: { lat: 61, lon: -150, km: 1500 },
  mediterranean: { lat: 38, lon: 15, km: 1600 },
  newzealand: { lat: -41, lon: 174, km: 1200 },
};

let historical = null; // active archive query params, or null for live feeds
let retryTimer = null;

async function loadFeed(feed) {
  ui.setLoading(true);
  clearTimeout(retryTimer);
  historical = null;
  ui.els.histNote.textContent = '';
  try {
    const features = await fetchFeed(feed); // retries with backoff internally
    applyFeatures(features);
    live.rememberIds(features);
    ui.hideBanner();
  } catch (e) {
    console.error('Feed error:', e);
    ui.els.count.textContent = 'load failed';
    ui.showBanner('USGS feed unreachable — retrying in 60 s');
    retryTimer = setTimeout(() => loadFeed(ui.els.feed.value), 60_000);
  }
  ui.setLoading(false);
}

async function loadHistorical(params) {
  ui.setLoading(true);
  clearTimeout(retryTimer);
  ui.els.histGo.disabled = true;
  try {
    const features = await queryEvents(params);
    historical = params;
    ui.els.feed.value = '__hist'; // canned-feed select shows "Historical query"
    applyFeatures(features);
    ui.hideBanner();
    ui.els.histNote.textContent = features.length >= QUERY_LIMIT
      ? `Showing the ${QUERY_LIMIT} largest events — narrow the range for all`
      : `${features.length} events loaded`;
  } catch (e) {
    console.error('Archive query error:', e);
    ui.els.histNote.textContent = 'Query failed — check the date range';
  }
  ui.els.histGo.disabled = false;
  ui.setLoading(false);
}

ui.els.histGo.addEventListener('click', () => {
  const start = ui.els.histStart.value, end = ui.els.histEnd.value;
  if (!start || !end || start >= end) {
    ui.els.histNote.textContent = 'Pick a valid date range';
    return;
  }
  loadHistorical({
    start, end,
    minMag: parseFloat(ui.els.histMag.value),
    region: REGIONS[ui.els.histRegion.value] || null,
  });
});

// ---------- Live updates ----------
const live = new LiveUpdater({
  getFeed: () => ui.els.feed.value,
  // don't refresh over historical results or an active playback/scrub session
  canApply: () => !historical && !timeline.playing && timeline.cutoff >= timeline.end,
  onUpdate(features, fresh) {
    applyFeatures(features);
    if (!fresh.length) return;
    for (const f of fresh) {
      const [lon, lat] = f.geometry.coordinates;
      const q = markers.quakes.find(x => x.feature.id === f.id);
      if (q) shockwaves.spawn(q.normal, magColor(q.mag), q.mag);
    }
    const top = fresh.reduce((a, b) => (b.properties.mag > a.properties.mag ? b : a));
    ui.showToast(`<b>${fresh.length} new quake${fresh.length > 1 ? 's' : ''}</b> — strongest M${top.properties.mag.toFixed(1)}, ${ui.escapeHTML(top.properties.place || 'unknown location')}`);
    ping.play();
  },
});
live.start();

ui.els.live.addEventListener('change', e => e.target.checked ? live.start() : live.stop());
ui.els.sound.addEventListener('change', e => ping.setEnabled(e.target.checked));

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
  window.__quake = { app, globe, markers, timeline, live, shockwaves, ping };

  // dev-only FPS meter (stripped from prod builds)
  const meter = document.createElement('div');
  meter.style.cssText = 'position:fixed;bottom:4px;right:4px;z-index:40;font:11px monospace;color:#4ade80;background:rgba(5,7,13,0.7);padding:2px 6px;border-radius:4px;pointer-events:none';
  document.body.appendChild(meter);
  let frames = 0, last = performance.now();
  app.onTick(() => {
    frames++;
    const now = performance.now();
    if (now - last >= 500) {
      meter.textContent = Math.round(frames * 1000 / (now - last)) + ' fps';
      window.__quake.fps = frames * 1000 / (now - last);
      frames = 0; last = now;
    }
  });
}
