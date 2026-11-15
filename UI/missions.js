import { markerDataUrl } from "./markers.js";
import { fetchCsv, table, toNumber } from "./csv.js";
import {
  el, img, detailList, createListPanel, legendButton, createLegendFilter, formatLatLon, formatElevation,
} from "./panel.js";

const COORDS_URL = "data/coordinates.csv";
const NOTES_URL = "data/notes.csv";

export const COUNTRIES = {
  "États-Unis": { label: "USA", color: "#4FA3FF", flag: "flags/united-states-flag-circle-badge-128.png" },
  URSS: { label: "USSR", color: "#FF4D4D", flag: "flags/ussr-flag-circle-badge.png" },
  Russie: { label: "Russia", color: "#FF9A3C", flag: "flags/russia-flag-circle-badge-128.png" },
  Chine: { label: "China", color: "#FFD23F", flag: "flags/china-flag-circle-badge-128.png" },
  Japon: { label: "Japan", color: "#FF7AC8", flag: "flags/japan-flag-circle-badge-128.png" },
  Inde: { label: "India", color: "#3DDC84", flag: "flags/india-flag-circle-badge-128.png" },
  "ESA (Europe)": { label: "ESA (Europe)", color: "#B48CFF", flag: "flags/eu-flag-circle-badge.png" },
  Israël: { label: "Israel", color: "#4DE8E0", flag: "flags/israel-flag-circle-badge-128.png" },
};

const COUNTRY_ALIASES = {
  "United States": "États-Unis", USA: "États-Unis", USSR: "URSS", "Soviet Union": "URSS",
  Russia: "Russie", China: "Chine", Japan: "Japon", India: "Inde", Israel: "Israël",
  ESA: "ESA (Europe)", Europe: "ESA (Europe)",
};

export function countryStyle(country) {
  return COUNTRIES[country] ?? { label: country || "Unknown", color: "#C8C8C8", flag: null };
}

const RELIABILITY = { bonne: "good", moyenne: "medium", faible: "low" };

// Accepted column headers (French or English, case-insensitive) for each field.
const COLUMNS = {
  name: ["nom", "name"],
  year: ["année", "year"],
  date: ["date"],
  time: ["heure utc", "time utc", "utc time", "time (utc)"],
  country: ["pays", "country"],
  lon: ["longitude"],
  lat: ["latitude"],
  crash: ["crash"],
  description: ["bref description", "brief description", "description"],
  eventType: ["type d'événement", "event type"],
  zone: ["lieu / zone", "location / area", "area"],
  reliability: ["fiabilité des coordonnées", "coordinate reliability", "reliability"],
};

const YES = new Set(["oui", "yes", "true", "1"]);

export async function loadMissions() {
  const [coords, notes] = await Promise.all([
    fetchCsv(COORDS_URL),
    fetchCsv(NOTES_URL).catch((err) => { console.warn(err); return null; }),
  ]);
  const noteRows = notes ? table(notes, NOTES_URL, COLUMNS, ["name"]) : [];
  const notesByName = new Map(noteRows.map((n) => [n.name, n]));

  return table(coords, COORDS_URL, COLUMNS, ["name", "lat", "lon"])
    .map((r, i) => {
      // Same name, else same row: notes.csv lists the missions in the same order.
      const note = notesByName.get(r.name) ?? noteRows[i] ?? {};
      const lat = toNumber(r.lat);
      const lon = toNumber(r.lon);
      return {
        name: r.name,
        year: r.year ?? "",
        date: r.date ?? "",
        time: r.time ?? "",
        country: COUNTRY_ALIASES[r.country] ?? r.country ?? "",
        lat,
        lon,
        hasCoords: lat !== null && lon !== null,
        crash: YES.has((r.crash ?? "").toLowerCase()),
        description: r.description ?? "",
        eventType: note.eventType ?? "",
        zone: note.zone ?? "",
        reliability: note.reliability ?? "",
      };
    })
    .filter((m) => m.name);
}

export function flagImg(style) {
  return style.flag ? img(style.flag, "flag", style.label) : el("span", "flag blank");
}

export const missionShape = (m) => (m.crash ? "diamond" : "circle");

const markerImg = (m) => img(markerDataUrl(countryStyle(m.country).color, missionShape(m)), "marker");

export function missionTooltip(m) {
  return [flagImg(countryStyle(m.country)), m.name, el("span", "meta", m.year)];
}

export function createMissionPanel({ panelEl, missions, elevationKm, onRowClick, onFilter }) {
  const legendEl = panelEl.querySelector(".legend");
  const counts = new Map();
  for (const m of missions) counts.set(m.country, (counts.get(m.country) ?? 0) + 1);
  for (const [country, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const style = countryStyle(country);
    legendEl.append(
      legendButton("country", country, `Show only ${style.label}`, [
        img(markerDataUrl(style.color, "circle"), "marker"),
        flagImg(style),
        el("span", "legend-label", style.label),
        el("span", "legend-count", String(n)),
      ])
    );
  }
  legendEl.append(
    el("div", "shape-key", [
      legendButton("outcome", "landing", "Show only landings", [img(markerDataUrl("#C8C8C8", "circle"), "marker"), "Landing"]),
      legendButton("outcome", "crash", "Show only crashes / impacts", [img(markerDataUrl("#C8C8C8", "diamond"), "marker"), "Crash / impact"]),
    ])
  );

  const list = createListPanel({
    listEl: panelEl.querySelector(".item-list"),
    items: missions,
    onRowClick,
    renderRow: (m) => [
      flagImg(countryStyle(m.country)),
      markerImg(m),
      el("span", "name", m.name),
      el("span", "meta", m.year),
    ],
    renderDetails: (m) => [
      detailList([
        ["Date", [m.date, m.time && `${m.time} UTC`].filter(Boolean).join(" · ")],
        ["Country", countryStyle(m.country).label],
        ["Outcome", `${m.crash ? "Crash / impact" : "Landing"}${m.eventType ? ` (${m.eventType})` : ""}`],
        ["Area", m.zone],
        ["Position", m.hasCoords ? formatLatLon(m.lat, m.lon) : "unknown"],
        ["Accuracy", RELIABILITY[m.reliability] ?? m.reliability],
        ["Elevation", m.hasCoords ? `${formatElevation(elevationKm(m))} (LOLA, ~2 km grid)` : ""],
      ]),
      m.description ? el("p", null, m.description) : [],
    ],
  });

  createLegendFilter({
    panelEl,
    list,
    facets: { country: (m) => m.country, outcome: (m) => (m.crash ? "crash" : "landing") },
    searchText: (m) =>
      [m.name, countryStyle(m.country).label, m.year, m.zone, m.eventType, m.crash ? "crash impact" : "landing"].join(" "),
    placeholder: "Search missions…",
    onChange: onFilter,
  });
  return list;
}
