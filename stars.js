import * as THREE from "three";

// A made-up night sky: star positions are random (not a real star catalogue), but their
// brightness spread, colours and the Milky Way band follow what the real sky looks like.

const SEED = 2026;
const FIELD_STARS = 9000;
const BAND_STARS = 16000;
const FAINTEST_MAG = 7.5;
const GLOW_STRENGTH = 0.5;

// Where the Milky Way sits: its bright centre just left of the Moon in the starting view, the band steeply tilted.
const GALACTIC_CENTRE = new THREE.Vector3(-0.45, 0.2, -0.87).normalize();
const BAND_TILT = new THREE.Vector3(0.9, 0.45, 0);

// Star colours by spectral class (O/B blue to M orange) and how common each is among visible stars.
const STAR_COLOURS = [
  [0.1, [0.67, 0.75, 1.0]],
  [0.22, [0.79, 0.84, 1.0]],
  [0.18, [0.97, 0.97, 1.0]],
  [0.17, [1.0, 0.96, 0.9]],
  [0.25, [1.0, 0.82, 0.63]],
  [0.08, [1.0, 0.75, 0.47]],
];

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise(rand) {
  const perm = new Uint8Array(512);
  const values = new Float32Array(256);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  for (let i = 0; i < 256; i++) values[i] = rand();
  const fade = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;

  function noise(x, y, z) {
    const xf = Math.floor(x), yf = Math.floor(y), zf = Math.floor(z);
    const X = xf & 255, Y = yf & 255, Z = zf & 255;
    const u = fade(x - xf), v = fade(y - yf), w = fade(z - zf);
    const a = perm[X] + Y, b = perm[X + 1] + Y;
    const aa = perm[a] + Z, ab = perm[a + 1] + Z, ba = perm[b] + Z, bb = perm[b + 1] + Z;
    return lerp(
      lerp(lerp(values[perm[aa]], values[perm[ba]], u), lerp(values[perm[ab]], values[perm[bb]], u), v),
      lerp(lerp(values[perm[aa + 1]], values[perm[ba + 1]], u), lerp(values[perm[ab + 1]], values[perm[bb + 1]], u), v),
      w
    );
  }

  return (x, y, z, octaves = 4) => {
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x * f, y * f, z * f);
      norm += amp;
      f *= 2.03;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Brightness of the Milky Way's glow for a direction (x, y, z) in galactic axes:
// x towards the galactic centre, z towards the galactic north pole.
function milkyWay(fbm, x, y, z) {
  const l = Math.atan2(y, x);
  const b = Math.asin(z);
  const centre = Math.exp(-((l / 1.1) ** 2));
  const width = 0.07 + 0.08 * centre;
  let glow = (0.22 + 0.78 * centre) * Math.exp(-((b / width) ** 2));
  glow += 0.7 * Math.exp(-((l / 0.25) ** 2) - (b / 0.13) ** 2);
  if (glow < 0.003) return 0;

  const clouds = smoothstep(0.25, 0.75, fbm(x * 4, y * 4, z * 4));
  glow *= 0.25 + 1.1 * clouds;

  // Dark dust lanes, and the long ragged "Great Rift" splitting the band near the centre
  const dn = fbm(x * 10 + 7.1, y * 10, z * 10 - 3.3);
  const dust = smoothstep(0.48, 0.7, dn) * Math.exp(-((b / (width * 0.9)) ** 2));
  const riftLine = b - 0.015 - 0.02 * Math.sin(l * 4) - 0.04 * (dn - 0.5);
  const rift = Math.exp(-((riftLine / (0.012 + 0.03 * dn)) ** 2)) * smoothstep(-0.6, -0.2, l) * (1 - smoothstep(1.0, 1.6, l));
  glow *= 1 - 0.85 * Math.max(dust, rift * (0.3 + 0.7 * smoothstep(0.3, 0.6, dn)));
  return glow;
}

function glowColour(x, y) {
  const centre = Math.exp(-((Math.atan2(y, x) / 1.3) ** 2));
  return [0.78 + 0.22 * centre, 0.82 + 0.07 * centre, 1.0 - 0.28 * centre];
}

function pickColour(rand) {
  let r = rand();
  for (const [share, colour] of STAR_COLOURS) {
    if ((r -= share) <= 0) return colour;
  }
  return STAR_COLOURS[0][1];
}

// More stars at each fainter magnitude, as in the real sky (about ×2.8 per magnitude).
const randomMagnitude = (rand, faintest) => faintest + Math.log10(1 - rand()) / 0.45;

function randomDirection(rand) {
  const z = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), r * Math.sin(a), z];
}

function buildStars(rand, field) {
  const positions = [];
  const colours = [];
  const fluxes = [];
  const add = ([x, y, z], mag) => {
    positions.push(x, y, z);
    colours.push(...pickColour(rand));
    fluxes.push(0.7 * 10 ** (-0.4 * (mag - 6)));
  };

  for (let i = 0; i < FIELD_STARS; i++) add(randomDirection(rand), Math.max(-1.4, randomMagnitude(rand, FAINTEST_MAG)));

  // Faint stars crowded where the Milky Way glows, so its clouds look grainy like the real one
  const { W, H, cdf } = field;
  const total = cdf[cdf.length - 1];
  for (let n = 0; n < BAND_STARS; n++) {
    const target = rand() * total;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const l = ((lo % W) + rand()) / W * Math.PI * 2 - Math.PI;
    const b = (Math.floor(lo / W) + rand()) / H * Math.PI - Math.PI / 2;
    add([Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)], Math.max(5.5, randomMagnitude(rand, 10)));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("tint", new THREE.Float32BufferAttribute(colours, 3));
  geometry.setAttribute("flux", new THREE.Float32BufferAttribute(fluxes, 1));
  return geometry;
}

// The glow sampled on a longitude × latitude grid (galactic axes), plus a running total
// weighted by each cell's area, used to scatter the Milky Way's stars.
function milkyWayField(fbm) {
  const W = 512, H = 256;
  const glow = new Float32Array(W * H);
  const cdf = new Float64Array(W * H);
  let total = 0;
  for (let j = 0; j < H; j++) {
    const b = ((j + 0.5) / H - 0.5) * Math.PI;
    const z = Math.sin(b), cb = Math.cos(b);
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (Math.abs(b) < 0.6) {
        const l = ((i + 0.5) / W - 0.5) * Math.PI * 2;
        glow[k] = milkyWay(fbm, cb * Math.cos(l), cb * Math.sin(l), z);
        total += glow[k] * cb;
      }
      cdf[k] = total;
    }
  }
  return { W, H, glow, cdf };
}

function glowTexture({ W, H, glow }) {
  const data = new Uint8Array(W * H * 4);
  for (let j = 0; j < H; j++) {
    const b = ((j + 0.5) / H - 0.5) * Math.PI;
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const g = Math.min(1, glow[k] / 1.3);
      if (!g) continue;
      const l = ((i + 0.5) / W - 0.5) * Math.PI * 2;
      const [r, gr, bl] = glowColour(Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l));
      data[k * 4] = 255 * g * r;
      data[k * 4 + 1] = 255 * g * gr;
      data[k * 4 + 2] = 255 * g * bl;
      data[k * 4 + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, W, H);
  texture.minFilter = THREE.LinearFilter; // no mipmaps: avoids a seam where the longitude wraps
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

// Draws a direction as if it were infinitely far away, behind everything else.
const SKY_POSITION = /* glsl */ `
  vec4 skyPosition(vec3 dir) {
    vec4 p = projectionMatrix * vec4(mat3(modelViewMatrix) * dir, 1.0);
    p.z = p.w * 0.99999;
    return p;
  }
`;

function starMaterial(pixelRatio) {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: pixelRatio } },
    vertexShader: /* glsl */ `
      uniform float uScale;
      attribute vec3 tint;
      attribute float flux;
      varying vec3 vTint;
      varying float vPeak;
      varying float vSigma;
      varying float vSize;
      ${SKY_POSITION}
      void main() {
        gl_Position = skyPosition(position);
        vSigma = 0.75 * max(uScale, 1.0);
        vPeak = flux * uScale * uScale / (6.2832 * vSigma * vSigma);
        vTint = tint;
        // Out to where the star fades below one colour step (the core grows with the log of brightness)
        float radius = vSigma * sqrt(2.0 * log(max(255.0 * vPeak, 1.0)));
        if (vPeak > 8.0) radius = max(radius, 3.0 * vSigma * log(255.0 * min(0.18, 0.004 * vPeak)));
        vSize = 2.0 * ceil(radius) + 1.0;
        gl_PointSize = vSize;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vTint;
      varying float vPeak;
      varying float vSigma;
      varying float vSize;
      void main() {
        vec2 d = (gl_PointCoord - 0.5) * vSize;
        float r2 = dot(d, d);
        float core = vPeak * exp(-r2 / (2.0 * vSigma * vSigma));
        float halo = min(0.18, 0.004 * vPeak) * exp(-sqrt(r2) / (3.0 * vSigma));
        // Bright cores look white, their edges keep the star's colour
        vec3 colour = mix(vTint, vec3(1.0), 0.6 * smoothstep(1.0, 4.0, core));
        gl_FragColor = vec4(colour * (min(core, 1.0) + halo), 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

function glowMaterial(texture) {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: texture }, uStrength: { value: GLOW_STRENGTH } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      ${SKY_POSITION}
      void main() {
        vDir = position;
        gl_Position = skyPosition(position);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uStrength;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec2 uv = vec2(atan(d.y, d.x) / 6.2831853 + 0.5, asin(clamp(d.z, -1.0, 1.0)) / 3.1415927 + 0.5);
        vec3 c = texture2D(uMap, uv).rgb * uStrength;
        // A little noise hides the steps of such a faint gradient
        float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) / 255.0;
        gl_FragColor = vec4(c + grain * step(0.002, c.r), 1.0);
      }
    `,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

export function createSky(pixelRatio) {
  const rand = mulberry32(SEED);
  const fbm = valueNoise(rand);

  const field = milkyWayField(fbm);
  const glow = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), glowMaterial(glowTexture(field)));
  const stars = new THREE.Points(buildStars(rand, field), starMaterial(pixelRatio));
  glow.renderOrder = -2;
  stars.renderOrder = -1;
  glow.frustumCulled = stars.frustumCulled = false; // drawn at infinity, not where their geometry sits

  const sky = new THREE.Group();
  sky.add(glow, stars);
  const pole = BAND_TILT.clone().projectOnPlane(GALACTIC_CENTRE).normalize();
  const side = new THREE.Vector3().crossVectors(pole, GALACTIC_CENTRE);
  sky.matrixAutoUpdate = false;
  sky.matrix.makeBasis(GALACTIC_CENTRE, side, pole);
  return sky;
}
