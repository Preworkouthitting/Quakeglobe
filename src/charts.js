import { magColor, depthColor } from './markers.js';

// Hand-rolled SVG mini-charts — no chart library, theme colors throughout.
const W = 218, H = 64, PAD_B = 14; // plot area H-PAD_B, labels in the pad

const hex = n => '#' + n.toString(16).padStart(6, '0');

function svgOpen() {
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
}

function bars(bins, colorFor) {
  const max = Math.max(...bins.map(b => b.n), 1);
  const bw = W / bins.length;
  let s = '';
  bins.forEach((b, i) => {
    if (!b.n) return;
    const h = Math.max(1.5, (b.n / max) * (H - PAD_B - 4));
    s += `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(H - PAD_B - h).toFixed(1)}" ` +
         `width="${(bw - 1).toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${colorFor(b)}"/>`;
  });
  return s;
}

function label(x, text, anchor = 'start') {
  return `<text x="${x}" y="${H - 3}" font-size="8.5" fill="#7d8aa5" ` +
         `font-family="inherit" text-anchor="${anchor}">${text}</text>`;
}

function chart(title, inner) {
  return `<div class="chart"><div class="chart-title">${title}</div>${inner}</div>`;
}

function magHistogram(quakes) {
  if (!quakes.length) return '';
  const lo = Math.floor(Math.min(...quakes.map(q => q.mag)) * 2) / 2;
  const hi = Math.ceil(Math.max(...quakes.map(q => q.mag)) * 2) / 2;
  const n = Math.max(Math.round((hi - lo) / 0.5), 1);
  const bins = Array.from({ length: n }, (_, i) => ({ m: lo + (i + 0.5) * 0.5, n: 0 }));
  for (const q of quakes) {
    const i = Math.min(Math.floor((q.mag - lo) / 0.5), n - 1);
    bins[i].n++;
  }
  const svg = svgOpen() + bars(bins, b => hex(magColor(b.m))) +
    label(0, 'M' + lo.toFixed(1)) + label(W, 'M' + hi.toFixed(1), 'end') + '</svg>';
  return chart('Magnitude', svg);
}

function timeHistogram(quakes, start, end) {
  if (!quakes.length || end <= start) return '';
  const n = 36;
  const bins = Array.from({ length: n }, () => ({ n: 0 }));
  for (const q of quakes) {
    const i = Math.min(Math.floor(((q.time - start) / (end - start)) * n), n - 1);
    bins[i].n++;
  }
  const short = end - start < 2 * 86400000;
  const fmt = t => short
    ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : new Date(t).toLocaleDateString();
  const svg = svgOpen() + bars(bins, () => '#ff8c42') +
    label(0, fmt(start)) + label(W, fmt(end), 'end') + '</svg>';
  return chart('Quakes over time', svg);
}

function depthHistogram(quakes) {
  if (!quakes.length) return '';
  const n = 14, binKm = 50; // 0–700 km
  const bins = Array.from({ length: n }, (_, i) => ({ km: (i + 0.5) * binKm, n: 0 }));
  for (const q of quakes) {
    const i = Math.min(Math.max(Math.floor(q.depth / binKm), 0), n - 1);
    bins[i].n++;
  }
  const svg = svgOpen() + bars(bins, b => '#' + depthColor(b.km).getHexString()) +
    label(0, '0 km') + label(W, '700 km', 'end') + '</svg>';
  return chart('Depth', svg);
}

// quakes: already filtered to what the globe shows (min magnitude)
export function renderCharts(container, quakes, windowStart, windowEnd) {
  container.innerHTML =
    magHistogram(quakes) +
    timeHistogram(quakes, windowStart, windowEnd) +
    depthHistogram(quakes);
}
