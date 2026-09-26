#!/usr/bin/env python3
"""Score the ACTUAL shipped Bortle data (src/data/bortle/rXX/*.js) against
the expanded 98-anchor set, replicating src/lib/bortleRegions.js
sampleRegionByte exactly. Byte -> SQM: sqm = 16.0 + 0.05 * byte."""
import base64
import json
import math
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
DATA = os.path.join(REPO, 'src', 'data', 'bortle')

BORTLE_BREAKS = [(21.90, 1), (21.70, 2), (21.40, 3), (20.90, 4),
                 (19.45, 5), (18.70, 6), (18.20, 7), (17.70, 8)]

def sqm_to_bortle(sqm):
    for edge, cls in BORTLE_BREAKS:
        if sqm >= edge:
            return cls
    return 9

LON_BANDS = [-180, -135, -90, -45, 0, 45, 90, 135, 180]
LAT_BANDS = [85, 40, 10, -20, -60]

def region_id_for(lat, lon):
    ln = lon
    while ln < -180: ln += 360
    while ln > 180: ln -= 360
    if lat > 85 or lat < -60: return None
    lon_idx = next((i for i in range(8)
                    if LON_BANDS[i] <= ln < LON_BANDS[i+1]),
                   7 if ln == 180 else None)
    if lon_idx is None: return None
    lat_idx = next((i for i in range(4)
                    if LAT_BANDS[i] >= lat > LAT_BANDS[i+1]), None)
    if lat_idx is None: return None
    return f"r{lat_idx}{lon_idx}"

def parse_js(path):
    txt = open(path).read()
    def num(key):
        m = re.search(rf"{key}:\s*([-\d.eE+]+)", txt)
        return float(m.group(1)) if m else None
    def integer(key):
        m = re.search(rf"{key}:\s*(\d+)", txt)
        return int(m.group(1)) if m else None
    def b64(key):
        m = re.search(rf"{key}:\s*'([A-Za-z0-9+/=]+)'", txt)
        return base64.b64decode(m.group(1)) if m else None
    return num, integer, b64

_regions = {}
def load_region(rid):
    if rid in _regions:
        return _regions[rid]
    num, integer, b64 = parse_js(os.path.join(DATA, rid, 'coarse.js'))
    coarse = {
        'rows': integer('rows'), 'cols': integer('cols'),
        'cellM': num('cellM'), 'xMin': num('xMin'), 'yMax': num('yMax'),
        'r0': integer('r0'), 'c0': integer('c0'),
        'globalCols': integer('globalCols'),
        'bytes': np.frombuffer(b64('data'), dtype=np.uint8),
    }
    num, integer, b64 = parse_js(os.path.join(DATA, rid, 'fine.js'))
    count = integer('count')
    if count == 0:
        fine = {'count': 0, 'per': integer('per'),
                'cellM': num('cellM'), 'map': {}, 'bytes': np.zeros(0, np.uint8)}
    else:
        keys = np.frombuffer(b64('index'), dtype=np.uint32)
        fmap = {int(k): i for i, k in enumerate(keys)}
        fine = {'count': count, 'per': integer('per'),
                'cellM': num('cellM'), 'map': fmap,
                'bytes': np.frombuffer(b64('data'), dtype=np.uint8)}
    reg = (coarse, fine)
    _regions[rid] = reg
    return reg

MERC_R = 6378137.0

def sample_region_byte(region, lat, lon):
    coarse, fine = region
    x = math.radians(lon) * MERC_R
    s = max(-0.9999999, min(0.9999999, math.sin(math.radians(lat))))
    y = MERC_R * math.log((1 + s) / (1 - s)) / 2

    globalC = math.floor((x - coarse['xMin']) / coarse['cellM']) + coarse['c0']
    globalR = math.floor((coarse['yMax'] - y) / coarse['cellM']) + coarse['r0']
    localC = globalC - coarse['c0']
    localR = globalR - coarse['r0']
    if not (0 <= localC < coarse['cols'] and 0 <= localR < coarse['rows']):
        return None

    per = fine['per']
    fkey = globalR * coarse['globalCols'] + globalC
    pi = fine['map'].get(fkey)
    if pi is not None:
        cm, fm = coarse['cellM'], fine['cellM']
        cellX = coarse['xMin'] + (globalC - coarse['c0']) * cm
        cellYTop = coarse['yMax'] - (globalR - coarse['r0']) * cm
        fr = math.floor((cellYTop - y) / fm)
        fc = math.floor((x - cellX) / fm)
        if 0 <= fr < per and 0 <= fc < per:
            q = int(fine['bytes'][pi * per * per + fr * per + fc])
            if q != 255:
                return q

    q = int(coarse['bytes'][localR * coarse['cols'] + localC])
    return None if q == 255 else q

def main():
    a1 = json.load(open(os.path.join(REPO, 'tools', 'bortle-grid', 'anchors.json')))
    a2 = json.load(open(os.path.join(REPO, 'tools', 'bortle-grid', 'anchors_expanded.json')))
    anchors = [a for a in a1 + a2 if a.get('known_bortle') is not None]
    print(f"{len(anchors)} anchors", flush=True)

    rows = []
    for a in anchors:
        rid = region_id_for(a['lat'], a['lon'])
        if rid is None:
            rows.append((a, None, None, None))
            continue
        q = sample_region_byte(load_region(rid), a['lat'], a['lon'])
        if q is None:
            rows.append((a, None, None, None))
            continue
        sqm = 16.0 + 0.05 * q
        pred = sqm_to_bortle(sqm)
        rows.append((a, q, sqm, pred))

    hits = tot = 0
    misses = []
    for a, q, sqm, pred in rows:
        if pred is None:
            misses.append((a['id'], a['known_bortle'], None, None, 'NODATA'))
            continue
        tot += 1
        ok = abs(pred - a['known_bortle']) <= 1
        hits += ok
        if not ok:
            misses.append((a['id'], a['known_bortle'], pred, round(sqm, 2), ''))

    print(f"\nSHIPPED data score: {hits}/{tot} = {hits/tot*100:.1f}%", flush=True)
    print(f"\nMisses ({len(misses)}):", flush=True)
    for m in misses:
        print(f"  {m[0]}: known={m[1]} pred={m[2]} sqm={m[3]} {m[4]}", flush=True)

    # breakdown
    for label, sel in [('urban>=5', lambda r: r[0]['known_bortle'] >= 5),
                       ('dark <=3', lambda r: r[0]['known_bortle'] <= 3)]:
        h = t = 0
        for a, q, sqm, pred in rows:
            if not sel((a,)) or pred is None:
                continue
            t += 1
            h += abs(pred - a['known_bortle']) <= 1
        print(f"  {label}: {h}/{t} = {h/t*100:.1f}%", flush=True)

    json.dump([{'id': a['id'], 'known': a['known_bortle'], 'byte': q,
                'sqm': round(sqm, 2) if sqm else None, 'pred': pred,
                'ok': (abs(pred - a['known_bortle']) <= 1) if pred is not None else False}
               for a, q, sqm, pred in rows],
              open(os.path.join(HERE, 'shipped_validation_expanded.json'), 'w'), indent=1)
    print("\nSaved: shipped_validation_expanded.json", flush=True)

if __name__ == '__main__':
    main()
