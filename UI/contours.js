import {
  Color, DataTexture, DataUtils, RedFormat, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping,
} from "three";

// Elevation contour lines drawn by the Moon's own shader (see extendMoonMaterial in main.js).
// Lines sit at fixed altitudes, multiples of 5 % of the highest elevation. Every 4th one (20 %)
// is always shown; zooming in adds the 10 % lines, then the 5 % ones, without moving any line.
// Line colour shows the elevation.

const STEP_SHARE = 0.05;
const WIDE_ALTITUDE = 2;    // camera height above the surface, in Moon radii
const CLOSE_ALTITUDE = 0.1;
const MIP_LEVELS = 7;

// Low → high, also used for the legend bar on the left
export const CONTOUR_COLOURS = ["#9B7BFF", "#4FA3FF", "#3DDC84", "#FFD23F", "#FF4D4D"];

export const contourUniforms = {
  contourOn: { value: 0 },
  contourElev: { value: null }, // elevation in km
  contourStep: { value: 0.5 },  // km between two of the finest lines
  contourMid: { value: 0 },     // 0..1 visibility of the 10 % lines
  contourMinor: { value: 0 },   // 0..1 visibility of the 5 % lines
  contourMin: { value: -9 },    // km, ends of the colour scale
  contourMax: { value: 10 },
  contourPx: { value: 1 },      // device pixels per CSS pixel
};

export function setContoursVisible(visible) {
  contourUniforms.contourOn.value = visible ? 1 : 0;
}

export function setContourRange(minKm, maxKm) {
  contourUniforms.contourMin.value = minKm;
  contourUniforms.contourMax.value = maxKm;
  contourUniforms.contourStep.value = STEP_SHARE * maxKm;
}

// Fades the finer lines in / out for this camera height; returns the finest spacing shown, in metres
export function updateContourZoom(altitude) {
  const t = Math.log(altitude / CLOSE_ALTITUDE) / Math.log(WIDE_ALTITUDE / CLOSE_ALTITUDE); // 0 close … 1 wide
  const fadeOut = (a, b) => 1 - Math.min(1, Math.max(0, (t - a) / (b - a)));
  const u = contourUniforms;
  u.contourMid.value = fadeOut(0.6, 0.75);
  u.contourMinor.value = fadeOut(0.12, 0.25);
  const every = u.contourMinor.value >= 0.5 ? 1 : u.contourMid.value >= 0.5 ? 2 : 4;
  return every * u.contourStep.value * 1000;
}

// The elevation grid (raw values, converted by toKm) as a half-float texture. The smaller
// copies (mipmaps) are averaged here, so lines stay clean when the whole Moon is in view.
export function setContourElevation({ data, width, height }, toKm, maxTextureSize, anisotropy) {
  const lut = new Uint16Array(65536);
  for (let r = 0; r < lut.length; r++) lut[r] = DataUtils.toHalfFloat(toKm(r));
  const full = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) full[i] = lut[data[i]];
  const mipmaps = [{ data: full, width, height }];

  let prev = data, w = width, h = height;
  while (mipmaps.length < MIP_LEVELS && w % 2 === 0 && h % 2 === 0) {
    const nw = w / 2, nh = h / 2;
    const avg = new Float32Array(nw * nh);
    const half = new Uint16Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const i = 2 * y * w + 2 * x;
        const k = y * nw + x;
        avg[k] = (prev[i] + prev[i + 1] + prev[i + w] + prev[i + w + 1]) / 4;
        half[k] = DataUtils.toHalfFloat(toKm(avg[k]));
      }
    }
    mipmaps.push({ data: half, width: nw, height: nh });
    prev = avg; w = nw; h = nh;
  }
  while (mipmaps.length > 1 && mipmaps[0].width > maxTextureSize) mipmaps.shift(); // older phones

  const { data: top, width: tw, height: th } = mipmaps[0];
  const texture = new DataTexture(top, tw, th, RedFormat, HalfFloatType);
  texture.mipmaps = mipmaps;
  texture.generateMipmaps = false;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  contourUniforms.contourElev.value = texture;
}

const vec3 = (hex) => {
  const c = new Color(hex); // converted to the shader's linear colours
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

const rampSteps = CONTOUR_COLOURS.slice(1)
  .map((hex, i) => `c = mix(c, ${vec3(hex)}, clamp(t * ${CONTOUR_COLOURS.length - 1}.0 - ${i}.0, 0.0, 1.0));`)
  .join("\n      ");

export const contourShader = {
  uniforms: contourUniforms,
  head: /* glsl */ `
    uniform float contourOn;
    uniform sampler2D contourElev;
    uniform float contourStep;
    uniform float contourMid;
    uniform float contourMinor;
    uniform float contourMin;
    uniform float contourMax;
    uniform float contourPx;
    vec3 contourColour(float t) {
      vec3 c = ${vec3(CONTOUR_COLOURS[0])};
      ${rampSteps}
      return c;
    }
    // Halo and core coverage (0..1) of the lines every "every" steps
    vec2 contourLine(float f, float fw, float every) {
      float dist = abs(fract(f / every + 0.5) - 0.5) * every / fw; // device pixels to the nearest line
      // Fade lines where they bunch up (steep crater walls) instead of filling them solid
      float spaced = smoothstep(3.0, 6.0, every / fw / contourPx);
      float halo = 1.0 - smoothstep(1.6 * contourPx - 0.75, 1.6 * contourPx + 0.75, dist);
      float core = 1.0 - smoothstep(0.7 * contourPx - 0.6, 0.7 * contourPx + 0.6, dist);
      return vec2(halo, core) * spaced;
    }
  `,
  // After lighting, like the grid, so the lines read the same on the night side
  afterLight: /* glsl */ `
    if (contourOn > 0.5) {
      float f = texture2D(contourElev, vec2(vMapUv.x, 1.0 - vMapUv.y)).r / contourStep;
      float fw = max(fwidth(f), 1e-6); // steps per device pixel
      vec2 major = contourLine(f, fw, 4.0);
      vec2 mid = contourLine(f, fw, 2.0) * contourMid;
      vec2 minor = contourLine(f, fw, 1.0) * contourMinor;
      vec2 line = max(major, max(mid, minor));
      float every = minor.y > max(mid.y, major.y) ? 1.0 : (mid.y > major.y ? 2.0 : 4.0);
      float level = floor(f / every + 0.5) * every * contourStep; // one colour per line
      vec3 colour = contourColour((level - contourMin) / (contourMax - contourMin));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.0), line.x * 0.55);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, colour, line.y);
    }
  `,
};
