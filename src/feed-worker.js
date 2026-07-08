// Web Worker: fetch + JSON parse + per-quake math off the main thread.
// Posts back a transferable SoA buffer ready for the InstancedMesh — the
// main thread never touches raw GeoJSON.

const RETRIES = [1000, 3000, 9000];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Matches THREE.Color's sRGB → linear-sRGB working-space conversion, so
// per-instance colors are identical to the old main-thread Color.set() path.
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function hexToLinear(hex) {
  return [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255)];
}

function magColorHex(m) {
  if (m >= 6) return 0xef4444;
  if (m >= 4.5) return 0xfb923c;
  if (m >= 3) return 0xfacc15;
  return 0x4ade80;
}
const MAG_LINEAR = new Map([0xef4444, 0xfb923c, 0xfacc15, 0x4ade80].map(h => [h, hexToLinear(h)]));

// linear-space lerp over the same stops as markers.js depthColor()
const DEPTH_STOPS = [0xff8c42, 0xfacc15, 0x4ade80, 0x38bdf8, 0x8b5cf6].map(hexToLinear);
function depthLinear(km, out, o) {
  const t = Math.min(Math.max(km, 0) / 660, 1) * (DEPTH_STOPS.length - 1);
  const i = Math.min(Math.floor(t), DEPTH_STOPS.length - 2);
  const f = t - i, a = DEPTH_STOPS[i], b = DEPTH_STOPS[i + 1];
  out[o] = a[0] + (b[0] - a[0]) * f;
  out[o + 1] = a[1] + (b[1] - a[1]) * f;
  out[o + 2] = a[2] + (b[2] - a[2]) * f;
}

self.onmessage = async e => {
  const { id, url } = e.data;
  try {
    let json, lastError;
    for (let attempt = 0; attempt <= RETRIES.length; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('USGS error: HTTP ' + res.status);
        json = await res.json();
        break;
      } catch (err) {
        lastError = err;
        if (attempt < RETRIES.length) await sleep(RETRIES[attempt]);
        else throw lastError;
      }
    }

    // mag can be null — skip those (data contract)
    const feats = json.features.filter(f => f.properties.mag !== null && f.properties.mag !== undefined);
    const n = feats.length;
    const buf = {
      count: n,
      normals: new Float32Array(n * 3),
      heights: new Float32Array(n),
      widths: new Float32Array(n),
      mags: new Float32Array(n),
      depths: new Float32Array(n),
      lats: new Float32Array(n),
      lons: new Float32Array(n),
      surfColors: new Float32Array(n * 3),
      depthColors: new Float32Array(n * 3),
      times: new Float64Array(n),
      recent: new Uint8Array(n),
      props: new Array(n), // light per-event UI data (strings)
    };

    const now = Date.now();
    const D2R = Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const f = feats[i];
      const [lon, lat, depthRaw] = f.geometry.coordinates;
      const p = f.properties;
      const mag = Math.max(p.mag, 0.1);
      const depth = depthRaw || 0;

      const phi = (90 - lat) * D2R, theta = (lon + 180) * D2R;
      buf.normals[i * 3] = -Math.sin(phi) * Math.cos(theta);
      buf.normals[i * 3 + 1] = Math.cos(phi);
      buf.normals[i * 3 + 2] = Math.sin(phi) * Math.sin(theta);

      buf.heights[i] = Math.max(1.5, mag * mag * 0.55);
      buf.widths[i] = Math.max(0.4, mag * 0.28);
      buf.mags[i] = mag;
      buf.depths[i] = depth;
      buf.lats[i] = lat;
      buf.lons[i] = lon;
      buf.times[i] = p.time;
      buf.recent[i] = now - p.time < 2 * 3600 * 1000 ? 1 : 0;

      const mc = MAG_LINEAR.get(magColorHex(mag));
      buf.surfColors[i * 3] = mc[0];
      buf.surfColors[i * 3 + 1] = mc[1];
      buf.surfColors[i * 3 + 2] = mc[2];
      depthLinear(depth, buf.depthColors, i * 3);

      buf.props[i] = {
        id: f.id,
        place: p.place || '',
        url: p.url || '',
        tsunami: p.tsunami || 0,
        felt: p.felt || 0,
      };
    }

    postMessage({ id, ok: true, buf }, [
      buf.normals.buffer, buf.heights.buffer, buf.widths.buffer, buf.mags.buffer,
      buf.depths.buffer, buf.lats.buffer, buf.lons.buffer,
      buf.surfColors.buffer, buf.depthColors.buffer, buf.times.buffer, buf.recent.buffer,
    ]);
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
