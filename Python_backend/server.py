"""
server.py - HTTP entry point for the website (FastAPI).

Routes:
  GET  /health    : liveness check
  GET  /criteria  : what the website can ask (used to build the interface)
  POST /query     : run a request (modes 1-3 or a temperature map, see api.handle_request)

Run with: uvicorn server:app --port 8000
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from spiceypy.utils.exceptions import SpiceyError
from threading import Lock

from api import handle_request
from query import CRITERIA_INFO, OPS, MAX_EVALS, MAX_DEPTH, MAX_LEAVES
from sites import sites

app = FastAPI()
# CORS is open for testing; restrict allow_origins to the website's address in production
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])
lock = Lock()   # SPICE is not thread-safe: one request at a time


@app.get("/health")
def health():
    """Return {"status": "ok"} when the server is running."""
    return {"status": "ok"}


@app.get("/criteria")
def criteria():
    """What the website can ask: criteria, operators, modes, sites, defaults and limits."""
    return dict(
        criteria=CRITERIA_INFO,
        operators=sorted(OPS),
        modes=["at", "any", "all", "avg"],
        combinators=["and", "or", "not"],
        sites=sorted(sites),
        advanced_defaults=dict(step_hours=1.0, range_days=1, grid_step_deg=5.0,
                               terrain=True, earth_min_el=5.0),
        limits=dict(max_evals=MAX_EVALS, max_depth=MAX_DEPTH, max_leaves=MAX_LEAVES),
    )


@app.post("/query")
def query(req: dict):
    """Run a JSON request; invalid requests return HTTP 400 with a readable message."""
    try:
        with lock:
            return handle_request(req)
    except (KeyError, ValueError, TypeError, AttributeError, SpiceyError) as e:
        raise HTTPException(400, f"Requête invalide : {type(e).__name__}: {e}")
