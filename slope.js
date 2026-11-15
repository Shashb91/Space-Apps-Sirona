import { Color, DataTexture, RedFormat, UnsignedByteType, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping } from "three";

// Slope debug map, drawn by the Moon's own shader (see extendMoonMaterial in main.js).
// tif/slope_16.png comes from the team's ldem_64_slope.tif: 16 px per degree, north row first,
// from -180° east; each pixel is the mean slope of a 4 × 4 block × 4 (0.25° steps).
const URL = "tif/slope_16.png";
const STEPS_PER_DEGREE = 4;
export const SLOPE_MAX = 30; // degrees: the colour scale ends here, steeper is the same colour

// Flat → steep: one orange, pale and see-through → deep and opaque
export const SLOPE_COLOURS = ["#FFE7C2", "#F28C38", "#A8340A"];
const ALPHA = [0.3, 0.95];

export const slopeUniforms = {
  slopeOn: { value: 0 },
  slopeMap: { value: null },
};

let grid = null;    // { values: Uint8Array, width, height } for the click readout
let loading = null;

export function setSlopeVisible(visible) {
  slopeUniforms.slopeOn.value = visible && grid ? 1 : 0;
}

// Loads the map once (about 11 MB), the first time the tick box is ticked
export function loadSlope(maxTextureSize, anisotropy) {
  loading ??= (async () => {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`Could not load ${URL} (HTTP ${res.status})`);
    const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const scale = Math.min(1, maxTextureSize / bitmap.width); // older phones
    const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
    const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const values = new Uint8Array(width * height);
    for (let i = 0; i < values.length; i++) values[i] = rgba[i * 4];

    const texture = new DataTexture(values, width, height, RedFormat, UnsignedByteType);
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.wrapS = RepeatWrapping;
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
    slopeUniforms.slopeMap.value = texture;
    grid = { values, width, height };
  })();
  loading.catch(() => { loading = null; }); // a later tick tries again
  return loading;
}

// Slope in degrees at (lat, lon), or null before the map is loaded
export function slopeAt(lat, lon) {
  if (!grid) return null;
  const { values, width: W, height: H } = grid;
  const x = Math.floor(((((lon + 180) % 360) + 360) % 360 / 360) * W) % W;
  const y = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
  return values[y * W + x] / STEPS_PER_DEGREE;
}

const vec3 = (hex) => {
  const c = new Color(hex); // converted to the shader's linear colours
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

export const slopeShader = {
  uniforms: slopeUniforms,
  head: "uniform float slopeOn;\nuniform sampler2D slopeMap;\n",
  // After lighting, tinted by the lit surface's brightness so craters stay visible under it
  afterLight: /* glsl */ `
    if (slopeOn > 0.5) {
      float deg = texture2D(slopeMap, vec2(vMapUv.x, 1.0 - vMapUv.y)).r * ${(255 / STEPS_PER_DEGREE).toFixed(2)};
      float t = clamp(deg / ${SLOPE_MAX.toFixed(1)}, 0.0, 1.0);
      vec3 c = mix(${vec3(SLOPE_COLOURS[0])}, ${vec3(SLOPE_COLOURS[1])}, clamp(t * 2.0, 0.0, 1.0));
      c = mix(c, ${vec3(SLOPE_COLOURS[2])}, clamp(t * 2.0 - 1.0, 0.0, 1.0));
      float shade = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, c * (0.35 + 1.6 * shade), mix(${ALPHA[0]}, ${ALPHA[1]}, t));
    }
  `,
};
