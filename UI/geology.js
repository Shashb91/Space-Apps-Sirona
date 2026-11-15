import * as THREE from "three";
import { fetchCsv, table, toNumber } from "./csv.js";
import { el, detailList, createListPanel, legendButton, createLegendFilter, formatLatLon } from "./panel.js";

// Made from the USGS Unified Geologic Map of the Moon by tools/geology_to_web.py
const UNITS_URL = "data/geology/units.csv";
const MAP_URL = "data/geology/units.png"; // pixel value = unit id

const GEO_OPACITY = 0.85; // how strongly unit colours cover the Moon photo
const FADED_ALPHA = 0.12; // units hidden by the legend filter or the selection

// Youngest first. Ages are the usual approximate boundaries (Wilhelms, 1987).
export const PERIODS = {
  Copernican: { label: "Copernican", age: "≈ 1.1 billion years ago to today" },
  Eratosthenian: { label: "Eratosthenian", age: "≈ 3.2 to 1.1 billion years ago" },
  "Eratosthenian-Imbrian": { label: "Eratosth.–Imbrian", age: "≈ 3.2 billion years ago" },
  Imbrian: { label: "Imbrian", age: "≈ 3.85 to 3.2 billion years ago" },
  "Imbrian-Nectarian": { label: "Imbrian–Nectarian", age: "≈ 3.85 billion years ago" },
  Nectarian: { label: "Nectarian", age: "≈ 3.92 to 3.85 billion years ago" },
  "Pre-Nectarian": { label: "Pre-Nectarian", age: "older than ≈ 3.92 billion years" },
};

export const TYPES = {
  Crater: "Crater",
  Volcanic: "Mare / volcanic",
  Basin: "Basin material",
  Plains: "Plains",
  Terra: "Highlands (terra)",
};

// The team's rating of each unit (by id) for a landing
export const TERRAIN = {
  Smooth: [6, 8, 9, 17, 22, 23, 24, 26, 32, 33, 34, 37, 43, 46],
  Medium: [3, 4, 5, 7, 10, 12, 15, 18, 19, 21, 27, 28, 29, 35, 36, 38, 42, 44, 45, 47, 48],
  Uneven: [1, 2, 11, 13, 14, 16, 20, 25, 30, 31, 39, 40, 41, 49],
};
export const terrainOf = (id) => Object.keys(TERRAIN).find((t) => TERRAIN[t].includes(id)) ?? "";
export const TERRAIN_COLOURS = { Smooth: "#3CC46E", Medium: "#F28C38", Uneven: "#E5404A" };
const TERRAIN_OPACITY = 0.7;

const periodLabel = (p) => PERIODS[p]?.label ?? p;
const typeLabel = (t) => TYPES[t] ?? t;

const COLUMNS = {
  id: ["id"],
  code: ["code", "unit"],
  name: ["name"],
  period: ["period"],
  type: ["type"],
  color: ["color", "colour"],
  areaKm2: ["area km2"],
  areaPct: ["area %"],
  polygons: ["polygons"],
  lat: ["latitude"],
  lon: ["longitude"],
  description: ["description"],
  interpretation: ["interpretation"],
};

export async function loadGeology() {
  const [rows, map] = await Promise.all([fetchCsv(UNITS_URL), loadUnitMap(MAP_URL)]);
  const units = table(rows, UNITS_URL, COLUMNS, ["id", "name"]).map((r) => {
    const lat = toNumber(r.lat);
    const lon = toNumber(r.lon);
    return {
      id: Number(r.id),
      code: r.code ?? "",
      name: r.name,
      period: r.period ?? "",
      type: r.type ?? "",
      color: /^#[0-9a-f]{6}$/i.test(r.color ?? "") ? r.color : "#C8C8C8",
      areaKm2: toNumber(r.areaKm2),
      areaPct: toNumber(r.areaPct),
      polygons: toNumber(r.polygons),
      lat,
      lon,
      hasCoords: lat !== null && lon !== null,
      description: r.description ?? "",
      interpretation: /^n\/?a$/i.test(r.interpretation ?? "") ? "" : r.interpretation ?? "",
    };
  });
  return { units, map };
}

// Reads the grey-level PNG back into one byte per pixel (the unit id).
async function loadUnitMap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const { width, height } = bitmap;
  const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const ids = new Uint8Array(width * height);
  for (let i = 0; i < ids.length; i++) ids[i] = rgba[i * 4];
  return { width, height, ids };
}

export function unitIdAt(map, lat, lon) {
  const x = Math.floor((((lon + 180) % 360) + 360) % 360 / 360 * map.width);
  const y = Math.min(map.height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * map.height)));
  return map.ids[y * map.width + x];
}

// --- Colours on the Moon -------------------------------------------------------------
// The Moon's own material gets two extra uniforms: a colour map of the units and how much
// of it to mix in (0 = layer off). Lighting still applies, so the relief stays visible.
export const geologyUniforms = {
  geoMap: { value: new THREE.DataTexture(new Uint8Array(4), 1, 1) },
  geoMix: { value: 0 },
};

// Added to the Moon's material by extendMoonMaterial in main.js
export const geologyShader = {
  uniforms: geologyUniforms,
  head: "uniform sampler2D geoMap;\nuniform float geoMix;\n",
  afterMap: /* glsl */ `
    vec4 geo = texture2D(geoMap, vMapUv);
    diffuseColor.rgb = mix(diffuseColor.rgb, geo.rgb, geoMix * geo.a);
  `,
};

export function setGeologyVisible(visible) {
  geologyUniforms.geoMix.value = visible ? GEO_OPACITY : 0;
}

// Colour texture painted from the unit-id map; shown(unit) decides which units stay opaque.
export function createGeologyTexture({ width, height, ids }, units, anisotropy) {
  const data = new Uint8Array(width * height * 4);
  const texture = new THREE.DataTexture(data, width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;

  const pixels = new Uint32Array(data.buffer);
  const palette = new Uint32Array(256); // one RGBA value per unit id (little-endian: ABGR)

  function paint(shown) {
    palette.fill(0);
    for (const u of units) {
      const n = parseInt(u.color.slice(1), 16);
      const a = Math.round(255 * (!shown || shown(u) ? 1 : FADED_ALPHA));
      palette[u.id] = ((a << 24) | ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16)) >>> 0;
    }
    // Texture row 0 is the bottom of the image (south), so rows are written upside down.
    for (let y = 0; y < height; y++) {
      const src = y * width;
      const dst = (height - 1 - y) * width;
      for (let x = 0; x < width; x++) pixels[dst + x] = palette[ids[src + x]];
    }
    texture.needsUpdate = true;
  }

  paint(null);
  return { texture, paint };
}

// --- Terrain smoothness on the Moon (the team's Smooth / Medium / Uneven rating) -------
export const terrainUniforms = {
  terrainMap: { value: new THREE.DataTexture(new Uint8Array(4), 1, 1) },
  terrainMix: { value: 0 },
};

// Added to the Moon's material by extendMoonMaterial in main.js (after geology: drawn over it)
export const terrainShader = {
  uniforms: terrainUniforms,
  head: "uniform sampler2D terrainMap;\nuniform float terrainMix;\n",
  afterMap: /* glsl */ `
    vec4 terrain = texture2D(terrainMap, vMapUv);
    diffuseColor.rgb = mix(diffuseColor.rgb, terrain.rgb, terrainMix * terrain.a);
  `,
};

export function setTerrainVisible(visible) {
  terrainUniforms.terrainMix.value = visible ? TERRAIN_OPACITY : 0;
}

// Painted once from the unit-id map, like the geology colours
export function createTerrainTexture({ width, height, ids }, anisotropy) {
  const palette = new Uint32Array(256); // one RGBA value per unit id (little-endian: ABGR); 0 = no rating
  for (const [rating, unitIds] of Object.entries(TERRAIN)) {
    const n = parseInt(TERRAIN_COLOURS[rating].slice(1), 16);
    for (const id of unitIds) palette[id] = ((255 << 24) | ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16)) >>> 0;
  }
  const data = new Uint8Array(width * height * 4);
  const pixels = new Uint32Array(data.buffer);
  for (let y = 0; y < height; y++) { // texture row 0 is the south edge
    const src = y * width, dst = (height - 1 - y) * width;
    for (let x = 0; x < width; x++) pixels[dst + x] = palette[ids[src + x]];
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

// --- Side panel ---------------------------------------------------------------------
export const swatch = (u) => {
  const s = el("span", "swatch");
  s.style.background = u.color;
  return s;
};

export function geologyTooltip(u) {
  return [swatch(u), u.name, el("span", "meta", u.code)];
}

const formatArea = (u) =>
  u.areaPct === null ? "" :
  `${u.areaPct < 0.01 ? "< 0.01" : u.areaPct.toFixed(2)} % of the Moon` +
  (u.areaKm2 ? ` (${Math.round(u.areaKm2).toLocaleString("en")} km²)` : "") +
  (u.polygons ? ` · ${u.polygons} area${u.polygons > 1 ? "s" : ""}` : "");

export function createGeologyPanel({ panelEl, units, onRowClick, onFilter }) {
  const legendEl = panelEl.querySelector(".legend");

  // Periods, each shown with the colour of its most widespread unit
  const byPeriod = new Map();
  for (const u of units) {
    const p = byPeriod.get(u.period) ?? { n: 0, main: u };
    p.n++;
    if ((u.areaPct ?? 0) > (p.main.areaPct ?? 0)) p.main = u;
    byPeriod.set(u.period, p);
  }
  for (const [period, { n, main }] of byPeriod) {
    legendEl.append(
      legendButton("period", period, `Show only ${periodLabel(period)} units`, [
        swatch(main),
        el("span", "legend-label", periodLabel(period)),
        el("span", "legend-count", String(n)),
      ])
    );
  }

  const typeCounts = new Map();
  for (const u of units) typeCounts.set(u.type, (typeCounts.get(u.type) ?? 0) + 1);
  legendEl.append(
    el("div", "shape-key", [...typeCounts].map(([type, n]) =>
      legendButton("type", type, `Show only: ${typeLabel(type)}`, [typeLabel(type), el("span", "legend-count", String(n))])
    ))
  );

  const list = createListPanel({
    listEl: panelEl.querySelector(".item-list"),
    items: units,
    onRowClick,
    renderRow: (u) => [
      swatch(u),
      el("span", "name", u.name),
      el("span", "meta", `${u.code}${u.areaPct !== null ? ` · ${u.areaPct < 0.01 ? "<0.01" : u.areaPct.toFixed(1)} %` : ""}`),
    ],
    renderDetails: (u) => [
      detailList([
        ["Code", u.code],
        ["Period", PERIODS[u.period] ? `${periodLabel(u.period)} (${PERIODS[u.period].age})` : u.period],
        ["Type", typeLabel(u.type)],
        ["Landing terrain", terrainOf(u.id)],
        ["Coverage", formatArea(u)],
        ["Largest area", u.hasCoords ? `around ${formatLatLon(u.lat, u.lon)}` : ""],
      ]),
      u.description ? el("p", null, u.description) : [],
      u.interpretation ? el("p", null, [el("b", null, "Interpretation: "), u.interpretation]) : [],
    ],
  });

  createLegendFilter({
    panelEl,
    list,
    facets: { period: (u) => u.period, type: (u) => u.type },
    searchText: (u) => `${u.code} ${u.name} ${periodLabel(u.period)} ${typeLabel(u.type)}`,
    placeholder: "Search units…",
    onChange: onFilter,
  });
  return list;
}
