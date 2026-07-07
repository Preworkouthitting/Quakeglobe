// Refresh the bundled tectonic plate boundaries (fraxen/tectonicplates,
// Peter Bird's PB2002 dataset). Run: node scripts/fetch-plates.mjs
import { writeFile } from 'node:fs/promises';

const URL = 'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json';
const OUT = new URL('../src/assets/plate-boundaries.json', import.meta.url);

const res = await fetch(URL);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const json = await res.json();
await writeFile(OUT, JSON.stringify(json));
console.log(`Wrote ${json.features.length} boundary features to src/assets/plate-boundaries.json`);
