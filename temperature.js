import { Color, DataTexture, RedFormat, UnsignedByteType, LinearFilter, RepeatWrapping, ClampToEdgeWrapping } from "three";
import { post } from "./api.js";

// Surface temperature over the whole Moon at one instant, from the team's Python server
// (temperature.py: the Hayne et al. 2017 regolith thermal model, driven by the Sun's position from
// the SPICE ephemerides), drawn by the Moon's own shader (see extendMoonMaterial in main.js).
const STEP_DEG = 0.5;
export const TEMP_MIN = 20;  // K: the colour scale (the model goes from about 24 K to 390 K)
export const TEMP_MAX = 400;

// Cold → hot, darker → lighter (inferno from 10 %: the coldest is dark indigo, not black, so the
// night side still shows on the grey Moon)
export const TEMPERATURE_COLOURS = ["#1B0C41", "#4A0C6B", "#781C6D", "#A52C60", "#CF4446", "#ED6925", "#FB9B06", "#F7D13D", "#FCFFA4"];

export const temperatureUniforms = {
  temperatureOn: { value: 0 },
  temperatureMap: { value: null },
};

let grid = null;   // the server's answer: { values (K), step_deg, lat0, lon0, n_lat, n_lon, utc }
let latest = 0;    // only the last request asked for is shown

export function setTemperatureVisible(visible) {
  temperatureUniforms.temperatureOn.value = visible && grid ? 1 : 0;
}

// Asks the server for the map at utc ("2026-11-15T12:00", UTC). Resolves to the instant shown,
// or null when a newer request replaced this one.
export async function loadTemperature(utc) {
  const token = ++latest;
  const res = await post({ temperature_map: { utc: `${utc}:00`.slice(0, 19), step_deg: STEP_DEG } });
  if (token !== latest) return null;
  const { n_lat: H, n_lon: W } = res.grid;
  // One byte per cell (1.5 K steps) for the colours; the readout keeps the server's values
  const bytes = new Uint8Array(W * H);
  const scale = 255 / (TEMP_MAX - TEMP_MIN);
  res.values.forEach((k, i) => { bytes[i] = Math.max(0, Math.min(255, Math.round((k - TEMP_MIN) * scale))); });

  // Rows from the south (lat0) up, columns from -180° east: the same layout as the colour map
  const texture = new DataTexture(bytes, W, H, RedFormat, UnsignedByteType);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  temperatureUniforms.temperatureMap.value?.dispose();
  temperatureUniforms.temperatureMap.value = texture;
  grid = { ...res.grid, values: res.values, utc: res.utc };
  return res.utc;
}

export const temperatureReady = () => !!grid;

// Temperature (K) at (lat, lon) in the loaded map, interpolated between cells; null before
export function temperatureKAt(lat, lon) {
  if (!grid) return null;
  const { values, step_deg: s, lat0, lon0, n_lat: H, n_lon: W } = grid;
  const fy = Math.min(H - 1, Math.max(0, (lat - lat0) / s));
  const fx = ((((lon - lon0) / s) % W) + W) % W;
  const y0 = Math.min(H - 2, Math.floor(fy)), x0 = Math.floor(fx) % W, x1 = (x0 + 1) % W;
  const wy = fy - y0, wx = fx - Math.floor(fx);
  const at = (y, x) => values[y * W + x];
  return (1 - wy) * ((1 - wx) * at(y0, x0) + wx * at(y0, x1)) + wy * ((1 - wx) * at(y0 + 1, x0) + wx * at(y0 + 1, x1));
}

// The same as text: "312 K (39 °C)"; null before the map is loaded
export function temperatureAt(lat, lon) {
  const k = temperatureKAt(lat, lon);
  if (k === null) return null;
  const c = Math.round(k - 273.15);
  return `${Math.round(k)} K (${c < 0 ? "−" : ""}${Math.abs(c)} °C)`;
}

const vec3 = (hex) => {
  const c = new Color(hex); // converted to the shader's linear colours
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

// Piecewise-linear ramp through the colours, t from 0 to 1
const ramp = TEMPERATURE_COLOURS.slice(1).map((hex, i) =>
  `c = mix(c, ${vec3(hex)}, clamp(t - ${i.toFixed(1)}, 0.0, 1.0));`).join("\n      ");

export const temperatureShader = {
  uniforms: temperatureUniforms,
  head: "uniform float temperatureOn;\nuniform sampler2D temperatureMap;\n",
  // After lighting, tinted by the lit surface's brightness so the relief stays visible, but less
  // than the other maps: with the real Sun on, the cold night side must still show its colours
  afterLight: /* glsl */ `
    if (temperatureOn > 0.5) {
      float t = texture2D(temperatureMap, vMapUv).r * ${(TEMPERATURE_COLOURS.length - 1).toFixed(1)};
      vec3 c = ${vec3(TEMPERATURE_COLOURS[0])};
      ${ramp}
      float shade = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, c * (0.55 + 1.1 * shade), 0.85);
    }
  `,
};
