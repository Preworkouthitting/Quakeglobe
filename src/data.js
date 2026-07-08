const FEED_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
const QUERY_BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const TTL = 5 * 60 * 1000; // don't re-hit USGS more than every 5 min per feed
const RETRIES = [1000, 3000, 9000]; // backoff before giving up
export const QUERY_LIMIT = 15000; // marker capacity; fdsnws caps at 20k anyway

const cache = new Map(); // url → { time, features }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchGeoJSON(url, { force = false } = {}) {
  const hit = cache.get(url);
  if (!force && hit && Date.now() - hit.time < TTL) return hit.features;

  let lastError;
  for (let attempt = 0; attempt <= RETRIES.length; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('USGS error: HTTP ' + res.status);
      const json = await res.json();
      // mag can be null — skip those (data contract)
      const features = json.features.filter(f => f.properties.mag !== null && f.properties.mag !== undefined);
      cache.set(url, { time: Date.now(), features });
      return features;
    } catch (e) {
      lastError = e;
      if (attempt < RETRIES.length) await sleep(RETRIES[attempt]);
    }
  }
  throw lastError;
}

export function fetchFeed(feed, opts) {
  return fetchGeoJSON(FEED_BASE + feed + '.geojson', opts);
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
  return fetchGeoJSON(QUERY_BASE + '?' + p);
}
