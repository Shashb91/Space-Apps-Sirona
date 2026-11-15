import { DataTexture, RGBAFormat, UnsignedByteType, SRGBColorSpace, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, ClampToEdgeWrapping } from "three";
import { el } from "./panel.js";

// "Add a category" (Visualisation only): a map of the whole Moon from a PNG or TIFF file, drawn by
// the Moon's own shader like the other maps (see extendMoonMaterial in main.js). Not used by the
// other modes, and gone when the page is reloaded.
//
// The file must have the layout of the Moon's colour map: longitude / latitude on a regular grid
// (simple cylindrical, "equirectangular"), the whole Moon, twice as wide as tall, north at the top.
// GeoTIFFs are checked against their georeferencing; a PNG has none, so its left edge is asked.
//   Colour images (PNG, RGB / palette TIFF) are shown with their own colours.
//   Values (one-band TIFF, grey PNG) get a colour scale, and the click readout shows the value.

export const MAX_ADDED = 4;   // the Moon's shader has a slot for each
const MAX_WIDTH = 4096;       // as sharp as the Moon's colour map; larger files are scaled down
const OPACITY = 0.9;
const MOON_RADIUS_KM = 1737.4;
// Values, low → high (viridis: lighter as it grows, readable for colour-blind people)
export const VALUE_COLOURS = ["#440154", "#482878", "#3E4A89", "#31688E", "#26828E", "#1F9E89", "#35B779", "#6DCD59", "#B4DE2C", "#FDE725"];
// GeoTIFF projections (ProjCoordTransGeoKey) that are not a longitude / latitude grid
const PROJECTIONS = {
  1: "Transverse Mercator", 7: "Mercator", 8: "Lambert conformal conic", 9: "Lambert conformal conic",
  10: "Lambert azimuthal equal-area", 11: "Albers equal-area", 12: "Azimuthal equidistant", 14: "Stereographic",
  15: "Polar stereographic", 16: "Oblique stereographic", 19: "Gnomonic", 20: "Miller cylindrical",
  21: "Orthographic", 23: "Robinson", 24: "Sinusoidal", 25: "Van der Grinten",
};
const EQUIRECTANGULAR = 17;

const $ = (id) => document.getElementById(id);
const num = (v) => v.toLocaleString("en-US");
const deg = (v) => `${v < 0 ? "−" : ""}${num(Math.abs(Math.round(v * 10) / 10))}°`;
// A value for the legend and the readout: 4 significant digits, powers of ten when very large or small
export function formatValue(v) {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2).replace("-", "−");
  return `${v < 0 ? "−" : ""}${num(Number(a.toPrecision(4)))}`;
}

// --- Shader: one slot per added category --------------------------------------------------
const SLOTS = [...Array(MAX_ADDED).keys()];
const EMPTY = new DataTexture(new Uint8Array(4), 1, 1);
EMPTY.needsUpdate = true;
export const categoryUniforms = Object.fromEntries(SLOTS.flatMap((i) => [
  [`addedOn${i}`, { value: 0 }],
  [`addedMap${i}`, { value: EMPTY }],
]));

export const categoryShader = {
  uniforms: categoryUniforms,
  head: SLOTS.map((i) => `uniform float addedOn${i};\nuniform sampler2D addedMap${i};\n`).join(""),
  // Like the water map: after lighting, tinted by the lit surface's brightness. Colours are stored
  // premultiplied by their alpha so transparent ("no data") texels don't darken the edges.
  afterLight: SLOTS.map((i) => /* glsl */ `
    if (addedOn${i} > 0.5) {
      vec4 a = texture2D(addedMap${i}, vec2(vMapUv.x, 1.0 - vMapUv.y));
      if (a.a > 0.01) {
        float shade = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, (a.rgb / a.a) * (0.35 + 1.6 * shade), a.a * ${OPACITY.toFixed(2)});
      }
    }`).join(""),
};

// --- Reading and checking a file ---------------------------------------------------------
// What the first bytes say: PNG (with its size from the header), TIFF, or something else
async function sniff(file) {
  const b = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const is = (...bytes) => bytes.every((v, i) => b[i] === v);
  if (is(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)) {
    const view = new DataView(b.buffer);
    return { format: "PNG", width: view.getUint32(16), height: view.getUint32(20), depth: b[24], colourType: b[25] };
  }
  if (is(0x49, 0x49, 0x2A, 0) || is(0x4D, 0x4D, 0, 0x2A) || is(0x49, 0x49, 0x2B, 0) || is(0x4D, 0x4D, 0, 0x2B)) return { format: "TIFF" };
  const other = is(0xFF, 0xD8, 0xFF) ? "a JPEG image" : is(0x47, 0x49, 0x46) ? "a GIF image" : is(0x42, 0x4D) ? "a BMP image"
    : is(0x52, 0x49, 0x46, 0x46) ? "a WebP image" : is(0x25, 0x50, 0x44, 0x46) ? "a PDF" : null;
  return { format: null, other };
}

// Where a GeoTIFF says it is. Returns a check { state, text } plus, when it is a whole-Moon map,
// startLon (longitude of its left edge) and flip (south at the top).
function georeference(image) {
  const fd = image.fileDirectory;
  if (!fd.hasTag("ModelTiepoint") && !fd.hasTag("ModelTransformation")) {
    return { state: "info", text: "No georeferencing in the file: check that its left edge is the longitude chosen below" };
  }
  const t = fd.getValue("ModelTransformation");
  if (t && (t[1] !== 0 || t[4] !== 0)) return { state: "bad", text: "The map is rotated: it must be a plain longitude / latitude grid" };
  const keys = image.getGeoKeys() ?? {};
  const [x0, y0, x1, y1] = image.getBoundingBox();
  const flip = t ? t[5] > 0 : false;
  const crs = keys.ProjectedCSTypeGeoKey;
  const how = keys.ProjCoordTransGeoKey;
  let lonLeft, spanLon, spanLat, latTop, note = "";

  if (keys.GTModelTypeGeoKey === 1 || how !== undefined || (crs && crs !== 32767)) {
    // Projected (x, y in metres): only the equirectangular projection of the Moon is a lon / lat grid
    if (crs && crs !== 32767) return { state: "bad", text: `It uses an Earth map projection (EPSG:${crs}): it must be a longitude / latitude map of the Moon` };
    if (how !== undefined && how !== EQUIRECTANGULAR) {
      return { state: "bad", text: `${PROJECTIONS[how] ?? "Another"} projection: it must be a simple longitude / latitude map (equirectangular)` };
    }
    if (Math.abs(keys.ProjStdParallel1GeoKey ?? 0) > 0.01) {
      return { state: "bad", text: `Equirectangular with a standard parallel at ${deg(keys.ProjStdParallel1GeoKey)}: the map is stretched` };
    }
    const unit = keys.ProjLinearUnitsGeoKey === 9036 ? 1000 : 1; // kilometres or metres
    const radius = keys.GeogSemiMajorAxisGeoKey ?? ((x1 - x0) * unit) / (2 * Math.PI);
    if (Math.abs(radius / 1000 - MOON_RADIUS_KM) > 20) {
      return { state: "bad", text: `Its sphere is ${num(Math.round(radius / 1000))} km wide in radius, not the Moon's ${num(MOON_RADIUS_KM)} km` };
    }
    const toDeg = (m) => ((m * unit) / radius) * (180 / Math.PI);
    const centre = keys.ProjCenterLongGeoKey ?? keys.ProjNatOriginLongGeoKey ?? 0;
    lonLeft = centre + toDeg(x0 - (keys.ProjFalseEastingGeoKey ?? 0));
    spanLon = toDeg(x1 - x0);
    spanLat = toDeg(y1 - y0);
    latTop = toDeg(y1 - (keys.ProjFalseNorthingGeoKey ?? 0));
  } else {
    // Longitude / latitude in degrees
    lonLeft = x0;
    spanLon = x1 - x0;
    spanLat = y1 - y0;
    latTop = y1;
    const datum = keys.GeographicTypeGeoKey;
    if (datum && datum !== 32767 && datum >= 4000 && datum < 5000) note = " (the file says Earth's datum: only its layout is used)";
  }
  if (keys.GTRasterTypeGeoKey === 2) { // pixel centres: the edge is half a pixel further
    lonLeft -= spanLon / image.getWidth() / 2;
    latTop += spanLat / image.getHeight() / 2;
    spanLon *= 1 + 1 / image.getWidth();
    spanLat *= 1 + 1 / image.getHeight();
  }
  const close = (a, b, tol) => Math.abs(a - b) <= tol;
  if (!close(spanLon, 360, 1.5) || !close(spanLat, 180, 1) || !close(latTop, 90, 1)) {
    return {
      state: "bad",
      text: `It covers longitude ${deg(lonLeft)} to ${deg(lonLeft + spanLon)} and latitude ${deg(latTop - spanLat)} to ${deg(latTop)}: it must be the whole Moon (360° × 180°)`,
    };
  }
  lonLeft = ((((lonLeft + 180) % 360) + 360) % 360) - 180;
  return {
    state: "ok",
    text: `Georeferenced: the whole Moon, ${deg(lonLeft)} at the left edge${flip ? ", south at the top (turned over)" : ""}${note}`,
    startLon: lonLeft, flip,
  };
}

const PNG_KINDS = {
  0: ["grey levels, read as values", true], 2: ["colour", false], 3: ["colour (palette)", false],
  4: ["grey levels + transparency, read as values", true], 6: ["colour + transparency", false],
};

// Reads a file into a map the shader can show. onStep(checks, waiting) shows the progress.
// Returns { ok, checks, map } with map = { kind: "colour" | "values", w, h, rgba (straight alpha,
// north row first, the file's left edge first), values (Float32Array, NaN = no data), lo, hi, startLon }.
export async function readMapFile(file, { maxWidth = MAX_WIDTH, signal, onStep = () => {} } = {}) {
  const checks = [];
  const fail = (text) => { checks.push({ state: "bad", text }); return { ok: false, checks }; };
  const head = await sniff(file);
  const ext = (file.name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  if (!head.format) return fail(`Not a PNG or TIFF file${head.other ? `: it is ${head.other}` : ""}`);
  const named = { PNG: ["png"], TIFF: ["tif", "tiff"] }[head.format];

  let W, H, tiff, image, colour, georef = null;
  if (head.format === "PNG") {
    ({ width: W, height: H } = head);
    const [what, values] = PNG_KINDS[head.colourType] ?? ["colour", false];
    colour = !values;
    checks.push({ state: "ok", text: `PNG, ${head.depth}-bit ${what}${head.depth === 16 && values ? " (the browser keeps 8 bits of the 16)" : ""}` });
  } else {
    try {
      tiff = await globalThis.GeoTIFF.fromBlob(file);
      image = await tiff.getImage();
    } catch (err) {
      return fail(`The TIFF could not be read: ${err.message}`);
    }
    W = image.getWidth();
    H = image.getHeight();
    const fd = image.fileDirectory;
    const pi = fd.getValue("PhotometricInterpretation");
    const bands = image.getSamplesPerPixel();
    colour = [2, 3, 5, 6, 8].includes(pi) || (pi === undefined && bands >= 3);
    const type = { 1: "integer", 2: "integer", 3: "float" }[image.getSampleFormat(0)] ?? "integer";
    checks.push({
      state: "ok",
      text: `TIFF, ${bands} band${bands > 1 ? "s" : ""}, ${image.getBitsPerSample(0)}-bit ${type}: ${colour ? "colour" : "values"}${!colour && bands > 1 ? ` (the first of the ${bands} bands)` : ""}`,
    });
  }
  if (!named.includes(ext)) checks.push({ state: "info", text: `Named .${ext || "?"} but it is a ${head.format} file` });

  // Layout: a whole-Moon longitude / latitude grid is twice as wide as tall
  const ratio = W / H;
  if (Math.abs(W - 2 * H) > Math.max(1, 0.005 * W)) {
    return fail(`${num(W)} × ${num(H)} px (${ratio.toFixed(2)} : 1): a map of the whole Moon in longitude / latitude is twice as wide as tall (360° × 180°)`);
  }
  if (H < 90) return fail(`${num(W)} × ${num(H)} px: too small, at least 180 × 90 px (2° per pixel)`);
  checks.push({ state: "ok", text: `${num(W)} × ${num(H)} px: 2 : 1, the shape of a whole-Moon map (${(180 / H).toPrecision(2)}° per pixel)` });
  if (image) {
    georef = georeference(image);
    checks.push({ state: georef.state, text: georef.text });
    if (georef.state === "bad") return { ok: false, checks };
  } else {
    checks.push({ state: "info", text: "A PNG has no georeferencing: check that its left edge is the longitude chosen below" });
  }

  // Read it (scaled down to maxWidth), in bands so that even a 1 GB TIFF fits in memory
  const w = Math.min(W, maxWidth) & ~1, h = w / 2;
  const progress = (f) => onStep(checks, `Reading the file… ${Math.round(f * 100)} %`);
  progress(0);
  let rgba = null, values = null;
  try {
    if (image) ({ rgba, values } = await readTiff(tiff, image, { w, h, colour, flip: georef?.flip, signal, progress }));
    else ({ rgba, values } = await readPng(file, { w, h, colour, depth: head.depth }));
  } catch (err) {
    if (err.name === "AbortError" || signal?.aborted) throw err;
    return fail(`The image could not be decoded: ${err.message}`);
  }
  const map = { kind: colour ? "colour" : "values", w, h, rgba, values, startLon: georef?.startLon ?? null, format: head.format };
  if (values) {
    const scale = colourValues(values);
    if (!scale) return fail("Every pixel is \"no data\"");
    Object.assign(map, scale);
    checks.push({ state: "ok", text: `Values from ${formatValue(scale.lo)} to ${formatValue(scale.hi)} (1st to 99th percentile)${scale.empty ? `, ${scale.empty} % with no data` : ""}` });
  }
  if (w < W) checks.push({ state: "info", text: `Shown at ${num(w)} × ${num(h)} px, like the Moon's colour map` });
  return { ok: true, checks, map };
}

async function readPng(file, { w, h, colour, depth }) {
  const bitmap = await createImageBitmap(file, {
    colorSpaceConversion: "none", premultiplyAlpha: "none", resizeWidth: w, resizeHeight: h, resizeQuality: "high",
  });
  const ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, w, h).data;
  if (colour) return { rgba, values: null };
  // Grey levels: the value is the grey (0-255, or 0-65535 for a 16-bit file); transparent = no data
  const values = new Float32Array(w * h);
  const scale = depth === 16 ? 257 : 1;
  for (let i = 0; i < values.length; i++) values[i] = rgba[i * 4 + 3] ? rgba[i * 4] * scale : NaN;
  return { rgba: null, values };
}

async function readTiff(tiff, image, { w, h, colour, flip, signal, progress }) {
  // A smaller copy inside the file (overview), when there is one big enough, is quicker to read
  let src = image;
  const count = await tiff.getImageCount();
  for (let i = 1; i < count; i++) {
    const o = await tiff.getImage(i);
    const kind = o.fileDirectory.getValue("NewSubfileType") ?? 0;
    if ((kind & 1) && !(kind & 4) && o.getWidth() >= w && o.getWidth() < src.getWidth()) src = o;
  }
  const W = src.getWidth(), H = src.getHeight();
  const fd = image.fileDirectory;
  const pi = fd.getValue("PhotometricInterpretation");
  const bands = image.getSamplesPerPixel();
  const extra = fd.getValue("ExtraSamples");
  const rgbSamples = pi === 2 || (pi === undefined && bands >= 3)
    ? (bands >= 4 && extra && extra[0] !== 0 ? [0, 1, 2, 3] : [0, 1, 2]) : null;
  const scale = image.getSampleFormat(0) === 3 ? 255 : 255 / (2 ** image.getBitsPerSample(0) - 1);
  const nodata = image.getGDALNoData();
  const rgba = colour ? new Uint8ClampedArray(w * h * 4) : null;
  const values = colour ? null : new Float32Array(w * h);
  const pool = new globalThis.GeoTIFF.Pool(); // decodes in background threads
  try {
    const band = Math.max(1, Math.floor((256 * h) / H)); // about 256 rows of the file at a time
    for (let r0 = 0; r0 < h; r0 += band) {
      const r1 = Math.min(h, r0 + band);
      const y0 = Math.floor((r0 * H) / h), y1 = Math.max(y0 + 1, Math.floor((r1 * H) / h));
      const opts = { window: [0, y0, W, y1], width: w, height: r1 - r0, pool, signal, interleave: true };
      const outRow = (r) => (flip ? h - 1 - r : r) * w;
      if (colour) {
        const data = rgbSamples
          ? await src.readRasters({ ...opts, samples: rgbSamples, resampleMethod: "bilinear" })
          : await src.readRGB({ ...opts, resampleMethod: "bilinear" }); // palette, YCbCr, CMYK: 8-bit RGB
        const k = rgbSamples?.length ?? 3, s = rgbSamples ? scale : 1;
        for (let r = r0; r < r1; r++) {
          const o = outRow(r) * 4, i0 = (r - r0) * w * k;
          for (let x = 0; x < w; x++) {
            const i = i0 + x * k, p = o + x * 4;
            rgba[p] = data[i] * s;
            rgba[p + 1] = data[i + 1] * s;
            rgba[p + 2] = data[i + 2] * s;
            rgba[p + 3] = k === 4 ? data[i + 3] * s : 255;
          }
        }
      } else {
        // Nearest pixel, so that "no data" is not blended with real values
        const data = await src.readRasters({ ...opts, samples: [0], resampleMethod: "nearest" });
        for (let r = r0; r < r1; r++) {
          const o = outRow(r), i0 = (r - r0) * w;
          for (let x = 0; x < w; x++) {
            const v = data[i0 + x];
            values[o + x] = v === nodata || !Number.isFinite(v) || Math.abs(v) > 1e30 ? NaN : v;
          }
        }
      }
      progress(r1 / h);
    }
  } finally {
    pool.destroy();
  }
  return { rgba, values };
}

// Colours for values: the scale runs from the 1st to the 99th percentile, so that a few odd pixels
// don't flatten it. Returns { rgba, lo, hi, empty (% of no data) } or null when there is no value.
function colourValues(values) {
  const step = Math.max(1, Math.floor(values.length / 200000));
  const sample = [];
  for (let i = 0; i < values.length; i += step) if (!Number.isNaN(values[i])) sample.push(values[i]);
  if (!sample.length) return null;
  sample.sort((a, b) => a - b);
  let lo = sample[Math.floor(0.01 * (sample.length - 1))], hi = sample[Math.ceil(0.99 * (sample.length - 1))];
  if (hi === lo) { lo = sample[0]; hi = sample.at(-1); }
  const lut = rampLut(VALUE_COLOURS);
  const rgba = new Uint8ClampedArray(values.length * 4);
  const k = hi > lo ? 255 / (hi - lo) : 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    const j = (hi > lo ? Math.min(255, Math.max(0, Math.round((v - lo) * k))) : 128) * 3;
    rgba[i * 4] = lut[j];
    rgba[i * 4 + 1] = lut[j + 1];
    rgba[i * 4 + 2] = lut[j + 2];
    rgba[i * 4 + 3] = 255;
  }
  const empty = Math.round((100 * (Math.ceil(values.length / step) - sample.length)) / Math.ceil(values.length / step));
  return { rgba, lo, hi, empty };
}

// 256 colours along the stops, blended in sRGB like the CSS gradient of the legend
function rampLut(stops) {
  const rgb = stops.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
  const lut = new Uint8Array(256 * 3);
  for (let j = 0; j < 256; j++) {
    const t = (j / 255) * (rgb.length - 1), i = Math.min(rgb.length - 2, Math.floor(t)), f = t - i;
    for (let c = 0; c < 3; c++) lut[j * 3 + c] = Math.round(rgb[i][c] + (rgb[i + 1][c] - rgb[i][c]) * f);
  }
  return lut;
}

// The map moved so that 180° W is its left edge, like the Moon's colour map
function place(map, startLon) {
  const { w, h } = map;
  const shift = ((Math.round(((startLon + 180) / 360) * w) % w) + w) % w;
  if (!shift) return { rgba: map.rgba, values: map.values };
  const roll = (a, k) => {
    if (!a) return null;
    const out = new a.constructor(a.length);
    for (let y = 0; y < h; y++) {
      const row = y * w * k, cut = row + (w - shift) * k;
      out.set(a.subarray(row, cut), row + shift * k);
      out.set(a.subarray(cut, row + w * k), row);
    }
    return out;
  };
  return { rgba: roll(map.rgba, 4), values: roll(map.values, 1) };
}

function makeTexture(rgba, w, h, anisotropy) {
  const data = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) { // premultiplied by alpha (see the shader)
    const a = rgba[i + 3] / 255;
    data[i] = Math.round(rgba[i] * a);
    data[i + 1] = Math.round(rgba[i + 1] * a);
    data[i + 2] = Math.round(rgba[i + 2] * a);
    data[i + 3] = rgba[i + 3];
  }
  const texture = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

// --- The "Add a category" link, its small panel and the added rows ---------------------------
// onChange(): an added category was shown, hidden, added or removed (to refresh the readout)
export function setupCategories({ maxTextureSize, anisotropy, onChange = () => {} }) {
  const pane = $("mode-visualisation");
  const addLink = $("addCategory");
  const dialog = $("categoryDialog");
  const form = $("categoryForm");
  const nameIn = $("categoryName");
  const nameNote = $("categoryNameNote");
  const fileIn = $("categoryFile");
  const edgeSel = $("categoryEdge");
  const checksEl = $("categoryChecks");
  const preview = $("categoryPreview");
  const addGo = $("categoryAdd");
  const fromFile = el("option", null, "");   // the file's own left edge, when it is neither of the two
  const edgeTexts = [...edgeSel.options].map((o) => o.textContent);
  const added = SLOTS.map(() => null); // per shader slot: { name, map, values, box, nodes, texture }
  let read = null;  // the last file read: { ok, checks, map }
  let job = null;   // AbortController of the reading in progress
  let autoName = ""; // the name filled in from the file's name: replaced when another file is chosen

  // The left edge chosen in the list: the file's own, when it says, but it can be changed
  const startLon = () => Number(edgeSel.value);
  const clearFromFile = () => {
    fromFile.remove();
    [...edgeSel.options].forEach((o, i) => { o.textContent = edgeTexts[i]; });
  };
  const names = () => [...pane.querySelectorAll(".tick > span:first-of-type")].map((s) => s.textContent.trim().toLowerCase());

  function updateLink() {
    const full = added.every(Boolean);
    addLink.disabled = full;
    addLink.title = full ? `Up to ${MAX_ADDED} added categories: remove one first` : "Show a map of your own (PNG or TIFF)";
  }

  function showChecks(checks, waiting) {
    const mark = { ok: "✓", bad: "✗", info: "i", wait: "…" };
    checksEl.replaceChildren(...[...checks, ...(waiting ? [{ state: "wait", text: waiting }] : [])].map(({ state, text }) =>
      el("li", `check ${state}`, [el("span", "mark", mark[state]), el("span", null, text)])));
  }

  function validate() {
    const name = nameIn.value.trim();
    const taken = name && names().includes(name.toLowerCase());
    nameNote.textContent = taken ? "Already used: choose another name" : "";
    addGo.disabled = !name || taken || !read?.ok;
  }

  function showPreview() {
    if (!read?.ok) { preview.hidden = true; return; }
    const { map } = read;
    const { rgba } = place(map, startLon());
    const big = new OffscreenCanvas(map.w, map.h);
    big.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), map.w, map.h), 0, 0);
    const ctx = preview.getContext("2d");
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(big, 0, 0, preview.width, preview.height);
    // 0° longitude and the equator, to see where the map sits
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.beginPath();
    ctx.moveTo(preview.width / 2 + 0.5, 0); ctx.lineTo(preview.width / 2 + 0.5, preview.height);
    ctx.moveTo(0, preview.height / 2 + 0.5); ctx.lineTo(preview.width, preview.height / 2 + 0.5);
    ctx.stroke();
    preview.hidden = false;
  }

  function reset() {
    job?.abort();
    job = null;
    read = null;
    autoName = "";
    clearFromFile();
    form.reset();
    edgeSel.value = edgeSel.options[0].value; // 180° W
    checksEl.replaceChildren();
    preview.hidden = true;
    nameNote.textContent = "";
    validate();
  }

  async function inspect() {
    job?.abort();
    read = null;
    preview.hidden = true;
    clearFromFile();
    edgeSel.value = edgeSel.options[0].value;
    validate();
    const file = fileIn.files[0];
    if (!file) { checksEl.replaceChildren(); return; }
    if (!nameIn.value.trim() || nameIn.value === autoName) {
      nameIn.value = autoName = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 32);
    }
    const controller = (job = new AbortController());
    showChecks([], "Reading the file…");
    try {
      const result = await readMapFile(file, {
        maxWidth: Math.min(MAX_WIDTH, maxTextureSize),
        signal: controller.signal,
        onStep: (checks, waiting) => { if (job === controller) showChecks(checks, waiting); },
      });
      if (job !== controller) return;
      read = result;
      showChecks(result.checks);
      if (result.ok && result.map.startLon !== null) {
        // The GeoTIFF says where its left edge is: chosen, and marked in the list
        const same = [...edgeSel.options].find((o) => Number(o.value) === result.map.startLon);
        if (same) same.textContent += " (from the file)";
        else {
          fromFile.value = String(result.map.startLon);
          fromFile.textContent = `${deg(result.map.startLon)} (from the file)`;
          edgeSel.prepend(fromFile);
        }
        edgeSel.value = same ? same.value : fromFile.value;
      }
      showPreview();
    } catch (err) {
      if (job === controller) showChecks([{ state: "bad", text: `Could not read the file: ${err.message}` }]);
    } finally {
      if (job === controller) job = null;
      validate();
    }
  }

  function add() {
    validate();
    const slot = added.indexOf(null);
    if (addGo.disabled || slot < 0) return;
    const { map } = read;
    const name = nameIn.value.trim();
    const { rgba, values } = place(map, startLon());
    const texture = makeTexture(rgba, map.w, map.h, anisotropy); // values: already coloured

    const box = el("input");
    box.type = "checkbox";
    box.checked = true;
    const remove = el("button", "added-remove", "×");
    remove.type = "button";
    remove.title = `Remove ${name}`;
    remove.setAttribute("aria-label", `Remove the category ${name}`);
    const row = el("div", "added-category", [
      el("label", "tick", [box, el("span", null, name), el("span", "count", map.format)]),
      remove,
    ]);
    const ramp = el("span", "ramp");
    ramp.style.background = `linear-gradient(to right, ${VALUE_COLOURS.join(", ")})`;
    const legend = el("div", "contour-legend", map.kind === "values"
      ? [el("span", null, formatValue(map.lo)), ramp, el("span", null, formatValue(map.hi))]
      : [el("span", "legend-note", "The file's own colours")]);
    addLink.before(row, legend);

    const layer = { name, values, w: map.w, h: map.h, box, nodes: [row, legend], texture };
    added[slot] = layer;
    categoryUniforms[`addedMap${slot}`].value = texture;
    const show = () => {
      categoryUniforms[`addedOn${slot}`].value = box.checked ? 1 : 0;
      legend.hidden = !box.checked;
      onChange();
    };
    box.addEventListener("change", show);
    remove.addEventListener("click", () => {
      categoryUniforms[`addedOn${slot}`].value = 0;
      categoryUniforms[`addedMap${slot}`].value = EMPTY;
      texture.dispose();
      layer.nodes.forEach((n) => n.remove());
      added[slot] = null;
      updateLink();
      addLink.focus();
      onChange();
    });
    show();
    updateLink();
    dialog.close();
  }

  addLink.addEventListener("click", () => {
    if (addLink.disabled) return;
    reset();
    dialog.showModal();
  });
  $("categoryCancel").addEventListener("click", () => dialog.close());
  // A click outside the panel (on the dimmed page) closes it too. Only a press and release both
  // on the backdrop itself: picking a choice in the drop-down's list (drawn by the browser, and
  // often hanging below the panel) or dragging out of a text box must not close it.
  const onBackdrop = (e) => {
    if (e.target !== dialog) return false;
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (e) => { pressedOutside = onBackdrop(e); });
  dialog.addEventListener("click", (e) => {
    if (pressedOutside && onBackdrop(e)) dialog.close();
    pressedOutside = false;
  });
  dialog.addEventListener("close", () => { job?.abort(); job = null; });
  fileIn.addEventListener("change", inspect);
  edgeSel.addEventListener("change", showPreview);
  nameIn.addEventListener("input", validate);
  form.addEventListener("submit", (e) => { e.preventDefault(); add(); });
  updateLink();

  // The added values at (lat, lon), for the click readout: [[name, "1,234"], …]
  function readouts(lat, lon) {
    return added.filter((l) => l?.values && l.box.checked).map(({ name, values, w, h }) => {
      const x = Math.floor(((((lon + 180) % 360) + 360) % 360 / 360) * w) % w;
      const y = Math.min(h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * h)));
      const v = values[y * w + x];
      return [name, Number.isNaN(v) ? "no data here" : formatValue(v)];
    });
  }
  return { readouts };
}
