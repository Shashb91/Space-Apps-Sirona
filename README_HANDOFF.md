# Handoff: Lunar Landing Site Navigator

This file is for starting a new conversation with Claude, for example Fable 5.2.
The new conversation will not know what was done before, so ask it to read this file first.

## The project

This is our entry for the NASA Space Apps Challenge 2026, "Lunar Landing Site Navigator".
It is a 3D Moon in the browser, built with Three.js. It helps the user find and compare landing sites.

There are two parts:
- the website, in `UI/`;
- the team's Python server ("Sirona"), in `Python_backend/`. It computes Sun, Earth, temperature and rover-route data.

## Folders

| Path | What it is |
|---|---|
| `UI/` | The website. Plain ES modules, no build step and no npm. Three.js 0.187.0 and geotiff.js come from jsDelivr through the import map in `index.html`. |
| `UI/data/` | `coordinates.csv` and `notes.csv` (missions; the notes are in French), `locations.csv`, and `geology/`. |
| `UI/flags/` | The country badges for the missions. |
| `UI/tif/` | Moon colour map (`lroc_color_16bit_srgb_4k.tif`) and relief (`ldem_16_uint.tif`), both from svs.gsfc.nasa.gov/4720 (byte-identical to the files there; `launcher.py` downloads them). Also `slope_16.png` and `water_4k.png`: the big whole-Moon data maps. The 16k colour map (`lroc_color_16bit_srgb_16k.tif`, ~950 MB) is too big for a browser: `lroc_16k_tiles/` holds it cut into 32 × 16 JPEG tiles (25 MB). |
| `UI/help/` | The Help panel's text, one Markdown file per mode (text only). |
| `UI/textures/` | The friend's UI drawings (mode buttons, ticks, knob, the "Parametric Search" area markers, music button, etc). |
| `Python_backend/` | The Python server (FastAPI, `server.py`). The big maps and SPICE kernels are hard links to copies in Downloads and are ignored by git. |
| `category_test_files/` | Two files for testing "Add a category": `works/ldem_4.tif` is accepted, `fails/ldem_hw5x3.tif` is rejected. See its README. |
| `tools/geology_to_web.py` | Converts the USGS geologic map (`Unified_Geologic_Map_of_the_Moon_GIS_v2/`) into `UI/data/geology/`. |
| `tools/make_slope_map.py` | Makes `Python_backend/ldem_64_slope.tif` (rover routes) from `ldem_64.tif`: arctan of the central differences, dx = R·(1/64)°·cos(lat) at pixel centres, wrapping round in longitude, one-sided at the two pole rows. 14 s here, in 256 × 256 tiles (never the whole map in memory), deflate + floating-point predictor. It matches the team's map to 8·10⁻⁶° on every row but the two pole rows (theirs wrapped dz/dy from the north pole row to the south one). `launcher.py` runs it once. |
| `tools/make_highres_tiles.py` | Cuts the 16k colour map into `UI/tif/lroc_16k_tiles/`. Run it again only if the 16k file changes. |
| `build_zip.py` → `dist/` | Builds a copy of the site that opens with a double-click, then zips it. **Run it only when the user asks for the zip.** |
| `Start Windows.bat`, `Start Mac.command`, `launcher.py` | The one-click start for GitHub users (see "How to run"). The .bat must keep CRLF and the .command LF (`.gitattributes`); the .command needs the executable bit in git (`git add --chmod=+x`). |
| `README.md` | The GitHub page: how to start the app and the list of maps to download. |
| `Python_backend/requirements.txt` | The server's packages, which `launcher.py` installs in `.venv/` (git-ignored). |
| `.gitignore` (root) | Keeps out the files over 25 MB (GitHub's limit for uploads), `.venv/`, `dist/` and the USGS GIS folder. `Python_backend/.gitignore` keeps out the kernels and its two big maps. |

## How to run

**One click (for GitHub users).** Double-click `Start Windows.bat` or `Start Mac.command` (Linux: `python3 launcher.py`; `--no-browser` for tests). Their windows are titled "Sirona - Lunar Landing Site Navigator" (`NAME` in `launcher.py`; `TITLE`, the page's `<title>`, is how a running app is found). The Windows file finds a 64-bit Python 3.10+ (`py`, then `python`) and offers a winget install if there is none. `launcher.py` then:
- holds a lock (`.launcher.lock`), so a second start only opens the running app (found by its page title) or says it is starting;
- moves the big files (`MAPS` and `KERNELS` in it) from anywhere in the folder, loose or inside a `.zip`, to where the code reads them;
- makes `.venv/` and installs `Python_backend/requirements.txt` (again when that file changes, or when a package is missing);
- downloads what is missing: the SPICE kernels (NASA NAIF) and the two needed maps (NASA SVS, the CGI Moon Kit) before the app opens, `ldem_64.tif` (1.1 GB, SVS) in a background thread while it runs. Downloads go through `.part` files and resume with HTTP ranges;
- makes `ldem_64_slope.tif` once `ldem_64.tif` is there (right after its download, or at start), with `tools/make_slope_map.py` in its own process. Until then a route gets the server's "Carte des pentes introuvable", which `routes.js` turns into a note;
- runs the team's `server.app` with uvicorn, with `UI/` mounted at `/`, on port 8000 or the next free one up to 8009, and opens the browser.

`UI/api.js` asks `health` at the page's own address: the launcher's server answers, so the page uses it; Live Server or http.server don't, so it uses port 8000.

**Website.** Use the `moon-ui` preview in `.claude/launch.json`, which runs `python -m http.server 5510 --directory UI`. Then open http://localhost:5510. The user sometimes uses VS Code's Live Server instead.

**Server.** The user starts and restarts it, so don't kill it. From `Python_backend/`:

```bash
python -m uvicorn server:app --port 8000
```

- The server needs `tifffile` to read the maps, and `imagecodecs` for `ldem_64_slope.tif` (its floating-point predictor); both are installed.
- To test server changes without touching the user's server, run a copy on port 8001.
- In headless Chrome (CDP), redirect the page's requests to port 8001 with the `Fetch` domain.

**Browser cache.** After editing a file, the user needs Ctrl+F5 to see the change.

## The four modes (buttons at the top left, `modes.js`)

### 1. Visualisation
Layers you can tick on and off:
- Space Missions and Noteworthy Locations, each with a side panel, a legend filter and tooltips;
- Terrain smoothness, Geology, Altitude, Slope, Water (H₂O), and Temperature at a chosen date;
- "+ Add a category" (`categories.js`): loads any global PNG or TIFF map of the Moon and colours it on the globe. The left-edge list defaults to 180° W; a GeoTIFF that says where it is gets its own value picked, and the user can still change it.

### 2. Custom Point
Pick a latitude, a longitude and a date.
- The right panel (`monthPanel.js`) shows the Sun and the Earth seen from that spot.
- The number of days is set in the panel title: 30 by default, 1 to 366 allowed.
- Below that are summaries: longest night and longest time without an Earth link.
- Data comes from server mode 1, through `customPoint.js`.

### 3. Parametric Search
Build criteria from these quantities:
- Sun visible %, Sun elevation, Power, Temperature, Longest night;
- Earth elevation, Earth link, Earth link gap;
- Water, Slope, Altitude, Geology, Terrain.

How the search works (`search.js`, using server mode 2 for the Sun and Earth criteria):
- Criteria combine with "All must hold" or "Any one is enough".
- "When" can be: at some point, the whole period, on average, or on the start date.
- The best areas appear as coloured patches on the Moon, each with an arrow marker that always points down.
- Each area also gets a panel on the right.
- Click two panels to compare them. Clicking a picked panel removes it; a third click drops the first panel picked.
- The Moon slides so it is centred between the search card and the area panels.
- "Export the areas (CSV)" in the results opens a window (`#exportDialog`, search.js `openExport`) asking how many areas, with quick choices; Cancel or closing it stops a running export. It saves the first N areas (not only the 4 shown), ranked by criteria met then size: rank, name, criteria met, lat, lon, km², then for each criterion "met" and its value at the area's safest spot (Sun and Earth values from server mode 1, as the search compared them: highest, lowest, mean or at the start).

### 4. Sirona Maps
A rover route between two points that avoids slopes steeper than a set limit (`routes.js`, server mode 3, `routing.py`).

### Also
- Sun and Earth arrows around the Moon (`arrows.js`).
- A star sky (`stars.js`).
- A music button in the bottom-left panel (`music.js`). It loops `UI/music.mp3` at half volume and has four images: off, off hover, on, on hover.
- "High resolution" in the bottom-left panel (`highres.js`): the 4k map by default; ticked, the 16k tiles of the zoomed area are joined into one patch over it, only once the screen shows more detail than the 4k has.
- A Help button right of the bottom-left panel (`help.js`), drawn like the mode buttons: it opens the help of the mode shown, from `UI/help/<mode>.md`.

## The server API (`Python_backend/`)

The UI calls the server through `UI/api.js`. It sends `POST http://127.0.0.1:8000/query`. Each request asks for relief first and retries without it.

| Mode | Request | Code |
|---|---|---|
| 1 | `points` + `date` → time series per point; `advanced.range_days` up to 366; a `durations` dict per point | `query.time_series` |
| 2 | `criteria` → places that match | `query.find_locations` |
| 3 | `start` + `end` + `max_slope_deg` → rover route (A* on the slope map) | `routing.py` |
| — | `{"temperature_map": {"utc", "step_deg"}}` → the whole-Moon temperature at one instant | `query.temperature_map` |

`api.py` picks the mode from the request's keys: `start` + `end` means mode 3, and `temperature_map` means the temperature map.

Server-side criteria (`CRITERIA_INFO` in `query.py`):
- `sun_elevation`, `illumination`, `flux`;
- `earth_elevation`, `communication`;
- `temperature`;
- `longest_night`, `longest_no_link`.

Durations:
- A duration is the longest run of an "off" state.
- A run cut by the period's edges is counted in full, using a 16-day margin on each side.

**Temperature** (`temperature.py`): the 1-D thermal model of Hayne et al. (2017).
- It is precomputed into `temperature_table.npz` and scaled by (1 AU / d)^½.
- It assumes a smooth Moon: no relief shadows, no slopes and no Earth eclipses.

**Fixes to keep in the friend's code.** Both rasters start at 180° W, so `constants.py` must have:
- `DEM_PPD = 64`;
- `DEM_LON0 = -180`;
- `SLOPE_LON0 = -180`.

These are read by `terrain.py` and `routing.py`. Without them every height and slope is read from the wrong place. A newer copy from the friend has already dropped them once, so check them after every update.

## Working rules (from the user)

- **Look:** game-HUD *functions* (side panels, tick boxes, tooltips, picking things on the map), but a clean modern *look*.
  - Don't draw pixel art yourself.
  - Use the Inter font.
  - Panels: background `#100820`, border `#2E1BAC`.
  - The friend's drawings in `UI/textures/` are welcome: frames, ticks, knob, mode buttons, arrows, music button.
- **Comments:** keep code comments short. The user removes extra ones.
- **Zip:** don't rebuild it unless asked. If a change affects the zip, say that it needs a rebuild.
- **Git:**
  - Commit only when asked.
  - The branch is `shash_local`; the main branch is `main`.
  - Nothing has been committed since `0765928`, so there is a lot of uncommitted work.
  - None of the local commits are on GitHub, and every one of them holds files over 100 MB (`GeoUnits.shp` since the first commit, the 16k TIFF, the `dist/` zip). GitHub refuses such a push, so the work must go on a clean branch without them first.
- **Server:** the user restarts the 8000 server. After a server change, tell them to restart it.
- **Testing:**
  - Test UI changes in the browser pane or headless Chrome with real mouse events.
  - Look at the result, then stop there.
- **Windows tips:**
  - Bash heredocs with backslashes break.
  - Write multi-line edit scripts to a file with the Write tool, and use forward-slash paths in Python.
- **Privacy:** never send the user's personal details to outside services.

## Where things stand (2026-11-15)

Everything above works and was tested in the browser. The latest work:
- area comparison;
- arrow markers;
- the two duration criteria;
- the days entry in Custom Point;
- the music button;
- a French LaTeX paragraph on the temperature model, given in chat only;
- high resolution from the 16k map, the CSV export of the areas, the Help button, and the left-edge list in "Add a category";
- the one-click start (`Start Windows.bat`, `Start Mac.command`, `launcher.py`) and the GitHub `README.md`. Tested on Windows: first start, a changed requirements.txt, a missing package, a second start, the maps moved from a folder and from a zip, the kernel download, the three NASA maps (byte-identical, resumed, `ldem_64.tif` in the background), the slope map made after it, two starts at once, the Python checks of the .bat. Not tested: macOS, a real winget install, the console minimising itself.

`build_zip.py` leaves the 16k TIFF out and packs the tiles and the help files instead; the zip has not been rebuilt since.

Nothing is pending.

The original project brief (`Downloads\CLAUDE.md`) and the mission CSVs in Downloads have been removed. The copies in `UI/data/` and `UI/flags/` are now the only ones.
