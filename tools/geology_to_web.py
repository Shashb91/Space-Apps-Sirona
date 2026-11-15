"""Turns the USGS Unified Geologic Map of the Moon (GIS v2) into two files the web page can load:

  UI/data/geology/units.png   4096 x 2048 lat/lon map; each pixel's value is a unit id (0 = no data)
  UI/data/geology/units.csv   one row per unit: id, code, name, period, type, colour, area,
                              a point to fly to, description, interpretation

Run once from the project folder:   python tools/geology_to_web.py
Needs numpy and Pillow. Names, colours and descriptions can then be edited in units.csv directly.
"""
import csv
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "Unified_Geologic_Map_of_the_Moon_GIS_v2" / "Unified_Geologic_Map_of_the_Moon_GIS" / "Lunar_GIS"
OUT = ROOT / "UI" / "data" / "geology"
W, H = 4096, 2048
R_M = 1737400.0  # the shapefile is equidistant cylindrical, in metres, on this sphere
R_KM = R_M / 1000

CODE_FIXES = {"Ios": "Iohs"}  # description table code -> shapefile code
NAME_FIXES = {"Ccc": "Copernican Crater, Catena"}

TYPES = {
    "Crater": "Cc Ccc Csc Ec Ecc Esc Ic Ic1 Ic2 Icc Isc Icf Iic Iohs Nc Nbsc pNc",
    "Volcanic": "Em EIp Id Im1 Im2 Imd",
    "Basin": "Ib Ibm Iia Iiap Iif Iohi Ioho Iom Iork Iorm Ig Nb Nbl Nbm Nnj pNb pNbm",
    "Plains": "Ip INp Np Ntp",
    "Terra": "It Itd INt Nt pNt",
}
TYPE_OF = {code: t for t, codes in TYPES.items() for code in codes.split()}


def read_dbf(path):
    data = path.read_bytes()
    nrec, hlen, rlen = struct.unpack("<IHH", data[4:12])
    fields, pos = [], 32
    while data[pos] != 0x0D:
        fields.append((data[pos:pos + 11].split(b"\0")[0].decode(), data[pos + 16]))
        pos += 32
    rows = []
    for i in range(nrec):
        rec, p, row = data[hlen + i * rlen: hlen + (i + 1) * rlen], 1, {}
        for name, length in fields:
            row[name] = rec[p:p + length].decode("latin-1").strip()
            p += length
        rows.append(row)
    return rows


def read_polygons(path):
    """Yields each record as a list of rings, each an (n, 2) array of projected metres."""
    data = path.read_bytes()
    pos = 100
    while pos < len(data):
        length = struct.unpack(">i", data[pos + 4:pos + 8])[0] * 2
        c = pos + 8
        if struct.unpack("<i", data[c:c + 4])[0] == 0:
            yield []
        else:
            nparts, npoints = struct.unpack("<ii", data[c + 36:c + 44])
            parts = list(np.frombuffer(data, "<i4", nparts, c + 44)) + [npoints]
            pts = np.frombuffer(data, "<f8", npoints * 2, c + 44 + 4 * nparts).reshape(-1, 2)
            yield [pts[parts[k]:parts[k + 1]] for k in range(nparts)]
        pos = c + length


def deepest_pixel(mask):
    """Pixel farthest inside a mask (repeated erosion), so the camera lands well inside the unit."""
    last = mask
    while mask.any():
        last = mask
        m = mask.copy()
        m[1:] &= mask[:-1]
        m[:-1] &= mask[1:]
        m[:, 1:] &= mask[:, :-1]
        m[:, :-1] &= mask[:, 1:]
        mask = m
    ys, xs = np.nonzero(last)
    k = len(ys) // 2
    return ys[k], xs[k]


def main():
    domu = list(csv.DictReader(open(SRC / "Symbol_LayerDefinitions" / "Unified_Geologic_Map_of_the_Moon_DOMU_descriptions.csv", encoding="utf-8-sig")))
    colors = {r["unit"]: r["color_hex"] for r in csv.DictReader(open(SRC / "Symbol_LayerDefinitions" / "GeologyUnit_colors.csv", encoding="utf-8-sig"))}
    records = read_dbf(SRC / "Shapefiles" / "GeoUnits.dbf")

    units = {}
    for d in domu:
        code = CODE_FIXES.get(d["Unit"], d["Unit"])
        units[code] = {
            "id": len(units) + 1, "code": code, "name": NAME_FIXES.get(code, d["Name"].strip()),
            "description": " ".join(d["Description"].split()), "interpretation": " ".join(d["Interpretation"].split()),
            "area": 0.0, "polygons": 0, "period": "", "best_ring": (0, None),
        }
    for r in records:
        code = r["FIRST_Unit"]
        if code not in units:
            units[code] = {"id": len(units) + 1, "code": code, "name": r["FIRST_Un_2"], "description": "",
                           "interpretation": "", "area": 0.0, "polygons": 0, "period": "", "best_ring": (0, None)}

    rings = []  # (area, unit id, pixel points) for every outer ring
    for rec, polygon in zip(records, read_polygons(SRC / "Shapefiles" / "GeoUnits.shp")):
        u = units[rec["FIRST_Unit"]]
        u["period"] = rec["FIRST_Un_1"]
        u["polygons"] += 1
        for ring in polygon:
            lon = np.degrees(ring[:, 0] / R_M)
            lat = np.degrees(ring[:, 1] / R_M)
            # Shoelace in (lon, sin lat) is an equal-area measure: area on the sphere = |A| * R^2.
            x, y = np.radians(lon), np.sin(np.radians(lat))
            a = 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y) * R_KM ** 2
            u["area"] -= a  # outer rings are clockwise (a < 0), holes counter-clockwise
            if a < 0:
                px = np.column_stack(((lon + 180) / 360 * W, (90 - lat) / 180 * H))
                rings.append((-a, u["id"], px))
                if -a > u["best_ring"][0]:
                    u["best_ring"] = (-a, px)

    # Painter's order: largest rings first, so whatever fills a hole is drawn on top of it.
    img = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(img)
    rings.sort(key=lambda r: -r[0])
    for _, uid, px in rings:
        draw.polygon([tuple(p) for p in px], fill=uid)
    idx = np.array(img)

    total = sum(u["area"] for u in units.values())
    print(f"rings drawn: {len(rings)}  total area {total:,.0f} km2 (sphere {4 * np.pi * R_KM ** 2:,.0f})"
          f"  unmapped pixels {np.mean(idx == 0):.4%}")

    for u in units.values():
        px = u["best_ring"][1]
        if px is None:
            u["lat"] = u["lon"] = ""
            continue
        x0, y0 = np.floor(px.min(0)).astype(int) - 1
        x1, y1 = np.ceil(px.max(0)).astype(int) + 2
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W), min(y1, H)
        mask = idx[y0:y1, x0:x1] == u["id"]
        if not mask.any():
            ys, xs = np.nonzero(idx == u["id"])
            if not len(ys):
                u["lat"] = u["lon"] = ""
                continue
            y, x = ys[len(ys) // 2], xs[len(xs) // 2]
        else:
            y, x = deepest_pixel(mask)
            y, x = y + y0, x + x0
        u["lat"] = round(90 - (y + 0.5) / H * 180, 2)
        u["lon"] = round((x + 0.5) / W * 360 - 180, 2)

    OUT.mkdir(parents=True, exist_ok=True)
    img.save(OUT / "units.png", optimize=True)
    with open(OUT / "units.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "code", "name", "period", "type", "color", "area km2", "area %", "polygons",
                    "latitude", "longitude", "description", "interpretation"])
        for u in sorted(units.values(), key=lambda u: u["id"]):
            w.writerow([u["id"], u["code"], u["name"], u["period"], TYPE_OF.get(u["code"], "Other"),
                        colors.get(u["code"], "#C8C8C8"), round(u["area"]), round(100 * u["area"] / total, 3),
                        u["polygons"], u["lat"], u["lon"], u["description"], u["interpretation"]])
    print(f"wrote {OUT / 'units.png'} and {OUT / 'units.csv'} ({len(units)} units)")


if __name__ == "__main__":
    main()
