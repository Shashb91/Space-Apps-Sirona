"""
routing.py - mode 3: rover path planning on a slope map.

plan_route(req) finds the cheapest path between two points that never crosses a cell
steeper than the rover's slope tolerance (A* search on the slope raster).

Request:
  {"start": {"lat": .., "lon": ..} or a site name,
   "end":   {"lat": .., "lon": ..} or a site name,
   "max_slope_deg": 15,                           # rover tolerance (default 15)
   "advanced": {"margin_deg": 3, "slope_weight": 2}}

Only a window around the two points is searched (margin_deg around their bounding box).
The window is downsampled (max-pooling, so it stays conservative) when it has too many cells.
"""
import heapq
import math
import os
import numpy as np

import constants
import terrain
from constants import R_MOON
from sites import sites

MAX_CELLS = 400_000   # max cells in the search window (downsampled above this)
BLOCKED = 999.0       # slope given to unknown cells: always impassable
MOVES = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

_SLOPE = {}           # raster cache: filled once by ensure_slope()


def ensure_slope():
    """Load the slope raster in memory once (float16). Values must be slopes in degrees
    after multiplication by SLOPE_SCALE."""
    if "z" in _SLOPE:
        return
    path = getattr(constants, "SLOPE_FILE", None)
    if not path or not os.path.exists(path):
        raise ValueError("Carte des pentes introuvable (SLOPE_FILE dans constants.py)")
    _SLOPE["z"] = terrain._read_dem(path).astype(np.float16)
    _SLOPE["ppd"] = getattr(constants, "SLOPE_PPD", 16)
    _SLOPE["scale"] = getattr(constants, "SLOPE_SCALE", 1.0)
    _SLOPE["lon0"] = getattr(constants, "SLOPE_LON0", 0.0)   # longitude of the raster's left edge


def _parse_point(p):
    """Accept a site name or {lat, lon}; returns (lat, lon) floats."""
    if isinstance(p, str):
        if p not in sites:
            raise ValueError(f"Site inconnu : {p} (disponibles : {sorted(sites)})")
        return sites[p]
    lat, lon = float(p["lat"]), float(p["lon"])
    if not (-90.0 <= lat <= 90.0):
        raise ValueError(f"Latitude hors limites : {lat}")
    return lat, lon


def _to_pixel(lat, lon, ppd, h, w, lon0=0.0):
    """Raster row/col of a point (same indexing convention as terrain.altitude)."""
    row = int(np.clip(round((90.0 - lat) * ppd), 0, h - 1))
    col = int(round(((lon - lon0) % 360.0) * ppd)) % w
    return row, col


def _haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance on the Moon [km]; angles in radians."""
    a = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * R_MOON * math.asin(min(1.0, math.sqrt(a)))


def plan_route(req):
    """Mode 3: path between two points for a rover with a slope tolerance."""
    ensure_slope()
    z, ppd, scale, lon0 = _SLOPE["z"], _SLOPE["ppd"], _SLOPE["scale"], _SLOPE["lon0"]
    h, w = z.shape

    a, b = _parse_point(req["start"]), _parse_point(req["end"])
    max_slope = float(req.get("max_slope_deg", 15.0))
    adv = req.get("advanced", {})
    margin_deg = float(adv.get("margin_deg", 3.0))
    slope_weight = float(adv.get("slope_weight", 2.0))   # extra cost on steep cells
    if max_slope <= 0 or margin_deg < 0 or slope_weight < 0:
        raise ValueError("max_slope_deg doit être > 0, margin_deg et slope_weight >= 0")

    # --- search window around the two points (columns may wrap around longitude 180)
    rs, cs = _to_pixel(a[0], a[1], ppd, h, w, lon0)
    re, _ = _to_pixel(b[0], b[1], ppd, h, w, lon0)
    dlon = (b[1] - a[1] + 180.0) % 360.0 - 180.0         # shortest signed longitude difference
    ce = cs + int(round(dlon * ppd))                      # unwrapped end column
    m = int(round(margin_deg * ppd))
    r0, r1 = max(0, min(rs, re) - m), min(h - 1, max(rs, re) + m)
    c0, c1 = min(cs, ce) - m, max(cs, ce) + m
    c1 = min(c1, c0 + w - 1)                              # never wider than the full circle
    win = z[np.ix_(np.arange(r0, r1 + 1), np.arange(c0, c1 + 1) % w)].astype(np.float32) * scale
    win = np.where(np.isfinite(win) & (win >= 0), win, BLOCKED)

    # --- downsample (max-pooling keeps steep cells) if the window is too large
    k = max(1, math.ceil(math.sqrt(win.size / MAX_CELLS)))
    if k > 1:
        H, W = win.shape
        win = np.pad(win, ((0, -H % k), (0, -W % k)), constant_values=BLOCKED)
        win = win.reshape(win.shape[0] // k, k, win.shape[1] // k, k).max(axis=(1, 3))
    nr, nc = win.shape
    slope = win.ravel().tolist()

    # --- geometry of the cells (km per step, latitude/longitude of cell centres)
    rows_deg = 90.0 - (r0 + np.arange(nr) * k + (k - 1) / 2) / ppd
    cols_deg = lon0 + (c0 + np.arange(nc) * k + (k - 1) / 2) / ppd   # unwrapped longitude
    lat_r = np.radians(rows_deg).tolist()
    lon_r = np.radians(cols_deg).tolist()
    dy = R_MOON * math.radians(k / ppd)                              # km per row step
    dx = (dy * np.maximum(np.cos(np.radians(rows_deg)), 1e-3)).tolist()   # km per column step

    si, sj = (rs - r0) // k, (cs - c0) // k
    ei, ej = (re - r0) // k, (ce - c0) // k
    start_idx, goal_idx = si * nc + sj, ei * nc + ej
    base = dict(start=dict(lat=a[0], lon=a[1]), end=dict(lat=b[0], lon=b[1]),
                max_slope_deg=max_slope, resolution_km=round(dy, 3), downsample=k)

    for name, idx in (("start", start_idx), ("end", goal_idx)):
        if slope[idx] > max_slope:
            return dict(**base, reachable=False, reason=f"{name}_too_steep",
                        message=f"Le point de {'départ' if name == 'start' else 'arrivée'} "
                                f"est trop pentu (pente locale {slope[idx]:.1f}°).")

    # --- A* search (8 neighbours, cost = distance x slope penalty)
    def heur(i, j):
        return _haversine_km(lat_r[i], lon_r[j], lat_r[ei], lon_r[ej])

    INF = float("inf")
    g = [INF] * (nr * nc)
    parent = [-1] * (nr * nc)
    g[start_idx] = 0.0
    heap = [(heur(si, sj), 0.0, si, sj)]
    while heap:
        _, gi, i, j = heapq.heappop(heap)
        idx = i * nc + j
        if gi > g[idx]:
            continue                                                  # stale heap entry
        if idx == goal_idx:
            break
        s_a = slope[idx]
        for di, dj in MOVES:
            ni, nj = i + di, j + dj
            if ni < 0 or ni >= nr or nj < 0 or nj >= nc:
                continue
            nidx = ni * nc + nj
            s_b = slope[nidx]
            if s_b > max_slope:
                continue                                              # too steep for the rover
            length = math.hypot(di * dy, dj * dx[i])
            ng = gi + length * (1.0 + slope_weight * ((s_a + s_b) / (2.0 * max_slope)) ** 2)
            if ng < g[nidx]:
                g[nidx] = ng
                parent[nidx] = idx
                heapq.heappush(heap, (ng + heur(ni, nj), ng, ni, nj))

    if g[goal_idx] == INF:
        return dict(**base, reachable=False, reason="no_path",
                    message="Aucun chemin dans la zone de recherche : augmente max_slope_deg "
                            "ou advanced.margin_deg.")

    # --- rebuild the path from goal to start
    cells = []
    idx = goal_idx
    while idx != -1:
        cells.append(idx)
        idx = parent[idx]
    cells.reverse()
    path = []
    for idx in cells:
        i, j = divmod(idx, nc)
        path.append(dict(lat=round(math.degrees(lat_r[i]), 5),
                         lon=round((math.degrees(lon_r[j]) + 180.0) % 360.0 - 180.0, 5),
                         slope_deg=round(slope[idx], 2)))
    path[0].update(lat=a[0], lon=a[1])                                # exact endpoints
    path[-1].update(lat=b[0], lon=b[1])

    dist = sum(_haversine_km(math.radians(p["lat"]), math.radians(p["lon"]),
                             math.radians(q["lat"]), math.radians(q["lon"]))
               for p, q in zip(path[:-1], path[1:]))
    straight = _haversine_km(math.radians(a[0]), math.radians(a[1]),
                             math.radians(b[0]), math.radians(b[1]))
    slopes = [p["slope_deg"] for p in path]
    return dict(**base, reachable=True, distance_km=round(dist, 3),
                straight_distance_km=round(straight, 3),
                max_path_slope_deg=max(slopes), mean_path_slope_deg=round(sum(slopes) / len(slopes), 2),
                n_points=len(path), path=path)