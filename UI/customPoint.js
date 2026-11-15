import { el, detailList, formatLatLon, formatElevation } from "./panel.js";
import { PERIODS, TYPES, swatch } from "./geology.js";
import { createMonthPanel, MAX_DAYS } from "./monthPanel.js";
import { EARTH_MIN_EL, query, serverHelp } from "./api.js";

// Custom Point mode: up to 4 named points, all looked at for the same date and time.
// Each point has a floating panel on the Moon (name, elevation, geology); the selected one's
// Sun and Earth come from the team's Python server (query.py, time_series: 30 days hour by hour
// from 00:00 UTC on the chosen day, or the number of days set in the right panel's title).
const LETTERS = ["A", "B", "C", "D"];
const GAP = 16; // px between a point and its floating panel

const $ = (id) => document.getElementById(id);
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (az) => COMPASS[Math.round(az / 45) % 8];
const num = (v, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const yesNo = (ok, yes, no) => el("span", ok ? "yes" : "no", ok ? yes : no);
const tuple = (p) => `(${p.lat.toFixed(3)}, ${p.lon.toFixed(3)})`;

const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC",
});

// The date field's "2026-12-22T05:00" → milliseconds (UTC)
const timeOf = (value) => Date.parse(`${value.slice(0, 16)}:00Z`);

// Hours between two values: hour by hour up to 62 days, then coarser, so a graph has at most
// about 1,500 values (a year: every 6 hours)
const stepFor = (days) => [1, 2, 3, 4, 6, 12].find((h) => (days * 24) / h <= 1500) ?? 12;

// One point over a number of days → { values: { sun_elevation: [...], ... }, times: [ms], terrain,
// earthMinEl, durations: { longest_night, longest_no_link } in days (none from an older server), days }
async function fetchMonth(lat, lon, day, days) {
  const [y, m, d] = day.split("-");
  const res = await query({
    points: [{ lat, lon }],
    date: `${d}/${m}/${y}`,
    advanced: { step_hours: stepFor(days), earth_min_el: EARTH_MIN_EL, range_days: Math.min(days, MAX_DAYS) },
  });
  return {
    values: res.points[0].values,
    times: res.times.map((t) => Date.parse(`${t}Z`)),
    terrain: res.terrain,
    earthMinEl: EARTH_MIN_EL,
    durations: res.points[0].durations ?? null,
    days,
  };
}

// Index of the hour closest to the date field's time
function hourIndex(month, value) {
  const { times } = month;
  const i = Math.round((timeOf(value) - times[0]) / (times[1] - times[0]));
  return Math.max(0, Math.min(times.length - 1, i));
}

function groundList(p, elevationKm, unit) {
  const period = unit && PERIODS[unit.period];
  return detailList([
    ["Position", formatLatLon(p.lat, p.lon)],
    ["Elevation", formatElevation(elevationKm)],
    ["Geology", unit ? [swatch(unit), `${unit.code} · ${unit.name}`] : "No unit mapped here"],
    ["Period", unit ? (period ? `${period.label} (${period.age})` : unit.period) : ""],
    ["Terrain", unit ? TYPES[unit.type] ?? unit.type : ""],
  ]);
}

const where = (el_, az) =>
  `${num(el_, 1)}° ${el_ >= 0 ? "above" : "below"} the horizon, towards ${compass(az)} (${num(az)}°)`;

// The Sun: "Up", "Partly visible" (low, or partly behind relief or the Earth), "Hidden" (above the
// horizon but behind relief), "Down"
function sunState(elevation, visible) {
  const text = visible >= 100 ? "Up" : visible > 0 ? "Partly visible" : elevation > 0 ? "Hidden" : "Down";
  return el("span", visible > 0 ? "yes" : "no", text);
}

function skySection(name, month, i) {
  const v = Object.fromEntries(Object.entries(month.values).map(([k, a]) => [k, a[i]]));
  const link = v.communication;
  const why = v.earth_elevation <= month.earthMinEl
    ? `Earth below ${num(month.earthMinEl)}°`
    : link ? `Earth above ${num(month.earthMinEl)}°` : "Earth hidden by relief";
  return [
    el("h3", null, `Sky at ${name} · ${DATE_TIME.format(month.times[i])} UTC`),
    detailList([
      ["Sun", [sunState(v.sun_elevation, v.illumination), ` · ${where(v.sun_elevation, v.sun_azimuth)}`]],
      ["Sun disc", v.illumination > 0 || v.sun_elevation > 0 ? `${num(v.illumination)} % visible` : ""],
      ["Solar power", `${num(v.flux)} W/m² on flat ground`],
      ["Earth", where(v.earth_elevation, v.earth_azimuth)],
      ["Earth link", [yesNo(link, "Direct link possible", "No direct link"), ` (${why})`]],
      ["Earth distance", `${num(v.earth_distance_km)} km`],
    ]),
  ];
}

// ready(): false while the Moon data is still loading
// onPick(lat, lon): a point was added or selected; onFly(lat, lon): move the camera there
// onPointsChange(points): the list changed (main.js puts a crosshair on each)
// onTime(value): the date and time changed ("2026-11-14T21:00", UTC)
export function setupCustomPoint({ ready, elevationKm, geologyAt, onPick, onFly, onPointsChange, onTime }) {
  const form = $("pointForm");
  const latIn = $("pointLat");
  const lonIn = $("pointLon");
  const dateIn = $("pointDate");
  const resultEl = $("pointResult");
  let days = 30; // shown in the right panel, set in its title
  const month = createMonthPanel({ onDays: (value) => { days = value; showSky(); } });
  dateIn.value = new Date().toISOString().slice(0, 13) + ":00"; // now, to the hour (UTC)

  const floatsEl = el("div", "point-floats");
  document.body.prepend(floatsEl); // under the cards and panels
  const listEl = el("ol", "point-list");
  const noteEl = el("p", "note");
  const skyEl = el("div");

  const points = []; // { letter, name, lat, lon, node, nameIn }
  let selected = null;
  let request = 0;
  let shownSky = null; // { p, month, i } to redraw the heading after a rename
  const cache = new Map(); // one series per point, day and number of days: changing only the hour asks nothing

  const whereText = (p) => {
    const step = stepFor(days);
    return `${p.name} · ${formatLatLon(p.lat, p.lon)} · ${step === 1 ? "hour by hour" : `every ${step} hours`}`;
  };

  function renderList() {
    resultEl.replaceChildren(...(points.length ? [
      el("h3", null, [`Points (lat, lon)`, el("span", "count", ` ${points.length} / ${LETTERS.length}`)]),
      listEl, noteEl, skyEl,
    ] : []));
    listEl.replaceChildren(...points.map((p) => {
      const pickBtn = el("button", "point-pick", [el("b", null, p.name), el("span", "tuple", tuple(p))]);
      const remove = el("button", "crit-remove", "×");
      pickBtn.type = remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${p.name}`);
      pickBtn.addEventListener("click", () => select(p, { fly: true }));
      remove.addEventListener("click", () => removePoint(p));
      return el("li", p === selected ? "selected" : null, [pickBtn, remove]);
    }));
    for (const p of points) syncFloat(p);
  }

  function makeFloat(p) {
    const nameIn = el("input", "float-name");
    Object.assign(nameIn, { value: p.name, maxLength: 24, spellcheck: false });
    nameIn.setAttribute("aria-label", "Point name");
    const toggle = el("button", "float-toggle", "−");
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Hide details");
    const body = el("div", "float-body", groundList(p, elevationKm(p.lat, p.lon), geologyAt(p.lat, p.lon)));
    const node = el("div", "point-float", [el("div", "float-head", [nameIn, toggle]), body]);

    nameIn.addEventListener("input", () => rename(p, nameIn.value));
    nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") nameIn.blur(); });
    nameIn.addEventListener("blur", () => { nameIn.value = p.name; });
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      p.open = body.hidden;
      syncFloat(p);
    });
    node.addEventListener("pointerdown", (e) => { if (p !== selected && e.target !== toggle) select(p); });
    floatsEl.append(node);
    return Object.assign(p, { node, nameIn, body, toggle, open: null });
  }

  // Details show for the selected point; the others are name tags unless opened with "+"
  function syncFloat(p) {
    const open = p.open ?? p === selected;
    p.body.hidden = !open;
    p.toggle.textContent = open ? "−" : "+";
    p.toggle.setAttribute("aria-label", open ? "Hide details" : "Show details");
    p.node.classList.toggle("selected", p === selected);
  }

  function rename(p, value) {
    p.name = value.trim() || `Point ${p.letter}`;
    renderList();
    if (p !== selected) return;
    if (shownSky?.p === p) skyEl.replaceChildren(...skySection(p.name, shownSky.month, shownSky.i));
    month.setWhere(whereText(p));
  }

  async function showSky() {
    const p = selected;
    const id = ++request;
    if (!p) {
      skyEl.replaceChildren();
      month.hide();
      return;
    }
    const value = dateIn.value;
    const day = value.slice(0, 10);
    const key = `${p.lat},${p.lon},${day},${days}`;
    let data = cache.get(key), err = null;
    if (!data) {
      shownSky = null;
      skyEl.replaceChildren(el("h3", null, `Sky at ${p.name}`), el("p", "note", "Computing…"));
      month.busy();
      try {
        data = await fetchMonth(p.lat, p.lon, day, days);
        if (cache.size > 40) cache.clear();
        cache.set(key, data);
      } catch (e) {
        err = e;
      }
    }
    if (id !== request) return;
    if (data) {
      const i = hourIndex(data, value);
      shownSky = { p, month: data, i };
      skyEl.replaceChildren(...skySection(p.name, data, i));
      month.show(data, i, whereText(p));
    } else {
      skyEl.replaceChildren(el("h3", null, `Sky at ${p.name}`), serverHelp(err, "pick the point again"));
      month.hide();
    }
  }

  function select(p, { fly = false } = {}) {
    selected = p;
    noteEl.textContent = "";
    renderList();
    if (!p) return showSky();
    latIn.value = Number(p.lat.toFixed(4));
    lonIn.value = Number(p.lon.toFixed(4));
    onPick(p.lat, p.lon);
    if (fly) onFly(p.lat, p.lon);
    showSky();
  }

  function removePoint(p) {
    points.splice(points.indexOf(p), 1);
    p.node.remove();
    onPointsChange(points);
    if (p === selected) select(points.at(-1) ?? null);
    else renderList();
  }

  function pick(lat, lon, { fly = false, date = null } = {}) {
    if (!ready()) return;
    if (date && date !== dateIn.value) {
      dateIn.value = date;
      onTime(date);
      if (selected) showSky();
    }
    const letter = LETTERS.find((l) => !points.some((p) => p.letter === l));
    if (!letter) {
      noteEl.textContent = `${LETTERS.length} points max: remove one (×) to add another.`;
      return;
    }
    const p = makeFloat({ letter, name: `Point ${letter}`, lat, lon });
    points.push(p);
    onPointsChange(points);
    select(p, { fly });
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    pick(Number(latIn.value), Number(lonIn.value), { fly: true });
  });
  // One date and time for every point
  dateIn.addEventListener("change", () => {
    if (!dateIn.value) return;
    onTime(dateIn.value);
    showSky();
  });
  onTime(dateIn.value);

  return {
    pick,
    selectIndex: (i) => points[i] && select(points[i]),
    // anchorOf(i): screen position of point i, or null when it is out of sight; view: the Moon canvas's
    // rectangle (panels never spill outside it). Called every frame.
    place(anchorOf, view) {
      const cut = (v) => `${Math.max(0, Math.round(v))}px`;
      floatsEl.style.clipPath =
        `inset(${cut(view.top)} ${cut(window.innerWidth - view.right)} ${cut(window.innerHeight - view.bottom)} ${cut(view.left)})`;
      // Free space between the left card and the right panel (both float over the Moon on a computer)
      let lo = 8, hi = window.innerWidth - 8;
      const leftCard = $("layers"), rightPanel = $("monthPanel");
      if (getComputedStyle(leftCard).position === "fixed") lo = leftCard.getBoundingClientRect().right + 8;
      if (!rightPanel.hidden && getComputedStyle(rightPanel).position === "fixed") hi = rightPanel.getBoundingClientRect().left - 8;

      const sizes = points.map((p) => [p.node.offsetWidth, p.node.offsetHeight]);
      points.forEach((p, i) => {
        const a = anchorOf(i);
        p.node.style.visibility = a ? "" : "hidden";
        if (!a) return;
        const [w, h] = sizes[i];
        const fitsRight = a.x + GAP + w <= hi;
        const fitsLeft = a.x - GAP - w >= lo;
        const right = fitsRight || (!fitsLeft && hi - a.x >= a.x - lo);
        const up = a.y - GAP - h >= Math.max(view.top, 0) + 8;
        const ideal = right ? a.x + GAP : a.x - GAP - w;
        const x = Math.min(Math.max(ideal, lo), hi - w); // stays on screen
        p.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(up ? a.y - GAP - h : a.y + GAP)}px)`;
        p.node.dataset.side = x === ideal ? `${up ? "up" : "down"}-${right ? "right" : "left"}` : ""; // no tail when pushed aside
      });
    },
  };
}
