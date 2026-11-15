import { DataTexture, RGBAFormat, UnsignedByteType, SRGBColorSpace, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping } from "three";

// Surface water (H₂O, ppm) map from the team, drawn by the Moon's own shader (see extendMoonMaterial
// in main.js). tif/water_4k.png comes from carte_eau_lune_sans_quadrillage.tif: same colours,
// -180° at the left edge, north row first; the grey "no data" areas are transparent.
const URL = "tif/water_4k.png";

// The team's colour bar, 0 → 1000 ppm (ESPAT 0 → 0.2), for the legend
export const WATER_COLOURS = ["#FDDEFD", "#FE1BFD", "#3700FE", "#259BFD", "#1EFF62", "#69FF00", "#FECF00", "#E15001", "#771500"];
export const WATER_MAX_PPM = 1000;

// Hue (°) → ppm along that colour bar, where each value has its own hue (133 → 853 ppm).
// Below it the bar only fades from magenta to white, above it red only darkens.
const HUE_TO_PPM = [
  [22.5, 853], [27.4, 833], [32.7, 813], [38.1, 793], [44.0, 773], [49.4, 753], [54.7, 733], [60.2, 713],
  [66.2, 693], [74.4, 673], [82.5, 653], [91.6, 633], [99.3, 613], [107.0, 593], [114.5, 573], [123.0, 553],
  [127.0, 533], [132.3, 513], [140.4, 493], [150.3, 473], [162.8, 453], [173.8, 433], [183.5, 413], [195.3, 393],
  [209.0, 373], [220.9, 353], [229.2, 333], [235.1, 313], [238.0, 293], [243.1, 273], [250.6, 253], [257.8, 233],
  [265.2, 213], [273.9, 193], [283.0, 173], [292.0, 153], [299.8, 133],
];

export const waterUniforms = {
  waterOn: { value: 0 },
  waterMap: { value: null },
};

let grid = null; // { rgba, width, height } for the click readout
let loading = null;

export function setWaterVisible(visible) {
  waterUniforms.waterOn.value = visible && grid ? 1 : 0;
}

// Loads the map once (about 11 MB), the first time the tick box is ticked
export function loadWater(maxTextureSize, anisotropy) {
  loading ??= (async () => {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`Could not load ${URL} (HTTP ${res.status})`);
    const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const scale = Math.min(1, maxTextureSize / bitmap.width); // older phones
    const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
    const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, width, height);
    const rgba = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer);

    const texture = new DataTexture(rgba, width, height, RGBAFormat, UnsignedByteType);
    texture.colorSpace = SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.wrapS = RepeatWrapping;
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
    waterUniforms.waterMap.value = texture;
    grid = { rgba, width, height };
  })();
  loading.catch(() => { loading = null; }); // a later tick tries again
  return loading;
}

export const waterReady = () => !!grid;

// Water (ppm) at (lat, lon) read back from the map's colour; null where the map has no data,
// undefined before it is loaded. Where the bar has no hue of its own, the shade is used: white →
// magenta for 0 → 133 ppm, orange → dark red for 853 → 1000 ppm.
export function waterPpmAt(lat, lon) {
  if (!grid) return undefined;
  const { rgba, width: W, height: H } = grid;
  const x = Math.floor(((((lon + 180) % 360) + 360) % 360 / 360) * W) % W;
  const y = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
  const k = (y * W + x) * 4;
  if (!rgba[k + 3]) return null;
  const [r, g, b] = [rgba[k], rgba[k + 1], rgba[k + 2]];
  const hue = ((Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI + 360) % 360;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const [lowHue, lowPpm] = HUE_TO_PPM.at(-1), [highHue, highPpm] = HUE_TO_PPM[0];
  if (hue >= lowHue && hue < 345) return clamp((lowPpm * (222 - g)) / 195, 0, lowPpm);
  if (hue < highHue || hue >= 345) return clamp(highPpm + ((WATER_MAX_PPM - highPpm) * (225 - r)) / 106, highPpm, WATER_MAX_PPM);
  const j = HUE_TO_PPM.findIndex(([h]) => h > hue);
  const [h0, p0] = HUE_TO_PPM[j - 1], [h1, p1] = HUE_TO_PPM[j];
  return p0 + ((hue - h0) / (h1 - h0)) * (p1 - p0);
}

// The same as text: "≈ 420 ppm", "no data here"; null before the map is loaded
export function waterAt(lat, lon) {
  const ppm = waterPpmAt(lat, lon);
  if (ppm === undefined) return null;
  return ppm === null ? "no data here" : `≈ ${Math.round(ppm / 10) * 10} ppm`;
}

export const waterShader = {
  uniforms: waterUniforms,
  head: "uniform float waterOn;\nuniform sampler2D waterMap;\n",
  // After lighting, tinted by the lit surface's brightness like the other maps. "No data" texels are
  // transparent black, so the filtered colour is divided by its alpha to avoid dark edges.
  afterLight: /* glsl */ `
    if (waterOn > 0.5) {
      vec4 w = texture2D(waterMap, vec2(vMapUv.x, 1.0 - vMapUv.y));
      if (w.a > 0.01) {
        float shade = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, (w.rgb / w.a) * (0.35 + 1.6 * shade), w.a * 0.9);
      }
    }
  `,
};
