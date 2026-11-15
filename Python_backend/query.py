"""
query.py - core computation and request handling.

Two modes are supported:
  * time_series(req)    : mode 1, all properties of given points over the next 30 days
                          (or advanced.range_days, up to a year).
  * find_locations(req) : mode 2, evaluate user criteria for given points (true/false at
                          each time step) or for a grid covering the whole Moon.

Conventions: positions are in the MOON_ME frame (km), angles in degrees unless stated,
arrays are shaped (P, T) = (points, time steps).
"""
import functools
import operator
import numpy as np
import spiceypy as sp
from datetime import datetime
from constants import R_MOON, R_SUN, R_EARTH, ABCORR, AU, S0
from eclairement import sun_fraction_horizon
import terrain
from temperature import surface_temperature, sun_geometry

# Quantities that can be used in criteria (also served to the website by GET /criteria)
CRITERIA_INFO = {
    "sun_elevation":   {"unit": "deg",  "desc": "Élévation géométrique du centre du Soleil"},
    "illumination":    {"unit": "%",    "desc": "% du disque solaire visible (horizon, relief si activé, éclipse par la Terre)"},
    "flux":            {"unit": "W/m2", "desc": "Flux solaire sur une surface horizontale"},
    "earth_elevation": {"unit": "deg",  "desc": "Élévation géométrique de la Terre"},
    "communication":   {"unit": "bool", "desc": "Terre au-dessus de earth_min_el (et du relief si activé) ; utiliser op '==' avec value 1 ou 0"},
    "temperature":     {"unit": "K",    "desc": "Température de surface (modèle thermique 1-D de Hayne et al. 2017, Lune lisse : sans relief ni éclipse)"},
    # Durations over the period (range_days from the date, even in mode "at"): one value per place,
    # the same at every time step. A night or a gap that reaches into the period counts in full.
    "longest_night":   {"unit": "days", "desc": "Plus longue nuit de la période : plus longue suite de pas de temps sans aucune partie du Soleil visible (illumination = 0, relief et éclipses compris)"},
    "longest_no_link": {"unit": "days", "desc": "Plus longue coupure de la liaison directe avec la Terre sur la période (communication = 0)"},
}
# The durations: the quantity each one follows, and when that quantity counts as "off"
DURATIONS = {
    "longest_night":   ("illumination",  lambda v: v < 1e-6),   # no part of the Sun's disc
    "longest_no_link": ("communication", lambda v: v < 0.5),    # no direct link with Earth
}
# Comparison operators allowed in a criterion
OPS = {">": lambda a, b: a > b, ">=": lambda a, b: a >= b,
       "<": lambda a, b: a < b,  "<=": lambda a, b: a <= b,
       "==": lambda a, b: a == b}

MAX_EVALS = 100_000_000_000     # max points x time steps per request
CHUNK_EVALS = 100_000_000_000     # max block size kept in memory
MAX_DEPTH = 5               # max nesting of and/or/not
MAX_LEAVES = 30             # max number of criteria
MAX_TERRAIN_POINTS = 3000   # max points when terrain is enabled
MAX_USER_POINTS = 1000      # max points when a true/false per time step is returned
SERIES_DAYS = 30            # mode 1: default duration (one month)
MAX_SERIES_DAYS = 366       # mode 1: longest duration (advanced.range_days)
DURATION_MARGIN_DAYS = 16   # a night (14.8 days at the equator) or a link gap cut by the period's
                            # start or end is followed this far beyond it, to count it in full
DURATION_CHUNK_EVALS = 2_000_000   # points x time steps computed at once for the durations


# ---------------------------------------------------------------- criteria
def _check(node, depth, leaves):
    """Recursively validate a criteria expression; appends the criterion types used to leaves."""
    if depth > MAX_DEPTH:
        raise ValueError(f"Critères trop imbriqués (max {MAX_DEPTH} niveaux)")
    if not isinstance(node, dict):
        raise ValueError(f"Critère invalide (objet JSON attendu) : {node!r}")
    comb = [k for k in ("and", "or", "not") if k in node]
    if len(comb) > 1:
        raise ValueError(f"Un seul de 'and', 'or', 'not' par niveau : {node}")
    if comb:
        # Combinator node: validate every child
        k = comb[0]
        if k == "not":
            children = [node["not"]]
        else:
            children = node[k]
            if not isinstance(children, list) or not children:
                raise ValueError(f"'{k}' doit contenir une liste non vide de critères")
        for ch in children:
            _check(ch, depth + 1, leaves)
        return
    # Leaf node: {type, op, value}
    for key in ("type", "op", "value"):
        if key not in node:
            raise ValueError(f"Critère incomplet (manque '{key}') : {node}")
    if node["type"] not in CRITERIA_INFO:
        raise ValueError(f"Critère non supporté : {node['type']} "
                         f"(disponibles : {sorted(CRITERIA_INFO)})")
    if node["op"] not in OPS:
        raise ValueError(f"Opérateur invalide : {node['op']} (disponibles : {sorted(OPS)})")
    float(node["value"])
    leaves.append(node["type"])


def _to_expr(criteria, combine):
    """A list becomes {combine: list}; a dict is already an expression."""
    if isinstance(criteria, list):
        if combine not in ("and", "or"):
            raise ValueError(f"'combine' doit valoir 'and' ou 'or' : {combine}")
        if not criteria:
            raise ValueError("'criteria' est vide")
        return {combine: criteria}
    return criteria


def _eval(node, vals):
    """Evaluate the expression; returns a boolean array of shape (P, T)."""
    if "and" in node:
        return functools.reduce(operator.and_, [_eval(n, vals) for n in node["and"]])
    if "or" in node:
        return functools.reduce(operator.or_, [_eval(n, vals) for n in node["or"]])
    if "not" in node:
        return ~_eval(node["not"], vals)
    return OPS[node["op"]](vals[node["type"]], float(node["value"]))


def _longest_run(off, first, last):
    """Longest run of consecutive True along axis 1 of a (P, T) array, in time steps (P,), among
    the runs that reach into the steps first..last (whole runs, also outside first..last)."""
    P, T = off.shape
    run = np.zeros(P, dtype=int)
    best = np.zeros(P, dtype=int)
    for t in range(T + 1):
        on = off[:, t] if t < T else np.zeros(P, dtype=bool)
        # A run ends at t - 1 where it stops now; it started at t - run
        ended = ~on & (run > 0) & (t - run <= last) & (t - 1 >= first)
        best = np.where(ended & (run > best), run, best)
        run = np.where(on, run + 1, 0)
    return best


# ---------------------------------------------------------------- geometry
def make_grid(step_deg):
    """Grid covering the whole Moon, as a list of (lat, lon) cell centres in degrees.
    Cell centres are used so that no point falls exactly on a pole."""
    lats = np.arange(-90 + step_deg / 2, 90, step_deg)
    lons = np.arange(-180 + step_deg / 2, 180, step_deg)
    return [(float(la), float(lo)) for la in lats for lo in lons]


def _unit(lat_deg, lon_deg):
    """Local vertical (unit vector) for each point, shape (P, 3)."""
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    return np.stack([np.cos(lat) * np.cos(lon),
                     np.cos(lat) * np.sin(lon),
                     np.sin(lat)], axis=1)


def _body(U, pos):
    """For a body at positions pos (T, 3) (MOON_ME, km) seen from sites R*U, returns
    (elevation in deg, distance in km, U.pos), each of shape (P, T)."""
    d = U @ pos.T                                        # (P, T)
    s2 = np.einsum("tk,tk->t", pos, pos)                 # (T,)
    norm = np.sqrt(s2[None, :] - 2 * R_MOON * d + R_MOON ** 2)   # |pos - R*U|
    el = np.degrees(np.arcsin(np.clip((d - R_MOON) / norm, -1.0, 1.0)))
    return el, norm, d


def overlap_area(r1, r2, d):
    """Vectorised intersection area of two discs (radii r1, r2, centre distance d)."""
    r1, r2, d = np.broadcast_arrays(r1, r2, d)
    # Full overlap (one disc inside the other); partial cases are filled in below
    out = np.where(d <= np.abs(r1 - r2), np.pi * np.minimum(r1, r2) ** 2, 0.0)
    part = (d > np.abs(r1 - r2)) & (d < r1 + r2)
    if part.any():
        a, b, c = r1[part], r2[part], d[part]
        a1 = a ** 2 * np.arccos(np.clip((c ** 2 + a ** 2 - b ** 2) / (2 * c * a), -1.0, 1.0))
        a2 = b ** 2 * np.arccos(np.clip((c ** 2 + b ** 2 - a ** 2) / (2 * c * b), -1.0, 1.0))
        tri = 0.5 * np.sqrt(np.clip((-c + a + b) * (c + a - b) * (c - a + b) * (c + a + b),
                                    0.0, None))
        out[part] = a1 + a2 - tri
    return out


def compute_values(needed, pts, sun, earth, use_terrain=False, earth_min_el=5.0):
    """Compute only the requested quantities. Every array has shape (P, T).
    needed : set of criterion names (not the DURATIONS: see durations()); earth may be None if
             not needed.
    pts    : list of (lat, lon) in degrees; sun/earth: (T, 3) positions in MOON_ME (km)."""
    lat = np.array([p[0] for p in pts], dtype=float)
    lon = np.array([p[1] for p in pts], dtype=float)
    U = _unit(lat, lon)
    el_s, d_s, su = _body(U, sun)
    vals = {}
    if "sun_elevation" in needed:
        vals["sun_elevation"] = el_s

    if needed & {"illumination", "flux"}:
        # Visible fraction of the solar disc: horizon (and terrain) x Earth eclipse
        rho_s = np.arcsin(R_SUN / d_s)
        hor = terrain.horizon_at_sun(lat, lon, sun) if use_terrain else 0.0
        f_hor = sun_fraction_horizon(el_s, rho_s, hor)
        el_e, d_e, eu = _body(U, earth)
        rho_e = np.arcsin(R_EARTH / d_e)
        se = np.einsum("tk,tk->t", sun, earth)
        dot = se[None, :] - R_MOON * (su + eu) + R_MOON ** 2      # sun_vec . earth_vec (from site)
        sep = np.arccos(np.clip(dot / (d_s * d_e), -1.0, 1.0))    # angular Sun-Earth separation
        f_ecl = 1.0 - overlap_area(rho_s, rho_e, sep) / (np.pi * rho_s ** 2)
        f_sun = f_hor * f_ecl
        vals["illumination"] = 100.0 * f_sun
        vals["flux"] = (S0 * (AU / d_s) ** 2 * f_sun
                        * np.maximum(np.sin(np.radians(el_s)), 0.0))

    if needed & {"earth_elevation", "communication"}:
        el_e, _, _ = _body(U, earth)
        vals["earth_elevation"] = el_e
        if "communication" in needed:
            # Direct link possible if Earth is above the minimum elevation (and the terrain)
            threshold = earth_min_el
            if use_terrain:
                threshold = np.maximum(earth_min_el, terrain.horizon_at_sun(lat, lon, earth))
            vals["communication"] = (el_e > threshold).astype(float)

    if "temperature" in needed:
        # Regolith thermal model (temperature.py), driven by the Sun's position from SPICE
        vals["temperature"] = surface_temperature(lat, lon, sun)
    return vals


def durations(req, points, days, wanted):
    """The DURATIONS in wanted for each point, in days (one array of P values each): the longest
    night or link gap that reaches into the period [date, date + days], counted in full, also
    the part beyond the period (up to DURATION_MARGIN_DAYS on each side)."""
    m = DURATION_MARGIN_DAYS
    s = _setup(req, days + 2 * m, points, wanted, offset_days=-m)
    first = int(round(m * 24 / s["step"]))
    last = first + int(days * 24 / s["step"])
    bases = {DURATIONS[w][0] for w in wanted}
    out = {w: np.zeros(len(points)) for w in wanted}
    chunk = max(1, DURATION_CHUNK_EVALS // s["n"])
    for i in range(0, len(points), chunk):
        vals = compute_values(bases, points[i:i + chunk], s["sun"], s["earth"],
                              s["use_terrain"], s["earth_min_el"])
        for w in wanted:
            base, off = DURATIONS[w]
            out[w][i:i + chunk] = _longest_run(off(vals[base]), first, last) * s["step"] / 24.0
    return out


# ---------------------------------------------------------------- shared preparation
def _read_points(raw):
    """Convert the JSON list of {lat, lon} into a list of (lat, lon) floats; checks latitude."""
    if not isinstance(raw, list):
        raise ValueError("'points' doit être une liste de {lat, lon}")
    points = [(float(p["lat"]), float(p["lon"])) for p in raw]
    for la, _ in points:
        if not (-90.0 <= la <= 90.0):
            raise ValueError(f"Latitude hors limites : {la}")
    return points


def _setup(req, days, points, needed, offset_days=0.0):
    """Advanced options, terrain, dates and ephemerides, shared by both modes.
    offset_days: the first time step, from 00:00 UTC on the date (negative: before it).
    Returns a dict: n (time steps), sun/earth (T, 3), times (UTC strings), step (hours),
    use_terrain, earth_min_el."""
    adv = req.get("advanced", {})
    step = float(adv.get("step_hours", 1.0))
    earth_min_el = float(adv.get("earth_min_el", 5.0))
    use_terrain = bool(adv.get("terrain", True))   # terrain is on by default; send "terrain": false to disable
    if step <= 0 or days < 0:
        raise ValueError("step_hours doit être > 0 et range_days >= 0")

    if use_terrain:
        if len(points) > MAX_TERRAIN_POINTS:
            raise ValueError(f"Avec le relief, {MAX_TERRAIN_POINTS} points maximum "
                             f"({len(points)} demandés) : utilise 'points', 'sites' "
                             "ou une grille plus large")
        terrain.ensure_dem()

    n = int(days * 24 / step) + 1
    if len(points) * n > MAX_EVALS:
        raise ValueError(f"Trop de calculs ({len(points) * n}) : augmente "
                         "grid_step_deg ou step_hours, ou réduis range_days")

    # Time steps start at 00:00 UTC on the requested date
    start = datetime.strptime(req["date"], "%d/%m/%Y").strftime("%Y-%m-%d 00:00:00")
    ets = sp.str2et(start) + offset_days * 86400.0 + np.arange(n) * step * 3600.0
    sun = np.atleast_2d(sp.spkpos("SUN", ets, "MOON_ME", ABCORR, "MOON")[0])   # (T, 3)
    earth = None
    if needed - {"sun_elevation", "temperature"}:
        earth = np.atleast_2d(sp.spkpos("EARTH", ets, "MOON_ME", ABCORR, "MOON")[0])
    times = [sp.et2utc(t, "ISOC", 0) for t in ets]
    return dict(n=n, sun=sun, earth=earth, times=times, step=step,
                use_terrain=use_terrain, earth_min_el=earth_min_el)


# ---------------------------------------------------------------- mode 1: point properties
def time_series(req):
    """Mode 1: coordinates + date -> every property at each time step over 30 days (or
    advanced.range_days, up to MAX_SERIES_DAYS). Also returns the Sun/Earth azimuths, distances
    and position vectors."""
    raw = req.get("points")
    if not raw:
        raise ValueError("Sans 'criteria', la requête doit contenir 'points' ou 'sites'")
    points = _read_points(raw)
    if len(points) > MAX_USER_POINTS:
        raise ValueError(f"{MAX_USER_POINTS} points maximum")

    days = float(req.get("advanced", {}).get("range_days", SERIES_DAYS))
    if not (0 < days <= MAX_SERIES_DAYS):
        raise ValueError(f"range_days doit être entre 0 et {MAX_SERIES_DAYS} jours")
    needed = set(CRITERIA_INFO) - set(DURATIONS)
    s = _setup(req, days, points, needed)
    vals = compute_values(needed, points, s["sun"], s["earth"],
                          s["use_terrain"], s["earth_min_el"])
    longest = durations(req, points, days, set(DURATIONS))

    # Sun and Earth position as seen from each point (azimuth: from north, towards east)
    lat = np.array([q[0] for q in points])
    lon = np.array([q[1] for q in points])
    U = _unit(lat, lon)
    extras = {
        "sun_azimuth": np.degrees(terrain.sun_azimuth(lat, lon, s["sun"])),
        "earth_azimuth": np.degrees(terrain.sun_azimuth(lat, lon, s["earth"])),
        "sun_distance_km": _body(U, s["sun"])[1],
        "earth_distance_km": _body(U, s["earth"])[1],
    }

    out = []
    for i, (p, q) in enumerate(zip(raw, points)):
        v = {k: np.round(a[i], 3).tolist() for k, a in {**vals, **extras}.items()}
        v["communication"] = (vals["communication"][i] > 0.5).tolist()   # booleans
        d = dict(lat=q[0], lon=q[1], values=v,
                 # days: the longest night and link gap reaching into the period, counted in full
                 durations={k: round(float(a[i]), 3) for k, a in longest.items()})
        if "name" in p:
            d = {"name": p["name"], **d}
        out.append(d)
    return dict(mode="series", date=req["date"], range_days=days, terrain=s["use_terrain"],
                n_times=s["n"], times=s["times"],
                # Moon centre -> body, MOON_ME frame (x, y, z in km), one per time step
                sun_vector_km=np.round(s["sun"], 1).tolist(),
                earth_vector_km=np.round(s["earth"], 1).tolist(),
                points=out)


# ---------------------------------------------------------------- mode 2: criteria
def find_locations(req):
    """Mode 2: evaluate the criteria expression.
    With points/sites: returns match, fraction and a true/false 'ok' per time step.
    Without points: tests a grid over the whole Moon and returns the % of time per cell."""
    leaves = []
    expr = _to_expr(req["criteria"], req.get("combine", "and"))
    _check(expr, 0, leaves)
    if len(leaves) > MAX_LEAVES:
        raise ValueError(f"Trop de critères ({len(leaves)}, max {MAX_LEAVES})")
    needed = set(leaves)

    # "at" (one instant), "any" (at least once), "all" (always) or "avg" (each quantity averaged
    # over the period, then compared; communication, 1 when possible and 0 when not, becomes the
    # fraction of the time it is possible: compare it with a value between 0 and 1)
    mode = req.get("mode", "any")
    if mode not in ("at", "any", "all", "avg"):
        raise ValueError(f"Mode invalide : {mode}")

    adv = req.get("advanced", {})
    days = 0 if mode == "at" else float(adv.get("range_days", 1))
    grid_step = float(adv.get("grid_step_deg", 5.0))   # 5 deg keeps the grid under MAX_TERRAIN_POINTS
    if grid_step <= 0:
        raise ValueError("grid_step_deg doit être > 0")

    raw = req.get("points")
    user_points = bool(raw)
    if user_points:
        points = _read_points(raw)
        if len(points) > MAX_USER_POINTS:
            raise ValueError(f"{MAX_USER_POINTS} points maximum")
    else:
        points = make_grid(grid_step)

    # The durations: one value per place over the period (in mode "at" too: range_days)
    wanted = needed & set(DURATIONS)
    others = needed - wanted
    s = _setup(req, days, points, others)
    n = s["n"]
    longest = {}
    if wanted:
        period = days if mode != "at" else float(adv.get("range_days", SERIES_DAYS))
        if period <= 0:
            raise ValueError("Les durées (longest_night, longest_no_link) demandent range_days > 0")
        longest = durations(req, points, period, wanted)

    # For each point: number of time steps where the expression is true, computed by blocks
    ok = np.zeros((len(points), n), dtype=bool) if user_points else None
    hits = np.zeros(len(points), dtype=int)
    chunk = max(1, CHUNK_EVALS // n)
    for i in range(0, len(points), chunk):
        part = points[i:i + chunk]
        vals = compute_values(others, part, s["sun"], s["earth"],
                              s["use_terrain"], s["earth_min_el"]) if others else {}
        for k, a in longest.items():   # the same at every time step
            vals[k] = np.broadcast_to(a[i:i + chunk, None], (len(part), n))
        if mode == "avg":
            vals = {k: v.mean(axis=1, keepdims=True) for k, v in vals.items()}
            res = np.repeat(_eval(expr, vals), n, axis=1)   # one answer for the whole period
        else:
            res = _eval(expr, vals)
        hits[i:i + chunk] = res.sum(axis=1)
        if user_points:
            ok[i:i + chunk] = res

    frac = hits / n
    keep = frac > 0 if mode == "any" else frac == 1.0

    base = dict(date=req["date"], mode=mode, criteria=req["criteria"],
                combine=req.get("combine", "and"), terrain=s["use_terrain"],
                n_times=n, n_tested=len(points), n_matching=int(keep.sum()))

    if user_points:
        out = []
        for i, (p, q) in enumerate(zip(raw, points)):
            d = dict(lat=q[0], lon=q[1], match=bool(keep[i]), fraction=float(frac[i]),
                     ok=ok[i].tolist())      # true/false at each instant of 'times'
            if "name" in p:
                d = {"name": p["name"], **d}
            out.append(d)
        return dict(**base, times=s["times"], points=out)

    # Grid: flat array, latitude is the outer loop and longitude the inner loop
    n_lat = len(np.arange(-90 + grid_step / 2, 90, grid_step))
    n_lon = len(np.arange(-180 + grid_step / 2, 180, grid_step))
    values = [int(round(f * 100)) if k else None for f, k in zip(frac, keep)]
    return dict(**base,
                grid=dict(step_deg=grid_step,
                          lat0=-90 + grid_step / 2, lon0=-180 + grid_step / 2,
                          n_lat=n_lat, n_lon=n_lon),
                values=values)   # None = not kept, otherwise 0-100 (% of time the expression is true)


# ---------------------------------------------------------------- temperature map
def temperature_map(req):
    """Surface temperature over the whole Moon at one instant.
    Request: {"temperature_map": {"utc": "2026-11-15T12:00:00", "step_deg": 0.5}}.
    Returns the grid (same layout as find_locations) and one value per cell in K (integers)."""
    opts = req["temperature_map"]
    if not isinstance(opts, dict):
        opts = {}
    utc = str(opts.get("utc") or req.get("utc") or "")
    if not utc:
        raise ValueError("'temperature_map' demande 'utc' (ex. \"2026-11-15T12:00:00\")")
    step = float(opts.get("step_deg", 0.5))
    if not (0.1 <= step <= 10):
        raise ValueError("step_deg doit être entre 0.1 et 10")

    et = sp.str2et(utc)
    sun = np.atleast_2d(sp.spkpos("SUN", et, "MOON_ME", ABCORR, "MOON")[0])
    lats = np.arange(-90 + step / 2, 90, step)
    lons = np.arange(-180 + step / 2, 180, step)
    lat, lon = np.meshgrid(lats, lons, indexing="ij")        # latitude outer, longitude inner
    temp = surface_temperature(lat.ravel(), lon.ravel(), sun)[:, 0]
    lon_ss, dec, dist = sun_geometry(sun)
    return dict(mode="temperature_map", utc=sp.et2utc(et, "ISOC", 0), unit="K",
                subsolar_lon=round(float(lon_ss[0]), 3), subsolar_lat=round(float(dec[0]), 3),
                sun_distance_km=round(float(dist[0]), 1),
                grid=dict(step_deg=step, lat0=-90 + step / 2, lon0=-180 + step / 2,
                          n_lat=len(lats), n_lon=len(lons)),
                min=round(float(temp.min()), 1), max=round(float(temp.max()), 1),
                values=np.rint(temp).astype(int).tolist())
