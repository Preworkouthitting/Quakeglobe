const $ = id => document.getElementById(id);

export function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export const els = {
  loading: $('loading'),
  feed: $('feed'),
  minMag: $('minMag'),
  magVal: $('magVal'),
  spin: $('spin'),
  count: $('count'),
  maxMag: $('maxMag'),
  tooltip: $('tooltip'),
  detail: $('detail'),
  detailBody: $('detailBody'),
  detailClose: $('detailClose'),
  depthMode: $('depthMode'),
  plates: $('plates'),
  live: $('live'),
  sound: $('sound'),
  toast: $('toast'),
  sigList: $('sigList'),
  charts: $('charts'),
  banner: $('banner'),
  histBox: $('histBox'),
  histStart: $('histStart'),
  histEnd: $('histEnd'),
  histMag: $('histMag'),
  histRegion: $('histRegion'),
  histGo: $('histGo'),
  histNote: $('histNote'),
  sheet: $('sheet'),
  sheetToggle: $('sheetToggle'),
  legendMag: $('legendMag'),
  legendDepth: $('legendDepth'),
  playBtn: $('playBtn'),
  scrub: $('scrub'),
  timeLabel: $('timeLabel'),
};

export function setLoading(on) {
  els.loading.style.display = on ? 'flex' : 'none';
}

export function updateStats({ count, max, maxPlace }) {
  els.count.textContent = count;
  els.maxMag.textContent = count ? 'M' + max.toFixed(1) + ' — ' + escapeHTML(maxPlace) : '–';
}

export function showTooltip(x, y, quake) {
  const p = quake.feature.properties;
  els.tooltip.style.display = 'block';
  els.tooltip.style.left = (x + 14) + 'px';
  els.tooltip.style.top = (y + 14) + 'px';
  els.tooltip.innerHTML =
    '<div class="mag">M' + quake.mag.toFixed(1) + '</div>' +
    '<div class="place">' + escapeHTML(p.place || 'Unknown location') + '</div>' +
    '<div class="meta">' + new Date(p.time).toLocaleString() + ' · depth ' + quake.depth.toFixed(0) + ' km</div>';
}

export function hideTooltip() {
  els.tooltip.style.display = 'none';
}

// Feed data is untrusted input: escapeHTML stops attribute breakout, but an
// href also needs a scheme/host check or javascript: URLs would execute.
function safeEventUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol === 'https:' && (url.hostname === 'usgs.gov' || url.hostname.endsWith('.usgs.gov'))) {
      return url.href;
    }
  } catch { /* not a URL */ }
  return null;
}

export function showDetail(quake) {
  const p = quake.feature.properties;
  const url = safeEventUrl(p.url);
  els.detailBody.innerHTML =
    '<div class="mag">M' + quake.mag.toFixed(1) + '</div>' +
    '<div class="place">' + escapeHTML(p.place || 'Unknown location') + '</div>' +
    '<div class="meta">' +
      'Time: ' + new Date(p.time).toLocaleString() + '<br>' +
      'Depth: ' + quake.depth.toFixed(1) + ' km<br>' +
      'Coords: ' + quake.lat.toFixed(2) + ', ' + quake.lon.toFixed(2) + '<br>' +
      (p.tsunami ? '⚠️ Tsunami flag raised<br>' : '') +
      'Felt reports: ' + (p.felt || 0) +
    '</div>' +
    (url ? '<a href="' + escapeHTML(url) + '" target="_blank" rel="noopener">View on USGS →</a>' : '');
  els.detail.style.display = 'block';
}

els.detailClose.addEventListener('click', () => { els.detail.style.display = 'none'; });
els.sheetToggle.addEventListener('click', () => els.sheet.classList.toggle('open'));

function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 30 * 86400) return Math.round(s / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString(); // archive events: show the date
}

// quakes: already the top-N by magnitude; onSelect(quake) fires on click
export function renderSigList(quakes, onSelect) {
  els.sigList.innerHTML = '';
  for (const q of quakes) {
    const li = document.createElement('li');
    li.innerHTML =
      '<span class="m">M' + q.mag.toFixed(1) + '</span>' +
      '<span class="p">' + escapeHTML(q.feature.properties.place || 'Unknown') +
      ' · ' + timeAgo(q.time) + '</span>';
    li.addEventListener('click', () => onSelect(q));
    els.sigList.appendChild(li);
  }
}

export function showBanner(text) {
  els.banner.textContent = text;
  els.banner.classList.add('show');
}
export function hideBanner() {
  els.banner.classList.remove('show');
}

let toastTimer = null;
export function showToast(html) {
  els.toast.innerHTML = html;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 5000);
}
