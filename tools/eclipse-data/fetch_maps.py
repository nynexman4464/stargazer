#!/usr/bin/env python3
"""Download NASA eclipse map figures for catalog entries that lack
a `map` field, and record the field in public/data/eclipses.json.

Sources (verified byte-identical against the 29 maps bundled in
commit 520154f, which were sourced the same way):
  Solar: eclipse.gsfc.nasa.gov SEplot path charts
         SEplot/SEplot<half-century>/SE<YYYY><Mon><DD><T|A|H|P>.GIF
         (SEplot2001 for 2001-2050, SEplot2051 for 2051-2100)
  Lunar: eclipse.gsfc.nasa.gov Five Millennium Canon figures
         5MCLEmap/2001-2100/LE<YYYY-MM-DD><N|P|T>.gif
         (linked from the LEcat5 century catalog pages)

Files land in public/img/eclipse-maps/ as <solar|lunar>-<date>.gif,
matching the existing 29. `map` is a catalog-only field (it does not
live in eclipse-circumstances.json); merge_circ.py preserves it
because it only overwrites `circ`. Standard library only. Every
failure is printed and listed at the end; nothing is silently
dropped and no entry gets a map field unless its file validated.
"""
import json
import os
import pathlib
import struct
import sys
import time
import urllib.request
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parents[2]
CAT_PATH = ROOT / "public/data/eclipses.json"
MAP_DIR = ROOT / "public/img/eclipse-maps"

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) stargazer-data-fetch/1.0"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
SOLAR_LETTER = {"total": "T", "annular": "A", "hybrid": "H", "partial": "P"}
LUNAR_LETTER = {"penumbral": "N", "partial": "P", "total": "T"}


def solar_url(iso, etype):
    y, mo, d = iso.split("-")
    folder = "SEplot2001" if int(y) <= 2050 else "SEplot2051"
    name = f"SE{y}{MONTHS[int(mo) - 1]}{d}{SOLAR_LETTER[etype]}.GIF"
    return f"https://eclipse.gsfc.nasa.gov/SEplot/{folder}/{name}"


def lunar_url(iso, etype):
    name = f"LE{iso}{LUNAR_LETTER[etype]}.gif"
    return f"https://eclipse.gsfc.nasa.gov/5MCLEmap/2001-2100/{name}"


def download(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def gif_dims(data):
    """(w, h) if data is a plausible GIF, else None."""
    if len(data) < 2000 or data[:6] not in (b"GIF87a", b"GIF89a"):
        return None
    w, h = struct.unpack_from("<HH", data, 6)
    if not (400 <= w <= 1400 and 400 <= h <= 1700):
        return None
    return (w, h)


def main():
    cat = json.loads(CAT_PATH.read_text())
    added, failed, skipped = [], [], 0
    for kind in ("solar", "lunar"):
        for entry in cat[kind]:
            if entry.get("map"):
                skipped += 1
                continue
            iso, etype = entry["date"], entry["type"]
            url = solar_url(iso, etype) if kind == "solar" \
                else lunar_url(iso, etype)
            fname = f"{kind}-{iso}.gif"
            dest = MAP_DIR / fname
            data, err = None, None
            for attempt in range(3):
                try:
                    data = download(url)
                    break
                except Exception as e:  # noqa: BLE001 - record, retry
                    err = e
                    time.sleep(2 * (attempt + 1))
            if data is None:
                failed.append((kind, iso, url, repr(err)))
                continue
            dims = gif_dims(data)
            if dims is None:
                failed.append((kind, iso, url,
                               f"not a plausible GIF ({len(data)} bytes)"))
                continue
            dest.write_bytes(data)
            # Insert `map` right after `type`, mirroring the
            # original 29 entries' key order.
            rebuilt = {}
            for k, v in entry.items():
                rebuilt[k] = v
                if k == "type":
                    rebuilt["map"] = f"/img/eclipse-maps/{fname}"
            entry.clear()
            entry.update(rebuilt)
            added.append((kind, iso, len(data), dims))
            print(f"ok {kind} {iso} {len(data)}B {dims[0]}x{dims[1]}")
            time.sleep(0.4)

    CAT_PATH.write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n")
    n_solar = sum(1 for a in added if a[0] == "solar")
    n_lunar = sum(1 for a in added if a[0] == "lunar")
    total = sum(a[2] for a in added)
    print(f"\nadded: {len(added)} (solar {n_solar}, lunar {n_lunar}), "
          f"{total} bytes; already had map: {skipped}; failed: {len(failed)}")
    for kind, iso, url, why in failed:
        print(f"FAILED {kind} {iso}: {why}\n  {url}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
