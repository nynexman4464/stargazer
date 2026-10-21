/* Build public/data/sky.json for the SkyChart "find in the sky" view.
   Source: d3-celestial data files (BSD-3-Clause, github.com/ofrohn/d3-celestial),
   themselves derived from the HYG / Yale Bright Star data.
   Output is trimmed hard: stars to magnitude 4.5 (921 whole-sky — enough for
   constellation pattern-matching), proper names for the brightest, the
   constellation stick figures, and one label anchor per constellation.
   Run: node tools/sky-data/build-sky-data.mjs */
import { writeFile } from 'node:fs/promises';

const BASE = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/';
const get = async (f) => (await fetch(BASE + f)).json();
const r2 = (n) => Math.round(n * 100) / 100;
const ra360 = (ra) => r2(((ra % 360) + 360) % 360);

const [starsRaw, namesRaw, linesRaw, labelsRaw] = await Promise.all([
  get('stars.6.json'),
  get('starnames.json'),
  get('constellations.lines.json'),
  get('constellations.json'),
]);

const stars = [];
const named = [];
for (const f of starsRaw.features) {
  const mag = f.properties.mag;
  if (mag > 4.5) continue;
  const [ra, dec] = f.geometry.coordinates;
  stars.push([ra360(ra), r2(dec), r2(mag)]);
  const nm = namesRaw[String(f.id)]?.name;
  if (nm && mag <= 2.6) named.push([ra360(ra), r2(dec), r2(mag), nm]);
}
stars.sort((a, b) => a[2] - b[2]);

const lines = [];
for (const f of linesRaw.features) {
  for (const line of f.geometry.coordinates) {
    lines.push(line.map(([ra, dec]) => [ra360(ra), r2(dec)]));
  }
}

const labels = labelsRaw.features.map((f) => [
  ra360(f.geometry.coordinates[0]),
  r2(f.geometry.coordinates[1]),
  f.properties.name,
]);

const out = { stars, named, lines, labels };
await writeFile(new URL('../../public/data/sky.json', import.meta.url), JSON.stringify(out));
console.log(
  `sky.json: ${stars.length} stars, ${named.length} named, ${lines.length} line segments polylines, ${labels.length} labels`,
);
