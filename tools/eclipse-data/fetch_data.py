#!/usr/bin/env python3
"""Fetch and parse eclipse circumstances data for the Stargazer app.

Solar: NASA GSFC SEdata pages -> polynomial Besselian elements.
Lunar: EclipseWise (Fred Espenak) LEprime pages -> contacts (TD),
       penumbral/umbral magnitudes, Delta T.

Raw pages are cached under tools/eclipse-data/raw/ (re-runs reuse
files already on disk, except for the two pre-existing solar examples
and the one pre-existing EclipseWise example, which are also reused).
Output: tools/eclipse-data/eclipse-circumstances.json

Standard library only. Every fetch/parse failure is recorded in an
anomalies list printed at the end and written to anomalies.txt next
to this script; nothing is silently dropped.
"""
import html
import json
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
OUT = os.path.join(HERE, "eclipse-circumstances.json")

SOLAR_DATES = [
    "2027-02-06", "2027-08-02", "2028-01-26", "2028-07-22",
    "2029-01-14", "2029-06-12", "2029-07-11", "2029-12-05",
    "2030-06-01", "2030-11-25", "2031-05-21", "2031-11-14",
    "2032-05-09", "2032-11-03",
]

# (ISO date, type suffix N=penumbral P=partial T=total)
LUNAR = [
    ("2027-02-20", "N"), ("2027-07-18", "N"), ("2027-08-17", "N"),
    ("2028-01-12", "P"), ("2028-07-06", "P"), ("2028-12-31", "T"),
    ("2029-06-26", "T"), ("2029-12-20", "T"), ("2030-06-15", "P"),
    ("2030-12-09", "N"), ("2031-05-07", "N"), ("2031-06-05", "N"),
    ("2031-10-30", "N"), ("2032-04-25", "T"), ("2032-10-18", "T"),
]

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) stargazer-data-fetch/1.0"}
anomalies = []


def note(msg):
    anomalies.append(msg)
    print("ANOMALY: " + msg, file=sys.stderr)


def fetch(url, dest):
    """Return page text; reuse cache if present. Record failures."""
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        with open(dest, encoding="utf-8", errors="replace") as f:
            return f.read()
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
    except Exception as e:  # noqa: BLE001 - record and continue
        note(f"fetch failed {url}: {e!r}")
        return None
    text = data.decode("utf-8", errors="replace")
    with open(dest, "w", encoding="utf-8") as f:
        f.write(text)
    time.sleep(0.5)
    return text


# ---------------------------------------------------------------- solar

def parse_solar(iso, text):
    if text is None:
        return None
    if "Polynomial Besselian Elements" not in text:
        note(f"solar {iso}: 'Polynomial Besselian Elements' not found in page")
        return None
    t = html.unescape(text)

    m = re.search(r"ΔT\s*=\s*([\d.]+)\s*s", t)
    dT = float(m.group(1)) if m else None
    if dT is None:
        note(f"solar {iso}: Delta T not found")

    m = re.search(
        r"Polynomial Besselian Elements for:\s+\d{4}\s+\w+\s+\d+\s+([\d.]+)\s+TDT",
        t)
    t0 = float(m.group(1)) if m else None
    if t0 is None:
        note(f"solar {iso}: t0 not found in Besselian header")

    m = re.search(r"tan f1\s*=\s*([\d.]+)\s+tan f2\s*=\s*([\d.]+)", t)
    if m:
        tanF1, tanF2 = float(m.group(1)), float(m.group(2))
    else:
        tanF1 = tanF2 = None
        note(f"solar {iso}: tan f1/f2 not found")

    # Coefficient rows: lines starting with row index 0..3 inside the
    # <pre> block after the Besselian header. Row 3 carries only x, y;
    # the PHP warning text and its trailing zero row are not matched
    # because they do not start with a bare row index.
    seg_m = re.search(
        r"Polynomial Besselian Elements for:.*?</pre>", t, re.S)
    seg = seg_m.group(0) if seg_m else t
    seg = re.sub(r"<[^>]+>", " ", seg)
    rows = {}
    for line in seg.splitlines():
        rm = re.match(
            r"^\s*([0-3])\s+(-?[\d.]+)\s+(-?[\d.]+)"
            r"(?:\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+))?\s*$",
            line)
        if rm:
            n = int(rm.group(1))
            vals = [float(g) if g is not None else 0.0
                    for g in rm.groups()[1:]]
            rows[n] = vals
    for n in range(4):
        if n not in rows:
            note(f"solar {iso}: coefficient row n={n} not found")
            return None
        if len(rows[n]) != 6:
            note(f"solar {iso}: row n={n} has {len(rows[n])} values, expected 6")
    cols = list(zip(*(rows[n] for n in range(4))))
    keys = ["x", "y", "d", "l1", "l2", "mu"]
    out = {"t0": t0, "dT": dT, "tanF1": tanF1, "tanF2": tanF2}
    for k, col in zip(keys, cols):
        out[k] = list(col)
    return out


# ---------------------------------------------------------------- lunar

def fmt_hms(raw):
    """Normalize 'HH:MM:SS.s' or 'HH:MM' to HH:MM:SS."""
    parts = raw.split(":")
    h, mnt = int(parts[0]), int(parts[1])
    sec = int(float(parts[2])) if len(parts) > 2 else 0
    return f"{h:02d}:{mnt:02d}:{sec:02d}"


CONTACT_KEYS = {"P1": "p1", "U1": "u1", "U2": "u2", "Greatest": "greatest",
                "U3": "u3", "U4": "u4", "P4": "p4"}
CONTACT_RE = re.compile(
    r"(P1|U1|U2|Greatest|U3|U4|P4)\s+"
    r"(\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s+"
    r"(\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\b")


def parse_lunar(iso, text):
    if text is None:
        return None
    txt = re.sub(r"<[^>]+>", " ", text)
    txt = html.unescape(txt)
    txt = re.sub(r"[ \t]+", " ", txt)
    lines = [ln.strip() for ln in txt.splitlines()]

    m = re.search(r"ΔT\s+([\d.]+)\s*s\b", txt) or re.search(
        r"has a value of\s+([\d.]+)\s+seconds", txt)
    dT = float(m.group(1)) if m else None
    if dT is None:
        note(f"lunar {iso}: Delta T not found")

    m = re.search(r"Penumbral Magnitude\s+(-?[\d.]+)", txt)
    pen = float(m.group(1)) if m else None
    if pen is None:
        note(f"lunar {iso}: Penumbral Magnitude not found")
    m = re.search(r"Umbral Magnitude\s+(-?[\d.]+)", txt)
    umb = float(m.group(1)) if m else None
    if umb is None:
        note(f"lunar {iso}: Umbral Magnitude not found")

    m = re.search(r"\bGamma\s+(-?[\d.]+)", txt)
    gamma = float(m.group(1)) if m else None
    if gamma is None:
        note(f"lunar {iso}: Gamma not found")

    # Shadow radii at t0 from the Besselian elements table
    # (row n=0: n, x, y, d, f1, f2, f3) — feeds the sky view's
    # eclipse diagram (radii in Earth radii at the Moon).
    m = re.search(
        r"\b0\s+-?\d+\.\d+\s+-?\d+\.\d+\s+-?\d+\.\d+\s+"
        r"(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)", txt)
    f1 = f2 = f3 = None
    if m:
        f1, f2, f3 = (float(m.group(i)) for i in (1, 2, 3))
    else:
        note(f"lunar {iso}: shadow radii (f1/f2/f3) not found")

    # Moon path polynomials (x, y) + t0 — the bulletin-figure
    # diagram draws the Moon at each contact along this path.
    m = re.search(r"at\s+(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)\s+TD\s+\(=t0\)", txt)
    t0 = None
    if m:
        t0 = int(m.group(1)) + int(m.group(2)) / 60 + float(m.group(3)) / 3600
    else:
        note(f"lunar {iso}: elements t0 not found")
    xs, ys = [], []
    seg = txt[txt.rfind("Polynomial Besselian Elements"):]
    end = seg.find("At time t1")
    if end > 0:
        seg = seg[:end]
    expect = 0
    for rm in re.finditer(r"\b([0-3])\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)", seg):
        if int(rm.group(1)) == expect:
            xs.append(float(rm.group(2)))
            ys.append(float(rm.group(3)))
            expect += 1
        if expect == 4:
            break
    if expect != 4:
        note(f"lunar {iso}: path rows parsed {expect}/4")
        xs = ys = None

    contacts = {k: None for k in
                ("p1", "u1", "u2", "greatest", "u3", "u4", "p4")}
    seen = set()
    for ln in lines:
        cm = CONTACT_RE.search(ln)
        if cm and ln.split()[0] not in ("Eclipse",):
            key = CONTACT_KEYS[cm.group(1)]
            if key in seen:
                continue
            # Row must look like a contacts-table row: label appears
            # as its own token and the TD time follows it.
            if re.search(rf"\b{cm.group(1)}\s+\d", ln):
                contacts[key] = fmt_hms(cm.group(2))
                seen.add(key)
    for req in ("p1", "greatest", "p4"):
        if contacts[req] is None:
            note(f"lunar {iso}: required contact {req} not found")
    return {"dT": dT, "penMag": pen, "umbMag": umb, "gamma": gamma,
            "f1": f1, "f2": f2, "f3": f3, "t0": t0, "x": xs, "y": ys,
            "contactsTD": contacts}


# ---------------------------------------------------------------- main

def main():
    os.makedirs(RAW, exist_ok=True)
    result = {"solar": {}, "lunar": {}}

    for iso in SOLAR_DATES:
        ymd = iso.replace("-", "")
        url = f"https://eclipse.gsfc.nasa.gov/SEsearch/SEdata.php?Ecl={ymd}"
        dest = os.path.join(RAW, f"solar-{ymd}.html")
        entry = parse_solar(iso, fetch(url, dest))
        if entry is None:
            note(f"solar {iso}: entry dropped (parse failed)")
        else:
            result["solar"][iso] = entry

    for iso, suffix in LUNAR:
        y, mo, d = iso.split("-")
        mon = MONTHS[int(mo) - 1]
        name = f"LE{y}{mon}{d}{suffix}"
        url = (f"https://eclipsewise.com/lunar/LEprime/2001-2100/"
               f"{name}prime.html")
        dest = os.path.join(RAW, f"EW-{name}.html")
        entry = parse_lunar(iso, fetch(url, dest))
        if entry is None:
            note(f"lunar {iso}: entry dropped (parse failed)")
        else:
            result["lunar"][iso] = entry
            # Type-specific structural check; missing umbral contacts on
            # partial/total eclipses are anomalies (not silent nulls).
            if suffix in ("P", "T"):
                for k in ("u1", "u4"):
                    if entry["contactsTD"][k] is None:
                        note(f"lunar {iso} ({suffix}): contact {k} is null")
            if suffix == "T":
                for k in ("u2", "u3"):
                    if entry["contactsTD"][k] is None:
                        note(f"lunar {iso} (T): contact {k} is null")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
        f.write("\n")

    # ---- sanity checks
    print(f"solar entries: {len(result['solar'])}/{len(SOLAR_DATES)}")
    for iso, e in result["solar"].items():
        for k in ("x", "y", "d", "l1", "l2", "mu"):
            assert len(e[k]) == 4, f"{iso} {k} len {len(e[k])}"
        assert 0.53 <= e["l1"][0] <= 0.60, f"{iso} l1[0]={e['l1'][0]}"
        assert all(abs(v) < 2.2 for v in e["x"][:1] + e["y"][:1]), iso
        assert e["dT"] is not None and 70 <= e["dT"] <= 80, \
            f"{iso} dT={e['dT']}"
    print(f"lunar entries: {len(result['lunar'])}/{len(LUNAR)}")
    for iso, e in result["lunar"].items():
        assert e["contactsTD"]["p1"] is not None, iso
        assert e["contactsTD"]["greatest"] is not None, iso
        assert e["contactsTD"]["p4"] is not None, iso
        assert e["penMag"] is not None and e["umbMag"] is not None, iso
    totals = [iso for iso, s in LUNAR if s == "T"]
    for iso in totals:
        c = result["lunar"][iso]["contactsTD"]
        assert all(c[k] is not None for k in ("u1", "u2", "u3", "u4")), iso
    print("sanity checks passed")
    print(f"anomalies: {len(anomalies)}")
    for a in anomalies:
        print(" -", a)
    with open(os.path.join(HERE, "anomalies.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(anomalies) + ("\n" if anomalies else ""))


if __name__ == "__main__":
    main()
