// Thin client for the feed worker: URL building + response caching here,
// fetch/parse/math in src/feed-worker.js (retry+backoff lives there too).
const FEED_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
const QUERY_BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const TTL = 5 * 60 * 1000; // don't re-hit USGS more than every 5 min per feed
export const QUERY_LIMIT = 15000; // marker capacity; fdsnws caps at 20k anyway

const cache = new Map(); // url → { time, buf }
let worker = null;
let seq = 0;
const pending = new Map(); // request id → { resolve, reject }

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./feed-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    const { id, ok, buf, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(buf) : p.reject(new Error(error));
  };
  return worker;
}

function request(url, { force = false } = {}) {
  const hit = cache.get(url);
  if (!force && hit && Date.now() - hit.time < TTL) return Promise.resolve(hit.buf);
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, {
      resolve(buf) {
        cache.set(url, { time: Date.now(), buf });
        resolve(buf);
      },
      reject,
    });
    ensureWorker().postMessage({ id, url });
  });
}

export function fetchFeed(feed, opts) {
  return request(FEED_BASE + feed + '.geojson', opts);
}

// Historical archive — any date range back to ~1900, optional circular region.
// { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', minMag, region: {lat, lon, km} }
export function queryEvents({ start, end, minMag, region }) {
  const p = new URLSearchParams({
    format: 'geojson',
    starttime: start,
    endtime: end,
    minmagnitude: String(minMag),
    orderby: 'magnitude', // if truncated at the limit, keep the biggest events
    limit: String(QUERY_LIMIT),
  });
  if (region) {
    p.set('latitude', String(region.lat));
    p.set('longitude', String(region.lon));
    p.set('maxradiuskm', String(region.km));
  }
  return request(QUERY_BASE + '?' + p);
}
