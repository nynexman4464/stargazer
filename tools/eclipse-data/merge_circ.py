#!/usr/bin/env python3
"""Merge eclipse-circumstances.json (produced by fetch_data.py)
into public/data/eclipses.json as a `circ` field on each entry,
so the app ships one data file. Re-run after refreshing the
circumstances or adding catalog eclipses."""
import json
import pathlib

root = pathlib.Path(__file__).resolve().parents[2]
circ = json.loads((root / "tools/eclipse-data/eclipse-circumstances.json").read_text())
cat_path = root / "public/data/eclipses.json"
cat = json.loads(cat_path.read_text())

missing = []
for kind in ("solar", "lunar"):
    for entry in cat[kind]:
        data = circ[kind].get(entry["date"])
        if data is None:
            missing.append((kind, entry["date"]))
        else:
            entry["circ"] = data
if missing:
    raise SystemExit(f"no circumstance data for: {missing}")
cat_path.write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n")
print("merged circ into", cat_path)
