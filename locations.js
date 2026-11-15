import { markerDataUrl } from "./markers.js";
import { fetchCsv, table, toNumber } from "./csv.js";
import {
  el, img, detailList, createListPanel, legendButton, createLegendFilter, formatLatLon, formatElevation,
} from "./panel.js";

const LOCATIONS_URL = "data/locations.csv";

// Keys are the values of the "type" column. Same type → same colour on the Moon and in the list.
export const TYPES = {
  Mare: { label: "Mare / plain", color: "#4FA3FF" },
  Crater: { label: "Crater", color: "#FFD23F" },
  Basin: { label: "Basin", color: "#FF9A3C" },
  Mountain: { label: "Mountain", color: "#3DDC84" },
  Region: { label: "Landing region", color: "#FF7AC8" },
  Pole: { label: "Pole", color: "#4DE8E0" },
};

export function typeStyle(type) {
  return TYPES[type] ?? { label: type || "Other", color: "#C8C8C8" };
}

const COLUMNS = {
  name: ["name", "nom"],
  type: ["type"],
  lat: ["latitude"],
  lon: ["longitude"],
  diameter: ["diameter km", "diameter (km)", "diameter"],
  match: ["match"],
  accuracy: ["accuracy", "coordinate reliability"],
  description: ["description"],
};

export async function loadLocations() {
  const rows = table(await fetchCsv(LOCATIONS_URL), LOCATIONS_URL, COLUMNS, ["name", "lat", "lon"]);
  return rows
    .filter((r) => r.name)
    .map((r) => {
      const lat = toNumber(r.lat);
      const lon = toNumber(r.lon);
      return {
        name: r.name,
        type: r.type ?? "",
        lat,
        lon,
        hasCoords: lat !== null && lon !== null,
        diameterKm: toNumber(r.diameter),
        // A mission belongs here when its "location / area" in notes.csv contains this text.
        match: (r.match || r.name).toLowerCase(),
        accuracy: r.accuracy ?? "",
        description: r.description ?? "",
      };
    });
}

const markerImg = (l) => img(markerDataUrl(typeStyle(l.type).color, "square"), "marker");

export function locationTooltip(l) {
  return [markerImg(l), l.name, el("span", "meta", typeStyle(l.type).label)];
}

export function createLocationPanel({ panelEl, locations, missions, elevationKm, onRowClick, onFilter }) {
  const legendEl = panelEl.querySelector(".legend");
  const counts = new Map();
  for (const l of locations) counts.set(l.type, (counts.get(l.type) ?? 0) + 1);
  for (const [type, n] of counts) {
    const style = typeStyle(type);
    legendEl.append(
      legendButton("type", type, `Show only: ${style.label}`, [
        img(markerDataUrl(style.color, "square"), "marker"),
        el("span", "legend-label", style.label),
        el("span", "legend-count", String(n)),
      ])
    );
  }

  const missionsAt = (l) => missions.filter((m) => m.zone.toLowerCase().includes(l.match)).map((m) => m.name);

  const list = createListPanel({
    listEl: panelEl.querySelector(".item-list"),
    items: locations,
    onRowClick,
    renderRow: (l) => [markerImg(l), el("span", "name", l.name), el("span", "meta", typeStyle(l.type).label)],
    renderDetails: (l) => [
      detailList([
        ["Type", typeStyle(l.type).label],
        ["Position", l.hasCoords ? formatLatLon(l.lat, l.lon) : "unknown"],
        ["Diameter", l.diameterKm !== null ? `${l.diameterKm} km` : ""],
        ["Accuracy", l.accuracy],
        ["Elevation", l.hasCoords ? `${formatElevation(elevationKm(l))} (LOLA, ~2 km grid)` : ""],
        ["Missions here", missionsAt(l).join(", ")],
      ]),
      l.description ? el("p", null, l.description) : [],
    ],
  });

  createLegendFilter({
    panelEl,
    list,
    facets: { type: (l) => l.type },
    searchText: (l) => `${l.name} ${typeStyle(l.type).label}`,
    placeholder: "Search locations…",
    onChange: onFilter,
  });
  return list;
}
