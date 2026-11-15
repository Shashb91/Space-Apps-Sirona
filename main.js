import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadMissions, createMissionPanel, missionTooltip, missionShape, countryStyle } from "./missions.js";
import { loadLocations, createLocationPanel, locationTooltip, typeStyle } from "./locations.js";
import {
  loadGeology, createGeologyPanel, createGeologyTexture, geologyTooltip, unitIdAt,
  geologyShader, setGeologyVisible, geologyUniforms,
  terrainShader, terrainUniforms, setTerrainVisible, createTerrainTexture, terrainOf, TERRAIN_COLOURS,
} from "./geology.js";
import { gridShader, gridUniforms, setGridVisible } from "./grid.js";
import {
  contourShader, contourUniforms, setContoursVisible, setContourRange, setContourElevation, updateContourZoom,
  CONTOUR_COLOURS,
} from "./contours.js";
import { formatElevation, el } from "./panel.js";
import { markerCanvas, ringCanvas, crosshairCanvas, letterCanvas } from "./markers.js";
import { setupRoutes } from "./routes.js";
import { createSky } from "./stars.js";
import { setupModes } from "./modes.js";
import { setupCustomPoint } from "./customPoint.js";
import { searchShader, setupSearch, AREA_COLOURS } from "./search.js";
import { slopeShader, setSlopeVisible, loadSlope, slopeAt, SLOPE_COLOURS, SLOPE_MAX } from "./slope.js";
import { createArrows } from "./arrows.js";
import { waterShader, setWaterVisible, loadWater, waterAt, waterPpmAt, WATER_COLOURS, WATER_MAX_PPM } from "./water.js";
import {
  temperatureShader, setTemperatureVisible, loadTemperature, temperatureAt, TEMPERATURE_COLOURS, TEMP_MIN, TEMP_MAX,
} from "./temperature.js";
import { categoryShader, setupCategories } from "./categories.js";
import { setupMusic } from "./music.js";
import { setupHelp } from "./help.js";
import { highResShader, planHighRes, loadHighRes, clearHighRes } from "./highres.js";

// ---------------------------------------------------------------------------
// NASA SVS CGI Moon Kit files (https://svs.gsfc.nasa.gov/4720/)
// Download them into a "tif" folder next to this file.
// ---------------------------------------------------------------------------
const COLOR_URL = "tif/lroc_color_16bit_srgb_4k.tif";
const ELEVATION_URL = "tif/ldem_16_uint.tif";

const MOON_RADIUS_KM = 1737.4;
const SEGMENTS_W = 1440;
const SEGMENTS_H = 720;
const MARKER_PX = 14;     // on-screen marker sizes, in CSS px
const RING_PX = 30;
const PROBE_PX = 32.5;
const ROUTE_MARKER_PX = 24;
// Parametric Search: the best areas' arrows (textures/area_arrow_<colour>.png, 40 × 80 px, the tip
// at x 19.5, y 71.5), shown a bit smaller than the images, so they stay sharp
const AREA_ARROW_PX = 52;                         // on screen: the arrow's height
const AREA_ARROW_TIP = [19.5 / 40, 1 - 71.5 / 80]; // the tip, on the spot (0, 0: the image's bottom left)
const AREA_ARROW_BODY = AREA_ARROW_PX * ((71.5 - 41) / 80); // px from the tip up to the arrow's middle
const HIT_RADIUS_PX = 11; // how close the mouse must be to a point to hover / pick it
const FADED_OPACITY = 0.18; // points hidden by the legend filter
const FLIGHT_MS = 1000;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const exagInput = $("exag");
const exagValue = $("exagValue");
const infoEl = $("info");
const tooltipEl = $("tooltip");

let currentExaggeration = Number(exagInput.value);

// The mode cards (top left) stop above the bottom-left panel, which grows when the Moon is clicked
const bottomPanel = $("panel");
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--panel-h", `${bottomPanel.offsetHeight}px`);
  document.documentElement.style.setProperty("--panel-w", `${bottomPanel.offsetWidth}px`); // the Help button sits right of it
}).observe(bottomPanel);

// --- Renderer, scene, camera ------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.localClippingEnabled = true; // Sirona Maps routes are cut at the horizon
document.body.appendChild(renderer.domElement);
const canvas = renderer.domElement; // its size comes from style.css (full window, or a section on phones)

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.add(createSky(renderer.getPixelRatio()));

// Units: 1 = one Moon radius
const camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.001, 100);
camera.position.set(0, 0, 3.2);
scene.add(camera);

const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(-2, 1.5, 1);
camera.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.15));

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.minDistance = 1.05;
controls.maxDistance = 10;

// --- Elevation data ---------------------------------------------------------
// ldem_16_uint.tif: 16 px per degree, values in half-metres above a sphere 10 km below 1737.4 km
const rawToKm = (raw) => raw * 0.0005 - 10;
let elev = null;

async function loadElevation(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const tiff = await GeoTIFF.fromArrayBuffer(await res.arrayBuffer());
  const image = await tiff.getImage();
  const [data] = await image.readRasters();
  return { data, width: image.getWidth(), height: image.getHeight() };
}

// --- Colour map ---------------------------------------------------------------
// 16-bit sRGB TIFF, turned into an 8-bit texture (screens show 8 bits per colour anyway).
async function loadColorTiff(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const image = await (await GeoTIFF.fromArrayBuffer(await res.arrayBuffer())).getImage();
  const pool = new GeoTIFF.Pool(); // decodes in background threads, so the page doesn't freeze
  const rgb = await image.readRasters({ interleave: true, pool });
  pool.destroy();

  const W = image.getWidth(), H = image.getHeight();
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const out = (H - 1 - y) * W * 4; // first TIFF row is the north edge = top of the texture
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3, o = out + x * 4;
      rgba[o] = ((rgb[i] + 128) / 257) | 0;
      rgba[o + 1] = ((rgb[i + 1] + 128) / 257) | 0;
      rgba[o + 2] = ((rgb[i + 2] + 128) / 257) | 0;
      rgba[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(rgba, W, H);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

export function getElevationKm(lat, lon) {
  const { data, width: W, height: H } = elev;
  const x = ((lon + 180) / 360) * W - 0.5;
  const y = Math.min(Math.max(((90 - lat) / 180) * H - 0.5, 0), H - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const xa = ((x0 % W) + W) % W, xb = (xa + 1) % W;
  const ya = y0, yb = Math.min(y0 + 1, H - 1);
  const top = data[ya * W + xa] * (1 - fx) + data[ya * W + xb] * fx;
  const bottom = data[yb * W + xa] * (1 - fx) + data[yb * W + xb] * fx;
  return rawToKm(top * (1 - fy) + bottom * fy);
}

function rowMean(row) {
  const { data, width: W } = elev;
  let sum = 0;
  for (let i = 0; i < W; i++) sum += data[row * W + i];
  return rawToKm(sum / W);
}

// The relief mesh comes in two levels of detail: the fine one, and one with 4× fewer triangles
// for when the Moon is small on screen (zoomed out, small window): the fine triangles would be
// smaller than a pixel there, costing GPU time on every frame for nothing visible.
function makeRelief(segW, segH) {
  const geometry = new THREE.SphereGeometry(1, segW, segH);
  const positions = geometry.attributes.position;
  return {
    geometry, segW, segH,
    unitDirs: Float32Array.from(positions.array), // undisplaced unit-sphere directions
    elevKm: new Float32Array(positions.count),    // elevation sampled once per vertex
  };
}
const fineRelief = makeRelief(SEGMENTS_W, SEGMENTS_H);
const coarseRelief = makeRelief(SEGMENTS_W / 2, SEGMENTS_H / 2);
const reliefs = [fineRelief, coarseRelief];
const COARSE_MAX_PX = 3; // the fine mesh takes over when a coarse square gets bigger than this on screen

function sampleVertexElevations() {
  const northPole = rowMean(0);
  const southPole = rowMean(elev.height - 1);
  for (const { geometry, segH, elevKm } of reliefs) {
    const uv = geometry.attributes.uv;
    // The data is finer than the mesh: average around each vertex so the relief stays smooth
    const d = Math.max(180 / elev.height, 45 / segH); // degrees: a quarter of a mesh square, one data pixel at least
    for (let i = 0; i < elevKm.length; i++) {
      const v = uv.getY(i);
      if (v === 1) { elevKm[i] = northPole; continue; } // all pole vertices share one value
      if (v === 0) { elevKm[i] = southPole; continue; }
      const lat = v * 180 - 90;
      const lon = uv.getX(i) * 360 - 180;
      elevKm[i] = (getElevationKm(lat - d, lon - d) + getElevationKm(lat - d, lon + d) +
        getElevationKm(lat + d, lon - d) + getElevationKm(lat + d, lon + d)) / 4;
    }
  }
}

// Push every vertex out (or in) along its radius according to its elevation.
function applyExaggeration(exaggeration) {
  const k = exaggeration / MOON_RADIUS_KM;
  for (const relief of reliefs) {
    const { geometry, unitDirs, elevKm } = relief;
    const positions = geometry.attributes.position;
    const p = positions.array;
    for (let i = 0; i < elevKm.length; i++) {
      const r = 1 + elevKm[i] * k;
      p[3 * i] = unitDirs[3 * i] * r;
      p[3 * i + 1] = unitDirs[3 * i + 1] * r;
      p[3 * i + 2] = unitDirs[3 * i + 2] * r;
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    fixSeamAndPoleNormals(relief);
    geometry.computeBoundingSphere();
  }
}

// The sphere has a duplicated column of vertices at 180° and single-triangle pole vertices:
// average / reset their normals so no lighting seam appears.
function fixSeamAndPoleNormals({ geometry, segW, segH }) {
  const n = geometry.attributes.normal;
  const rowLen = segW + 1;
  for (let iy = 0; iy <= segH; iy++) {
    const a = iy * rowLen, b = a + segW;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const len = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / len, y / len, z / len);
    n.setXYZ(b, x / len, y / len, z / len);
  }
  for (let ix = 0; ix <= segW; ix++) {
    n.setXYZ(ix, 0, 1, 0);
    n.setXYZ(segH * rowLen + ix, 0, -1, 0);
  }
  n.needsUpdate = true;
}

// Picks the mesh from how big a coarse square looks right below the camera (with a margin, so
// it doesn't flip back and forth at the limit).
function pickRelief() {
  const altitude = Math.max(camera.position.length() - 1, 1e-3);
  const pxPerRadian = canvas.height / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / altitude;
  const coarsePx = pxPerRadian * (Math.PI / coarseRelief.segH);
  const coarse = moon.geometry === coarseRelief.geometry;
  if (coarse && coarsePx > COARSE_MAX_PX * 1.1) moon.geometry = fineRelief.geometry;
  else if (!coarse && coarsePx < COARSE_MAX_PX / 1.1) moon.geometry = coarseRelief.geometry;
}

// --- Lat/lon <-> 3D (Moon-local coordinates) -----------------------------------
// Inverse of SphereGeometry's vertex formula: x = -cos(φ)sin(θ), y = cos(θ), z = sin(φ)sin(θ),
// with φ = uv.x·2π and lon = uv.x·360 − 180.
function localPointToLatLon(p) {
  const lat = THREE.MathUtils.radToDeg(Math.asin(p.y / p.length()));
  let lon = THREE.MathUtils.radToDeg(Math.atan2(p.z, -p.x)) - 180;
  lon = ((lon + 180) % 360 + 360) % 360 - 180; // wrap to [−180, 180)
  return { lat, lon };
}

function latLonToLocalDir(lat, lon) {
  const phi = THREE.MathUtils.degToRad(lon + 180);
  const theta = THREE.MathUtils.degToRad(90 - lat);
  return new THREE.Vector3(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
}

// Point on the displaced surface, so markers follow the relief slider.
function surfacePoint(lat, lon, out) {
  const r = 1 + (getElevationKm(lat, lon) * currentExaggeration) / MOON_RADIUS_KM;
  return out.copy(latLonToLocalDir(lat, lon)).multiplyScalar(r);
}

// --- Marker sprites ------------------------------------------------------------
// A Sprite is a flat image that always faces the camera. With sizeAttenuation off it keeps
// the same size on screen at any zoom; depthTest off draws it over the terrain, and
// updateOverlayVisibility() hides it when it is on the far side.
function spriteMaterial(markerCanvas) {
  const map = new THREE.CanvasTexture(markerCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.SpriteMaterial({ map, sizeAttenuation: false, depthTest: false });
}

const sprites = [];
function makeSprite(material, renderOrder, px, aspect = 1) {
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = renderOrder;
  sprite.userData.px = px;         // its height on screen
  sprite.userData.aspect = aspect; // width / height
  sizeSprite(sprite);
  sprites.push(sprite);
  return sprite;
}

function sizeSprite(sprite) {
  const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const height = (sprite.userData.px * viewHeight) / (canvas.clientHeight || window.innerHeight);
  sprite.scale.set(height * sprite.userData.aspect, height, 1);
}

const selectionRing = makeSprite(spriteMaterial(ringCanvas()), 2, RING_PX);
const probeMarker = makeSprite(spriteMaterial(crosshairCanvas()), 3, PROBE_PX);
// Custom Point mode: one crosshair per point (4 at most)
const pointMarkers = Array.from({ length: 4 }, () => makeSprite(probeMarker.material, 3, PROBE_PX));
let customPoints = [];

// --- Layers: one per tick box, each with its points on the Moon and a side panel ---
// Several can be on at once; their panels then share the right side as tabs.
function makeLayer(id, tabName) {
  const group = new THREE.Group();
  group.visible = false;
  const panelEl = $(`${id}Panel`);
  const titleEl = panelEl.querySelector(".window-title");
  return {
    group,
    items: [],
    panel: null,
    tooltip: null,
    ready: false,
    panelEl,
    titleEl,
    title: titleEl.textContent,
    tabName,
    box: document.querySelector(`input[data-layer="${id}"]`),
    countEl: document.querySelector(`[data-count="${id}"]`),
  };
}

const layers = {
  missions: makeLayer("missions", "Missions"),
  locations: makeLayer("locations", "Locations"),
  geology: makeLayer("geology", "Geology"),
};
const allLayers = Object.values(layers);

let moon = null;
let selected = null; // { layer, item }
let probe = null;    // { lat, lon } of the last terrain click

function placeOverlays() {
  for (const layer of allLayers) {
    for (const s of layer.group.children) surfacePoint(s.userData.item.lat, s.userData.item.lon, s.position);
  }
  if (selected?.item.hasCoords) surfacePoint(selected.item.lat, selected.item.lon, selectionRing.position);
  if (probe) surfacePoint(probe.lat, probe.lon, probeMarker.position);
  customPoints.forEach((p, i) => surfacePoint(p.lat, p.lon, pointMarkers[i].position));
  if (elev) arrows.placePoles(surfacePoint(90, 0, new THREE.Vector3()), surfacePoint(-90, 0, new THREE.Vector3()));
  route.place();
  for (const s of areaMarkers) if (s.userData.item) surfacePoint(s.userData.item.lat, s.userData.item.lon, s.position);
}

const tmp = new THREE.Vector3();

// On the camera's side of the sphere (horizon test): camera·p > |p|².
function facesCamera(sprite) {
  tmp.copy(sprite.position).applyMatrix4(moon.matrixWorld);
  return camera.position.dot(tmp) > tmp.lengthSq();
}

function updateOverlayVisibility(now) {
  for (const layer of allLayers) {
    if (layer.group.visible) for (const s of layer.group.children) s.visible = facesCamera(s);
  }
  selectionRing.visible =
    !!selected?.item.hasCoords && !selected.layer.noRing && selected.layer.group.visible && facesCamera(selectionRing);
  selectionRing.material.opacity = 0.7 + 0.3 * Math.sin(now / 200); // gentle pulse
  probeMarker.visible = !!probe && mode !== "custom" && mode !== "maps" && facesCamera(probeMarker);
  pointMarkers.forEach((s, i) => { s.visible = mode === "custom" && i < customPoints.length && facesCamera(s); });
  for (const s of route.markers) s.visible = mode === "maps" && s.userData.on && facesCamera(s);
  for (const s of areaMarkers) s.visible = mode === "search" && !!s.userData.item && facesCamera(s);
}

// Screen position of a marker, or null when it is hidden or outside the canvas
function screenOf(sprite) {
  if (!moon || !sprite.visible) return null;
  const rect = canvas.getBoundingClientRect();
  tmp.copy(sprite.position).applyMatrix4(moon.matrixWorld).project(camera);
  const x = rect.left + ((tmp.x + 1) / 2) * rect.width;
  const y = rect.top + ((1 - tmp.y) / 2) * rect.height;
  return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom ? null : { x, y };
}

function pointMarkerAt(x, y) {
  return pointMarkers.findIndex((s) => {
    const p = screenOf(s);
    return p && Math.hypot(p.x - x, p.y - y) < PROBE_PX / 2;
  });
}

// Sirona Maps: the A (0) or B (1) marker under the mouse, the nearest if both are, else -1
function routeMarkerAt(x, y) {
  if (mode !== "maps") return -1;
  let best = -1, bestDist = ROUTE_MARKER_PX / 2;
  route.markers.forEach((s, i) => {
    const p = screenOf(s);
    const d = p ? Math.hypot(p.x - x, p.y - y) : Infinity;
    if (d < bestDist) { best = i; bestDist = d; }
  });
  return best;
}
// Parametric Search: the arrow of a best area under the mouse (its body, above the tip on the spot),
// the nearest if several are, else -1
function areaMarkerAt(x, y) {
  if (mode !== "search") return -1;
  let best = -1, bestDist = AREA_ARROW_PX * 0.4;
  areaMarkers.forEach((s, i) => {
    const p = screenOf(s);
    const d = p ? Math.hypot(p.x - x, p.y - AREA_ARROW_BODY - y) : Infinity;
    if (d < bestDist) { best = i; bestDist = d; }
  });
  return best;
}
const areaMarkerTip = { tooltip: (i) => [el("b", null, search.areaName(i)), el("span", "meta", "click to show it")] };
const routeMarkerTip = {
  tooltip: (i) => [el("b", null, ["A, the start", "B, the destination"][i]), el("span", "meta", "click to remove")],
};

// Nearest visible point within HIT_RADIUS_PX of the mouse (cheaper than raycasting the mesh).
function spriteAt(x, y) {
  if (!moon) return null;
  const rect = canvas.getBoundingClientRect();
  let best = null, bestDist = HIT_RADIUS_PX;
  for (const layer of allLayers) {
    if (!layer.group.visible) continue;
    for (const s of layer.group.children) {
      if (!s.visible || s.userData.faded) continue;
      tmp.copy(s.position).applyMatrix4(moon.matrixWorld).project(camera);
      const sx = rect.left + ((tmp.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - tmp.y) / 2) * rect.height;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestDist) { bestDist = d; best = { layer, item: s.userData.item }; }
    }
  }
  return best;
}

// Map layers (geology) answer for any point of the Moon. A plain sphere is precise enough for hovering.
const unitSphere = new THREE.Sphere(new THREE.Vector3(), 1);
const localRay = new THREE.Ray();
const inverseMoon = new THREE.Matrix4();

function mapItemAt(x, y) {
  const mapLayers = allLayers.filter((l) => l.group.visible && l.itemAtLatLon);
  if (!moon || !mapLayers.length) return null;
  const rect = canvas.getBoundingClientRect();
  pointerNdc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  localRay.copy(raycaster.ray).applyMatrix4(inverseMoon.copy(moon.matrixWorld).invert());
  if (!localRay.intersectSphere(unitSphere, tmp)) return null;
  const { lat, lon } = localPointToLatLon(tmp);
  for (const layer of mapLayers) {
    const item = layer.itemAtLatLon(lat, lon);
    if (item) return { layer, item };
  }
  return null;
}

// --- High resolution: the lat/lon box the camera currently sees -------------------------
// Samples the four screen corners, the four edge midpoints and the centre; a sample that misses
// the sphere (zoomed out, looking past the Moon's edge) falls back to the point on its ray closest
// to the centre, which is close enough to the horizon for this.
const BBOX_NDC = [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0], [0, 0]];
const bboxPoint = new THREE.Vector3();
const bboxZero = new THREE.Vector3();
const bboxCamera = new THREE.Vector3();
const bboxCentre = new THREE.Vector3();

function visibleBBox() {
  if (!moon) return null;
  inverseMoon.copy(moon.matrixWorld).invert();
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity, lonRef = null;
  for (const [nx, ny] of BBOX_NDC) {
    pointerNdc.set(nx, ny);
    raycaster.setFromCamera(pointerNdc, camera);
    localRay.copy(raycaster.ray).applyMatrix4(inverseMoon);
    if (!localRay.intersectSphere(unitSphere, bboxPoint)) {
      localRay.closestPointToPoint(bboxZero, bboxPoint);
      if (bboxPoint.lengthSq() < 1e-8) continue;
      bboxPoint.normalize();
    }
    const { lat, lon } = localPointToLatLon(bboxPoint);
    latMin = Math.min(latMin, lat);
    latMax = Math.max(latMax, lat);
    lonRef ??= lon;
    const unwrapped = lonRef + (((lon - lonRef + 180) % 360 + 360) % 360 - 180);
    lonMin = Math.min(lonMin, unwrapped);
    lonMax = Math.max(lonMax, unwrapped);
  }
  if (!Number.isFinite(latMin)) return null;
  // A pole on screen: the view goes all the way round it
  moon.getWorldPosition(bboxCentre);
  for (const pole of [1, -1]) {
    bboxPoint.set(0, pole, 0).applyMatrix4(moon.matrixWorld);
    bboxCamera.subVectors(camera.position, bboxPoint);
    if (bboxCamera.dot(bboxPoint) - bboxCamera.dot(bboxCentre) <= 0) continue; // on the far side
    bboxPoint.project(camera);
    if (Math.abs(bboxPoint.x) > 1 || Math.abs(bboxPoint.y) > 1) continue;
    if (pole > 0) latMax = 90;
    else latMin = -90;
    lonMin = -180;
    lonMax = 180;
  }
  const padLat = Math.max(0.05, (latMax - latMin) * 0.12);
  const padLon = Math.max(0.05, (lonMax - lonMin) * 0.12);
  return {
    latMin: Math.max(-90, latMin - padLat), latMax: Math.min(90, latMax + padLat),
    lonMin: lonMin - padLon, lonMax: lonMax + padLon,
  };
}

// --- Selection and camera flight ---------------------------------------------
function setSelection(layer, item) {
  layer.panel?.select(item);
  layer.onSelect?.(item);
}

function selectItem(layer, item, { fly }) {
  if (selected && selected.layer !== layer) setSelection(selected.layer, null);
  selected = item ? { layer, item } : null;
  if (item) showPanel(layer); // before select(), so the row can scroll into view
  setSelection(layer, item);
  if (!item?.hasCoords) return;
  surfacePoint(item.lat, item.lon, selectionRing.position);
  if (fly) flyTo(item.lat, item.lon);
}

const ORIGIN = new THREE.Vector3();
const NO_TURN = new THREE.Quaternion();
let flight = null;

// zoomOut: end a bit further away than now (typed coordinates in Custom Point);
// distance: end this far from the Moon's centre (a Sirona Maps route in full view)
function flyTo(lat, lon, { zoomOut = false, distance = null } = {}) {
  // Polar sites are viewed at a slant: looking straight down at a pole makes OrbitControls spin.
  const viewLat = THREE.MathUtils.clamp(lat, -75, 75);
  const startDir = camera.position.clone().normalize();
  const endDir = latLonToLocalDir(viewLat, lon).applyQuaternion(moon.quaternion);
  const startDist = camera.position.length();
  flight = {
    startDir,
    startDist,
    endDist: distance ?? (zoomOut ? THREE.MathUtils.clamp(startDist * 1.3, 2.2, 3.5) : THREE.MathUtils.clamp(startDist, 1.6, 3.2)),
    turn: new THREE.Quaternion().setFromUnitVectors(startDir, endDir),
    startTarget: controls.target.clone(),
    t0: performance.now(),
  };
}

function updateFlight() {
  const t = Math.min((performance.now() - flight.t0) / FLIGHT_MS, 1);
  const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2; // ease in-out
  const turn = new THREE.Quaternion().slerpQuaternions(NO_TURN, flight.turn, e);
  const dist = THREE.MathUtils.lerp(flight.startDist, flight.endDist, e);
  camera.position.copy(flight.startDir).applyQuaternion(turn).multiplyScalar(dist);
  controls.target.lerpVectors(flight.startTarget, ORIGIN, e);
  if (t === 1) flight = null;
}

controls.addEventListener("start", () => { flight = null; hideTooltip(); }); // user takes over

// --- Probe (click on terrain) ------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

// Lat / lon of the relief under a screen point, or null off the Moon
function surfaceAt(x, y) {
  if (!moon) return null;
  const rect = canvas.getBoundingClientRect();
  pointerNdc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  const hit = raycaster.intersectObject(moon, false)[0];
  return hit ? localPointToLatLon(moon.worldToLocal(hit.point.clone())) : null;
}

// Crosshair on the Moon + position and elevation in the bottom-left box
function setProbe(lat, lon) {
  probe = { lat, lon };
  surfacePoint(lat, lon, probeMarker.position);
  const deg = (v, pos, neg) => `${Math.abs(v).toFixed(3)}° ${v >= 0 ? pos : neg}`;
  infoEl.innerHTML =
    `<b>Lat</b> ${deg(lat, "N", "S")} &nbsp; <b>Lon</b> ${deg(lon, "E", "W")}<br>` +
    `<b>Elevation</b> ${formatElevation(getElevationKm(lat, lon))} ` +
    `<span class="hint">(vs. 1737.4 km sphere)</span>`;
  const slope = slopeBox.checked ? slopeAt(lat, lon) : null;
  if (slope !== null) infoEl.append(el("br"), el("b", null, "Slope"), ` ${slope.toFixed(1)}° `, el("span", "hint", "(mean over ~2 km)"));
  const terrain = terrainBox.checked ? terrainOf(layers.geology.unitAt?.(lat, lon)?.id) : "";
  if (terrain) infoEl.append(el("br"), el("b", null, "Terrain"), ` ${terrain}`);
  const water = waterBox.checked ? waterAt(lat, lon) : null;
  if (water !== null) infoEl.append(el("br"), el("b", null, "Water"), ` ${water} `, el("span", "hint", "(read from the map colours)"));
  const temperature = temperatureBox.checked ? temperatureAt(lat, lon) : null;
  if (temperature !== null) infoEl.append(el("br"), el("b", null, "Temperature"), ` ${temperature} `, el("span", "hint", `(model, ${temperatureShown})`));
  for (const [name, value] of categories.readouts(lat, lon)) infoEl.append(el("br"), el("b", null, name), ` ${value} `, el("span", "hint", "(your file)"));
}

function probeAt(x, y) {
  const point = surfaceAt(x, y);
  if (!point) return;
  setProbe(point.lat, point.lon);

  for (const layer of allLayers) {
    const item = layer.group.visible ? layer.itemAtLatLon?.(probe.lat, probe.lon) : null;
    if (!item) continue;
    infoEl.append(el("br"), el("b", null, "Unit"), ` ${item.code} · ${item.name}`);
    // Only take over the selection when that layer's list is the one being looked at
    if (activePanel === layer) selectItem(layer, item, { fly: false });
  }
}

// --- Tooltip -----------------------------------------------------------------
let tooltipItem = null;

function showTooltip({ layer, item }, x, y) {
  if (item !== tooltipItem) {
    tooltipItem = item;
    tooltipEl.replaceChildren(...layer.tooltip(item));
  }
  tooltipEl.hidden = false;
  const w = tooltipEl.offsetWidth;
  tooltipEl.style.left = `${x + 16 + w > window.innerWidth ? x - 16 - w : x + 16}px`;
  tooltipEl.style.top = `${y + 14}px`;
  canvas.style.cursor = "pointer";
}

function hideTooltip() {
  tooltipItem = null;
  tooltipEl.hidden = true;
  canvas.style.cursor = "";
}

// --- Mouse -------------------------------------------------------------------
canvas.addEventListener("pointermove", (e) => {
  const end = e.buttons === 0 ? routeMarkerAt(e.clientX, e.clientY) : -1;
  const area = e.buttons === 0 ? areaMarkerAt(e.clientX, e.clientY) : -1;
  const hit = end >= 0 ? { layer: routeMarkerTip, item: end }
    : area >= 0 ? { layer: areaMarkerTip, item: area }
    : e.buttons === 0 ? spriteAt(e.clientX, e.clientY) ?? mapItemAt(e.clientX, e.clientY) : null;
  if (hit) showTooltip(hit, e.clientX, e.clientY);
  else hideTooltip();
});
canvas.addEventListener("pointerleave", hideTooltip);

// A click is a press + release without dragging, so rotating the Moon doesn't pick anything.
let downX = 0, downY = 0;
canvas.addEventListener("pointerdown", (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
canvas.addEventListener("pointerup", (e) => {
  if (e.button !== 0 || Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
  const hit = spriteAt(e.clientX, e.clientY);
  const existing = mode === "custom" ? pointMarkerAt(e.clientX, e.clientY) : -1;
  const routeEnd = routeMarkerAt(e.clientX, e.clientY);
  const area = areaMarkerAt(e.clientX, e.clientY);
  if (existing >= 0) customPoint.selectIndex(existing);
  else if (routeEnd >= 0) { route.remove(routeEnd); hideTooltip(); }
  else if (area >= 0) search.showArea(area);
  else if (mode === "custom" || mode === "search" || mode === "maps") {
    // A marker gives its own position, anywhere else the ground under the mouse
    const point = hit?.item.hasCoords ? hit.item : surfaceAt(e.clientX, e.clientY);
    if (point) ({ custom: customPoint, search, maps: route })[mode].pick(point.lat, point.lon);
  } else if (hit) selectItem(hit.layer, hit.item, { fly: false });
  else probeAt(e.clientX, e.clientY);
});

// --- Modes (buttons at the top left) ----------------------------------------------
let mode = "visualisation";
// While their panels show on the right, the Moon slides to the middle of the space between the
// search card and the panels, and the camera backs away if needed so that it fits there; both come
// back when the panels go (the distance only if the view was not zoomed since).
const SHIFT_TIME = 0.15;  // s: the slide eases with this time constant, whatever the frame rate
const MOON_EDGE = 1.02;  // the Moon's radius with the relief exaggerated (1 = the Moon's radius)
const AREAS_MARGIN = 14; // px between the Moon's edge and the cards
let areasFit = null;     // { distance, before } while backed away for the panels
let viewShift = 0;       // px the picture is moved left (camera view offset), eased towards viewShiftGoal
let viewShiftGoal = 0;
let lastShiftStep = 0;

// { shift, distance } for the Moon between the search card and the panels, or null
function areasLayout() {
  const panels = $("searchAreas");
  if (mode !== "search" || panels.hidden || getComputedStyle(panels).position !== "fixed") return null; // phone: below the Moon
  const card = $("searchForm").getBoundingClientRect();
  const left = card.width ? card.right : 0, right = panels.getBoundingClientRect().left;
  const halfH = canvas.clientHeight / 2;
  const room = Math.min((right - left) / 2 - AREAS_MARGIN, halfH - AREAS_MARGIN); // the Moon's radius on screen
  if (room < 60) return null;
  const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return {
    shift: canvas.clientWidth / 2 - (left + right) / 2,
    distance: MOON_EDGE / Math.sin(Math.atan((room / halfH) * tanHalfFov)),
  };
}
const areasFitDistance = () => areasLayout()?.distance ?? null;

// The picture moved sideways without turning the camera, so the Moon stays a round disc
function applyViewShift() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (Math.abs(viewShift) < 0.5) camera.clearViewOffset();
  else camera.setViewOffset(w, h, viewShift, 0, w, h);
}

function stepViewShift(now) {
  const dt = lastShiftStep ? Math.min(0.1, (now - lastShiftStep) / 1000) : 0.016; // the first step: one frame
  lastShiftStep = now;
  viewShift += (viewShiftGoal - viewShift) * (1 - Math.exp(-dt / SHIFT_TIME));
  if (Math.abs(viewShiftGoal - viewShift) < 0.5) viewShift = viewShiftGoal;
  applyViewShift();
  wake();
}

function zoomTo(distance) {
  const dir = camera.position.clone().normalize();
  flight = {
    startDir: dir, startDist: camera.position.length(), endDist: distance,
    turn: new THREE.Quaternion(), startTarget: controls.target.clone(), t0: performance.now(),
  };
}

function fitMoonToAreas() {
  const layout = areasLayout();
  const need = layout?.distance ?? null;
  const now = flight ? flight.endDist : camera.position.length(); // where the camera is going
  viewShiftGoal = layout?.shift ?? 0;
  if (need) {
    if (need > now + 0.005) {
      areasFit = { distance: need, before: areasFit?.before ?? now };
      zoomTo(need);
    } else if (areasFit && Math.abs(now - areasFit.distance) < 0.01) {
      // More room than before (a bigger window): come back in, but not closer than the user was
      const to = Math.max(need, areasFit.before);
      if (to < now - 0.005) {
        zoomTo(to);
        areasFit = to > areasFit.before + 0.005 ? { distance: to, before: areasFit.before } : null;
      }
    }
  } else if (areasFit) {
    if (Math.abs(now - areasFit.distance) < 0.01) zoomTo(areasFit.before);
    areasFit = null;
  }
}

// Parametric Search, "Any one is enough": the best areas, an arrow in its panel's colour pointing
// down at each (a sprite stays upright on screen, so it always points down)
const arrowLoader = new THREE.TextureLoader();
const areaMarkers = Object.keys(AREA_COLOURS).map((colour) => {
  const map = arrowLoader.load(`textures/area_arrow_${colour}.png`, () => wake());
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map, sizeAttenuation: false, depthTest: false });
  const sprite = makeSprite(material, 3, AREA_ARROW_PX, 0.5);
  sprite.center.set(...AREA_ARROW_TIP);
  return sprite;
});
const search = setupSearch({
  ready: () => !!moon,
  loadSlope: () => loadSlope(renderer.capabilities.maxTextureSize, renderer.capabilities.getMaxAnisotropy()),
  slopeAt,
  loadWater: () => loadWater(renderer.capabilities.maxTextureSize, renderer.capabilities.getMaxAnisotropy()),
  waterPpmAt,
  altitudeAt: (lat, lon) => getElevationKm(lat, lon) * 1000,
  unitAt: (lat, lon) => layers.geology.unitAt(lat, lon),
  geologyReady: () => !!layers.geology.unitAt,
  onAreas(areas) {
    areaMarkers.forEach((s, i) => {
      s.userData.item = areas?.[i] ?? null;
      if (s.userData.item) surfacePoint(s.userData.item.lat, s.userData.item.lon, s.position);
    });
    wake();
    fitMoonToAreas();
  },
  // To an area, still far enough for the whole Moon to fit between the search card and the panels
  onFly(lat, lon) {
    const fit = areasFitDistance();
    flyTo(lat, lon, fit ? { distance: Math.max(fit, THREE.MathUtils.clamp(camera.position.length(), 1.6, 3.2)) } : {});
    if (fit && areasFit) areasFit.distance = flight.endDist;
  },
  onPick: setProbe,
  onOpen(lat, lon, date) {
    modes.select("custom");
    customPoint.pick(lat, lon, { fly: true, date });
  },
});
const route = setupRoutes({
  ready: () => !!moon,
  surfacePoint,
  makeMarker: (letter) => makeSprite(spriteMaterial(letterCanvas(letter)), 3, ROUTE_MARKER_PX),
  pixelRatio: renderer.getPixelRatio(),
  onPick: setProbe,
  onFly: (lat, lon, distance) => flyTo(lat, lon, { distance }),
});
const modes = setupModes((name) => {
  mode = name;
  document.body.dataset.mode = name; // style.css hides the right panel outside Visualisation
  search.setActive(name === "search"); // search results only show in their own mode
  route.setActive(name === "maps");
  hideTooltip();
  fitMoonToAreas();
});
addEventListener("resize", fitMoonToAreas); // after search.js has resized the panels

// --- Direction arrows (Sun, Earth, poles), at Custom Point's date and time -----------------
const arrows = createArrows();
const arrowsBox = $("arrowsToggle");
const arrowsTime = $("arrowsTime");
const ARROW_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC",
});
const showArrows = () => { arrows.group.visible = arrowsBox.checked; };
arrowsBox.addEventListener("change", showArrows);
showArrows();
setupMusic();
setupHelp(() => mode);

async function setArrowsTime(value) {
  try {
    const shown = await arrows.setTime(value);
    if (shown !== null) arrowsTime.textContent = `${ARROW_TIME.format(shown)} UTC`;
  } catch {
    arrowsTime.textContent = "Sun & Earth need the server";
  }
  updateLight();
}

// --- Sunlight: the light comes from the Sun arrow's direction instead of the camera -------
const realSunBox = $("realSunToggle");
const realSunNote = $("realSunNote");

function updateLight() {
  const direction = realSunBox.checked && moon ? arrows.sunDirection() : null;
  realSunNote.textContent = realSunBox.checked && !arrows.sunDirection() ? "needs the server" : "";
  if (direction) {
    if (sun.parent !== scene) scene.add(sun); // leaves the camera
    sun.position.copy(direction).applyQuaternion(moon.quaternion).multiplyScalar(10);
  } else if (sun.parent !== camera) {
    camera.add(sun);
    sun.position.set(-2, 1.5, 1);
  }
}
realSunBox.addEventListener("change", updateLight);

// --- High resolution: the 16k map over the zoomed area (highres.js); the 4k map everywhere else
const highResBox = $("highResToggle");
const highResNote = $("highResNote");
let highResTimer = null;

async function refreshHighRes() {
  if (!highResBox.checked) return;
  const bbox = visibleBBox();
  if (!bbox) return;
  // The screen's detail straight below the camera, in pixels per degree of the Moon
  const below = camera.position.length() - 1;
  const pxPerDeg = (Math.PI / 180) * renderer.domElement.height / (2 * below * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const plan = planHighRes(bbox, pxPerDeg, renderer.capabilities.maxTextureSize);
  if (plan === "kept") return;
  if (plan === "wide") {
    highResNote.textContent = "zoom in to see it";
    wake();
    return;
  }
  // The last patch stays on while this one loads: it is placed by lat / lon, so it stays right.
  highResNote.textContent = "loading…";
  try {
    if (await loadHighRes(plan, renderer.capabilities.getMaxAnisotropy())) {
      highResNote.textContent = "";
      wake();
    }
  } catch (err) {
    console.warn(`High resolution: ${err.message}`);
    highResNote.textContent = "tiles missing: run tools/make_highres_tiles.py";
  }
}

function scheduleHighRes() {
  clearTimeout(highResTimer);
  highResTimer = setTimeout(refreshHighRes, 350);
}

highResBox.addEventListener("change", () => {
  clearTimeout(highResTimer);
  highResNote.textContent = "";
  if (highResBox.checked) refreshHighRes();
  else clearHighRes();
  wake();
});

const customPoint = setupCustomPoint({
  ready: () => !!moon,
  elevationKm: getElevationKm,
  geologyAt: (lat, lon) => layers.geology.unitAt?.(lat, lon) ?? null,
  onPick: setProbe,
  onFly: (lat, lon) => flyTo(lat, lon, { zoomOut: true }),
  onPointsChange(points) {
    customPoints = points;
    placeOverlays();
  },
  onTime: setArrowsTime,
});

// --- Right side: one panel at a time, tabs when several layers are on ---------------
let activePanel = null;

function updatePanels() {
  const open = allLayers.filter((l) => l.group.visible && l.ready);
  if (!open.includes(activePanel)) activePanel = open.at(-1) ?? null;
  for (const layer of allLayers) {
    layer.panelEl.hidden = layer !== activePanel;
    if (open.length < 2) {
      layer.titleEl.replaceChildren(layer.title);
      continue;
    }
    layer.titleEl.replaceChildren(...open.map((l) => {
      const tab = el("button", l === layer ? "tab active" : "tab", l.tabName);
      tab.type = "button";
      tab.setAttribute("aria-pressed", String(l === layer));
      tab.addEventListener("click", () => showPanel(l));
      return tab;
    }));
  }
}

function showPanel(layer) {
  if (activePanel === layer) return;
  activePanel = layer;
  updatePanels();
  hideTooltip();
}

// --- Tick boxes (independent: layers stack on the Moon) ----------------------------
function setLayerVisible(layer, visible) {
  layer.group.visible = visible;
  layer.onVisible?.(visible);
  if (visible) activePanel = layer; // the layer just ticked comes to the front
  else {
    if (selected?.layer === layer) selectItem(layer, null, { fly: false });
    hideTooltip();
  }
  updatePanels();
}

// Legend filter: points that don't match fade out and can't be hovered or picked.
function applyFilter(layer, match) {
  for (const s of layer.group.children) {
    const faded = !!match && !match(s.userData.item);
    s.userData.faded = faded;
    s.material = faded ? s.userData.materials.faded : s.userData.materials.normal;
    s.renderOrder = faded ? 0 : 1; // bright points drawn on top
  }
  if (match && selected?.layer === layer && !match(selected.item)) selectItem(layer, null, { fly: false });
  layer.onFilter?.(match);
  hideTooltip();
}

for (const layer of allLayers) {
  layer.box.addEventListener("change", () => setLayerVisible(layer, layer.box.checked));
}

// --- Relief slider -------------------------------------------------------------
let pendingExaggeration = null;

function updateGaugeFill() {
  const { min, max, value } = exagInput;
  exagInput.style.setProperty("--fill", `${((value - min) / (max - min)) * 100}%`);
}
updateGaugeFill();

exagInput.addEventListener("input", () => {
  exagValue.textContent = `${exagInput.value}×`;
  pendingExaggeration = Number(exagInput.value); // applied once per frame below
  updateGaugeFill();
});

// --- Coordinate grid tick box (bottom-left box) -------------------------------------
const gridBox = $("gridToggle");
gridUniforms.gridPx.value = renderer.getPixelRatio();
gridBox.addEventListener("change", () => setGridVisible(gridBox.checked));
setGridVisible(gridBox.checked); // the browser may restore the tick after a reload

// --- Altitude (contour lines) tick box --------------------------------------------------
const contourBox = $("contourToggle");
const contourStepEl = $("contourStep");
const contourLegend = $("contourLegend");
let shownStepM = null;
contourUniforms.contourPx.value = renderer.getPixelRatio();

function showContours() {
  setContoursVisible(contourBox.checked);
  contourLegend.hidden = !contourBox.checked;
  if (contourBox.checked) return;
  shownStepM = null;
  contourStepEl.textContent = "";
}
contourBox.addEventListener("change", showContours);
showContours();

function initContours() {
  let min = Infinity, max = -Infinity;
  for (const v of elev.data) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  setContourRange(rawToKm(min), rawToKm(max));
  setContourElevation(elev, rawToKm, renderer.capabilities.maxTextureSize, renderer.capabilities.getMaxAnisotropy());
  const km = (v) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(1)} km`;
  $("contourLow").textContent = km(rawToKm(min));
  $("contourHigh").textContent = km(rawToKm(max));
  contourLegend.querySelector(".ramp").style.background = `linear-gradient(to right, ${CONTOUR_COLOURS.join(", ")})`;
}

// --- Slope tick box (debug colour map) --------------------------------------------------
const slopeBox = $("slopeToggle");
const slopeNote = $("slopeNote");
const slopeLegend = $("slopeLegend");
$("slopeHigh").textContent = `${SLOPE_MAX}°+`;
slopeLegend.querySelector(".ramp").style.background = `linear-gradient(to right, ${SLOPE_COLOURS.join(", ")})`;

async function showSlope() {
  slopeLegend.hidden = !slopeBox.checked;
  setSlopeVisible(false);
  if (!slopeBox.checked) return;
  slopeNote.textContent = "loading…";
  try {
    await loadSlope(renderer.capabilities.maxTextureSize, renderer.capabilities.getMaxAnisotropy());
    slopeNote.textContent = "";
    setSlopeVisible(slopeBox.checked);
  } catch (err) {
    slopeNote.textContent = "file missing";
    console.error(err);
  }
}
slopeBox.addEventListener("change", showSlope);
showSlope();

// Sirona Maps has its own tick for the same slope map
const routeSlopeBox = $("routeSlope");
routeSlopeBox.addEventListener("change", () => {
  slopeBox.checked = routeSlopeBox.checked;
  slopeBox.dispatchEvent(new Event("change"));
});
slopeBox.addEventListener("change", () => { routeSlopeBox.checked = slopeBox.checked; });

// --- Terrain smoothness tick box (the team's rating of each geologic unit) --------------
const terrainBox = $("terrainToggle");
const terrainNote = $("terrainNote");
const terrainLegend = $("terrainLegend");
let terrainReady = false; // its texture is painted once the geology map has loaded
terrainLegend.replaceChildren(...Object.entries(TERRAIN_COLOURS).map(([rating, colour]) => {
  const swatch = el("span", "swatch");
  swatch.style.background = colour;
  return el("span", "terrain-key", [swatch, rating]);
}));

function showTerrain() {
  terrainLegend.hidden = !terrainBox.checked;
  terrainNote.textContent = terrainBox.checked && !terrainReady ? "loading…" : "";
  setTerrainVisible(terrainBox.checked && terrainReady);
}
terrainBox.addEventListener("change", showTerrain);

// --- Water tick box (the team's H₂O map) -----------------------------------------------
const waterBox = $("waterToggle");
const waterNote = $("waterNote");
const waterLegend = $("waterLegend");
$("waterHigh").textContent = `${WATER_MAX_PPM.toLocaleString("en-US")} ppm`;
waterLegend.querySelector(".ramp").style.background = `linear-gradient(to right, ${WATER_COLOURS.join(", ")})`;

async function showWater() {
  waterLegend.hidden = !waterBox.checked;
  setWaterVisible(false);
  if (!waterBox.checked) return;
  waterNote.textContent = "loading…";
  try {
    await loadWater(renderer.capabilities.maxTextureSize, renderer.capabilities.getMaxAnisotropy());
    waterNote.textContent = "";
    setWaterVisible(waterBox.checked);
  } catch (err) {
    waterNote.textContent = "file missing";
    console.error(err);
  }
}
waterBox.addEventListener("change", showWater);
showWater();

// --- Temperature tick box (thermal model on the team's server, at the chosen UTC time) ----
const temperatureBox = $("temperatureToggle");
const temperatureNote = $("temperatureNote");
const temperatureLegend = $("temperatureLegend");
const temperatureTime = $("temperatureTime");
let temperatureShown = "";   // the instant on the Moon, for the readout
$("temperatureLow").textContent = `${TEMP_MIN} K`;
$("temperatureHigh").textContent = `${TEMP_MAX} K`;
temperatureLegend.querySelector(".ramp").style.background = `linear-gradient(to right, ${TEMPERATURE_COLOURS.join(", ")})`;
temperatureTime.value = new Date().toISOString().slice(0, 16); // now, to the minute (UTC)
const TEMPERATURE_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC",
});

async function showTemperature() {
  temperatureLegend.hidden = !temperatureBox.checked;
  if (!temperatureBox.checked) { setTemperatureVisible(false); return; }
  if (!temperatureTime.value) return;
  temperatureNote.textContent = "computing…";
  try {
    const utc = await loadTemperature(temperatureTime.value);
    if (utc === null) return; // a newer time was asked for
    temperatureShown = `${TEMPERATURE_TIME.format(new Date(`${utc}Z`))} UTC`;
    temperatureNote.textContent = "";
    setTemperatureVisible(temperatureBox.checked);
    if (probe) setProbe(probe.lat, probe.lon);
  } catch (err) {
    temperatureNote.textContent = err instanceof TypeError ? "needs the server" : "server error";
    setTemperatureVisible(false);
    console.error(err);
  }
}
temperatureBox.addEventListener("change", showTemperature);
// The box sends "input" while the date is typed: wait for a pause before asking the server
let temperatureTimer = 0;
temperatureTime.addEventListener("input", () => {
  clearTimeout(temperatureTimer);
  temperatureTimer = setTimeout(showTemperature, 400);
});
showTemperature();

// --- Added categories: maps of your own from a PNG or TIFF file (Visualisation only) -----
const categories = setupCategories({
  maxTextureSize: renderer.capabilities.maxTextureSize,
  anisotropy: renderer.capabilities.getMaxAnisotropy(),
  onChange: () => { if (probe) setProbe(probe.lat, probe.lon); },
});

// Zooming in adds finer lines; the label next to the tick box shows the finest one
function updateContours(altitude) {
  if (!contourBox.checked || !elev) return;
  const stepM = Math.round(updateContourZoom(altitude));
  if (stepM === shownStepM) return;
  shownStepM = stepM;
  contourStepEl.textContent = `every ${stepM.toLocaleString("en-US")} m`;
}

// The Moon is only redrawn when something may have changed: the view moved, the page was used in
// the last second, or the selection ring is pulsing; otherwise 4 times a second, for data arriving
// from the server or a map finishing loading. A still Moon then leaves the GPU alone, also in
// other tabs or windows showing the site.
let awakeUntil = 0, lastDraw = -Infinity;
const wake = () => { awakeUntil = performance.now() + 1000; };
for (const type of ["pointerdown", "pointermove", "wheel", "keydown", "input", "change"]) {
  window.addEventListener(type, wake, { capture: true, passive: true });
}
const lastPosition = new THREE.Vector3(), lastQuaternion = new THREE.Quaternion();

// Follows the canvas's CSS size (window resize, phone rotation, switching to the phone layout).
let firstFit = true;
function fitToCanvas() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  wake(); // resizing clears the canvas
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  applyViewShift();
  for (const s of sprites) sizeSprite(s);
  if (firstFit) {
    // Start with the whole Moon in view, also on a narrow portrait screen
    firstFit = false;
    const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect));
    camera.position.setLength(Math.max(3.2, 1.25 / Math.sin(halfFov)));
  }
}
fitToCanvas();
new ResizeObserver(fitToCanvas).observe(canvas);

renderer.setAnimationLoop((now) => {
  if (pendingExaggeration !== null && elev) {
    applyExaggeration(pendingExaggeration);
    currentExaggeration = pendingExaggeration;
    placeOverlays();
    pendingExaggeration = null;
  }
  if (viewShift !== viewShiftGoal) stepViewShift(now);
  else lastShiftStep = 0;
  if (flight) updateFlight();
  // Rotate and zoom more gently when close to the surface
  const altitude = camera.position.length() - 1;
  controls.rotateSpeed = THREE.MathUtils.clamp(altitude, 0.05, 1);
  controls.zoomSpeed = THREE.MathUtils.clamp(altitude, 0.2, 1);
  controls.update();
  const moved = !camera.position.equals(lastPosition) || !camera.quaternion.equals(lastQuaternion);
  if (moved && moon && highResBox.checked) scheduleHighRes();
  const idle = !moved && !selectionRing.visible && now >= awakeUntil;
  if (idle && now - lastDraw < 250) return; // nothing new to draw
  lastDraw = now;
  lastPosition.copy(camera.position);
  lastQuaternion.copy(camera.quaternion);
  updateContours(camera.position.length() - 1);
  if (moon) updateOverlayVisibility(now);
  if (moon && mode === "custom") customPoint.place((i) => screenOf(pointMarkers[i]), canvas.getBoundingClientRect());
  if (moon) pickRelief();
  renderer.render(scene, camera);
});

// --- Start ------------------------------------------------------------------
// Adds GLSL snippets to three.js's standard shader: "afterMap" can change the surface colour
// (lighting still applies), "afterLight" draws on top of the lit result.
function extendMoonMaterial(material, parts) {
  material.onBeforeCompile = (shader) => {
    for (const p of parts) Object.assign(shader.uniforms, p.uniforms);
    const join = (key) => parts.map((p) => p[key] ?? "").join("\n");
    shader.fragmentShader =
      join("head") +
      shader.fragmentShader
        .replace("#include <map_fragment>", `#include <map_fragment>\n${join("afterMap")}`)
        .replace("#include <opaque_fragment>", `#include <opaque_fragment>\n${join("afterLight")}`);
  };
}

async function initMoon() {
  const [colorMap, elevation] = await Promise.all([loadColorTiff(COLOR_URL), loadElevation(ELEVATION_URL)]);
  elev = elevation;

  sampleVertexElevations();
  applyExaggeration(currentExaggeration);
  initContours();

  const material = new THREE.MeshStandardMaterial({ map: colorMap, roughness: 1, metalness: 0 });
  extendMoonMaterial(material, [geologyShader, terrainShader, slopeShader, waterShader, temperatureShader, categoryShader, contourShader, searchShader, gridShader, highResShader]);
  moon = new THREE.Mesh(fineRelief.geometry, material);
  moon.rotation.y = -Math.PI / 2; // put 0° longitude (near side centre) facing the camera
  moon.add(...allLayers.map((l) => l.group), selectionRing, probeMarker, ...pointMarkers, arrows.group, route.group, ...route.markers, ...areaMarkers);
  placeOverlays();
  updateLight();
  scene.add(moon);
  moon.updateMatrixWorld();

  statusEl.style.display = "none";
}

function addMarkers(layer, styleOf) {
  const materials = new Map(); // one normal + faded pair per colour + shape, shared by sprites
  for (const item of layer.items) {
    if (!item.hasCoords) continue;
    const { color, shape } = styleOf(item);
    const key = color + shape;
    if (!materials.has(key)) {
      const normal = spriteMaterial(markerCanvas(color, shape));
      const faded = normal.clone();
      faded.opacity = FADED_OPACITY;
      materials.set(key, { normal, faded });
    }
    const sprite = makeSprite(materials.get(key).normal, 1, MARKER_PX);
    sprite.userData.item = item;
    sprite.userData.materials = materials.get(key);
    layer.group.add(sprite);
  }
}

// A layer that fails to load shows its error in its own panel; the others still work.
async function initLayer(layer, setup) {
  try {
    await setup(layer);
    layer.countEl.textContent = layer.items.length;
  } catch (err) {
    console.error(err);
    layer.panelEl.querySelector(".item-list").textContent = err.message;
  }
  layer.ready = true;
  placeOverlays();
  setLayerVisible(layer, layer.box.checked);
}

const elevationKm = (item) => getElevationKm(item.lat, item.lon);
const rowClick = (layer) => (item) => selectItem(layer, selected?.item === item ? null : item, { fly: true });

async function setupMissions(layer) {
  layer.items = await loadMissions();
  layer.tooltip = missionTooltip;
  layer.panel = createMissionPanel({
    panelEl: layer.panelEl,
    missions: layer.items,
    elevationKm,
    onRowClick: rowClick(layer),
    onFilter: (match) => applyFilter(layer, match),
  });
  addMarkers(layer, (m) => ({ color: countryStyle(m.country).color, shape: missionShape(m) }));
}

async function setupLocations(layer) {
  layer.items = await loadLocations();
  layer.tooltip = locationTooltip;
  layer.panel = createLocationPanel({
    panelEl: layer.panelEl,
    locations: layer.items,
    missions: layers.missions.items, // for "Missions here"
    elevationKm,
    onRowClick: rowClick(layer),
    onFilter: (match) => applyFilter(layer, match),
  });
  addMarkers(layer, (l) => ({ color: typeStyle(l.type).color, shape: "square" }));
}

// The geology layer colours the Moon itself; selecting a unit highlights everywhere it occurs.
async function setupGeology(layer) {
  const { units, map } = await loadGeology();
  const overlay = createGeologyTexture(map, units, renderer.capabilities.getMaxAnisotropy());
  geologyUniforms.geoMap.value = overlay.texture;
  terrainUniforms.terrainMap.value = createTerrainTexture(map, renderer.capabilities.getMaxAnisotropy());
  terrainReady = true;
  showTerrain();
  const byId = new Map(units.map((u) => [u.id, u]));

  let filter = null, highlighted = null, queued = false;
  const repaint = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      overlay.paint(highlighted ? (u) => u === highlighted : filter);
    });
  };

  Object.assign(layer, {
    items: units,
    tooltip: geologyTooltip,
    noRing: true,
    itemAtLatLon(lat, lon) {
      const u = byId.get(unitIdAt(map, lat, lon));
      return u && (!filter || filter(u)) ? u : null;
    },
    unitAt: (lat, lon) => byId.get(unitIdAt(map, lat, lon)) ?? null, // ignores the legend filter
    onVisible: setGeologyVisible,
    onFilter(match) { filter = match; repaint(); },
    onSelect(item) { highlighted = item; repaint(); },
  });
  layer.panel = createGeologyPanel({
    panelEl: layer.panelEl,
    units,
    onRowClick: rowClick(layer),
    onFilter: (match) => applyFilter(layer, match),
  });
}

try {
  await initMoon();
  await Promise.all([
    initLayer(layers.missions, setupMissions).then(() => initLayer(layers.locations, setupLocations)),
    initLayer(layers.geology, setupGeology),
  ]);
} catch (err) {
  console.error(err);
  statusEl.textContent =
    `${err.message}\n\nPut lroc_color_16bit_srgb_4k.tif and ldem_16_uint.tif (from svs.gsfc.nasa.gov/4720)\n` +
    `in a "tif" folder next to index.html, and open the page with Live Server.`;
}
