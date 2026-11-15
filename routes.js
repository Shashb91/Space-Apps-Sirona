import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { el, formatLatLon } from "./panel.js";
import { post, serverHelp } from "./api.js";

// Sirona Maps mode: a rover route between two points that never climbs a slope steeper than the
// rover can take. The team's Python server finds it (routing.py: A* search on the slope map).
const MOON_RADIUS_KM = 1737.4;

// Along the route, how close the slope is to the rover's limit: easy → at the limit
export const ROUTE_COLOURS = ["#4FE3A1", "#FFD23F", "#FF5A4D"];
const OUTLINE = "#000026";

const REASONS = {
  start_too_steep: "The start is too steep for the rover",
  end_too_steep: "The destination is too steep for the rover",
};

const $ = (id) => document.getElementById(id);
const km = (v) => `${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : 1 })} km`;
const deg = (v) => `${v.toFixed(1)}°`;
const ramp = ROUTE_COLOURS.map((hex) => new THREE.Color(hex)); // shader (linear) colours

function colourAt(t) {
  const c = new THREE.Color();
  return t < 0.5 ? c.lerpColors(ramp[0], ramp[1], t * 2) : c.lerpColors(ramp[1], ramp[2], t * 2 - 1);
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * MOON_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

// A small chart of slope against distance along the route, coloured the same way as the 3D line.
function slopeProfile(path, maxSlope) {
  const W = 280, H = 64, PAD = 3;
  let dist = 0;
  const xs = [0];
  for (let i = 1; i < path.length; i++) {
    dist += haversineKm(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon);
    xs.push(dist);
  }
  const total = dist || 1;
  const sx = (d) => PAD + (d / total) * (W - 2 * PAD);
  const sy = (s) => H - PAD - (Math.min(s, maxSlope) / maxSlope) * (H - 2 * PAD);
  const top = path.map((p, i) => `${sx(xs[i]).toFixed(1)},${sy(p.slope_deg).toFixed(1)}`).join(" L ");
  const gradId = `slopeProfileGrad${Math.random().toString(36).slice(2, 8)}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "slope-profile-chart");
  svg.innerHTML = `
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="${ROUTE_COLOURS[0]}" />
        <stop offset="50%" stop-color="${ROUTE_COLOURS[1]}" />
        <stop offset="100%" stop-color="${ROUTE_COLOURS[2]}" />
      </linearGradient>
    </defs>
    <path d="M ${sx(0)},${H - PAD} L ${top} L ${sx(total)},${H - PAD} Z" fill="url(#${gradId})" fill-opacity="0.3" stroke="none" />
    <path d="M ${top}" fill="none" stroke="url(#${gradId})" stroke-width="1.6" stroke-linejoin="round" />
  `;
  return el("div", "slope-profile", [
    el("div", "slope-profile-head", ["Slope along the way", el("span", null, km(total))]),
    svg,
  ]);
}

// surfacePoint(lat, lon, out): point on the displaced Moon (follows the relief slider);
// makeMarker(letter): a sprite for the start (A) and destination (B);
// onPick(lat, lon): a spot was clicked; onFly(lat, lon, distance): show the route.
export function setupRoutes({ ready, surfacePoint, makeMarker, pixelRatio, onPick, onFly }) {
  const form = $("routeForm");
  const fields = {
    start: [$("routeStartLat"), $("routeStartLon")],
    end: [$("routeEndLat"), $("routeEndLon")],
  };
  const maxSlopeIn = $("routeMaxSlope");
  const marginIn = $("routeMargin");
  const weightSel = $("routeWeight");
  const nextEl = $("routeNext");
  const goBtn = form.querySelector(".point-go");
  const resultEl = $("routeResult");

  const markers = { start: makeMarker("A"), end: makeMarker("B") };

  // The route: a dark outline under a line coloured by slope. Drawn over the terrain (no depth
  // test, so hills never cut it) and clipped at the horizon, so its far-side part stays hidden.
  const horizon = new THREE.Plane();
  const lineMaterial = (options) => new LineMaterial({
    depthTest: false, depthWrite: false, clippingPlanes: [horizon], ...options,
  });
  const outline = new Line2(new LineGeometry(), lineMaterial({ color: OUTLINE, linewidth: 7 * pixelRatio }));
  const line = new Line2(new LineGeometry(), lineMaterial({ vertexColors: true, linewidth: 3.5 * pixelRatio }));
  outline.renderOrder = 1;
  line.renderOrder = 1.5;
  for (const l of [outline, line]) {
    l.frustumCulled = false;
    const resize = l.onBeforeRender.bind(l); // keeps the line width in screen pixels
    l.onBeforeRender = (renderer, scene, camera) => {
      resize(renderer, scene, camera);
      horizon.normal.copy(camera.position).normalize(); // the Moon's centre is the origin
      horizon.constant = -0.999 / camera.position.length();
    };
  }
  const group = new THREE.Group();
  group.add(outline, line);
  group.visible = false;

  let active = false;
  let route = null; // the server's answer while it is shown
  let request = 0;
  let slopeMapLoaded = false;

  const read = ([latIn, lonIn]) => {
    const lat = parseFloat(latIn.value), lon = parseFloat(lonIn.value);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  };

  function placeMarkers() {
    for (const which of ["start", "end"]) {
      const p = read(fields[which]);
      markers[which].userData.on = !!p && ready();
      if (markers[which].userData.on) surfacePoint(p.lat, p.lon, markers[which].position);
    }
    const start = read(fields.start), end = read(fields.end);
    nextEl.textContent = start && !end ? "B, the destination" : "A, the start";
  }

  function drawRoute() {
    group.visible = active && !!route;
    if (!route) return;
    const positions = [], colours = [];
    const v = new THREE.Vector3();
    for (const p of route.path) {
      surfacePoint(p.lat, p.lon, v);
      positions.push(v.x, v.y, v.z);
      const c = colourAt(Math.min(1, p.slope_deg / route.max_slope_deg));
      colours.push(c.r, c.g, c.b);
    }
    for (const l of [outline, line]) {
      l.geometry.dispose();
      l.geometry = new LineGeometry();
      l.geometry.setPositions(positions);
      if (l === line) l.geometry.setColors(colours);
    }
  }

  const setPoint = (which, p) => {
    fields[which][0].value = p ? +p.lat.toFixed(4) : "";
    fields[which][1].value = p ? +p.lon.toFixed(4) : "";
  };

  function clearRoute() {
    request++; // an answer still on its way is dropped
    route = null;
    drawRoute();
    resultEl.replaceChildren();
    goBtn.disabled = false;
    goBtn.textContent = "Find route";
  }

  for (const input of [...fields.start, ...fields.end]) {
    input.addEventListener("input", () => { placeMarkers(); if (route) clearRoute(); });
  }

  function legend(max) {
    const bar = el("span", "ramp");
    bar.style.background = `linear-gradient(to right, ${ROUTE_COLOURS.join(", ")})`;
    return el("div", "search-legend", ["0°", bar, `${deg(max)} (rover limit)`]);
  }

  function actions() {
    const swap = el("button", "link-button", "Swap A and B");
    const clear = el("button", "link-button", "Clear route");
    swap.type = clear.type = "button";
    swap.addEventListener("click", () => {
      const a = read(fields.start), b = read(fields.end);
      setPoint("start", b);
      setPoint("end", a);
      placeMarkers();
      form.requestSubmit();
    });
    clear.addEventListener("click", () => {
      setPoint("start", null);
      setPoint("end", null);
      placeMarkers();
      clearRoute();
    });
    return el("div", "route-actions", [swap, clear]);
  }

  function render(res, margin) {
    if (!res.reachable) {
      route = null;
      drawRoute();
      const local = res.message?.match(/(\d+(?:\.\d+)?)°/)?.[1];
      const text = res.reason === "no_path"
        ? `No route within ${margin}° around the two points without slopes over ${deg(res.max_slope_deg)}.`
        : `${REASONS[res.reason] ?? "No route"}${local ? ` (local slope ${local}°)` : ""}.`;
      const tip = res.reason === "no_path"
        ? "Allow a steeper slope, or search a wider area around the points."
        : "Move that point to flatter ground, or allow a steeper slope.";
      resultEl.replaceChildren(el("h3", null, "No route"), el("p", "found", text), el("p", "note", tip), actions());
      return;
    }
    route = res;
    drawRoute();
    const detour = res.straight_distance_km > 0 ? (res.distance_km / res.straight_distance_km - 1) * 100 : 0;
    resultEl.replaceChildren(
      el("h3", null, "Route"),
      el("dl", null, [
        el("dt", null, "Distance"), el("dd", null, km(res.distance_km)),
        el("dt", null, "Straight line"), el("dd", null, `${km(res.straight_distance_km)} (${detour < 0.5 ? "no detour" : `+${Math.round(detour)} %`})`),
        el("dt", null, "Steepest slope"), el("dd", null, deg(res.max_path_slope_deg)),
        el("dt", null, "Mean slope"), el("dd", null, deg(res.mean_path_slope_deg)),
      ]),
      slopeProfile(res.path, res.max_slope_deg),
      legend(res.max_slope_deg),
      el("p", "note", `Slope map cells: ${km(res.resolution_km)} wide. Boulders and rocks smaller than that are not in it.`),
      actions(),
    );
    const mid = res.path[Math.floor(res.path.length / 2)];
    const span = Math.max(res.straight_distance_km, 30) / MOON_RADIUS_KM; // radians of Moon
    onFly(mid.lat, mid.lon, THREE.MathUtils.clamp(1 + 3 * span, 1.08, 3.2));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const start = read(fields.start), end = read(fields.end);
    if (!start || !end) return;
    const margin = Number(marginIn.value);
    const body = {
      start, end,
      max_slope_deg: Number(maxSlopeIn.value),
      advanced: { margin_deg: margin, slope_weight: Number(weightSel.value) },
    };
    const id = ++request;
    goBtn.disabled = true;
    goBtn.textContent = "Finding a route…";
    resultEl.replaceChildren(el("p", "note", slopeMapLoaded
      ? "Searching the slope map…"
      : "The first route also loads the slope map on the server (1 GB, about 10 s)…"));
    try {
      const res = await post(body);
      if (!("reachable" in res)) {
        throw new Error("this server runs an older version without routes. Restart it to load routing.py.");
      }
      slopeMapLoaded = true;
      if (id === request) render(res, margin);
    } catch (err) {
      if (id !== request) return;
      resultEl.replaceChildren(/pentes introuvable/.test(err.message)
        ? el("p", "note", ["The server has no slope map yet. The Start file makes it once ", el("code", null, "ldem_64.tif"),
          " is downloaded (its window says when), or run ", el("code", null, "python tools/make_slope_map.py"),
          ". Then find the route again."])
        : serverHelp(err, "find the route again"));
    } finally {
      if (id === request) {
        goBtn.disabled = false;
        goBtn.textContent = "Find route";
      }
    }
  });

  // A click on the Moon: the start first, then the destination (and the route is searched).
  // With one end missing (removed), the click puts it back.
  function pick(lat, lon) {
    if (!ready()) return;
    onPick(lat, lon);
    const start = read(fields.start), end = read(fields.end);
    if (!start !== !end) {
      setPoint(start ? "end" : "start", { lat, lon });
      placeMarkers();
      form.requestSubmit();
    } else {
      setPoint("start", { lat, lon });
      setPoint("end", null);
      placeMarkers();
      clearRoute();
      resultEl.replaceChildren(el("p", "note", `A: ${formatLatLon(lat, lon)}. Now click the destination.`));
    }
  }

  // A click on the A or B marker removes that point (and the route)
  function remove(which) {
    setPoint(which, null);
    placeMarkers();
    clearRoute();
    const other = which === "start" ? "end" : "start";
    const next = read(fields[other])
      ? `Click the Moon to set a new ${which === "start" ? "start" : "destination"}.`
      : "Click the Moon to set the start.";
    resultEl.replaceChildren(el("p", "note", `${which === "start" ? "A" : "B"} removed. ${next}`));
  }

  placeMarkers();
  return {
    group,
    markers: [markers.start, markers.end],
    pick,
    remove: (i) => remove(["start", "end"][i]),
    // After the relief slider moved
    place() { placeMarkers(); drawRoute(); },
    setActive(on) { active = on; group.visible = active && !!route; },
  };
}
