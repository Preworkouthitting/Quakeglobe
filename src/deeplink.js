// Shareable state in the URL hash, e.g.
//   #f=4.5_month&m=5&d=1&c=38.3,142.4,250&q=usp000hvnu
//   #h=2011-03-01~2011-04-01~4~japan&q=official20110311054624120_30
// All values use unreserved characters, so the hash stays human-readable.

const DEFAULT_FEED = 'all_day';

let timer = null;
function write(hash) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    history.replaceState(null, '', hash ? '#' + hash : location.pathname + location.search);
  }, 250);
}

// state: { feed, hist:{start,end,minMag,regionKey}|null, minMag, depth, plates, cam:[lat,lon,dist], quake }
export function updateHash(state) {
  const parts = [];
  if (state.hist) {
    const h = state.hist;
    parts.push(`h=${h.start}~${h.end}~${h.minMag}~${h.regionKey || ''}`);
  } else if (state.feed && state.feed !== DEFAULT_FEED) {
    parts.push(`f=${state.feed}`);
  }
  if (state.minMag > 0) parts.push(`m=${state.minMag}`);
  if (state.depth) parts.push('d=1');
  if (!state.plates) parts.push('p=0');
  if (state.cam) parts.push(`c=${state.cam[0]},${state.cam[1]},${state.cam[2]}`);
  if (state.quake) parts.push(`q=${state.quake}`);
  write(parts.join('&'));
}

export function readHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return null;
  const state = { feed: DEFAULT_FEED, hist: null, minMag: 0, depth: false, plates: true, cam: null, quake: null };
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq), v = decodeURIComponent(part.slice(eq + 1));
    if (k === 'f') state.feed = v;
    else if (k === 'h') {
      const [start, end, minMag, regionKey] = v.split('~');
      if (start && end) state.hist = { start, end, minMag: parseFloat(minMag) || 4, regionKey: regionKey || '' };
    }
    else if (k === 'm') state.minMag = parseFloat(v) || 0;
    else if (k === 'd') state.depth = v === '1';
    else if (k === 'p') state.plates = v !== '0';
    else if (k === 'c') {
      const [lat, lon, dist] = v.split(',').map(Number);
      if ([lat, lon, dist].every(Number.isFinite)) state.cam = [lat, lon, dist];
    }
    else if (k === 'q') state.quake = v;
  }
  return state;
}
