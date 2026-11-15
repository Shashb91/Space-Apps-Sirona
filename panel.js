export function el(tag, className, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...[children].flat(Infinity));
  return node;
}

export function img(src, className, alt = "") {
  const node = el("img", className);
  node.src = src;
  node.alt = alt;
  return node;
}

const deg = (v, pos, neg) => `${Math.abs(v).toFixed(3)}° ${v >= 0 ? pos : neg}`;
export const formatLatLon = (lat, lon) => `${deg(lat, "N", "S")} · ${deg(lon, "E", "W")}`;
export const formatElevation = (km) => `${km >= 0 ? "+" : "−"}${Math.abs(km * 1000).toFixed(0)} m`;

// [term, value] pairs; empty values are skipped.
export function detailList(entries) {
  const dl = el("dl");
  for (const [term, value] of entries) if (value) dl.append(el("dt", null, term), el("dd", null, value));
  return dl;
}

// Clickable list of items; the selected item expands to show its details.
export function createListPanel({ listEl, items, renderRow, renderDetails, onRowClick }) {
  const rows = new Map();
  for (const item of items) {
    const row = el("button", "item-row", renderRow(item));
    row.type = "button";
    row.setAttribute("aria-expanded", "false");
    if (!item.hasCoords) row.title = "Position unknown: not shown on the Moon";
    row.addEventListener("click", () => onRowClick(item));
    const li = el("li", item.hasCoords ? "item" : "item no-coords", row);
    rows.set(item, li);
    listEl.append(li);
  }
  const empty = el("li", "empty", "No match");
  empty.hidden = true;
  listEl.append(empty);

  function setFilter(match) {
    for (const [item, li] of rows) li.classList.toggle("dimmed", !!match && !match(item));
  }

  function setSearch(match) {
    let shown = 0;
    for (const [item, li] of rows) {
      li.hidden = !!match && !match(item);
      if (!li.hidden) shown++;
    }
    empty.hidden = shown > 0;
  }

  // Scrolls the list only, never the page (the page scrolls on small screens).
  function revealRow(li) {
    const list = listEl.getBoundingClientRect();
    const row = li.getBoundingClientRect();
    const by = row.top < list.top ? row.top - list.top : Math.max(0, Math.min(row.bottom - list.bottom, row.top - list.top));
    if (by) listEl.scrollBy({ top: by, behavior: "smooth" });
  }

  let current = null;
  function select(item) {
    if (current) {
      const li = rows.get(current);
      li.classList.remove("selected");
      li.querySelector(".details")?.remove();
      li.firstChild.setAttribute("aria-expanded", "false");
    }
    current = item;
    if (!item) return;
    const li = rows.get(item);
    li.classList.add("selected");
    li.append(el("div", "details", renderDetails(item)));
    li.firstChild.setAttribute("aria-expanded", "true");
    revealRow(li);
  }

  return { select, setFilter, setSearch };
}

// A legend entry that filters by one category (facet = what it sorts by, e.g. "country").
export function legendButton(facet, value, title, children) {
  const button = el("button", "legend-item", children);
  button.type = "button";
  button.title = title;
  button.dataset.facet = facet;
  button.dataset.value = value;
  button.setAttribute("aria-pressed", "false");
  return button;
}

// Lower case, accents removed: "rumker" finds "Rümker".
const normalize = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Legend: clicking an entry keeps only that category (one per facet, so "USA" + "Crash" combine),
// clicking it again removes it. Rows outside it are dimmed.
// Search box (bottom of the panel): rows whose searchText doesn't contain every word are hidden.
// "Show all" clears both. onChange gets match(item) for the points on the Moon, or null.
export function createLegendFilter({ panelEl, list, facets, searchText, placeholder, onChange }) {
  const legendEl = panelEl.querySelector(".legend");
  const active = new Map(); // facet → value
  const reset = el("button", "legend-reset", "Show all");
  reset.type = "button";
  reset.hidden = true;
  panelEl.append(reset);

  const search = el("input", "search");
  search.type = "search";
  search.placeholder = placeholder;
  search.setAttribute("aria-label", placeholder);
  panelEl.append(search);

  const legendMatch = (item) => [...active].every(([facet, value]) => facets[facet](item) === value);

  function update() {
    for (const b of legendEl.querySelectorAll("[data-facet]")) {
      const value = active.get(b.dataset.facet);
      b.setAttribute("aria-pressed", String(value === b.dataset.value));
      b.classList.toggle("dimmed", value !== undefined && value !== b.dataset.value);
    }
    const words = normalize(search.value).split(/\s+/).filter(Boolean);
    const searchMatch = words.length
      ? (item) => { const text = normalize(searchText(item)); return words.every((w) => text.includes(w)); }
      : null;
    const byLegend = active.size ? legendMatch : null;
    list.setFilter(byLegend);
    list.setSearch(searchMatch);
    reset.hidden = !byLegend && !searchMatch;
    onChange(byLegend && searchMatch ? (item) => byLegend(item) && searchMatch(item) : byLegend ?? searchMatch);
  }

  search.addEventListener("input", update);

  legendEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-facet]");
    if (!b) return;
    const { facet, value } = b.dataset;
    if (active.get(facet) === value) active.delete(facet);
    else active.set(facet, value);
    update();
  });
  reset.addEventListener("click", () => {
    active.clear();
    search.value = "";
    update();
  });
}
