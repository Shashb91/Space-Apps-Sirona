"""
make_slope_map.py - makes Python_backend/ldem_64_slope.tif (rover routes, routing.py) from the
NASA relief map Python_backend/ldem_64.tif. Run it once (launcher.py does it when the map is missing):

    python tools/make_slope_map.py            or: python tools/make_slope_map.py <dem.tif> <slope.tif>

Each pixel's slope in degrees, from its neighbours (central differences):
    dz/dx = (z east - z west) / (2 dx)       dx = R x 1/64 deg x cos(latitude)   (wraps round at 180 deg)
    dz/dy = (z north - z south) / (2 dy)     dy = R x 1/64 deg
    slope = arctan(sqrt(dz/dx^2 + dz/dy^2))
The two pole rows use the row next to them only. z is in km, as in ldem_64.tif.
Needs numpy, tifffile and imagecodecs (Python_backend/requirements.txt).
"""
import sys
from pathlib import Path

import numpy as np
import tifffile

BACKEND = Path(__file__).resolve().parents[1] / "Python_backend"
R_MOON = 1737.4  # km, as constants.py
PPD = 64  # pixels per degree, as DEM_PPD in constants.py
TILE = 256  # rows (and columns) per tile: 11520 x 23040 is 45 x 90 tiles


def slope_rows(z, r0, r1):
    """Slopes (degrees) of rows r0 to r1 - 1 of the relief z (km, 90 N at the top)."""
    h = z.shape[0]
    top, bottom = max(r0 - 1, 0), min(r1 + 1, h)
    block = np.asarray(z[top:bottom], dtype=np.float32)
    rows = np.arange(r0, r1)
    north, south = np.maximum(rows - 1, 0), np.minimum(rows + 1, h - 1)
    dy = np.float32(R_MOON * np.pi / 180 / PPD)
    dx = (dy * np.cos(np.radians(90 - (rows + 0.5) / PPD))).astype(np.float32)[:, None]  # pixel centres
    mid = block[r0 - top:r1 - top]
    dzdx = (np.roll(mid, -1, axis=1) - np.roll(mid, 1, axis=1)) / (2 * dx)
    dzdy = (block[north - top] - block[south - top]) / ((south - north).astype(np.float32)[:, None] * dy)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy)))


def make(dem_path, out_path, show=print):
    try:
        z = tifffile.memmap(dem_path, mode="r")  # read as needed: the 1 GB map is never all in memory
    except ValueError:  # compressed: read it all
        z = tifffile.imread(dem_path)
    z = np.squeeze(z)
    h, w = z.shape
    shown = set()

    def tiles():
        for r0 in range(0, h, TILE):
            block = slope_rows(z, r0, min(r0 + TILE, h)).astype(np.float32)
            for c0 in range(0, w, TILE):
                yield block[:, c0:c0 + TILE]
            quarter = 4 * min(r0 + TILE, h) // h
            if 0 < quarter < 4 and quarter not in shown:
                shown.add(quarter)
                show(f"  {out_path.name}: {25 * quarter} %")

    part = out_path.with_name(out_path.name + ".part")
    tifffile.imwrite(part, data=tiles(), shape=(h, w), dtype=np.float32, tile=(TILE, TILE),
                     compression="zlib", predictor=True)
    part.replace(out_path)


if __name__ == "__main__":
    args = [Path(a) for a in sys.argv[1:]]
    dem = args[0] if args else BACKEND / "ldem_64.tif"
    out = args[1] if len(args) > 1 else BACKEND / "ldem_64_slope.tif"
    if not dem.exists():
        sys.exit(f"{dem} is missing: the Start file downloads it (or svs.gsfc.nasa.gov/4720).")
    print(f"Making {out.name} from {dem.name} (a few minutes)...", flush=True)
    make(dem, out, lambda text: print(text, flush=True))
    print(f"Done: {out}", flush=True)
