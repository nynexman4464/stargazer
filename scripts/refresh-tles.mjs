// Refreshes public/data/tles.json with current TLEs from CelesTrak.
// Run daily (cron) so the app can ship fresh orbital data and rarely needs
// to reach CelesTrak from the client at runtime. Exits non-zero (leaving the
// existing file untouched) if any satellite's TLE fails validation.
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const NORADS = [25544, 48274, 20580]; // ISS, Tiangong, Hubble
const outFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'tles.json');

function valid(lines, norad) {
  if (lines.length !== 3) return false;
  const l1 = lines[1].trim();
  const l2 = lines[2].trim();
  return (
    l1.startsWith('1 ') &&
    l2.startsWith('2 ') &&
    l1.slice(2, 7).trim() === String(norad) &&
    l2.slice(2, 7).trim() === String(norad) &&
    l1.length >= 69 &&
    l2.length >= 69
  );
}

const tles = {};
for (const norad of NORADS) {
  let lines = null;
  // CelesTrak throttles bursts per IP; back off and retry on any failure.
  for (let attempt = 0; attempt < 4 && !lines; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 30000;
      console.log(`${norad}: retry ${attempt} after ${wait / 1000}s`);
      await new Promise((res) => setTimeout(res, wait));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=TLE`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Stargazer-static-site/1.0 (daily TLE refresh)' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      const cand = text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (valid(cand, norad)) lines = cand;
      else console.error(`${norad}: invalid TLE body (${text.length} chars)`);
    } catch (e) {
      console.error(`${norad}: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    // be polite between satellites
    await new Promise((res) => setTimeout(res, 5000));
  }
  if (!lines) {
    console.error(`FAILED for ${norad} after retries, keeping existing file`);
    process.exit(1);
  }
  tles[String(norad)] = [lines[1].trim(), lines[2].trim()];
  console.log(`${norad}: ok (epoch ${lines[1].trim().slice(18, 32)})`);
}

writeFileSync(
  outFile,
  JSON.stringify({ updated: new Date().toISOString(), tles, _source: ['CelesTrak'] }, null, 2) + '\n',
);
console.log(`wrote ${outFile}`);
