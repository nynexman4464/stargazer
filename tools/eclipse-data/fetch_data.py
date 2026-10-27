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
    "2032-05-09", "2032-11-03", "2033-03-30", "2033-09-23",
    "2034-03-20", "2034-09-12", "2035-03-09", "2035-09-02",
    "2036-02-27", "2036-07-23", "2036-08-21", "2037-01-16",
    "2037-07-13", "2038-01-05", "2038-07-02", "2038-12-26",
    "2039-06-21", "2039-12-15", "2040-05-11", "2040-11-04",
    "2041-04-30", "2041-10-25", "2042-04-20", "2042-10-14",
    "2043-04-09", "2043-10-03", "2044-02-28", "2044-08-23",
    "2045-02-16", "2045-08-12", "2046-02-05", "2046-08-02",
    "2047-01-26", "2047-06-23", "2047-07-22", "2047-12-16",
    "2048-06-11", "2048-12-05", "2049-05-31", "2049-11-25",
    "2050-05-20", "2050-11-14", "2051-04-11", "2051-10-04",
    "2052-03-30", "2052-09-22", "2053-03-20", "2053-09-12",
    "2054-03-09", "2054-08-03", "2054-09-02", "2055-01-27",
    "2055-07-24", "2056-01-16", "2056-07-12", "2057-01-05",
    "2057-07-01", "2057-12-26", "2058-05-22", "2058-06-21",
    "2058-11-16", "2059-05-11", "2059-11-05", "2060-04-30",
    "2060-10-24", "2061-04-20", "2061-10-13", "2062-03-11",
    "2062-09-03", "2063-02-28", "2063-08-24", "2064-02-17",
    "2064-08-12", "2065-02-05", "2065-07-03", "2065-08-02",
    "2065-12-27", "2066-06-22", "2066-12-17", "2067-06-11",
    "2067-12-06", "2068-05-31", "2068-11-24", "2069-04-21",
    "2069-05-20", "2069-10-15", "2070-04-11", "2070-10-04",
    "2071-03-31", "2071-09-23", "2072-03-19", "2072-09-12",
    "2073-02-07", "2073-08-03", "2074-01-27", "2074-07-24",
    "2075-01-16", "2075-07-13", "2076-01-06", "2076-06-01",
    "2076-07-01", "2076-11-26", "2077-05-22", "2077-11-15",
    "2078-05-11", "2078-11-04", "2079-05-01", "2079-10-24",
    "2080-03-21", "2080-09-13", "2081-03-10", "2081-09-03",
    "2082-02-27", "2082-08-24", "2083-02-16", "2083-07-15",
    "2083-08-13", "2084-01-07", "2084-07-03", "2084-12-27",
    "2085-06-22", "2085-12-16", "2086-06-11", "2086-12-06",
    "2087-05-02", "2087-06-01", "2087-10-26", "2088-04-21",
    "2088-10-14", "2089-04-10", "2089-10-04", "2090-03-31",
    "2090-09-23", "2091-02-18", "2091-08-15", "2092-02-07",
    "2092-08-03", "2093-01-27", "2093-07-23", "2094-01-16",
    "2094-06-13", "2094-07-12", "2094-12-07", "2095-06-02",
    "2095-11-27", "2096-05-22", "2096-11-15", "2097-05-11",
    "2097-11-04", "2098-04-01", "2098-09-25", "2098-10-24",
    "2099-03-21", "2099-09-14", "2100-03-10", "2100-09-04",
]

# (ISO date, type suffix N=penumbral P=partial T=total)
LUNAR = [
    ("2027-02-20", "N"), ("2027-07-18", "N"), ("2027-08-17", "N"),
    ("2028-01-12", "P"), ("2028-07-06", "P"), ("2028-12-31", "T"),
    ("2029-06-26", "T"), ("2029-12-20", "T"), ("2030-06-15", "P"),
    ("2030-12-09", "N"), ("2031-05-07", "N"), ("2031-06-05", "N"),
    ("2031-10-30", "N"), ("2032-04-25", "T"), ("2032-10-18", "T"),
    ("2033-04-14", "T"), ("2033-10-08", "T"), ("2034-04-03", "N"),
    ("2034-09-28", "P"), ("2035-02-22", "N"), ("2035-08-19", "P"),
    ("2036-02-11", "T"), ("2036-08-07", "T"), ("2037-01-31", "T"),
    ("2037-07-27", "P"), ("2038-01-21", "N"), ("2038-06-17", "N"),
    ("2038-07-16", "N"), ("2038-12-11", "N"), ("2039-06-06", "P"),
    ("2039-11-30", "P"), ("2040-05-26", "T"), ("2040-11-18", "T"),
    ("2041-05-16", "P"), ("2041-11-08", "P"), ("2042-04-05", "N"),
    ("2042-09-29", "N"), ("2043-03-25", "T"), ("2043-09-19", "T"),
    ("2044-03-13", "T"), ("2044-09-07", "T"), ("2045-03-03", "N"),
    ("2045-08-27", "N"), ("2046-01-22", "P"), ("2046-07-18", "P"),
    ("2047-01-12", "T"), ("2047-07-07", "T"), ("2048-01-01", "T"),
    ("2048-06-26", "P"), ("2048-12-20", "N"), ("2049-05-17", "N"),
    ("2049-06-15", "N"), ("2049-11-09", "N"), ("2050-05-06", "T"),
    ("2050-10-30", "T"), ("2051-04-26", "T"), ("2051-10-19", "T"),
    ("2052-04-14", "N"), ("2052-10-08", "P"), ("2053-03-04", "N"),
    ("2053-08-29", "N"), ("2054-02-22", "T"), ("2054-08-18", "T"),
    ("2055-02-11", "T"), ("2055-08-07", "P"), ("2056-02-01", "N"),
    ("2056-06-27", "N"), ("2056-07-26", "N"), ("2056-12-22", "N"),
    ("2057-06-17", "P"), ("2057-12-11", "P"), ("2058-06-06", "T"),
    ("2058-11-30", "T"), ("2059-05-27", "P"), ("2059-11-19", "P"),
    ("2060-04-15", "N"), ("2060-10-09", "N"), ("2060-11-08", "N"),
    ("2061-04-04", "T"), ("2061-09-29", "T"), ("2062-03-25", "T"),
    ("2062-09-18", "T"), ("2063-03-14", "P"), ("2063-09-07", "N"),
    ("2064-02-02", "P"), ("2064-07-28", "P"), ("2065-01-22", "T"),
    ("2065-07-17", "T"), ("2066-01-11", "T"), ("2066-07-07", "P"),
    ("2066-12-31", "N"), ("2067-05-28", "N"), ("2067-06-27", "N"),
    ("2067-11-21", "N"), ("2068-05-17", "P"), ("2068-11-09", "T"),
    ("2069-05-06", "T"), ("2069-10-30", "T"), ("2070-04-25", "N"),
    ("2070-10-19", "P"), ("2071-03-16", "N"), ("2071-09-09", "N"),
    ("2072-03-04", "T"), ("2072-08-28", "T"), ("2073-02-22", "T"),
    ("2073-08-17", "T"), ("2074-02-11", "N"), ("2074-07-08", "N"),
    ("2074-08-07", "N"), ("2075-01-02", "N"), ("2075-06-28", "P"),
    ("2075-12-22", "P"), ("2076-06-17", "T"), ("2076-12-10", "T"),
    ("2077-06-06", "P"), ("2077-11-29", "P"), ("2078-04-27", "N"),
    ("2078-10-21", "N"), ("2078-11-19", "N"), ("2079-04-16", "P"),
    ("2079-10-10", "T"), ("2080-04-04", "T"), ("2080-09-29", "T"),
    ("2081-03-25", "P"), ("2081-09-18", "N"), ("2082-02-13", "P"),
    ("2082-08-08", "N"), ("2083-02-02", "T"), ("2083-07-29", "T"),
    ("2084-01-22", "T"), ("2084-07-17", "P"), ("2085-01-10", "N"),
    ("2085-06-08", "N"), ("2085-07-07", "N"), ("2085-12-01", "N"),
    ("2086-05-28", "P"), ("2086-11-20", "P"), ("2087-05-17", "T"),
    ("2087-11-10", "T"), ("2088-05-05", "P"), ("2088-10-30", "P"),
    ("2089-03-26", "N"), ("2089-09-19", "N"), ("2090-03-15", "T"),
    ("2090-09-08", "T"), ("2091-03-05", "T"), ("2091-08-29", "T"),
    ("2092-02-23", "N"), ("2092-07-19", "N"), ("2092-08-17", "N"),
    ("2093-01-12", "N"), ("2093-07-08", "P"), ("2094-01-01", "P"),
    ("2094-06-28", "T"), ("2094-12-21", "T"), ("2095-06-17", "P"),
    ("2095-12-11", "P"), ("2096-05-07", "N"), ("2096-06-06", "N"),
    ("2096-10-31", "N"), ("2096-11-29", "N"), ("2097-04-26", "P"),
    ("2097-10-21", "T"), ("2098-04-15", "T"), ("2098-10-10", "T"),
    ("2099-04-05", "P"), ("2099-09-29", "N"), ("2100-02-24", "N"),
    ("2100-08-19", "N"),
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
        assert e["dT"] is not None and 50 <= e["dT"] <= 250, \
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
