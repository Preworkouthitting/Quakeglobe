const BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
const TTL = 5 * 60 * 1000; // don't re-hit USGS more than every 5 min per feed
const RETRIES = [1000, 3000, 9000]; // backoff before giving up

const cache = new Map(); // feed → { time, features }
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function fetchFeed(feed, { force = false } = {}) {
  const hit = cache.get(feed);
  if (!force && hit && Date.now() - hit.time < TTL) return hit.features;

  let lastError;
  for (let attempt = 0; attempt <= RETRIES.length; attempt++) {
    try {
      const res = await fetch(BASE + feed + '.geojson');
      if (!res.ok) throw new Error('USGS feed error: HTTP ' + res.status);
      const json = await res.json();
      // mag can be null — skip those (data contract)
      const features = json.features.filter(f => f.properties.mag !== null && f.properties.mag !== undefined);
      cache.set(feed, { time: Date.now(), features });
      return features;
    } catch (e) {
      lastError = e;
      if (attempt < RETRIES.length) await sleep(RETRIES[attempt]);
    }
  }
  throw lastError;
}
