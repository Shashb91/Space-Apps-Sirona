# Lunar Landing Site Navigator

NASA Space Apps Challenge 2026, Milano. A 3D Moon to find and compare landing sites: sunlight, the Earth in the sky, temperatures, slopes, water, geology, and rover routes.

## Start it

1. Get this folder: on GitHub, **Code > Download ZIP**, then extract it (Windows: right-click > Extract All).
2. Double-click **`Start Windows.bat`** (Windows) or **`Start Mac.command`** (Mac). On Linux: `python3 launcher.py`.

The app opens in the browser, at http://127.0.0.1:8000. A small window stays open in the taskbar: closing it stops the app.

The first start takes a few minutes. It installs the Python packages in a `.venv` folder (FastAPI, uvicorn, NumPy, SpiceyPy, tifffile, imagecodecs), then downloads from NASA the SPICE kernels (130 MB) and the two maps the app needs (95 MB). The 1.1 GB relief map then comes in the background, while the app already runs, and the slope map for rover routes is made from it (about a minute). If a download stops, the next start goes on with it. The next starts take a few seconds.

It needs:
- Python 3.10 or newer, 64-bit ([python.org](https://www.python.org/downloads/)). On Windows, the Start file offers to install it.
- An internet connection: for the first start, and every time for the 3D engine and the font.
- Chrome, Edge, Firefox or Safari.
- About 2.5 GB of free disk space, with all the maps.

On a Mac, if it says the file can't be opened: right-click it > Open. If it says you don't have permission: in Terminal, `chmod +x "Start Mac.command"`.

## The maps

Too big for GitHub, so the Start file gets them. If you already have them, put them in the folder, next to the Start file (a zip is fine): it moves them into place.

| File | Size | Used for | From |
|---|---|---|---|
| `lroc_color_16bit_srgb_4k.tif` | 62 MB | the Moon's colours (needed) | [NASA](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_4k.tif), at the first start |
| `ldem_16_uint.tif` | 33 MB | the Moon's relief in 3D (needed) | [NASA](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16_uint.tif), at the first start |
| `ldem_64.tif` | 1.1 GB | hills hiding the Sun and the Earth | [NASA](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_64.tif), in the background |
| `ldem_64_slope.tif` | 870 MB | rover routes (Sirona Maps) | made from `ldem_64.tif` by `tools/make_slope_map.py`, once |

The NASA ones come from the [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/). The Start file puts the first two in `UI/tif` and the last two in `Python_backend`. Without the last two the app still works: the Moon is smooth for the Sun and Earth computations, and there are no rover routes.

The slope map is each pixel's slope in degrees, from its neighbours in `ldem_64.tif`: arctan(√((dz/dx)² + (dz/dy)²)), with dy = R × 1/64° and dx = dy × cos(latitude). By hand: `python tools/make_slope_map.py` (it needs NumPy, tifffile and imagecodecs).

## Inside

- `UI/`: the website (Three.js, no build step).
- `Python_backend/`: the server (FastAPI and SPICE). It computes the Sun, the Earth, temperatures and rover routes.
- `launcher.py`: what the Start files run.
- `tools/`: the scripts that make the slope map, the high resolution tiles and the geology data.
