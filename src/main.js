import * as THREE from 'three';
import { createScene, latLonToVec3 } from './scene.js';
import { createGlobe } from './globe.js';
import { QuakeMarkers } from './markers.js';
import { createPlateBoundaries } from './plates.js';
import { fetchFeed, queryEvents, QUERY_LIMIT } from './data.js';
import { LiveUpdater, Shockwaves, Ping } from './live.js';
import { magColor } from './markers.js';
import { Timeline } from './timeline.js';
import { updateHash, readHash } from './deeplink.js';
import { renderCharts } from './charts.js';
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

// Things that force full-rate rendering while they animate (idle limiter)
app.addActivity(() => timeline.playing);
app.addActivity(() => markers.flashing.size > 0);
app.addActivity(() => markers.ringGroup.visible && markers.pulseRings.some(r => r.visible));
app.addActivity(() => shockwaves.active.length > 0);
app.addActivity(() => performance.now() - lastPointerMove < 120);

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
function selectQuake(q, { fly = true } = {}) {
  selectedQuake = q.feature.id;
  ui.showDetail(q);
  if (fly) app.flyTo(q.normal);
  updateDeepLink();
}

function refreshCharts() {
  renderCharts(ui.els.charts, markers.buf, parseFloat(ui.els.minMag.value), timeline.start, timeline.end);
}

function applyFeatures(buf) {
  markers.setBuffer(buf);
  const extent = markers.timeExtent();
  if (extent) timeline.setWindow(extent[0], extent[1]);
  ui.updateStats(markers.visibleStats());
  ui.renderSigList(markers.topByMag(10), q => selectQuake(q));
  refreshCharts();
  if (pendingQuakeId) {
    const i = markers.indexOfId(pendingQuakeId);
    pendingQuakeId = null;
    if (i >= 0) selectQuake(markers.view(i), { fly: !initialCamera });
  }
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
let selectedQuake = null;  // event id shown in the detail card
let pendingQuakeId = null; // from a deep link, resolved after data loads
let initialCamera = false; // deep link framed the camera already

// ---------- Deep links ----------
function cameraState() {
  const p = app.camera.position;
  const r = p.length();
  const lat = Math.asin(p.y / r) * 180 / Math.PI;
  const lon = ((Math.atan2(p.z, -p.x) * 180 / Math.PI - 180 + 540) % 360) - 180;
  return [+lat.toFixed(1), +lon.toFixed(1), Math.round(r)];
}

function updateDeepLink() {
  updateHash({
    feed: ui.els.feed.value,
    hist: historical,
    minMag: parseFloat(ui.els.minMag.value),
    depth: ui.els.depthMode.checked,
    plates: ui.els.plates.checked,
    cam: cameraState(),
    quake: ui.els.detail.style.display === 'block' ? selectedQuake : null,
  });
}
app.controls.addEventListener('end', updateDeepLink);
ui.els.detailClose.addEventListener('click', () => {
  selectedQuake = null;
  updateDeepLink();
});

async function loadFeed(feed) {
  ui.setLoading(true);
  clearTimeout(retryTimer);
  historical = null;
  ui.els.histNote.textContent = '';
  try {
    const buf = await fetchFeed(feed); // worker retries with backoff internally
    applyFeatures(buf);
    live.rememberIds(buf);
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
    const buf = await queryEvents(params);
    historical = params;
    ui.els.feed.value = '__hist'; // canned-feed select shows "Historical query"
    applyFeatures(buf);
    ui.hideBanner();
    updateDeepLink();
    ui.els.histNote.textContent = buf.count >= QUERY_LIMIT
      ? `Showing the ${QUERY_LIMIT} largest events — narrow the range for all`
      : `${buf.count} events loaded`;
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
    regionKey: ui.els.histRegion.value,
  });
});

// ---------- Live updates ----------
const live = new LiveUpdater({
  getFeed: () => ui.els.feed.value,
  // don't refresh over historical results or an active playback/scrub session
  canApply: () => !historical && !timeline.playing && timeline.cutoff >= timeline.end,
  onUpdate(buf, fresh) {
    applyFeatures(buf);
    if (!fresh.length) return;
    let top = fresh[0];
    for (const i of fresh) {
      const v = markers.view(i);
      shockwaves.spawn(v.normal, magColor(v.mag), v.mag);
      if (buf.mags[i] > buf.mags[top]) top = i;
    }
    ui.showToast(`<b>${fresh.length} new quake${fresh.length > 1 ? 's' : ''}</b> — strongest M${buf.mags[top].toFixed(1)}, ${ui.escapeHTML(buf.props[top].place || 'unknown location')}`);
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
let lastPointerMove = 0;
let downAt = { x: 0, y: 0 };

function pickAtPointer() {
  raycaster.setFromCamera(pointer, app.camera);
  return markers.pick(raycaster);
}

app.renderer.domElement.addEventListener('pointermove', e => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  pointerPix.x = e.clientX;
  pointerPix.y = e.clientY;
  hoverDirty = true;
  lastPointerMove = performance.now();
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
  if (hit) selectQuake(hit.quake, { fly: false });
});

// ---------- UI wiring ----------
ui.els.feed.addEventListener('change', e => {
  loadFeed(e.target.value);
  updateDeepLink();
});
ui.els.minMag.addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  ui.els.magVal.textContent = v.toFixed(1);
  markers.setMinMag(v);
  ui.updateStats(markers.visibleStats());
  refreshCharts();
  updateDeepLink();
});
ui.els.spin.addEventListener('change', e => {
  app.controls.autoRotate = e.target.checked;
});
ui.els.plates.addEventListener('change', e => {
  plates.visible = e.target.checked;
  updateDeepLink();
});
ui.els.depthMode.addEventListener('change', e => {
  const on = e.target.checked;
  markers.setMode(on ? 'depth' : 'surface');
  globe.setDepthMode(on);
  ui.els.legendMag.style.display = on ? 'none' : '';
  ui.els.legendDepth.style.display = on ? '' : 'none';
  updateDeepLink();
});

// ---------- Boot: restore deep-linked state, then load ----------
{
  const initial = readHash();
  if (initial) {
    if (initial.minMag > 0) {
      ui.els.minMag.value = initial.minMag;
      ui.els.magVal.textContent = initial.minMag.toFixed(1);
      markers.setMinMag(initial.minMag);
    }
    if (initial.depth) {
      ui.els.depthMode.checked = true;
      ui.els.depthMode.dispatchEvent(new Event('change'));
    }
    if (!initial.plates) {
      ui.els.plates.checked = false;
      ui.els.plates.dispatchEvent(new Event('change'));
    }
    if (initial.cam) {
      initialCamera = true;
      ui.els.spin.checked = false; // hold the shared framing
      app.controls.autoRotate = false;
      const dist = Math.min(Math.max(initial.cam[2], 130), 600);
      app.camera.position.copy(latLonToVec3(initial.cam[0], initial.cam[1], dist));
      app.controls.update();
    }
    pendingQuakeId = initial.quake;
    if (initial.hist) {
      ui.els.histBox.open = true;
      ui.els.histStart.value = initial.hist.start;
      ui.els.histEnd.value = initial.hist.end;
      ui.els.histMag.value = String(initial.hist.minMag);
      ui.els.histRegion.value = initial.hist.regionKey;
      loadHistorical({
        start: initial.hist.start,
        end: initial.hist.end,
        minMag: initial.hist.minMag,
        region: REGIONS[initial.hist.regionKey] || null,
        regionKey: initial.hist.regionKey,
      });
    } else {
      const valid = [...ui.els.feed.options].some(o => o.value === initial.feed);
      if (valid) ui.els.feed.value = initial.feed;
      loadFeed(ui.els.feed.value);
    }
  } else {
    loadFeed(ui.els.feed.value);
  }
}

if (import.meta.env.DEV) {
  // dev-only handle for browser-console verification
  window.__quake = { app, globe, markers, timeline, live, shockwaves, ping };

  // dev-only FPS meter (stripped from prod builds)
  const meter = document.createElement('div');
  meter.style.cssText = 'position:fixed;bottom:4px;right:4px;z-index:40;font:11px monospace;color:#4ade80;background:rgba(5,7,13,0.7);padding:2px 6px;border-radius:4px;pointer-events:none';
  document.body.appendChild(meter);
  let lastRenders = 0, last = performance.now();
  app.onTick(() => {
    const now = performance.now();
    if (now - last >= 500) {
      const fps = (app.frameStats.renders - lastRenders) * 1000 / (now - last);
      meter.textContent = Math.round(fps) + ' fps';
      window.__quake.fps = fps;
      lastRenders = app.frameStats.renders;
      last = now;
    }
  });
}
