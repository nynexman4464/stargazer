#!/usr/bin/env python3
"""Validate the BUILT 1km chunks against all 98 anchors.

Reads ~/workspace/data/bortle-1km/manifest.json + chunks, samples the 1km
cell containing each anchor, converts to Bortle with the app breaks, scores.
"""
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'mercator-2025'))
from merc_grid import XMIN, YMAX, COLS, COARSE_M, R_MERC

DATA_DIR = "/home/hatch/workspace/data/bortle-1km"
BREAKS = [(21.90, 1), (21.70, 2), (21.40, 3), (20.90, 4),
          (19.45, 5), (18.70, 6), (18.20, 7), (17.70, 8)]

PER = 20
CELL_M = 1000.0


def sqm_to_bortle(s):
    for edge, b in BREAKS:
        if s >= edge:
            return b
    return 9


def load_chunks():
    manifest = json.load(open(os.path.join(DATA_DIR, 'manifest.json')))
    key_to = {}  # global key -> (chunk_bytes, patch_idx)
    for rid, reg in manifest['regions'].items():
        for ch in reg['chunks']:
            with open(os.path.join(DATA_DIR, ch['file']), 'rb') as f:
                blob = f.read()
            magic, ver, per, cellm, count = struct.unpack('<4sIIII', blob[:20])
            assert magic == b'B1K1' and per == PER and cellm == CELL_M, ch['id']
            keys = memoryview(blob)[20:20+4*count].cast('I')
            data = blob[20+4*count:]
            assert len(data) == count * PER * PER
            for i, k in enumerate(keys):
                key_to[int(k)] = (data, i)
    return key_to


def sample(key_to, lat, lon):
    x = math.radians(lon) * R_MERC
    s = math.sin(math.radians(lat))
    y = R_MERC * math.log((1 + s) / (1 - s)) / 2
    gc = int((x - XMIN) / COARSE_M)
    gr = int((YMAX - y) / COARSE_M)
    key = gr * COLS + gc
    hit = key_to.get(key)
    if not hit:
        return None
    data, pi = hit
    # 1km cell within patch
    fx = (x - (XMIN + gc * COARSE_M)) / CELL_M
    fy = ((YMAX - gr * COARSE_M) - y) / CELL_M
    fc = min(PER - 1, max(0, int(fx)))
    fr = min(PER - 1, max(0, int(fy)))
    q = data[pi * PER * PER + fr * PER + fc]
    if q == 255:
        return None
    return 16.0 + q * 0.05


def main():
    print("Loading built chunks...", flush=True)
    key_to = load_chunks()
    print(f"  {len(key_to)} patches indexed", flush=True)
    a1 = json.load(open(os.path.join(HERE, '..', 'anchors.json')))
    a2 = json.load(open(os.path.join(HERE, '..', 'anchors_expanded.json')))
    anchors = [a for a in a1 + a2 if a.get('known_bortle') is not None]

    urban_ids = {a['id'] for a in a2}  # expanded set is mostly urban
    snow_ids = {'boston-common', 'cambridge-common', 'danehy-park',
                'arlington-ma', 'lincoln-ma'}

    total = hit = 0
    urban_total = urban_hit = 0
    dark_total = dark_hit = 0
    misses = []
    for a in anchors:
        sqm = sample(key_to, a['lat'], a['lon'])
        if sqm is None:
            continue
        pred = sqm_to_bortle(sqm)
        known = a['known_bortle']
        ok = abs(pred - known) <= 1
        total += 1
        hit += ok
        if a['id'] in urban_ids:
            urban_total += 1
            urban_hit += ok
        else:
            dark_total += 1
            dark_hit += ok
        if not ok:
            misses.append((a['id'], known, pred, round(sqm, 2)))

    print(f"\nBuilt 1km: {hit}/{total} ({100*hit/total:.1f}%)", flush=True)
    print(f"  urban: {urban_hit}/{urban_total}  dark: {dark_hit}/{dark_total}",
          flush=True)
    # Excluding snow-tainted Boston
    print(f"\nMisses ({len(misses)}):", flush=True)
    for m in sorted(misses):
        flag = " [snow]" if m[0] in snow_ids else ""
        print(f"  {m[0]}: known B{m[1]}, pred B{m[2]} (SQM {m[3]}){flag}")

    # Potsdam probe
    sqm = sample(key_to, 44.67, -74.98)
    print(f"\nPotsdam center: SQM {sqm:.2f} -> B{sqm_to_bortle(sqm)}"
          if sqm else "\nPotsdam: no data")


if __name__ == '__main__':
    main()
