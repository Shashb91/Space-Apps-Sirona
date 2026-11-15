"""
api.py - entry point between the transport layer (server.py / main.py) and the computation.

handle_request() normalises a JSON request and dispatches it to the right mode.
"""
from load_kernels import load_kernels
from query import find_locations, temperature_map, time_series
from routing import plan_route
from sites import sites

_kernels_loaded = False


def _ensure_kernels():
    """Load the SPICE kernels only once for the whole program."""
    global _kernels_loaded
    if not _kernels_loaded:
        load_kernels()
        _kernels_loaded = True


def _normalize(req):
    """Accept the old 'criterion' format and expand named 'sites' into 'points'."""
    req = dict(req)
    if "criteria" not in req and "criterion" in req:
        req["criteria"] = [req.pop("criterion")]

    names = req.pop("sites", None)
    if names is not None:
        if not isinstance(names, list) or not names:
            raise ValueError("'sites' doit être une liste non vide de noms")
        unknown = [s for s in names if s not in sites]
        if unknown:
            raise ValueError(f"Sites inconnus : {unknown} (disponibles : {sorted(sites)})")
        req["points"] = list(req.get("points") or []) + [
            dict(name=s, lat=sites[s][0], lon=sites[s][1]) for s in names]
    return req


def handle_request(req: dict) -> dict:
    """Run a request. With 'start' and 'end' -> mode 3 (route), with 'temperature_map' -> the
    surface temperature over the whole Moon at one instant, with 'criteria' -> mode 2,
    otherwise -> mode 1."""
    if not isinstance(req, dict):
        raise ValueError("La requête doit être un objet JSON")
    if "start" in req and "end" in req:
        return plan_route(req)       # mode 3: rover route 
    req = _normalize(req)
    _ensure_kernels()
    if "temperature_map" in req:
        return temperature_map(req)  # map of the surface temperature at one instant
    if "criteria" in req:
        return find_locations(req)   # mode 2: criteria. true/false at each time step
    return time_series(req)          # mode 1: points + date. properties at each time step
