import { CanvasTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, ClampToEdgeWrapping, SRGBColorSpace } from "three";

// "High resolution" tick box: the 16k colour map over the area the camera zooms into, drawn over
// the 4k map of the globe (see extendMoonMaterial in main.js). The 16k file
// (tif/lroc_color_16bit_srgb_16k.tif, ~950 MB) is too big for a browser, so
// tools/make_highres_tiles.py cuts it into 32 × 16 tiles of 512 px (11.25° each); only the tiles
// of the visible area are loaded, and joined into one patch.
const TILES_URL = "tif/lroc_16k_tiles";
const TILE_PX = 512;
const COLS = 32, ROWS = 16;
const TILE_DEG = 360 / COLS;
const PX_PER_DEG = (COLS * TILE_PX) / 360; // 45.5 (the 4k map: 11.4)
const BASE_PX_PER_DEG = 4096 / 360;
const MAX_PATCH_PX = 8 * 2 ** 20; // pixels in one patch (32 MB on the GPU)
const MIN_GAIN = 1.25; // a patch with less than 1.25 × the 4k map's detail isn't worth loading

const EMPTY = new DataTexture(new Uint8Array(4), 1, 1);

export const highResUniforms = {
  highResOn: { value: 0 },
  highResMap: { value: EMPTY },
  highResCenter: { value: [0, 0] },         // lon, lat (degrees)
  highResHalf: { value: [0.0001, 0.0001] }, // half-width, half-height (degrees)
  highResFade: { value: [1, 1, 1, 1] },     // soft W, E, S, N edges (0: the patch ends at a pole or goes all the way round)
};

export const highResShader = {
  uniforms: highResUniforms,
  head: "uniform float highResOn;\nuniform sampler2D highResMap;\nuniform vec2 highResCenter;\nuniform vec2 highResHalf;\nuniform vec4 highResFade;\n",
  // Before lighting, like the base colour map itself: the patch is lit the same way as the rest.
  afterMap: /* glsl */ `
    if (highResOn > 0.5) {
      float lon = vMapUv.x * 360.0 - 180.0;
      float lat = vMapUv.y * 180.0 - 90.0;
      float dLon = lon - highResCenter.x;
      dLon -= 360.0 * floor((dLon + 180.0) / 360.0); // across the ±180° seam
      vec2 t = vec2(dLon, lat - highResCenter.y) / highResHalf;
      vec3 hi = texture2D(highResMap, vec2(0.5 + 0.5 * t.x, 0.5 - 0.5 * t.y)).rgb;
      vec4 e = vec4(1.0 + t.x, 1.0 - t.x, 1.0 + t.y, 1.0 - t.y); // towards the W, E, S, N edges
      vec4 f = mix(step(0.0, e), clamp(e * 12.0, 0.0, 1.0), highResFade);
      diffuseColor.rgb = mix(diffuseColor.rgb, hi, min(min(f.x, f.y), min(f.z, f.w)));
    }
  `,
};

let shown = null; // the patch on the globe: { colMin, colMax, rowMin, rowMax, px, texture }
let token = 0;
const blobs = new Map(); // tile files already fetched (all of them: 25 MB)

export function setHighResVisible(visible) {
  highResUniforms.highResOn.value = visible && shown ? 1 : 0;
}

export function clearHighRes() {
  token++;
  shown?.texture.dispose();
  shown = null;
  highResUniforms.highResMap.value = EMPTY; // otherwise the shader would upload the patch again
  setHighResVisible(false);
}

// The tiles for a lat/lon box (degrees; lonMin / lonMax unwrapped, lonMax − lonMin ≥ 360 for a
// view all the way round) and their size in the patch, from the screen's pixels per degree
// straight below the camera. Returns "wide" when the 4k map is enough there (the patch is then
// removed), "kept" when the patch shown already covers it, or a plan for loadHighRes.
export function planHighRes(bbox, screenPxPerDeg, maxSide) {
  let colMin = Math.floor((bbox.lonMin + 180) / TILE_DEG);
  let colMax = Math.floor((bbox.lonMax + 180) / TILE_DEG);
  if (colMax - colMin + 1 >= COLS) [colMin, colMax] = [0, COLS - 1];
  const rowMin = Math.max(0, Math.floor((90 - bbox.latMax) / TILE_DEG));
  const rowMax = Math.min(ROWS - 1, Math.floor((90 - bbox.latMin) / TILE_DEG));
  const nCols = colMax - colMin + 1, nRows = rowMax - rowMin + 1;
  const scale = Math.min(1, Math.sqrt(MAX_PATCH_PX / (nCols * nRows * TILE_PX ** 2)),
    maxSide / (nCols * TILE_PX), maxSide / (nRows * TILE_PX));
  const px = Math.min(Math.floor(TILE_PX * scale), Math.ceil(screenPxPerDeg * TILE_DEG));
  if (px / TILE_DEG < MIN_GAIN * BASE_PX_PER_DEG) {
    if (shown) clearHighRes();
    return "wide";
  }
  if (shown && px <= shown.px && rowMin >= shown.rowMin && rowMax <= shown.rowMax && covers(shown, colMin, colMax)) return "kept";
  return { colMin, colMax, rowMin, rowMax, px };
}

// Whether the patch shown spans columns colMin..colMax (which may run past either end of 0..31)
function covers(patch, colMin, colMax) {
  if (patch.colMax - patch.colMin + 1 >= COLS) return true;
  const start = ((colMin - patch.colMin) % COLS + COLS) % COLS;
  return start + (colMax - colMin) <= patch.colMax - patch.colMin;
}

async function tile(row, col, px) {
  const key = `${row}/${((col % COLS) + COLS) % COLS}`;
  if (!blobs.has(key)) {
    const url = `${TILES_URL}/${key}.jpg`;
    blobs.set(key, fetch(url).then((res) => {
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.blob();
    }));
  }
  try {
    return await createImageBitmap(await blobs.get(key), { resizeWidth: px, resizeHeight: px, resizeQuality: "high" });
  } catch (err) {
    blobs.delete(key); // try again next time
    throw err;
  }
}

// Loads and shows the plan's tiles. Resolves to false if a newer view or the tick box replaced it.
export async function loadHighRes(plan, anisotropy = 1) {
  const mine = ++token;
  const { colMin, colMax, rowMin, rowMax, px } = plan;
  const nCols = colMax - colMin + 1, nRows = rowMax - rowMin + 1;
  const jobs = [];
  for (let r = rowMin; r <= rowMax; r++) {
    for (let c = colMin; c <= colMax; c++) jobs.push(tile(r, c, px).then((bitmap) => ({ bitmap, r, c })));
  }
  const results = await Promise.allSettled(jobs);
  const tiles = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failed = results.find((r) => r.status === "rejected");
  if (failed || mine !== token) {
    for (const { bitmap } of tiles) bitmap.close();
    if (failed && mine === token) throw failed.reason;
    return false;
  }

  const canvas = new OffscreenCanvas(nCols * px, nRows * px);
  const ctx = canvas.getContext("2d");
  for (const { bitmap, r, c } of tiles) {
    ctx.drawImage(bitmap, (c - colMin) * px, (r - rowMin) * px);
    bitmap.close();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false; // row 0 of the canvas is the patch's north edge
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = anisotropy;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;

  shown?.texture.dispose();
  shown = { ...plan, texture };
  const round = nCols >= COLS;
  highResUniforms.highResMap.value = texture;
  highResUniforms.highResCenter.value = [-180 + ((colMin + colMax + 1) / 2) * TILE_DEG, 90 - ((rowMin + rowMax + 1) / 2) * TILE_DEG];
  highResUniforms.highResHalf.value = [(nCols * TILE_DEG) / 2, (nRows * TILE_DEG) / 2];
  highResUniforms.highResFade.value = [round ? 0 : 1, round ? 0 : 1, rowMax === ROWS - 1 ? 0 : 1, rowMin === 0 ? 0 : 1];
  setHighResVisible(true);
  return true;
}
