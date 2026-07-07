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

export function showDetail(quake) {
  const p = quake.feature.properties;
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
    '<a href="' + escapeHTML(p.url) + '" target="_blank" rel="noopener">View on USGS →</a>';
  els.detail.style.display = 'block';
}

els.detailClose.addEventListener('click', () => { els.detail.style.display = 'none'; });
