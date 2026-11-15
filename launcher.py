"""
launcher.py - what "Start Windows.bat" and "Start Mac.command" run: one click starts the app.

1. Moves the maps put into this folder (loose, in a sub-folder or still in a .zip) to where the
   code reads them (UI/tif, Python_backend).
2. First start: makes a Python environment (.venv) and installs Python_backend/requirements.txt.
3. Downloads what is missing from NASA: the SPICE kernels (NAIF) and the maps (the CGI Moon Kit).
   The 1 GB relief map comes in the background, while the app already runs, and the slope map for
   rover routes is then made from it (tools/make_slope_map.py).
4. Starts the Python server (uvicorn) on port 8000, or the next free one. It also sends the
   website, which opens in the browser. Closing the window stops it.

By hand (Linux):  python3 launcher.py        option: --no-browser
"""
import hashlib
import os
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
import zipfile
from collections import namedtuple
from pathlib import Path

ROOT = Path(__file__).resolve().parent
UI = ROOT / "UI"
BACKEND = ROOT / "Python_backend"
VENV = ROOT / ".venv"
REQUIREMENTS = BACKEND / "requirements.txt"
TITLE = "Lunar Landing Site Navigator"  # the page's <title>: how a running app is found
NAME = "Sirona - " + TITLE
PORTS = range(8000, 8010)  # the first free one: the page finds the server at its own address (UI/api.js)

# The maps, too big for GitHub
Map = namedtuple("Map", "name folder size use needed")
SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/"  # NASA's CGI Moon Kit, svs.gsfc.nasa.gov/4720
MAPS = [
    Map("lroc_color_16bit_srgb_4k.tif", "UI/tif", "62 MB", "the Moon's colours", True),
    Map("ldem_16_uint.tif", "UI/tif", "33 MB", "the Moon's relief in 3D", True),
    Map("ldem_64.tif", "Python_backend", "1.1 GB", "hills hiding the Sun and the Earth", False),
]
SLOPE = BACKEND / "ldem_64_slope.tif"  # rover routes in Sirona Maps: made from ldem_64.tif
MAKE_SLOPE = ROOT / "tools" / "make_slope_map.py"
# The SPICE kernels (Python_backend/load_kernels.py), from NASA NAIF as in download_files.py
NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"
KERNELS = {
    "naif0012.tls": "lsk/",
    "de440.bsp": "spk/planets/",
    "pck00011.tpc": "pck/",
    "moon_pa_de440_200625.bpc": "pck/",
    "moon_de440_220930.tf": "fk/satellites/a_old_versions/",
}
WANTED = {m.name: ROOT / m.folder / m.name for m in MAPS}
WANTED.update({name: BACKEND / name for name in KERNELS})

PACKAGES = ["fastapi", "uvicorn", "numpy", "spiceypy", "tifffile", "imagecodecs"]  # requirements.txt, by import name
NEED_PACKAGES = 3  # exit code of the server step when a package is missing: install them again
LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 127.0.0.1, never via a proxy


# --- 1. The maps put into this folder ------------------------------------------------------------
def place_files():
    """Moves the big files put anywhere in this folder (next to Start, in an extracted download)
    to where the code reads them, and takes them out of the .zip files found here."""
    missing = {name: path for name, path in WANTED.items() if not path.exists()}
    if not missing:
        return
    zips = []
    for folder, subfolders, files in os.walk(ROOT):
        subfolders[:] = [d for d in subfolders if d not in {".git", ".venv", "__pycache__", "node_modules"}]
        for name in files:
            if name in missing:
                move(Path(folder) / name, missing.pop(name))
            elif name.lower().endswith(".zip"):
                zips.append(Path(folder) / name)
    for path in zips:
        if not missing:
            break
        try:
            with zipfile.ZipFile(path) as z:
                for info in z.infolist():
                    name = info.filename.replace("\\", "/").rsplit("/", 1)[-1]
                    if name in missing:
                        unzip(z, info, path, missing.pop(name))
        except (OSError, zipfile.BadZipFile) as e:
            print(f"  Could not read {path.name}: {e}")


def move(src, dest):
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        print(f"  Moved {src.name} into {dest.parent.relative_to(ROOT)}")
    except OSError as e:
        print(f"  Could not move {src}: {e}")


def unzip(z, info, path, dest):
    print(f"  Taking {dest.name} out of {path.name}...")
    part = dest.with_name(dest.name + ".part")
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with z.open(info) as src, open(part, "wb") as out:
            shutil.copyfileobj(src, out, 1 << 20)
        part.replace(dest)
    except (OSError, zipfile.BadZipFile, RuntimeError) as e:  # RuntimeError: a zip with a password
        print(f"  Could not: {e}")
        remove(part)


def missing_maps():
    return [m for m in MAPS if not WANTED[m.name].exists()]


def remove(path):
    try:
        path.unlink()
    except OSError:
        pass


# --- 2. The Python packages ----------------------------------------------------------------------
def venv_python():
    return VENV / "Scripts" / "python.exe" if os.name == "nt" else VENV / "bin" / "python"


def venv_home_exists():
    """False when the Python that .venv was made from has been moved or uninstalled."""
    try:
        for line in (VENV / "pyvenv.cfg").read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "home":
                return Path(value.strip()).is_dir()
    except OSError:
        pass
    return False


def ensure_packages(repair=False):
    """First start, or a new requirements.txt: makes .venv and installs the packages in it."""
    python = venv_python()
    if python.exists() and not venv_home_exists():
        shutil.rmtree(VENV, ignore_errors=True)  # made again below
    stamp = VENV / "installed.txt"
    want = hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()
    if not repair and python.exists() and stamp.exists() and stamp.read_text() == want:
        return True
    if not python.exists():
        print("\nFirst start: making a Python environment for the app (the .venv folder)...")
        if subprocess.call([sys.executable, "-m", "venv", str(VENV)]) != 0 or not python.exists():
            shutil.rmtree(VENV, ignore_errors=True)
            linux = sys.platform.startswith("linux")
            print("It could not be made." + (" On Ubuntu or Debian: sudo apt install python3-venv" if linux else ""))
            return False
    print("\nInstalling the Python packages (a few minutes the first time)...")
    cmd = [str(python), "-m", "pip", "install", "--disable-pip-version-check", "--prefer-binary", "-r", str(REQUIREMENTS)]
    if subprocess.call(cmd + (["--force-reinstall"] if repair else [])) != 0:
        print("\nThe packages could not be installed: check the internet connection, then start again.")
        return False
    stamp.write_text(want)
    return True


# --- 3. Downloads from NASA ----------------------------------------------------------------------
def ssl_context():
    context = ssl.create_default_context()
    try:
        from pip._vendor import certifi  # Python from python.org on a Mac has no certificates of its own
        context.load_verify_locations(certifi.where())
    except Exception:
        pass
    return context


def download(url, dest, context, show):
    """url -> dest through a .part file: a later try goes on from where this one stopped.
    show(done, size) gets the progress (size 0: unknown)."""
    part = dest.with_name(dest.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    request = urllib.request.Request(url, headers={"Range": f"bytes={have}-"} if have else {})
    try:
        r = urllib.request.urlopen(request, timeout=60, context=context)
    except urllib.error.HTTPError as e:
        if e.code == 416 and have:  # the .part doesn't fit the file: start again
            remove(part)
            return download(url, dest, context, show)
        raise
    with r, open(part, "ab" if r.status == 206 else "wb") as out:
        done = have if r.status == 206 else 0
        length = int(r.headers.get("Content-Length") or 0)
        size = done + length if length else 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            show(done, size)
    if size and done != size:
        raise OSError("the download stopped before the end")
    part.replace(dest)


def fetch_now(files, context):
    """Downloads [(name, url)], showing the progress. Returns the names that failed."""
    failed = []
    for name, url in files:
        def show(done, size, name=name):
            print(f"\r  {name}: " + (f"{100 * done // size} %" if size else f"{done >> 20} MB"), end="", flush=True)
        try:
            download(url, WANTED[name], context, show)
            print()
        except OSError as e:
            print(f"\n  Could not download {name}: {e}")
            failed.append(name)
    return failed


def fetch_later(maps, context, on_done):
    """Downloads the maps while the app runs; on_done(map) once each one is complete."""
    def run():
        for m in maps:
            shown = set()

            def show(done, size, name=m.name):
                quarter = 4 * done // size if size else 0
                if 0 < quarter < 4 and quarter not in shown:
                    shown.add(quarter)
                    print(f"  {name}: {100 * done // size} %", flush=True)
            try:
                download(SVS + m.name, WANTED[m.name], context, show)
                print(f"  Done: {m.name} ({m.use}).", flush=True)
                on_done(m)
            except OSError as e:
                print(f"  Could not download {m.name} ({e}): the next start goes on with it.", flush=True)
    threading.Thread(target=run, daemon=True).start()


def make_slope():
    """The slope map, made once from ldem_64.tif, in its own process (its memory is freed after)."""
    print(f"\nMaking {SLOPE.name} from ldem_64.tif, for rover routes in Sirona Maps (about a minute)...", flush=True)
    if subprocess.call([sys.executable, str(MAKE_SLOPE)], stdout=subprocess.DEVNULL) == 0:
        print(f"  Done: {SLOPE.name} (rover routes in Sirona Maps).", flush=True)
    else:
        print(f"  Could not make {SLOPE.name}: the next start tries again.", flush=True)


# --- 4. The server -------------------------------------------------------------------------------
def find_port():
    """(port, socket) for the first free port; (port, None) when the app already runs on it."""
    for port in PORTS:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
        except OSError:  # nothing there: take it
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            if os.name != "nt":
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port, sock
            except OSError:
                sock.close()
                continue
        if ours(port):
            return port, None
    return None, None


def running_port():
    """The port this app already runs on, or None."""
    for port in PORTS:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
        except OSError:
            continue
        if ours(port):
            return port
    return None


def ours(port):
    try:
        with LOCAL.open(f"http://127.0.0.1:{port}/", timeout=3) as r:
            return f"<title>{TITLE}</title>".encode() in r.read(4096)
    except OSError:
        return False


def fix_mime_types():
    """Windows can map .js to text/plain in its registry, and browsers then refuse the page's modules."""
    import mimetypes
    for ext, kind in {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
                      ".md": "text/markdown", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg",
                      ".svg": "image/svg+xml", ".tif": "image/tiff", ".mp3": "audio/mpeg"}.items():
        mimetypes.add_type(kind, ext)


def announce(url, open_browser, minimise):
    for _ in range(240):  # up to a minute for the server to answer
        try:
            LOCAL.open(url, timeout=2).close()
            break
        except OSError:
            time.sleep(0.25)
    print(f"\n  {NAME} is running: {url}")
    print("  Keep this window open (minimised is fine): closing it stops the app.\n", flush=True)
    if open_browser:
        webbrowser.open(url)
        if minimise and os.name == "nt":
            import ctypes
            time.sleep(1)  # the browser first
            window = ctypes.windll.kernel32.GetConsoleWindow()
            if window:
                ctypes.windll.user32.ShowWindow(window, 6)  # SW_MINIMIZE


def serve(open_browser):
    """Runs in .venv's Python: the team's API (Python_backend/server.py) plus the website."""
    port, sock = find_port()
    if port is None:
        print(f"\nPorts {PORTS[0]} to {PORTS[-1]} are all taken: close some programs, then start again.")
        return 1
    url = f"http://127.0.0.1:{port}/"
    if sock is None:
        print(f"\n{NAME} is already running: {url}")
        if open_browser:
            webbrowser.open(url)
        return 0
    try:
        for name in PACKAGES:
            __import__(name)
        import uvicorn
        from fastapi import FastAPI
        from fastapi.staticfiles import StaticFiles
    except ImportError as e:
        print(f"\nA Python package is missing ({e}): installing them again...")
        sock.close()
        return NEED_PACKAGES

    # The kernels and the needed maps before the app opens, the optional maps while it runs
    context = ssl_context()
    missing = missing_maps()
    now = [(name, NAIF + KERNELS[name] + name) for name in KERNELS if not WANTED[name].exists()]
    now += [(m.name, SVS + m.name) for m in missing if m.needed]
    if now:
        print("\nDownloading from NASA (first start only)...")
    failed = fetch_now(now, context)
    lost = [m for m in missing if m.needed and m.name in failed]
    if lost:
        print("\nThe app can't start without " + " and ".join(m.name for m in lost) + ". Download by hand:")
        for m in lost:
            print(f"  {SVS + m.name}")
        print(f"into this folder, next to the Start file, then start again:\n  {ROOT}")
        sock.close()
        return 1
    problems = any(name in KERNELS for name in failed)
    if problems:
        print("Without the SPICE kernels, the Sun and Earth computations don't work: start again to retry.")

    sys.path.insert(0, str(BACKEND))
    os.chdir(BACKEND)
    try:
        from server import app  # /health, /criteria, /query
        import constants
    except Exception:
        traceback.print_exc()
        print("\nThe Python server could not start: only the 3D Moon works "
              "(not Custom Point, the Sun and Earth criteria or Sirona Maps).")
        app, constants, problems = FastAPI(), None, True
    later = [m for m in missing if not m.needed]
    slope = not SLOPE.exists() and MAKE_SLOPE.exists()  # made once ldem_64.tif is there
    if later:
        dem = getattr(constants, "DEM_FILE", None)
        if constants and not WANTED["ldem_64.tif"].exists():
            constants.DEM_FILE = None  # until it is there: a clean "no relief" answer, and the page asks without

        def on_done(m):
            if m.name == "ldem_64.tif":
                if constants:
                    constants.DEM_FILE = dem
                if slope:
                    make_slope()
        for m in later:
            print(f"\nDownloading {m.name} ({m.size}) while the app runs: {m.use} come once it is done"
                  + (", then rover routes." if m.name == "ldem_64.tif" and slope else "."))
        fetch_later(later, context, on_done)
    elif slope:
        threading.Thread(target=make_slope, daemon=True).start()
    fix_mime_types()
    app.mount("/", StaticFiles(directory=UI, html=True), name="website")
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
    threading.Thread(target=announce, args=(url, open_browser, not problems), daemon=True).start()
    server.run(sockets=[sock])
    return 0


# --- One start at a time -------------------------------------------------------------------------
_lock = None


def lock():
    """False when another start from this folder runs (an OS lock, freed when that process ends)."""
    global _lock
    try:
        _lock = open(ROOT / ".launcher.lock", "a+")
    except OSError:
        return True  # a folder it can't write in: no lock
    try:
        if os.name == "nt":
            import msvcrt
            _lock.seek(0)
            msvcrt.locking(_lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    return True


def main():
    args = sys.argv[1:]
    if sys.version_info < (3, 10):
        print(f"This app needs Python 3.10 or newer (this one is {sys.version.split()[0]}): "
              "https://www.python.org/downloads/")
        return 1
    if "--serve" in args:
        return serve(open_browser="--no-browser" not in args)
    if not lock():
        port = running_port()
        if port:
            print(f"{NAME} is already running: http://127.0.0.1:{port}/")
            if "--no-browser" not in args:
                webbrowser.open(f"http://127.0.0.1:{port}/")
        else:
            print(f"{NAME} is already starting, in another window.")
            time.sleep(5)
        return 0
    print(f"{NAME}\n{'=' * len(NAME)}")
    place_files()
    code = 1
    for attempt in range(2):
        if not ensure_packages(repair=attempt > 0):
            return 1
        server = subprocess.Popen([str(venv_python()), str(Path(__file__).resolve()), "--serve"] + args)
        while True:
            try:
                code = server.wait()
                break
            except KeyboardInterrupt:  # Ctrl+C: the server got it too and stops by itself
                pass
        if code != NEED_PACKAGES:
            return code
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
