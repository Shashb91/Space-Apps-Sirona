import { el, detailList } from "./panel.js";

// Custom Point, right-hand panel: the Sun and the Earth seen from the spot over the number of
// days in its title (30 by default), from the team's Python server (query.py, time_series).
const SUN = "#C98500";
const EARTH = "#3987E5";
const MIN_PLOT_H = 72; // graphs share the panel's free height, never smaller than this
const MAX_PLOT_H = 220;
const CAPTION_H = 18;  // same as .month-chart figcaption in style.css
const FIG_GAP = 10;    // .month-chart margin-top
const LEFT = 42;
const RIGHT = 10;
const TOP = 8;
const AXIS = 20; // date labels under the last graph
const TABLE_EVERY_H = 12;

const NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const fmt = (v, max = 2) => v.toLocaleString("en-US", { maximumFractionDigits: max });
const num = (v, d = 0) => v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC",
});
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function svg(tag, attrs, parent) {
  const node = document.createElementNS(NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  parent?.append(node);
  return node;
}

// At most 4 round ticks covering [lo, hi]; angles step by 15/30/45/90° when the range is wide.
function niceTicks(lo, hi, degrees = false) {
  if (hi - lo < 1e-9) hi = lo + 1;
  const span = hi - lo;
  const mag = 10 ** Math.floor(Math.log10(span / 4));
  const steps = degrees && span >= 40 ? [15, 30, 45, 90, 180] : [1, 2, 2.5, 5, 10, 20].map((m) => m * mag);
  for (const step of steps) {
    if (step < span / 4) continue;
    const a = Math.floor(lo / step + 1e-9);
    const b = Math.ceil(hi / step - 1e-9);
    if (b - a <= 3) return Array.from({ length: b - a + 1 }, (_, k) => Number(((a + k) * step).toFixed(10)));
  }
}

const range = (values, ...extra) => [Math.min(...values, ...extra), Math.max(...values, ...extra)];

// s: the point's values (query.py names), one per hour; d: the whole month from customPoint.js
const CHARTS = [
  {
    key: "sun_elevation", title: "Sun elevation", colour: SUN, degrees: true,
    domain: (s) => range(s.sun_elevation, 0),
    refs: () => [{ v: 0, label: "horizon" }],
    tick: (v) => `${fmt(v)}°`,
    value: (v) => `${num(v, 1)}°`,
    state: (s, i) => {
      const seen = s.illumination[i];
      return [seen >= 100 ? "up" : seen > 0 ? "partly visible" : s.sun_elevation[i] > 0 ? "hidden" : "down"];
    },
  },
  {
    key: "flux", title: "Solar power", colour: SUN, area: true,
    domain: (s) => [0, Math.max(...s.flux)],
    refs: () => [],
    tick: (v) => fmt(v),
    value: (v) => `${num(v)} W/m²`,
  },
  {
    key: "earth_elevation", title: "Earth elevation", colour: EARTH, degrees: true,
    domain: (s, d) => range(s.earth_elevation, 0, d.earthMinEl),
    refs: (d) => [{ v: 0 }, { v: d.earthMinEl, label: "link limit", dashed: true }],
    tick: (v) => `${fmt(v)}°`,
    value: (v) => `${num(v, 1)}°`,
    state: (s, i) => (s.communication[i] ? ["link", "yes"] : ["no link", "no"]),
  },
  {
    key: "earth_distance_km", title: "Earth distance", colour: EARTH,
    domain: (s) => range(s.earth_distance_km),
    refs: () => [],
    tick: (v) => `${fmt(v / 1000)}K`,
    value: (v) => `${num(v)} km`,
  },
];

const share = (flags) => (100 * flags.filter(Boolean).length) / flags.length;
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

// Hours of the longest stretch with the Sun fully hidden; open = it runs into the edge of the period.
function longestNight(visible, step) {
  let best = 0, open = false, start = -1;
  for (let i = 0; i <= visible.length; i++) {
    const dark = i < visible.length && visible[i] === 0;
    if (dark && start < 0) start = i;
    if (!dark && start >= 0) {
      const hours = (i - start) * step;
      if (hours > best) { best = hours; open = start === 0 || i === visible.length; }
      start = -1;
    }
  }
  return { hours: best, open };
}

// The server's durations (days): the longest night and Earth link gap reaching into the period,
// counted in full, also the part outside it. An older server has none: the night is then
// measured here, inside the period only.
function durationText(days, allOff, none, whole, period) {
  return allOff ? whole : days ? `${num(days, 1)} days${days > period ? " (counted in full, beyond the period)" : ""}` : none;
}

function summary(data, step) {
  const s = data.values;
  const d = data.durations;
  const period = ((data.times.length - 1) * step) / 24;
  const night = longestNight(s.illumination, step);
  const allDark = s.illumination.every((v) => v === 0);
  return detailList([
    ["Sunlight", `${num(share(s.illumination.map((v) => v > 0)))} % of the time`],
    ["Longest night", d
      ? durationText(d.longest_night, allDark, "None, the Sun never fully sets", "All the period", period)
      : night.hours ? `${night.open ? "at least " : ""}${num(night.hours / 24, 1)} days` : "None, the Sun never fully sets"],
    ["Earth link", `${num(share(s.communication))} % of the time (Earth above ${num(data.earthMinEl)}°)`],
    ...(d ? [["Longest without link", durationText(d.longest_no_link, !s.communication.some(Boolean), "None, Earth always in view", "All the period", period)]] : []),
    ["Solar power", `${num(mean(s.flux))} W/m² on average`],
    ["Highest Sun", `${num(Math.max(...s.sun_elevation), 1)}°`],
    ["Relief", data.terrain
      ? "Included: hills and crater walls can hide the Sun and the Earth"
      : "Not included yet: a smooth Moon, so hills and crater walls hide nothing"],
  ]);
}

function table(data, step) {
  const s = data.values;
  const every = Math.max(1, Math.round(TABLE_EVERY_H / step));
  const head = el("tr", null, ["Date (UTC)", "Sun", "Power W/m²", "Earth", "Earth km"].map((t) => el("th", null, t)));
  const rows = [];
  for (let i = 0; i < data.times.length; i += every) {
    rows.push(el("tr", null, [
      DATE_TIME.format(data.times[i]),
      `${num(s.sun_elevation[i], 1)}°`,
      num(s.flux[i]),
      `${num(s.earth_elevation[i], 1)}°`,
      num(s.earth_distance_km[i]),
    ].map((t) => el("td", null, t))));
  }
  return el("table", null, [el("thead", null, head), el("tbody", null, rows)]);
}

export const MAX_DAYS = 366; // query.py MAX_SERIES_DAYS

// onDays(days): the number of days in the title was changed (1 to MAX_DAYS)
export function createMonthPanel({ onDays } = {}) {
  const panel = $("monthPanel");
  const titleEl = $("monthTitleText");
  const daysIn = $("monthDays");
  let days = Number(daysIn.value);
  daysIn.addEventListener("change", () => {
    const value = Math.round(Number(daysIn.value));
    if (!(value >= 1 && value <= MAX_DAYS)) { daysIn.value = days; return; }
    daysIn.value = days = value;
    onDays?.(days);
  });
  daysIn.addEventListener("keydown", (e) => { if (e.key === "Enter") daysIn.blur(); });
  const whereEl = $("monthWhere");
  const timeEl = $("monthTime");
  const nightKey = $("monthNightKey");
  const chartsEl = $("monthCharts");
  const summaryEl = $("monthSummary");
  const tableEl = $("monthTable");

  let data = null;
  let chosen = 0;   // the hour picked in the date field
  let step = 1;     // hours between two values
  let index = null; // hovered hour, null = the chosen one
  let drawn = [];   // per graph: { cross, dot, y, valueEl, stateEl, chart }
  let width = 0;
  let height = 0;
  let x = () => 0;

  const n = () => data.times.length;
  const timeAt = (i) => data.times[i];

  function draw() {
    width = chartsEl.clientWidth;
    height = chartsEl.clientHeight;
    const k = CHARTS.length;
    const fit = Math.floor((height - k * (FIG_GAP + CAPTION_H + TOP) - (k - 1) * 4 - AXIS) / k);
    const plotH = Math.min(MAX_PLOT_H, Math.max(MIN_PLOT_H, fit));
    if (!data || !width) return;
    const series = data.values;
    const last = n() - 1;
    const plotW = width - LEFT - RIGHT;
    x = (i) => LEFT + (i / last) * plotW;

    const nights = [];
    for (let i = 0, start = -1; i <= n(); i++) {
      const dark = i < n() && series.illumination[i] === 0;
      if (dark && start < 0) start = i;
      if (!dark && start >= 0) { nights.push([Math.max(0, start - 0.5), Math.min(last, i - 0.5)]); start = -1; }
    }
    nightKey.hidden = nights.length === 0;
    // Vertical lines (and dates under the last graph): every day, week… so there are at most 8
    const span = (last * step) / 24;
    const every = [1, 2, 7, 14, 28, 56, 91].find((g) => span / g <= 8) ?? 182;
    const marks = [];
    for (let d = every; (d * 24) / step <= last; d += every) marks.push((d * 24) / step);

    drawn = CHARTS.map((chart, c) => {
      const isLast = c === CHARTS.length - 1;
      const values = series[chart.key];
      const ticks = niceTicks(...chart.domain(series, data), chart.degrees);
      const lo = ticks[0], hi = ticks.at(-1);
      const y = (v) => TOP + ((hi - v) / (hi - lo)) * plotH;
      const bottom = TOP + plotH;

      const root = svg("svg", { width, height: bottom + (isLast ? AXIS : 4), "aria-hidden": "true" });
      for (const [a, b] of nights) svg("rect", { class: "night", x: x(a), y: TOP, width: x(b) - x(a), height: plotH }, root);
      for (const i of marks) svg("line", { class: "grid", x1: x(i), x2: x(i), y1: TOP, y2: bottom }, root);
      for (const t of ticks) {
        svg("line", { class: "grid", x1: LEFT, x2: width - RIGHT, y1: y(t), y2: y(t) }, root);
        svg("text", { class: "tick", x: LEFT - 6, y: y(t) + 4, "text-anchor": "end" }, root).textContent = chart.tick(t);
      }
      for (const ref of chart.refs(data)) {
        svg("line", { class: `ref${ref.dashed ? " dashed" : ""}`, x1: LEFT, x2: width - RIGHT, y1: y(ref.v), y2: y(ref.v) }, root);
        if (ref.label) {
          svg("text", { class: "tick ref-label", x: width - RIGHT - 2, y: y(ref.v) - 4, "text-anchor": "end" }, root).textContent = ref.label;
        }
      }
      let d = "";
      for (let i = 0; i <= last; i++) d += `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(values[i]).toFixed(1)}`;
      if (chart.area) svg("path", { d: `${d}L${x(last)} ${y(lo)}L${x(0)} ${y(lo)}Z`, fill: chart.colour, "fill-opacity": 0.1 }, root);
      svg("path", { class: "line", d, stroke: chart.colour }, root);
      if (isLast) {
        for (const i of [0, ...marks]) {
          const anchor = i === 0 ? "start" : x(i) > width - RIGHT - 24 ? "end" : "middle";
          svg("text", { class: "tick", x: x(i), y: bottom + 15, "text-anchor": anchor }, root).textContent = DAY.format(timeAt(i));
        }
      }
      const cross = svg("line", { class: "cross", y1: TOP, y2: bottom, visibility: "hidden" }, root);
      const dot = svg("circle", { class: "dot", r: 4, fill: chart.colour, visibility: "hidden" }, root);

      const valueEl = el("b", "value");
      const stateEl = el("span", "state");
      const key = el("span", "line-key");
      key.style.background = chart.colour;
      return { chart, y, cross, dot, valueEl, stateEl, figure: el("figure", "month-chart", [
        el("figcaption", null, [key, chart.title, valueEl, chart.state ? stateEl : []]), root,
      ]) };
    });
    chartsEl.replaceChildren(...drawn.map((g) => g.figure));
    update();
  }

  function update() {
    if (!data || !drawn.length) return;
    const i = index ?? chosen;
    timeEl.textContent = `${DATE_TIME.format(timeAt(i))} UTC · ${index === null ? "chosen time" : `day ${num((i * step) / 24, 1)}`}`;
    for (const g of drawn) {
      const v = data.values[g.chart.key][i];
      g.valueEl.textContent = g.chart.value(v);
      if (g.chart.state) {
        const [text, cls = ""] = g.chart.state(data.values, i, data);
        g.stateEl.textContent = text;
        g.stateEl.className = `state ${cls}`;
      }
      for (const [node, attrs] of [[g.cross, { x1: x(i), x2: x(i) }], [g.dot, { cx: x(i), cy: g.y(v) }]]) {
        node.setAttribute("visibility", "visible");
        for (const k in attrs) node.setAttribute(k, attrs[k]);
      }
    }
  }

  function setIndex(i) {
    index = i === null ? null : Math.max(0, Math.min(n() - 1, Math.round(i)));
    update();
  }

  chartsEl.addEventListener("pointermove", (e) => {
    if (!data || !width) return;
    const left = chartsEl.getBoundingClientRect().left;
    setIndex(((e.clientX - left - LEFT) / (width - LEFT - RIGHT)) * (n() - 1));
  });
  chartsEl.addEventListener("pointerleave", () => setIndex(null));
  chartsEl.addEventListener("keydown", (e) => {
    if (!data) return;
    const day = 24 / step;
    const moves = { ArrowRight: e.shiftKey ? day : 1, ArrowLeft: e.shiftKey ? -day : -1 };
    if (e.key in moves) setIndex((index ?? chosen) + moves[e.key]);
    else if (e.key === "Home") setIndex(0);
    else if (e.key === "End") setIndex(n() - 1);
    else if (e.key === "Escape") setIndex(null);
    else return;
    e.preventDefault();
  });
  // Opening the table below must not squeeze the graphs: the panel scrolls instead
  panel.querySelector(".month-table").addEventListener("toggle", (e) => {
    chartsEl.style.minHeight = e.target.open ? `${chartsEl.clientHeight}px` : "";
  });
  new ResizeObserver(() => {
    if (chartsEl.clientWidth !== width || chartsEl.clientHeight !== height) draw();
  }).observe(chartsEl);

  return {
    busy() { panel.classList.add("busy"); },
    hide() { panel.classList.remove("busy"); panel.hidden = true; },
    setWhere(text) { whereEl.textContent = text; },
    // month: { values, times (ms), terrain, earthMinEl, durations, days }; at: index of the chosen time
    show(month, at, where) {
      data = month;
      chosen = at;
      index = null;
      step = (month.times[1] - month.times[0]) / 3600e3;
      panel.classList.remove("busy");
      panel.hidden = false;
      titleEl.textContent = `days from ${DAY.format(month.times[0])}`;
      whereEl.textContent = where;
      summaryEl.replaceChildren(summary(month, step));
      tableEl.replaceChildren(table(month, step));
      draw();
    },
  };
}
