"""
build_zip.py - makes a copy of the website (UI/) that opens with a double-click, no server needed,
and zips it: dist/Lunar Landing Site Navigator.zip

Browsers block JavaScript modules and fetch() on pages opened from a file, so in the copy:
- all of UI/*.js is bundled into the page, as one inline module script;
- the files the code fetches (data/, the .tif maps, the slope and water maps) are packed into
  assets/*.js scripts, loaded only when the code asks for them and handed out by a fetch() stand-in.
Three.js, geotiff.js and the Inter font still come from the internet, as on the normal site.
The modes that need the team's Python server (Custom Point, Parametric Search (Sun and Earth criteria), Sirona Maps,
the Sun/Earth arrows) say so, unless that server runs on the same computer.

Run from anywhere:  python build_zip.py
"""
import base64
import json
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
UI = ROOT / "UI"
DIST = ROOT / "dist"
NAME = "Lunar Landing Site Navigator"
OUT = DIST / NAME
PAGE = f"{NAME}.html"
MIME = {".png": "image/png", ".jpg": "image/jpeg", ".tif": "image/tiff", ".csv": "text/csv", ".md": "text/markdown", ".json": "application/json"}


def fetched(rel):
    """Files the code loads with fetch() (everything else is used by CSS or <img> and stays a file)."""
    return (rel.startswith("data/") or rel.startswith("help/") or rel.startswith("tif/lroc_16k_tiles/") or rel.endswith(".tif")
            or rel in {"tif/slope_16.png", "tif/water_4k.png"})


# The 16k colour map (~950 MB): the site only uses its tiles (tools/make_highres_tiles.py)
LEFT_OUT = {"tif/lroc_color_16bit_srgb_16k.tif"}


# --- JavaScript: one bundle, each module in its own function scope -------------------------------
IMPORT = re.compile(r'^import\s+(.+?)\s+from\s+"([^"]+)";[ \t]*\r?\n', re.M | re.S)
EXPORT = re.compile(r'^export\s+(?:async\s+)?(?:function\*?\s+|const\s+|let\s+|class\s+)([A-Za-z_$][\w$]*)', re.M)


def module_var(name):
    return "__m_" + re.sub(r"\W", "_", name.removesuffix(".js"))


def bundle(entry="main.js"):
    order, sources = [], {}

    def visit(name):  # dependencies first
        if name in sources:
            return
        sources[name] = (UI / name).read_text(encoding="utf-8-sig")
        for _, spec in IMPORT.findall(sources[name]):
            if spec.startswith("./"):
                visit(spec[2:])
        order.append(name)

    visit(entry)
    externals, exports, parts = {}, {}, []
    for name in order:
        head = []

        def replace(m):
            what, spec = " ".join(m.group(1).split()), m.group(2)
            local = spec.startswith("./")
            target = module_var(spec[2:]) if local else externals.setdefault(spec, f"__ext{len(externals)}")
            if what.startswith("* as "):
                head.append(f"const {what[5:]} = {target};")
                return ""
            names = [n.strip() for n in what.strip("{} ").split(",") if n.strip()]
            if local:
                missing = [n.split(" as ")[0] for n in names if n.split(" as ")[0] not in exports[spec[2:]]]
                if missing:
                    raise SystemExit(f"{name} imports {missing} from {spec}, which doesn't export them")
            head.append(f"const {{ {', '.join(n.replace(' as ', ': ') for n in names)} }} = {target};")
            return ""

        body = IMPORT.sub(replace, sources[name])
        exports[name] = EXPORT.findall(body)
        body = re.sub(r"^export\s+", "", body, flags=re.M)
        if name == entry:  # left at the top level: nothing imports it, and it uses top-level await
            parts.append(f"// ---- {name}\n" + "\n".join(head) + "\n" + body)
            continue
        parts.append(f"// ---- {name}\nconst {module_var(name)} = (() => {{\n" + "\n".join(head) + "\n"
                     + body + f"\nreturn {{ {', '.join(exports[name])} }};\n}})();\n")
    top = [f'import * as {var} from "{spec}";' for spec, var in externals.items()]
    code = "\n".join(top) + "\n\n" + "\n".join(parts)
    return code.replace("</script", "<\\/script")


# --- fetch() stand-in: hands out the packed files ------------------------------------------------
SHIM = """
// Pages opened from a file can't fetch() the files next to them: the ones the code loads are packed
// in assets/*.js (loaded on first use) and handed out here instead.
(() => {
  const ASSETS = %s;
  const packed = (window.__assets = {});
  const loading = {}, decoding = {};
  const base = new URL(".", document.baseURI).href;
  const realFetch = window.fetch.bind(window);
  const load = (script) => (loading[script] ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = script;
    s.onload = () => { s.remove(); resolve(); };
    s.onerror = () => reject(new TypeError(`Could not load the Moon maps (${script}).\\n\\n` +
      "Extract the whole zip first (right-click > Extract All), then double-click the page in the extracted folder."));
    document.head.append(s);
  }));
  const decode = (b64) => {
    if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64);
    const text = atob(b64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  };
  window.fetch = async (input, init) => {
    const href = input instanceof URL ? input.href : typeof input === "string" ? input : "";
    const url = href && new URL(href, document.baseURI).href;
    const path = url.startsWith(base) ? decodeURIComponent(url.slice(base.length).split(/[?#]/)[0]) : "";
    const asset = ASSETS[path];
    if (!asset) return realFetch(input, init);
    const bytes = await (decoding[path] ??= load(asset.script).then(() => {
      const b = decode(packed[path]);
      delete packed[path]; // frees the text copy (the big maps are ~100 MB of it): a later fetch loads it again
      delete loading[asset.script];
      return b;
    }).finally(() => delete decoding[path]));
    return new Response(bytes, { status: 200, headers: { "Content-Type": asset.type } });
  };
})();
"""

README = f"""{NAME}
NASA Space Apps Challenge 2026

1. Extract this zip first (Windows: right-click > Extract All; Mac: double-click it).
2. In the extracted folder, double-click "{PAGE}".
   It opens in your web browser (Chrome, Edge, Firefox or Safari).

Needs an internet connection: the 3D engine and the font load from the web.
The Moon maps are inside this folder (about 100 MB), so the first load takes a few seconds.

Custom Point, Parametric Search (Sun and Earth criteria), Sirona Maps and the Sun / Earth arrows need the team's
Python server running on the same computer (http://127.0.0.1:8000). Without it, they say so;
everything else works.
"""


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    (OUT / "assets").mkdir()

    site_text = "\n".join(p.read_text(encoding="utf-8-sig") for p in UI.glob("*") if p.suffix in {".html", ".css", ".js"})
    assets = {}
    for f in sorted(p for p in UI.rglob("*") if p.is_file()):
        rel = f.relative_to(UI).as_posix()
        if f.suffix in {".js", ".html"} or rel.startswith(".") or rel in LEFT_OUT:
            continue
        if fetched(rel):
            script = f"assets/{len(assets)}.js"
            b64 = base64.b64encode(f.read_bytes()).decode("ascii")
            (OUT / script).write_text(f"window.__assets[{json.dumps(rel)}]=\"{b64}\";\n", encoding="ascii")
            assets[rel] = {"script": script, "type": MIME.get(f.suffix, "application/octet-stream")}
        elif rel not in site_text:
            print(f"left out (not used by the site): {rel}")
        else:
            (OUT / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, OUT / rel)

    html = (UI / "index.html").read_text(encoding="utf-8-sig")
    entry = '<script type="module" src="main.js"></script>'
    if entry not in html:
        raise SystemExit(f"index.html no longer has {entry}: update build_zip.py")
    code = bundle()
    # main.js's load error tells to use Live Server, which doesn't apply here: show the shim's message
    code, n = re.subn(r"statusEl\.textContent =\s*`\$\{err\.message\}.*?Live Server\.`;",
                      "statusEl.textContent = err.message;", code, flags=re.S)
    if not n:
        print("warning: main.js's load error message changed, so it still mentions Live Server")
    html = html.replace(entry, f"<script>{SHIM % json.dumps(assets)}</script>\n"
                               f"  <script type=\"module\">\n{code}\n  </script>")
    (OUT / PAGE).write_text(html, encoding="utf-8")
    (OUT / "README.txt").write_text(README, encoding="utf-8")

    archive = DIST / f"{NAME}.zip"
    archive.unlink(missing_ok=True)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(OUT.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(DIST).as_posix())
    print(f"{archive}  ({archive.stat().st_size / 1e6:.1f} MB, {len(assets)} packed files)")


if __name__ == "__main__":
    main()
