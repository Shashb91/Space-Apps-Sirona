// The mode panels as windows (not the bottom-left panel): resized within limits, moved to the left,
// the right or the bottom of the screen, and minimised to a small bar where they were.
// Limits, from each panel's usual size: width 0.75× to 1.25× (the Custom Point and Parametric Search
// cards: never narrower than usual), height 0.33× to 1.25×, never taller than its place on screen.
// At the bottom: a wide strip (its own layout, style.css), about a third of the screen tall.
// Two panels of one mode never share a side: dropping one there swaps them.
import { el } from "./panel.js";

const $ = (id) => document.getElementById(id);
const KEY = "sirona.windows"; // the layout, kept in this browser
const GAP = 12;               // px between a window and the bottom-left panel, the Help button or another window
// The Best areas block unscaled (search.js): 2 × 2 on a side, 4 in a row at the bottom
const AREAS = { side: { w: 2 * 250 + 16, h: 34 + 2 * 404 + 16 }, bottom: { w: 4 * 250 + 3 * 16, h: 34 + 404 } };
const BOTTOM_H = 0.32; // the bottom strip's usual height, × the screen's
const DOCKS = ["left", "right", "bottom"];
const phone = matchMedia("(max-width: 760px), (max-height: 500px)");
const STYLE_PROPS = ["position", "left", "right", "top", "bottom", "width", "height", "maxHeight", "zoom"];

// fill: as tall as its place; otherwise as tall as its content, up to its place
// keepWidth: never narrower than usual; scaled: zoomed as a whole (its panels are drawings)
const SPECS = [
  { key: "visualisation", mode: "visualisation", home: "right", fill: true, ids: ["missionsPanel", "locationsPanel", "geologyPanel"],
    title: (node) => ({ missionsPanel: "Space Missions", locationsPanel: "Noteworthy Locations", geologyPanel: "Geology" })[node.id] },
  { key: "custom", mode: "custom", home: "left", keepWidth: true, ids: ["pointForm"], title: () => "Custom Point" },
  { key: "month", mode: "custom", home: "right", fill: true, ids: ["monthPanel"],
    title: () => `${$("monthDays").value} ${$("monthTitleText").textContent}` },
  { key: "search", mode: "search", home: "left", keepWidth: true, ids: ["searchForm"], title: () => "Parametric Search" },
  { key: "areas", mode: "search", home: "right", scaled: true, ids: ["searchAreas"], title: () => "Best areas" },
  { key: "maps", mode: "maps", home: "left", ids: ["routeForm"], title: () => "Sirona Maps" },
];

export function setupWindows({ onChange } = {}) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { /* no storage: the usual layout */ }
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(wins.map((w) => [w.key, w.state])))); } catch { /* not kept */ }
  };

  const wins = SPECS.map((spec) => {
    const s = saved[spec.key] ?? {};
    const num = (v) => (Number.isFinite(v) ? v : null);
    // sizes: { dock: { w, h } } chosen by the user, one per dock (null: the usual size)
    const sizes = Object.fromEntries(DOCKS.map((d) => [d, { w: num(s.sizes?.[d]?.w), h: num(s.sizes?.[d]?.h) }]));
    const state = {
      dock: DOCKS.includes(s.dock) ? s.dock : spec.home, sizes,
      scale: num(s.scale) ?? 1, min: s.min === true,
    };
    const nodes = spec.ids.map($);
    const bar = el("div", "window-bar", [el("span", "window-bar-title"), el("button", "window-bar-open", "Reopen")]);
    bar.hidden = true;
    document.body.append(bar);
    return { ...spec, state, nodes, bar };
  });
  const mode = () => document.body.dataset.mode;
  const shown = (w) => w.nodes.find((n) => !n.hidden);

  // --- Where each window goes --------------------------------------------------------------
  // The free space: under the mode buttons (and the tick boxes in Visualisation), above the bottom-left panel
  function frame() {
    const pane = $(`mode-${mode()}`)?.getBoundingClientRect();
    const modes = document.querySelector(".modes").getBoundingClientRect();
    return {
      vw: innerWidth, vh: innerHeight,
      leftTop: pane ? pane.bottom + (pane.height ? 10 : 0) : modes.bottom + 16,
      leftBottom: $("panel").getBoundingClientRect().top - GAP,
      bottomLeft: $("helpButton").getBoundingClientRect().right + GAP,
      bottomTop: modes.bottom + GAP,
    };
  }
  const fit = (w) => Number(w.nodes[0].dataset.fit) || 1;
  const clamp = (v, lo, hi) => Math.max(Math.min(v, hi), Math.min(lo, hi)); // no room: hi wins
  const areasSize = (dock) => (dock === "bottom" ? AREAS.bottom : AREAS.side);

  // The free space in a dock: { x, top, bottom, width }
  // others: the boxes already placed in this mode (left and right first, then the bottom)
  function room(dock, f, others) {
    const across = others.filter((o) => o.dock !== "bottom" && o.dock !== dock).reduce((a, o) => a + o.width + GAP, 0);
    if (dock === "left") return { x: 20, top: f.leftTop, bottom: f.leftBottom, width: f.vw - 36 - across };
    if (dock === "right") return { top: 16, bottom: f.vh - 16, width: f.vw - 36 - across };
    // A side window counts only if it comes down to where the strip may reach (1.25 × its usual height)
    const reach = f.vh - 16 - 1.25 * BOTTOM_H * f.vh - GAP;
    const right = others.find((o) => o.dock === "right" && o.y + o.height > reach);
    const left = others.find((o) => o.dock === "left");
    const top = left && left.x + left.width > f.bottomLeft ? Math.max(f.bottomTop, left.y + left.height + GAP) : f.bottomTop;
    const end = right ? right.x - GAP : f.vw - 16;
    return { x: f.bottomLeft, top, bottom: f.vh - 16, width: end - f.bottomLeft };
  }

  // The usual size in a dock and the limits around it
  function limits(w, dock, f, r) {
    let baseW, baseH;
    if (dock === "bottom") { baseW = r.width; baseH = BOTTOM_H * f.vh; }
    else {
      baseW = w.fill ? (innerWidth <= 1100 ? 380 : 510) : 360;
      baseH = w.fill ? f.vh - 32 : f.leftBottom - f.leftTop;
    }
    const keep = w.keepWidth && dock !== "bottom";
    return { baseW, baseH, minW: keep ? baseW : 0.75 * baseW, maxW: 1.25 * baseW, minH: 0.33 * baseH, maxH: 1.25 * baseH };
  }
  // The Best areas block's usual zoom: search.js's on a side; at the bottom, a row as tall as the strip
  function areasBase(dock, f, r) {
    const a = areasSize(dock);
    return dock === "bottom" ? Math.min(r.width / a.w, (1.4 * BOTTOM_H * f.vh) / a.h) : null;
  }

  // The window's box in a dock: { x, y (top) or bottom, width, height or cap (as tall as its content up to it) }
  function box(w, dock, f, others) {
    const r = room(dock, f, others);
    const tall = r.bottom - r.top;
    const b = { dock };
    if (w.scaled) {
      const a = areasSize(dock);
      const base = areasBase(dock, f, r) ?? fit(w);
      const z = Math.min(base * clamp(w.state.scale, 0.75, 1.25), r.width / a.w, tall / a.h);
      Object.assign(b, { zoom: z, width: z * a.w, height: z * a.h });
    } else {
      const lim = limits(w, dock, f, r);
      const size = w.state.sizes[dock];
      b.width = clamp(size.w ?? lim.baseW, lim.minW, Math.min(lim.maxW, r.width));
      const maxH = Math.min(lim.maxH, tall);
      if (size.h != null) b.height = clamp(size.h, lim.minH, maxH);
      else b.cap = Math.min(lim.baseH, tall);
      if (w.fill && b.height == null) b.height = b.cap;
    }
    b.x = dock === "right" ? f.vw - 16 - b.width : r.x;
    b.y = dock === "bottom" ? null : r.top;
    return b;
  }
  // As drawn on screen (an auto height: the window's own, up to its cap)
  function rect(w, b, f) {
    const h = b.height ?? Math.min(shown(w)?.getBoundingClientRect().height || b.cap, b.cap);
    return { left: b.x, top: b.y ?? f.vh - 16 - h, width: b.width, height: h };
  }
  // The others of this mode, as placed (a hidden or minimised one leaves its place free)
  const othersOf = (w) => wins.filter((o) => o !== w && o.mode === w.mode && o.rect && !o.state.min && shown(o)).map((o) => o.rect);

  function place(w, b) {
    for (const n of w.nodes) {
      const s = n.style;
      n.dataset.dock = b.dock;
      const z = b.zoom ?? 1; // a zoomed element's lengths are in its own (zoomed) pixels
      s.zoom = b.zoom ? z : "";
      s.position = "fixed";
      s.left = `${b.x / z}px`; s.right = "auto";
      if (b.y == null) { s.top = "auto"; s.bottom = `${16 / z}px`; } else { s.top = `${b.y / z}px`; s.bottom = "auto"; }
      if (b.zoom) { s.width = s.height = s.maxHeight = ""; continue; }
      s.width = `${b.width}px`;
      s.height = b.height != null ? `${b.height}px` : "";
      s.maxHeight = b.height != null ? "" : `${b.cap}px`;
    }
  }

  function layout() {
    const desktop = !phone.matches;
    document.body.classList.toggle("windows", desktop);
    if (!desktop) {
      for (const w of wins) for (const n of w.nodes) for (const p of STYLE_PROPS) n.style[p] = "";
      for (const w of wins) w.bar.hidden = true;
      return;
    }
    const f = frame();
    const mine = wins.filter((w) => w.mode === mode());
    const order = [...mine].sort((a, b) => (a.state.dock === "bottom") - (b.state.dock === "bottom"));
    const placed = [];
    for (const w of order) {
      const b = box(w, w.state.dock, f, placed);
      place(w, b);
      const r = rect(w, b, f);
      w.rect = { dock: b.dock, x: r.left, y: r.top, width: r.width, height: r.height };
      if (!w.state.min && shown(w)) placed.push(w.rect); // a hidden or minimised one leaves its place free
      w.box = b;
    }
    updateBars(f);
    onChange?.();
  }

  // --- Minimised: a bar with the title and Reopen, where the window was ---------------------
  function updateBars(f = frame()) {
    for (const w of wins) {
      for (const n of w.nodes) n.classList.toggle("win-min", w.state.min);
      const node = shown(w);
      w.bar.hidden = phone.matches || !w.state.min || w.mode !== mode() || !node;
      if (w.bar.hidden) continue;
      w.bar.querySelector(".window-bar-title").textContent = w.title(node);
      const s = w.bar.style;
      const b = w.box ?? box(w, w.state.dock, f, []);
      s.left = w.state.dock === "right" ? "auto" : `${b.x}px`;
      s.right = w.state.dock === "right" ? "16px" : "auto";
      s.top = w.state.dock === "bottom" ? "auto" : `${b.y}px`;
      s.bottom = w.state.dock === "bottom" ? "16px" : "auto";
    }
  }

  // --- Moving: the window darkens and a block shows where it will go ------------------------
  const preview = el("div", "dock-preview");
  preview.hidden = true;
  document.body.append(preview);
  const target = (x, y) => (y > innerHeight * 0.7 ? "bottom" : x < innerWidth / 2 ? "left" : "right");
  const INTERACTIVE = "button, input, select, textarea, a, label, summary";

  function startMove(w, e) {
    const x0 = e.clientX, y0 = e.clientY;
    let moving = false, dock = null;
    const show = (x, y) => {
      dock = target(x, y);
      const f = frame();
      // The others that stay where they are (one on that side swaps with this one)
      const others = othersOf(w).filter((o) => o.dock !== dock);
      const r = rect(w, box(w, dock, f, others), f);
      Object.assign(preview.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const move = (ev) => {
      if (!moving && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (!moving) {
        moving = true;
        for (const n of w.nodes) n.classList.add("win-moving");
        document.body.classList.add("win-dragging");
        preview.hidden = false;
      }
      show(ev.clientX, ev.clientY);
    };
    const end = (ev, cancel = false) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("keydown", key);
      if (!moving) return;
      for (const n of w.nodes) n.classList.remove("win-moving");
      document.body.classList.remove("win-dragging");
      preview.hidden = true;
      if (cancel || dock === w.state.dock) return;
      const other = wins.find((o) => o !== w && o.mode === w.mode && o.state.dock === dock);
      if (other) other.state.dock = w.state.dock; // swap
      w.state.dock = dock;
      save();
      layout();
    };
    const up = (ev) => end(ev);
    const key = (ev) => { if (ev.key === "Escape") end(ev, true); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("keydown", key);
  }

  // --- Resizing from the free edges (the dock decides which: see style.css) -----------------
  function startResize(w, node, edge, e) {
    const f = frame();
    const dock = w.state.dock;
    const others = othersOf(w).filter((o) => dock === "bottom" || o.dock !== "bottom");
    const r = room(dock, f, others);
    const lim = limits(w, dock, f, r);
    const a = areasSize(dock), base = areasBase(dock, f, r) ?? fit(w);
    const size = w.state.sizes[dock];
    const r0 = node.getBoundingClientRect();
    const move = (ev) => {
      const dx = ev.clientX - e.clientX, dy = ev.clientY - e.clientY;
      const width = r0.width + (dock === "right" ? -dx : dx);
      const height = r0.height + (dock === "bottom" ? -dy : dy);
      if (w.scaled) {
        const s = edge === "end" ? height / (base * a.h) : width / (base * a.w);
        w.state.scale = clamp(s, 0.75, 1.25);
      } else {
        if (edge !== "end") size.w = clamp(width, lim.minW, lim.maxW);
        if (edge !== "side") size.h = clamp(height, lim.minH, lim.maxH);
      }
      layout();
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      document.body.classList.remove("win-resizing");
      save();
    };
    document.body.classList.add("win-resizing");
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  // --- The controls on each window ------------------------------------------------------------
  for (const w of wins) {
    for (const node of w.nodes) {
      node.classList.add("win");
      const minBtn = el("button", "win-min-btn", "–");
      Object.assign(minBtn, { type: "button", title: "Minimise" });
      minBtn.setAttribute("aria-label", `Minimise ${w.title(node) ?? "the panel"}`);
      minBtn.addEventListener("click", () => { w.state.min = true; save(); layout(); });
      node.append(minBtn);
      for (const edge of ["side", "end", "corner"]) {
        const grip = el("div", `win-grip win-${edge}`);
        grip.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          startResize(w, node, edge, e);
        });
        node.append(grip);
      }
      const title = node.querySelector(".window-title");
      title.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(INTERACTIVE) || phone.matches) return;
        e.preventDefault();
        startMove(w, e);
      });
      title.title = "Drag to move the panel: to the left, the right or the bottom";
      new MutationObserver(() => layout()).observe(node, { attributes: true, attributeFilter: ["hidden"] }); // shown or gone: the Moon too
    }
    w.bar.querySelector(".window-bar-open").addEventListener("click", () => { w.state.min = false; save(); layout(); });
  }

  // --- When to place them again ---------------------------------------------------------------
  addEventListener("resize", layout);
  phone.addEventListener("change", layout);
  $("searchAreas").addEventListener("fit", layout);
  new MutationObserver(layout).observe(document.body, { attributes: true, attributeFilter: ["data-mode"] });
  const watch = new ResizeObserver(() => layout());
  watch.observe($("panel"));
  for (const pane of document.querySelectorAll(".mode-pane")) watch.observe(pane);
  for (const w of wins) if (!w.fill && !w.scaled) for (const n of w.nodes) watch.observe(n); // an auto height: its bar and the bottom
  layout();
  return { layout };
}
