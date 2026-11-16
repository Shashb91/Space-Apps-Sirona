import { DataTexture, NearestFilter, SRGBColorSpace } from "three";
import { el, formatLatLon } from "./panel.js";
import { EARTH_MIN_EL, query, serverHelp } from "./api.js";
import { PERIODS, TERRAIN, TERRAIN_COLOURS, terrainOf } from "./geology.js";

// Parametric Search mode: a lat/lon grid over the whole Moon is tested against the criteria; the
// places that pass are painted blue on the Moon. The Sun and Earth criteria are worked out by the
// team's Python server (query.py, find_locations); water, slope, altitude and geology are read
// here, on the site's own maps, at the same grid points, and combined with the server's answer.
const MAX_EVALS = 100e6;       // query.py MAX_EVALS
const MAX_AREAS = 4;           // "Any one is enough": the best areas, in 2 × 2 panels
const MOON_RADIUS_KM = 1737.4;

// "Any one is enough": the best areas' panels (textures/area_<colour>[_hover|_active].png), in
// this order, and the colour each area is painted in on the Moon (with textures/area_arrow_<colour>.png)
export const AREA_COLOURS = { red: "#D23A14", green: "#1FA14B", magenta: "#F25CEA", cyan: "#16D9CC" };
// The panels' six rows, drawn in their images (y: the middle of each row's icon, in image pixels),
// and the criteria each row answers
// (more, less: how the comparison of two panels words it, see compareRows)
const PANEL_ROWS = [
  { y: 121, types: ["illumination", "sun_elevation", "flux", "temperature", "longest_night"] }, // the Sun, and the heat it brings
  { y: 167, types: ["communication", "earth_elevation", "longest_no_link"], more: "More Earth link than", less: "Less Earth link than" },
  { y: 222, types: ["water"], more: "More water than", less: "Less water than" },
  { y: 276, types: ["slope"], more: "Steeper than", less: "Gentler than" },
  { y: 329, types: ["altitude"], more: "Higher than", less: "Lower than" },
  { y: 384, types: ["terrain", "geology"], more: "Smoother than", less: "Rougher than" },
];
const PANEL_W = 250, PANEL_H = 404, PANEL_GAP = 16; // the images' size; the gap as in style.css
const AREAS_HEAD = 34; // the "Best areas" title above them (style.css .areas-title)
const LEFT_COLUMN = 400; // the search card and its margins: the panels never reach it
// Two panels clicked: each row against the other panel's (textures/compare_<how>.png, on the right
// of the row), worded by the row's more / less, or these
const COMPARE_TEXT = { higher: "Higher than", lower: "Lower than", equal: "The same as" };
const COMPARE_HINT = "Click to compare this area with another one, and turn the Moon to it";
const SMOOTHNESS = { Smooth: 3, Medium: 2, Uneven: 1 }; // higher = smoother

// Rarely → always true: one blue, lighter and more see-through when rarer
const LOW = ["#B7D3F6", 0.3];
const HIGH = ["#1C5CAB", 0.9];
const AREA_ALPHA = 0.85; // "Any one is enough": the best areas, each in its colour (in place of the blue)

// start, op: what a new row gets. communication is yes / no (query.py: op "==", value 1 or 0).
// onMap: tested in the browser, not sent to the server. choices: pick one in a list.
const QUANTITIES = {
  illumination: { label: "Sun visible %", min: 0, max: 100, start: 50 },
  sun_elevation: { label: "Sun elevation °", min: -90, max: 90, start: 10 },
  flux: { label: "Power W/m²", min: 0, max: 1500, start: 300 },
  temperature: { label: "Temperature K", min: 0, max: 450, start: 250 }, // the server's thermal model
  // period: one duration per place over the period (query.py DURATIONS), also with "On that day".
  // Their unit is not in the label (too long for the list).
  longest_night: { label: "Longest night", unit: "days", min: 0, max: 400, start: 10, op: "<", period: true },
  earth_elevation: { label: "Earth elevation °", min: -90, max: 90, start: 10 },
  communication: { label: "Earth link", yesNo: true },
  longest_no_link: { label: "Earth link gap", unit: "days", min: 0, max: 400, start: 3, op: "<", period: true },
  water: { label: "Water ppm", min: 0, max: 1000, start: 300, onMap: true },
  slope: { label: "Slope °", min: 0, max: 60, start: 10, op: "<", onMap: true },
  altitude: { label: "Altitude m", min: -10000, max: 11000, start: 0, onMap: true },
  geology: { label: "Geology", choices: Object.fromEntries(Object.entries(PERIODS).map(([k, p]) => [k, p.label])), onMap: true },
  terrain: { label: "Terrain", choices: Object.fromEntries(Object.keys(TERRAIN).map((t) => [t, t])), onMap: true },
};
const OPS = { ">": ">", ">=": "≥", "<": "<", "<=": "≤" };
const COMPARE = { ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b, "<=": (a, b) => a <= b };

// Criteria read on the site's maps → a test of one place (lat, lon)
const MAP_TESTS = {
  slope: (c, { slopeAt }) => (lat, lon) => { const s = slopeAt(lat, lon); return s !== null && COMPARE[c.op](s, c.value); },
  water: (c, { waterPpmAt }) => (lat, lon) => { const w = waterPpmAt(lat, lon); return w != null && COMPARE[c.op](w, c.value); },
  altitude: (c, { altitudeAt }) => (lat, lon) => COMPARE[c.op](altitudeAt(lat, lon), c.value),
  geology: (c, { unitAt }) => (lat, lon) => unitAt(lat, lon)?.period === c.value,
  terrain: (c, { unitAt }) => {
    const ids = new Set(TERRAIN[c.value]);
    return (lat, lon) => ids.has(unitAt(lat, lon)?.id);
  },
};
const usesGeology = (c) => c.type === "geology" || c.type === "terrain";
class MapError extends Error {} // one of the site's maps could not be loaded
const MODE_TEXT = {
  at: "Matches on that day at 00:00 UTC",
  all: "Matches during the whole period",
  avg: "Matches on average over the period",
};

const $ = (id) => document.getElementById(id);
const num = (v) => v.toLocaleString("en-US");
const percent = (v) => (v > 0 && v < 1 ? "< 1 %" : `${Math.round(v)} %`);
const often = (v) => percent(Math.max(v, 0.5)); // a matching place: 0 means under 0.5 % of the time
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const latLon1 = (v, pos, neg) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? pos : neg}`;
const metres = (m) => `${m < 0 ? "−" : ""}${num(Math.abs(Math.round(m)))} m`;
const mean = (list) => list.reduce((sum, v) => sum + Number(v), 0) / list.length;
const EXPORT_CHUNK = 250; // spots per server request for the CSV (each answer holds every time step)
// The CSV: what the search compared for a Sun or Earth criterion, by "When" (op: the criterion's)
const STAT = {
  any: (op) => (op[0] === ">" ? "highest" : "lowest"),
  all: (op) => (op[0] === ">" ? "lowest" : "highest"),
  avg: () => "mean",
  at: () => "at the start",
};

const NO_RESULT = new DataTexture(new Uint8Array(4), 1, 1);
export const searchUniforms = {
  searchOn: { value: 0 },
  searchMap: { value: NO_RESULT },
};

// Added to the Moon's material by extendMoonMaterial in main.js. The tint follows the lit surface's
// brightness so craters stay visible under it.
export const searchShader = {
  uniforms: searchUniforms,
  head: "uniform float searchOn;\nuniform sampler2D searchMap;\n",
  afterLight: /* glsl */ `
    if (searchOn > 0.5) {
      vec4 found = texture2D(searchMap, vMapUv);
      float shade = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, found.rgb * (0.35 + 1.6 * shade), found.a);
    }
  `,
};

// values: one per grid cell, south row first, from -180° east; null = no match, else 0-100 % of the time
function makeTexture({ grid, values }, lo, hi) {
  const data = new Uint8Array(grid.n_lat * grid.n_lon * 4);
  const [a, b] = [rgb(LOW[0]), rgb(HIGH[0])];
  values.forEach((v, k) => {
    if (v === null) return;
    const t = hi > lo ? (v - lo) / (hi - lo) : 1;
    for (let c = 0; c < 3; c++) data[k * 4 + c] = Math.round(a[c] + (b[c] - a[c]) * t);
    data[k * 4 + 3] = Math.round(255 * (LOW[1] + (HIGH[1] - LOW[1]) * t));
  });
  return gridTexture(data, grid);
}

// "Any one is enough": only the best areas' places, each area in its panel's colour
function areasTexture(grid, areas) {
  const data = new Uint8Array(grid.n_lat * grid.n_lon * 4);
  areas.forEach((area, i) => {
    const colour = [...rgb(Object.values(AREA_COLOURS)[i]), Math.round(255 * AREA_ALPHA)];
    for (const k of area.cells) data.set(colour, k * 4);
  });
  return gridTexture(data, grid);
}

function gridTexture(data, grid) {
  const texture = new DataTexture(data, grid.n_lon, grid.n_lat);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = texture.minFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

// "Slope < 10°", "Earth link: possible", "Geology: Imbrian"… avg: the "On average" search
function describe(c, avg = false) {
  const q = QUANTITIES[c.type];
  if (q.yesNo && avg) return `Earth link ${OPS[c.op]} ${Math.round(c.value * 100)} % of the time`;
  if (q.yesNo) return `${q.label}: ${c.value ? "possible" : "not possible"}`;
  if (q.choices) return `${q.label}: ${q.choices[c.value]}`;
  const [, label, inLabel] = q.label.match(/^(.*?)(?: (%|°|W\/m²|ppm|m|K))?$/);
  const unit = q.unit === "days" ? (Number(c.value) === 1 ? "day" : "days") : inLabel;
  return `${label} ${OPS[c.op]} ${c.value}${unit === "°" ? "°" : unit ? ` ${unit}` : ""}${avg && !q.onMap && !q.period ? " on average" : ""}`;
}

function option(value, text, selected) {
  const o = el("option", null, text);
  o.value = value;
  o.selected = selected;
  return o;
}

// averaged(): the "On average" search is chosen; Earth link then becomes a % of the time
function criterionRow({ type, op, value }, onRemove, averaged) {
  const typeSel = el("select", null, Object.entries(QUANTITIES).map(([v, q]) => option(v, q.label, v === type)));
  const opSel = el("select", "crit-op", Object.entries(OPS).map(([v, t]) => option(v, t, v === op)));
  const valueIn = el("input");
  const linkSel = el("select", "crit-link", [option("1", "Possible", true), option("0", "Not possible")]);
  const choiceSel = el("select", "crit-choice");
  const remove = el("button", "crit-remove", "×");
  typeSel.setAttribute("aria-label", "Quantity");
  opSel.setAttribute("aria-label", "Comparison");
  valueIn.setAttribute("aria-label", "Value");
  linkSel.setAttribute("aria-label", "Earth link");
  remove.setAttribute("aria-label", "Remove this criterion");
  Object.assign(valueIn, { type: "number", step: "any", value });
  remove.type = "button";

  const row = el("div", "criterion", [typeSel, opSel, valueIn, linkSel, choiceSel, remove]);
  const linkOption = typeSel.querySelector('option[value="communication"]');
  const sync = (chosen) => {
    const q = QUANTITIES[typeSel.value];
    const share = q.yesNo && averaged(); // Earth link, on average: % of the time it is possible
    const yesNo = q.yesNo && !share;
    linkOption.textContent = averaged() ? "Earth link %" : QUANTITIES.communication.label;
    if (share && valueIn.value === "") { valueIn.value = 50; opSel.value = ">"; }
    opSel.hidden = valueIn.hidden = !!(yesNo || q.choices);
    linkSel.hidden = !yesNo;
    choiceSel.hidden = !q.choices;
    if (q.choices) {
      choiceSel.replaceChildren(...Object.entries(q.choices).map(([v, t]) => option(v, t, v === chosen)));
      choiceSel.setAttribute("aria-label", q.label);
    }
    row.classList.toggle("by-choice", !!q.choices);
    Object.assign(valueIn, { required: !valueIn.hidden, min: share ? 0 : q.min ?? "", max: share ? 100 : q.max ?? "" });
    valueIn.title = q.unit ? `In ${q.unit}` : "";
  };
  typeSel.addEventListener("change", () => {
    const q = QUANTITIES[typeSel.value];
    valueIn.value = q.start ?? "";
    opSel.value = q.op ?? ">";
    sync(null);
  });
  sync(value);

  row.type = () => typeSel.value;
  row.sync = () => sync(choiceSel.value);
  row.read = () => {
    const q = QUANTITIES[typeSel.value];
    if (q.yesNo && averaged()) return { type: typeSel.value, op: opSel.value, value: Number(valueIn.value) / 100 };
    if (q.yesNo) return { type: typeSel.value, op: "==", value: Number(linkSel.value) };
    if (q.choices) return { type: typeSel.value, op: "==", value: choiceSel.value };
    return { type: typeSel.value, op: opSel.value, value: Number(valueIn.value) };
  };
  remove.addEventListener("click", () => { row.remove(); onRemove(); });
  return row;
}

// --- Slope and geology, read on the site's maps ---------------------------------------
// The grid query.py tests (make_grid): cell centres, south row first, from -180° east
function makeGrid(step) {
  return { step_deg: step, lat0: -90 + step / 2, lon0: -180 + step / 2, n_lat: Math.round(180 / step), n_lon: Math.round(360 / step) };
}

// 1 where the map criteria hold (all of them, or any one with combine "or"), else 0
function mapMask(grid, criteria, combine, maps) {
  const tests = criteria.map((c) => MAP_TESTS[c.type](c, maps));
  const ok = new Uint8Array(grid.n_lat * grid.n_lon);
  for (let r = 0, k = 0; r < grid.n_lat; r++) {
    const lat = grid.lat0 + r * grid.step_deg;
    for (let c = 0; c < grid.n_lon; c++, k++) {
      const lon = grid.lon0 + c * grid.step_deg;
      ok[k] = combine === "or" ? tests.some((t) => t(lat, lon)) : tests.every((t) => t(lat, lon));
    }
  }
  return ok;
}

// Slope and geology don't change with time: with "and" they keep or drop each place the server
// found; with "or" a place where they hold matches all the time (100 %).
function withMap(res, ok, combine) {
  const values = res.values.map((v, k) => (combine === "or" ? (ok[k] ? 100 : v) : ok[k] ? v : null));
  return { ...res, values, n_matching: values.filter((v) => v !== null).length };
}

// Only slope and geology criteria: no server needed
function mapOnlyResult(grid, ok) {
  const values = Array.from(ok, (o) => (o ? 100 : null));
  return { mode: "map", onMapOnly: true, grid, values, n_tested: values.length, n_matching: values.filter((v) => v !== null).length };
}

// "Any one is enough": the areas, the ones meeting the most criteria first. An area is a patch of
// neighbouring places that meet the same criteria; they rank by how many they meet, then by size.
// parts: each criterion's own result, on the same grid. Each area is marked at its place farthest
// from its edge (the safest spot to land in it).
function findAreas(parts) {
  const { n_lat: rows, n_lon: cols, step_deg: step, lat0, lon0 } = parts[0].grid;
  const n = rows * cols;
  const met = new Uint32Array(n); // bit i: criterion i holds there
  parts.forEach((p, i) => { for (let k = 0; k < n; k++) if (p.values[k] !== null) met[k] |= 1 << i; });
  const around = (k, out) => { // the 8 neighbours, round the Moon east-west
    out.length = 0;
    const r = Math.floor(k / cols), c = k % cols;
    for (let rr = Math.max(0, r - 1); rr <= Math.min(rows - 1, r + 1); rr++) {
      for (let dc = -1; dc <= 1; dc++) if (rr !== r || dc) out.push(rr * cols + ((c + dc + cols) % cols));
    }
    return out;
  };
  const rad = Math.PI / 180;
  const cellKm2 = (r) => {
    const lat = lat0 + r * step;
    return MOON_RADIUS_KM ** 2 * step * rad * (Math.sin((lat + step / 2) * rad) - Math.sin((lat - step / 2) * rad));
  };
  const seen = new Uint8Array(n);
  const depth = new Int32Array(n).fill(-1);
  const near = [];
  const areas = [];
  for (let start = 0; start < n; start++) {
    if (!met[start] || seen[start]) continue;
    const mask = met[start];
    const cells = [start];
    seen[start] = 1;
    for (let i = 0; i < cells.length; i++) {
      for (const j of around(cells[i], near)) if (!seen[j] && met[j] === mask) { seen[j] = 1; cells.push(j); }
    }
    // Steps in from the edge: 0 on the edge, then inwards
    const queue = cells.filter((k) => around(k, near).some((j) => met[j] !== mask));
    for (const k of queue) depth[k] = 0;
    for (let i = 0; i < queue.length; i++) {
      for (const j of around(queue[i], near)) if (depth[j] < 0 && met[j] === mask) { depth[j] = depth[queue[i]] + 1; queue.push(j); }
    }
    let best = cells[0], km2 = 0;
    for (const k of cells) {
      km2 += cellKm2(Math.floor(k / cols));
      if (depth[k] > depth[best]) best = k;
    }
    let count = 0;
    for (let b = mask; b; b &= b - 1) count++;
    areas.push({ k: best, mask, count, km2, cells, lat: lat0 + Math.floor(best / cols) * step, lon: lon0 + (best % cols) * step });
  }
  areas.sort((a, b) => b.count - a.count || b.km2 - a.km2);
  return areas;
}

function reliefNote(res, wanted) {
  if (res.terrain) return "Relief included: hills and crater walls can hide the Sun and the Earth.";
  return wanted
    ? "Relief not included yet (the server has no relief data): a smooth Moon, so hills and crater walls hide nothing."
    : "A smooth Moon: hills and crater walls are not taken into account.";
}

// onPick(lat, lon): a spot was clicked; onOpen(lat, lon, date): "Open in Custom Point";
// onFly(lat, lon): turn the Moon to a spot; loadSlope(): loads the slope map; slopeAt(lat, lon): degrees or null;
// loadWater(): loads the water map; waterPpmAt(lat, lon): ppm, or null where it has no data;
// altitudeAt(lat, lon): metres; unitAt(lat, lon): the geologic unit there or null, once geologyReady();
// onAreas(areas): with "Any one is enough", the best areas to mark on the Moon ([{ lat, lon }]), or null
export function setupSearch({
  ready, onPick, onOpen, onFly, loadSlope, slopeAt, loadWater, waterPpmAt, altitudeAt, unitAt, geologyReady, onAreas,
}) {
  const form = $("searchForm");
  const listEl = $("criteriaList");
  const combineSel = $("searchCombine");
  const modeSel = $("searchMode");
  const dateIn = $("searchDate");
  const daysIn = $("searchDays");
  const stepIn = $("searchStep");
  const gridSel = $("searchGrid");
  const goBtn = form.querySelector(".point-go");
  const resultEl = $("searchResult");
  const areasEl = $("searchAreas");
  const gridEl = $("areasGrid");
  dateIn.value = new Date().toISOString().slice(0, 10);

  let active = false;
  let result = null; // { res, parts, titles, date, spotEl }
  let request = 0;
  let panels = []; // the best areas' panels: { area, node, nameIn, name }
  let comparing = []; // the panels being compared, in the order they were clicked (2 at most)
  let rowWords = [];   // the first two rows' more / less: what they show depends on the criteria

  // The 2 × 2 panels are as tall as Custom Point's panel on the right (the window less 16 px above
  // and below), unless the window is too narrow for that: they never reach the search card, and
  // leave the Moon (kept in the middle, see main.js) a radius of a quarter of the window's height.
  // On a phone, as wide as the screen.
  const phone = matchMedia("(max-width: 760px), (max-height: 500px)");
  const fitPanels = () => {
    const across = 2 * PANEL_W + PANEL_GAP;
    const zoom = phone.matches
      ? Math.min(1, (innerWidth - 20) / across)
      : Math.min((innerHeight - 32) / (AREAS_HEAD + 2 * PANEL_H + PANEL_GAP), (innerWidth - LEFT_COLUMN - 32) / across,
        (innerWidth / 2 - 16 - 14 - innerHeight / 4) / across);
    if (phone.matches) areasEl.style.zoom = zoom;
    // On a computer windows.js places them, at this size times the user's
    areasEl.dataset.fit = zoom;
    areasEl.dispatchEvent(new Event("fit"));
  };
  addEventListener("resize", fitPanels);
  phone.addEventListener("change", fitPanels);
  fitPanels();
  // Their hover and selected images, so they show at once
  for (const colour of Object.keys(AREA_COLOURS)) {
    for (const state of ["", "_hover", "_active"]) new Image().src = `textures/area_${colour}${state}.png`;
  }

  const show = () => { searchUniforms.searchOn.value = active && result ? 1 : 0; };

  // The date and period only matter for the Sun and Earth criteria
  const timeFields = [modeSel, dateIn].map((input) => input.closest("label"));
  const periodFields = form.querySelectorAll(".period");
  // The durations (longest night…) always look at a period, also with "On the start date"
  const usesPeriod = () => modeSel.value !== "at" || [...listEl.children].some((row) => QUANTITIES[row.type()].period);
  const syncFields = () => {
    const timed = [...listEl.children].some((row) => !QUANTITIES[row.type()].onMap);
    for (const f of timeFields) f.hidden = !timed;
    for (const f of periodFields) f.hidden = !timed || !usesPeriod();
  };
  modeSel.addEventListener("change", () => {
    for (const row of listEl.children) row.sync();
    syncFields();
  });
  listEl.addEventListener("change", syncFields);

  const rowsChanged = () => {
    const several = listEl.children.length > 1;
    for (const b of listEl.querySelectorAll(".crit-remove")) b.hidden = !several;
    combineSel.hidden = !several;
    syncFields();
  };
  const averaged = () => modeSel.value === "avg";
  const addCriterion = (c) => { listEl.append(criterionRow(c, rowsChanged, averaged)); rowsChanged(); };
  addCriterion({ type: "illumination", op: ">", value: QUANTITIES.illumination.start });
  $("addCriterion").addEventListener("click", () => {
    const used = new Set([...listEl.children].map((row) => row.type()));
    const type = Object.keys(QUANTITIES).find((t) => !used.has(t)) ?? "sun_elevation";
    addCriterion({ type, op: QUANTITIES[type].op ?? ">", value: QUANTITIES[type].start ?? "" });
  });

  // The best areas' colours on the Moon
  function areasLegend(areas) {
    const swatches = areas.map((_, i) => {
      const swatch = el("span", "swatch-found");
      swatch.style.background = Object.values(AREA_COLOURS)[i];
      return swatch;
    });
    return el("div", "search-legend", [el("span", "swatches", swatches), "The best areas"]);
  }

  function legend(res, lo, hi) {
    if (res.mode !== "any" || hi === lo) {
      return el("div", "search-legend", [el("span", "swatch-found"), MODE_TEXT[res.mode] ?? "Matches"]);
    }
    const ramp = el("span", "ramp");
    ramp.style.background = `linear-gradient(to right, ${LOW[0]}, ${HIGH[0]})`;
    return el("div", "search-legend", [often(lo), ramp, `${often(hi)} of the time`]);
  }

  // "Any one is enough": one panel per best area, 2 × 2 on the right. Each lists the six things
  // that matter for a landing (rows drawn in its image) with the criteria it meets (✓) or not (✗).
  // Clicking one turns the Moon to its area.
  // relief: the search's own (the panels' values must agree with its ✓ and ✗)
  function showAreas(areas, parts, criteria, titles, date, relief = true) {
    areasEl.hidden = !areas;
    panels = [];
    comparing = [];
    if (!areas) return gridEl.replaceChildren();
    const token = {};
    showAreas.token = token;
    panels = areas.map((a, i) => {
      const colour = Object.keys(AREA_COLOURS)[i];
      const name = `Area ${i + 1}`;
      const nameIn = el("input", "area-name");
      Object.assign(nameIn, { value: name, maxLength: 24, spellcheck: false });
      nameIn.setAttribute("aria-label", "Area name");
      const rows = PANEL_ROWS.map(({ y, types }) => {
        // The criteria this row answers: ✓ or ✗ each (the first one, and a count if there are more)
        const mine = criteria.map((c, j) => [c, j]).filter(([c]) => types.includes(c.type));
        const checks = mine.map(([, j]) => [titles[j], (a.mask >> j) & 1]);
        const failed = checks.find(([, ok]) => !ok);
        const [title, ok] = failed ?? checks[0] ?? [];
        const more = checks.length > 1 ? ` (+${checks.length - 1})` : "";
        const value = el("span", "area-value", "…");
        const row = el("li", "area-row", [
          value,
          checks.length ? el("span", `area-check ${ok ? "yes" : "no"}`, [el("span", "mark", ok ? "✓" : "✗"), `${title}${more}`]) : [],
        ]);
        if (checks.length) row.title = checks.map(([t, yes]) => `${yes ? "✓" : "✗"} ${t}`).join("\n");
        row.style.top = `${y - 12}px`;
        const compare = el("span", "area-compare");
        compare.style.top = `${y - 17}px`;
        compare.hidden = true;
        return { row, value, compare };
      });
      const node = el("div", "area-panel", [
        el("div", "area-name-box", [
          nameIn,
          el("span", "area-meta", a.count === parts.length ? "Meets all criteria" : `Meets ${a.count} of ${parts.length} criteria`),
          el("span", "area-meta", `≈ ${num(Number(a.km2.toPrecision(2)))} km²`),
          el("span", "area-meta", `${latLon1(a.lat, "N", "S")} · ${latLon1(a.lon, "E", "W")}`),
        ]),
        el("ul", "area-rows", rows.map((r) => r.row)),
        rows.map((r) => r.compare),
      ]);
      node.dataset.colour = colour;
      Object.assign(node, { tabIndex: 0, title: COMPARE_HINT });
      node.setAttribute("role", "button");
      node.setAttribute("aria-pressed", "false");
      const panel = {
        area: a, node, nameIn, name,
        values: rows.map((r) => r.value),
        compares: rows.map((r) => r.compare),
        nums: PANEL_ROWS.map(() => null), // each row's value as a number, to compare the panels
      };
      nameIn.addEventListener("input", () => { panel.name = nameIn.value.trim() || name; compareRows(); });
      nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") nameIn.blur(); });
      nameIn.addEventListener("blur", () => { nameIn.value = panel.name; });
      node.addEventListener("click", (e) => { if (e.target !== nameIn) toggleCompare(i); });
      node.addEventListener("keydown", (e) => {
        if (e.target === nameIn || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        toggleCompare(i);
      });
      return panel;
    });
    gridEl.replaceChildren(...panels.map((p) => p.node));
    // The first row shows the Sun and the temperature, or the longest night when that is a
    // criterion; its ▲▼ follow the temperature when that is the only one of its criteria. The
    // second row shows the Earth link, or its longest gap when that is a criterion.
    const types = new Set(criteria.map((c) => c.type));
    const sunBy = types.has("longest_night") ? "night"
      : types.has("temperature") && !criteria.some((c) => c.type !== "temperature" && PANEL_ROWS[0].types.includes(c.type)) ? "temperature"
        : "sun";
    const linkBy = types.has("longest_no_link") ? "gap" : "link";
    rowWords = [
      {
        sun: { more: "More Sun than", less: "Less Sun than" },
        temperature: { more: "Hotter than", less: "Colder than" },
        night: { more: "Longer night than", less: "Shorter night than" },
      }[sunBy],
      linkBy === "gap" ? { more: "Longer link gap than", less: "Shorter link gap than" } : null,
    ];
    // Over the search's period when it has one, else 30 days
    const days = usesPeriod() ? Number(daysIn.value) : 30;
    fillPanels(token, date, { sunBy, linkBy, days, relief });
  }

  // The six rows' values at each area's marked spot. The maps are read here; the Sun and the Earth
  // over the 30 days from the search date come from the Python server.
  async function fillPanels(token, date, { sunBy, linkBy, days, relief }) {
    const fresh = () => showAreas.token === token;
    // text and nums: one per row (undefined: leave that row as it is; a null number: nothing to compare)
    const set = (i, text, nums) => {
      if (!fresh()) return;
      panels[i].values.forEach((v, r) => {
        if (text[r] === undefined) return;
        v.replaceChildren(...[text[r]].flat(2));
        panels[i].nums[r] = nums[r] ?? null;
      });
    };
    const [slopeOk, waterOk] = (await Promise.allSettled([loadSlope(), loadWater()])).map((r) => r.status === "fulfilled");
    if (!fresh()) return;
    panels.forEach(({ area: { lat, lon } }, i) => {
      const slope = slopeOk ? slopeAt(lat, lon) : null;
      const water = waterOk ? waterPpmAt(lat, lon) : undefined;
      const unit = geologyReady() ? unitAt(lat, lon) : null;
      const terrain = terrainOf(unit?.id);
      const swatch = el("span", "area-swatch");
      swatch.style.background = TERRAIN_COLOURS[terrain] ?? "transparent";
      // Rounded as shown, so "the same" is what the panels say
      const ppm = water == null ? null : Math.round(water / 10) * 10;
      const deg = slope === null ? null : Number(slope.toFixed(1));
      const alt = Math.round(altitudeAt(lat, lon));
      set(i, [, ,
        water === undefined ? "Water: map not loaded" : water === null ? "Water: no data here" : `Water ≈ ${num(ppm)} ppm`,
        deg === null ? "Slope: no data" : `Slope ${deg.toFixed(1)}°`,
        `Altitude ${metres(alt)}`,
        unit ? [terrain ? [swatch, terrain] : "Not rated", ` · ${PERIODS[unit.period]?.label ?? unit.period}`] : "No geologic unit mapped",
      ], [, , ppm, deg, alt, SMOOTHNESS[terrain]]);
    });
    compareRows();
    const [y, m, d] = date.split("-");
    try {
      const res = await query({
        points: panels.map(({ area: { lat, lon } }) => ({ lat, lon })),
        date: `${d}/${m}/${y}`,
        advanced: { step_hours: 2, earth_min_el: EARTH_MIN_EL, range_days: days },
      }, relief);
      const span = `${num(Number(days.toFixed(1)))} days from ${date}`;
      res.points.forEach(({ values, durations }, i) => {
        const sun = Math.round(mean(values.illumination)), link = Math.round(100 * mean(values.communication));
        // An older server has no temperature, nor durations
        const temp = values.temperature ? Math.round(mean(values.temperature)) : null;
        const night = durations ? Number(durations.longest_night.toFixed(1)) : null;
        const gap = durations ? Number(durations.longest_no_link.toFixed(1)) : null;
        const allDark = values.illumination.every((v) => Number(v) === 0);
        const neverLinked = values.communication.every((v) => !v);
        const sunText = sunBy === "night" && night !== null
          ? allDark ? "Night all the period" : night ? `Longest night ${night.toFixed(1)} days` : "No night: Sun always up"
          : temp === null ? `Sun ${sun} % on average` : `Sun ${sun} % · ${temp} K`;
        const linkText = linkBy === "gap" && gap !== null
          ? neverLinked ? "No Earth link all the period" : gap ? `Longest link gap ${gap.toFixed(1)} days` : "Earth link all the time"
          : `Earth link ${link} % of time`;
        set(i, [sunText, linkText], [
          sunBy === "night" && night !== null ? night : sunBy === "temperature" ? temp : sun,
          linkBy === "gap" && gap !== null ? gap : link,
        ]);
        if (fresh()) {
          const when = `over the ${span}${res.terrain ? ", with relief" : ", smooth Moon"}`;
          const sunTitle = temp === null ? `How much of the Sun's disc shows, ${when}`
            : `How much of the Sun's disc shows, and the surface temperature (${(temp < 273.15 ? "−" : "") + Math.abs(Math.round(temp - 273.15))} °C, thermal model on a smooth Moon), on average ${when}`;
          panels[i].values[0].title = sunBy === "night" && night !== null
            ? `The longest stretch with no Sun at all reaching into the ${span}, counted in full (Sun ${sun} % of the time)`
            : sunTitle;
          panels[i].values[1].title = linkBy === "gap" && gap !== null
            ? `The longest stretch without Earth more than ${EARTH_MIN_EL}° up reaching into the ${span}, counted in full (link ${link} % of the time)`
            : `Earth more than ${EARTH_MIN_EL}° up, ${when}`;
        }
      });
    } catch {
      panels.forEach((_, i) => set(i, ["Sun: needs the server", "Earth link: needs the server"], []));
    }
    if (fresh()) compareRows();
  }

  // Two panels clicked: each row of one against the same row of the other, ▲ higher, ▼ lower or
  // = the same (as the panels show them, rounded). Nothing on the other panels, nor on rows either
  // of the two has no value for (no data, no server).
  function compareRows() {
    const [a, b] = comparing.length === 2 ? comparing : [];
    for (const p of panels) {
      const other = p === a ? b : p === b ? a : null;
      PANEL_ROWS.forEach((row, r) => {
        const { more, less } = rowWords[r] ?? row;
        const v = p.nums[r], w = other?.nums[r] ?? null;
        const how = v === null || w === null ? "" : v === w ? "equal" : v > w ? "higher" : "lower";
        const words = { higher: more, lower: less }[how] ?? COMPARE_TEXT[how];
        Object.assign(p.compares[r], {
          className: `area-compare ${how}`, hidden: !how,
          title: how ? `${words} ${other.name} (${other.values[r].textContent})` : "",
        });
      });
    }
  }

  // A panel was clicked: it joins the comparison and the Moon turns to it (with two already in,
  // the first one clicked leaves), or, if it was in the comparison, it leaves it
  function toggleCompare(i) {
    const panel = panels[i];
    if (!panel) return;
    const leaving = comparing.includes(panel);
    comparing = leaving ? comparing.filter((p) => p !== panel) : [...comparing, panel].slice(-2);
    for (const p of panels) {
      const on = comparing.includes(p);
      p.node.classList.toggle("selected", on);
      p.node.setAttribute("aria-pressed", String(on));
      p.node.title = on ? "Click to take this area out of the comparison" : COMPARE_HINT;
    }
    compareRows();
    if (!leaving) showArea(i);
  }

  // Turns the Moon to an area and reads it there (its panel, or its arrow on the Moon, was clicked)
  function showArea(i) {
    const panel = panels[i];
    if (!panel) return;
    onFly(panel.area.lat, panel.area.lon);
    pick(panel.area.lat, panel.area.lon);
  }

  // "Export the areas (CSV)": a small window asks how many areas, the first ones in the list
  const exportDialog = $("exportDialog");
  const exportCount = $("exportCount");
  const exportCountNote = $("exportCountNote");
  const exportChoices = $("exportChoices");
  const exportGo = $("exportGo");
  let exportJob = 0;        // a new export, or the window closed: the one running stops
  let exportNoteEl = null;  // the results' line saying what was exported

  // Every area of the result, the ones meeting the most criteria first (with "All must hold", or
  // a single criterion, every patch meets them all)
  function allAreas() {
    if (!result.allAreas) {
      const { res, criteria, areas } = result;
      const all = 2 ** criteria.length - 1;
      result.allAreas = areas ?? findAreas([res]).map((a) => ({ ...a, count: criteria.length, mask: all }));
    }
    return result.allAreas;
  }

  function checkCount() {
    const most = Number(exportCount.max), v = Number(exportCount.value);
    const ok = exportCount.value !== "" && Number.isInteger(v) && v >= 1 && v <= most;
    exportCountNote.textContent = ok ? "" : `A whole number from 1 to ${num(most)}`;
    exportGo.disabled = !ok;
    for (const b of exportChoices.children) b.setAttribute("aria-pressed", String(Number(b.dataset.value) === v));
  }

  function openExport(noteEl) {
    if (!result) return;
    exportNoteEl = noteEl;
    const areas = allAreas();
    const n = areas.length, total = result.criteria.length, shown = panels.length;
    const meetAll = areas.filter((a) => a.count === total).length;
    $("exportFound").textContent = `${num(n)} ${n === 1 ? "area" : "areas"} found` +
      (result.parts ? `, ${meetAll ? num(meetAll) : "none"} meeting all ${total} criteria.` : ".");
    // Quick choices (value → text); "All" wins when two are the same number
    const picks = new Map();
    if (shown) picks.set(shown, shown === 1 ? "The one shown" : `The ${shown} shown`);
    if (n > 10) picks.set(10, "The first 10");
    if (meetAll && meetAll < n && !picks.has(meetAll)) picks.set(meetAll, `Meeting all criteria (${num(meetAll)})`);
    picks.set(n, `All (${num(n)})`);
    exportChoices.replaceChildren(...[...picks].sort((a, b) => a[0] - b[0]).map(([value, text]) => {
      const b = el("button", "export-choice", text);
      b.type = "button";
      b.dataset.value = value;
      b.addEventListener("click", () => { exportCount.value = value; checkCount(); });
      return b;
    }));
    Object.assign(exportCount, { max: n, value: shown || Math.min(10, n), disabled: false });
    exportGo.textContent = "Export";
    checkCount();
    exportDialog.showModal();
    exportCount.select();
  }

  exportCount.addEventListener("input", checkCount);
  $("exportForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!exportGo.disabled) exportAreas(Number(exportCount.value));
  });
  const stopExport = () => { exportJob++; exportDialog.close(); };
  $("exportCancel").addEventListener("click", stopExport);
  exportDialog.addEventListener("close", () => { exportJob++; });
  // A press and a release both on the dimmed page close it
  const outsideExport = (e) => {
    if (e.target !== exportDialog) return false;
    const r = exportDialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  exportDialog.addEventListener("pointerdown", (e) => { pressedOutside = outsideExport(e); });
  exportDialog.addEventListener("click", (e) => {
    if (pressedOutside && outsideExport(e)) stopExport();
    pressedOutside = false;
  });

  // The CSV of the first `count` areas: one row per area, the ones meeting the most criteria first,
  // then the biggest. For each criterion: met or not, and its value at the area's marked spot (the
  // Sun and Earth ones from the server, over the search's period, the way the search compared them).
  async function exportAreas(count) {
    if (!result) return;
    const job = ++exportJob;
    const stopped = () => job !== exportJob || !exportDialog.open; // cancelled, or the window closed
    const { criteria, titles, settings } = result;
    const areas = allAreas().slice(0, count);
    exportGo.disabled = exportCount.disabled = true;
    $("exportCancel").focus(); // the focus stays in the window while it measures
    const timed = criteria.filter((c) => !QUANTITIES[c.type].onMap);
    const measured = new Array(areas.length).fill(null); // the server's answer for each area's spot
    let serverFailed = false;
    if (timed.length) {
      const [y, m, d] = settings.date.split("-");
      for (let i = 0; i < areas.length && !serverFailed; i += EXPORT_CHUNK) {
        exportGo.textContent = `Measuring… ${num(i)} of ${num(areas.length)}`;
        try {
          const ans = await query({
            points: areas.slice(i, i + EXPORT_CHUNK).map(({ lat, lon }) => ({ lat, lon })),
            date: `${d}/${m}/${y}`,
            advanced: { step_hours: settings.step, earth_min_el: EARTH_MIN_EL, range_days: settings.days },
          }, settings.relief);
          if (stopped()) return;
          ans.points.forEach((p, j) => { measured[i + j] = p; });
        } catch {
          if (stopped()) return;
          serverFailed = true;
        }
      }
    }
    if (stopped()) return;

    const stat = (c) => (QUANTITIES[c.type].period ? "over the period" : STAT[settings.mode](c.op));
    const valueHead = (c) => {
      const q = QUANTITIES[c.type];
      if (q.onMap) return `${q.label} (at the spot)`;
      if (q.period) return `${q.label} days (${stat(c)})`;
      if (q.yesNo) return settings.mode === "at" ? "Earth link (at the start)" : "Earth link % of the time";
      return `${q.label} (${stat(c)})`;
    };
    const valueAt = (c, a, point) => {
      if (c.type === "slope") { const v = slopeAt(a.lat, a.lon); return v === null ? "" : v.toFixed(1); }
      if (c.type === "water") { const v = waterPpmAt(a.lat, a.lon); return v == null ? "" : Math.round(v); }
      if (c.type === "altitude") return Math.round(altitudeAt(a.lat, a.lon));
      if (c.type === "geology") { const u = unitAt(a.lat, a.lon); return u ? PERIODS[u.period]?.label ?? u.period : ""; }
      if (c.type === "terrain") return terrainOf(unitAt(a.lat, a.lon)?.id) ?? "";
      if (!point) return "";
      if (QUANTITIES[c.type].period) return point.durations?.[c.type]?.toFixed(1) ?? "";
      const list = point.values[c.type]?.map(Number);
      if (!list) return "";
      if (c.type === "communication") return settings.mode === "at" ? (list[0] ? "yes" : "no") : Math.round(100 * mean(list));
      const how = stat(c);
      const v = settings.mode === "at" ? list[0]
        : how === "highest" ? Math.max(...list) : how === "lowest" ? Math.min(...list) : mean(list);
      return c.type === "flux" || c.type === "temperature" ? Math.round(v) : v.toFixed(1);
    };

    const head = ["Rank", "Name", "Criteria met", "Criteria", "Latitude (°N)", "Longitude (°E)", "Surface (km²)",
      ...criteria.flatMap((c, j) => [`${titles?.[j] ?? describe(c)}: met`, valueHead(c)])];
    const rows = areas.map((a, i) => [
      i + 1, panels[i]?.name ?? `Area ${i + 1}`, a.count, criteria.length,
      a.lat.toFixed(2), a.lon.toFixed(2), Math.round(a.km2),
      ...criteria.flatMap((c, j) => [(a.mask >> j) & 1 ? "yes" : "no", valueAt(c, a, measured[i])]),
    ]);
    const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
    const csv = [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
    const link = el("a");
    link.href = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    link.download = `areas-${settings.date}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    exportDialog.close();
    exportNoteEl.textContent = `${num(areas.length)} ${areas.length === 1 ? "area" : "areas"} exported.` +
      (serverFailed ? " The Sun and Earth values are empty: the Python server could not be reached." : "");
  }

  function render(res, parts, areas, criteria, date, reliefWanted, settings) {
    let lo = Infinity, hi = -Infinity; // (not Math.min(...values): too many arguments on fine grids)
    for (const v of res.values) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const spotEl = el("div", "spot");
    const avg = res.mode === "avg" || parts?.some((p) => p.mode === "avg");
    const titles = parts ? criteria.map((c) => describe(c, avg)) : null;
    result = res.n_matching ? { res, parts, titles, date, spotEl, criteria, areas, settings } : null;
    const shownAreas = result && areas?.length ? areas.slice(0, MAX_AREAS) : null;
    // With best areas, only they are painted (each in its colour); otherwise every match, in blue
    if (searchUniforms.searchMap.value !== NO_RESULT) searchUniforms.searchMap.value.dispose();
    searchUniforms.searchMap.value = !result ? NO_RESULT : shownAreas ? areasTexture(res.grid, shownAreas) : makeTexture(res, lo, hi);
    show();
    // Relief as in the search; with only map criteria (no server asked), with relief if it can
    showAreas(shownAreas, parts, criteria, titles, date, res.onMapOnly || !!res.terrain);
    onAreas(shownAreas);

    const exportBtn = el("button", "link-button", "Export the areas (CSV)");
    exportBtn.type = "button";
    exportBtn.title = "Save the areas found as a spreadsheet: where, how big, and each criterion's value there. You choose how many";
    exportBtn.setAttribute("aria-haspopup", "dialog");
    const exportNote = el("p", "note");
    exportBtn.addEventListener("click", () => openExport(exportNote));

    const clear = el("button", "link-button", "Clear results");
    clear.type = "button";
    clear.addEventListener("click", () => {
      result = null;
      show();
      showAreas(null);
      onAreas(null);
      resultEl.replaceChildren();
    });

    // How the best areas compare with "all the criteria"
    const several = shownAreas?.length > 1;
    const areasNote = !shownAreas ? [] : el("p", "note", (shownAreas[0].count === criteria.length
      ? `${several ? `The ${shownAreas.length} best areas are` : "The best area is"} shown on the right, and painted on the Moon in their colours: the biggest meeting the most criteria. An arrow points at the safest spot of each, the farthest from its edge.`
      : `No place meets all ${criteria.length} criteria. ${several ? `The ${shownAreas.length} areas meeting the most are` : "The area meeting the most is"} shown on the right, and painted on the Moon in their colours. An arrow points at the safest spot of each, the farthest from its edge.`) +
      (several ? " Click two panels to compare them row by row (▲ higher, ▼ lower, = the same); click one again to stop." : ""));
    resultEl.replaceChildren(
      el("h3", null, "Results"),
      el("p", "found", [el("b", null, num(res.n_matching)), ` of ${num(res.n_tested)} places match (${percent((100 * res.n_matching) / res.n_tested)})`]),
      ...(result
        ? [shownAreas ? areasLegend(shownAreas) : legend(res, lo, hi),
          el("p", "note", shownAreas ? "Click a spot on the Moon to read it." : "Shown in blue on the Moon. Click a spot to read it."),
          areasNote, spotEl, exportBtn, exportNote, clear]
        : [el("p", "note", res.onMapOnly ? "Nothing matches. Try looser criteria." : "Nothing matches. Try looser criteria, or a longer period with “At some point”.")]),
      res.onMapOnly ? [] : el("p", "note", reliefNote(res, reliefWanted)),
    );
  }

  // The whole search: { res: all criteria together, parts: each criterion alone or null, areas: the best or null }
  async function search(criteria, combine, step, onStep) {
    const timed = criteria.filter((c) => !QUANTITIES[c.type].onMap);
    const onMap = criteria.filter((c) => QUANTITIES[c.type].onMap);
    if (onMap.some((c) => c.type === "slope")) {
      await loadSlope().catch(() => { throw new MapError("the slope map (tif/slope_16.png) could not be loaded."); });
    }
    if (onMap.some((c) => c.type === "water")) {
      await loadWater().catch(() => { throw new MapError("the water map (tif/water_4k.png) could not be loaded."); });
    }
    const [y, m, d] = dateIn.value.split("-");
    const ask = (crit) => query({
      date: `${d}/${m}/${y}`,
      criteria: crit,
      combine,
      mode: modeSel.value,
      advanced: {
        grid_step_deg: step,
        range_days: Number(daysIn.value),
        step_hours: Number(stepIn.value),
        earth_min_el: EARTH_MIN_EL,
      },
    });
    const timedRes = timed.length ? await ask(timed) : null;
    const grid = timedRes?.grid ?? makeGrid(step);
    const maps = { slopeAt, waterPpmAt, altitudeAt, unitAt };
    let res = timedRes;
    if (onMap.length) {
      const ok = mapMask(grid, onMap, combine, maps);
      res = res ? withMap(res, ok, combine) : mapOnlyResult(grid, ok);
    }
    if (combine !== "or" || criteria.length < 2) return { res, parts: null, areas: null };

    // Each criterion alone, to find which ones each place meets. A Sun or Earth one needs its own
    // server answer, unless it is the only one.
    const parts = [];
    let asked = 0;
    for (const c of criteria) {
      if (QUANTITIES[c.type].onMap) parts.push(mapOnlyResult(grid, mapMask(grid, [c], "and", maps)));
      else if (timed.length === 1) parts.push(timedRes);
      else {
        onStep(`Finding the best areas: asking the server for “${describe(c, averaged())}” (${++asked} of ${timed.length})…`);
        parts.push(await ask([c]));
      }
    }
    return { res, parts, areas: findAreas(parts) };
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const criteria = [...listEl.children].map((row) => row.read());
    const timed = criteria.some((c) => !QUANTITIES[c.type].onMap);
    const step = Number(gridSel.value);
    const id = ++request;
    if (!ready()) {
      resultEl.replaceChildren(el("p", "note", "The Moon is still loading. Search again in a moment."));
      return;
    }
    if (criteria.some(usesGeology) && !geologyReady()) {
      resultEl.replaceChildren(el("p", "note", "The geology map is still loading. Search again in a moment."));
      return;
    }
    const cells = Math.round(180 / step) * Math.round(360 / step);
    const times = modeSel.value === "at" ? 1 : Math.floor((Number(daysIn.value) * 24) / Number(stepIn.value)) + 1;
    if (timed && cells * times > MAX_EVALS) {
      resultEl.replaceChildren(el("p", "note",
        `Too much to test (${num(cells)} places × ${num(times)} moments). Pick less map detail, a longer time step or a shorter period.`));
      return;
    }
    goBtn.disabled = true;
    goBtn.textContent = "Searching…";
    resultEl.replaceChildren(el("p", "note", timed
      ? `Testing ${num(cells)} places × ${num(times)} moments with relief. Fine maps can take a few minutes…`
      : `Reading the maps at ${num(cells)} places…`));
    try {
      const onStep = (text) => { if (id === request) resultEl.replaceChildren(el("p", "note", text)); };
      const { res, parts, areas } = await search(criteria, combineSel.value, step, onStep);
      // The search's own settings, for the CSV (the form can change afterwards)
      const settings = {
        date: dateIn.value, mode: modeSel.value, days: usesPeriod() ? Number(daysIn.value) : Number(stepIn.value) / 24,
        step: Number(stepIn.value), relief: res.onMapOnly || !!res.terrain,
      };
      if (id === request) render(res, parts, areas, criteria, dateIn.value, true, settings);
    } catch (err) {
      if (id === request) {
        resultEl.replaceChildren(err instanceof MapError
          ? el("p", "note", `Could not search: ${err.message}`)
          : serverHelp(err, "search again"));
      }
    } finally {
      if (id === request) {
        goBtn.disabled = false;
        goBtn.textContent = "Search";
      }
    }
  });

  function pick(lat, lon) {
    if (!ready()) return;
    onPick(lat, lon);
    if (!result) return;
    const { res, parts, titles, date, spotEl } = result;
    const { grid } = res;
    const row = Math.min(grid.n_lat - 1, Math.max(0, Math.round((lat - grid.lat0) / grid.step_deg)));
    const col = (((Math.round((lon - grid.lon0) / grid.step_deg)) % grid.n_lon) + grid.n_lon) % grid.n_lon;
    const k = row * grid.n_lon + col;
    const v = res.values[k];
    const open = el("button", "link-button", "Open in Custom Point →");
    open.type = "button";
    open.addEventListener("click", () => onOpen(lat, lon, `${date}T00:00`));
    // "Any one is enough": which of them hold here
    const each = parts?.map((p, i) => {
      const pv = p.values[k];
      const text = pv === null ? "no" : p.onMapOnly || p.mode !== "any" ? "yes" : `${often(pv)} of the time`;
      return el("li", null, [`${titles[i]}: `, el("span", pv === null ? "no" : "yes", text)]);
    });
    spotEl.replaceChildren(
      el("b", null, formatLatLon(lat, lon)),
      el("span", v === null ? "no" : "yes", v === null ? "Doesn't match" : res.mode === "any" ? `Matches ${often(v)} of the time` : "Matches"),
      each ? el("ul", "spot-each", each) : [],
      open,
    );
  }

  return {
    pick,
    showArea,
    areaName: (i) => panels[i]?.name ?? "",
    setActive(on) { active = on; show(); },
  };
}
