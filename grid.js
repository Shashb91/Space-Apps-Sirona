// Latitude / longitude grid drawn by the Moon's own shader (see extendMoonMaterial in main.js),
// so the lines follow the relief and keep the same width on screen at any zoom.
// Lines every 15°, faint 5° lines when zoomed in; the equator and the prime meridian (0°) are dark.

export const gridUniforms = {
  gridOn: { value: 0 },
  gridPx: { value: 1 }, // device pixels per CSS pixel
};

export function setGridVisible(visible) {
  gridUniforms.gridOn.value = visible ? 1 : 0;
}

export const gridShader = {
  uniforms: gridUniforms,
  head: /* glsl */ `
    uniform float gridOn;
    uniform float gridPx;
    // 0..1 coverage of lines every "step" degrees, "halfWidth" CSS px on each side, anti-aliased
    float gridLine(float deg, float degPerPx, float step, float halfWidth) {
      float distPx = abs(fract(deg / step + 0.5) - 0.5) * step / degPerPx;
      float w = halfWidth * gridPx;
      return 1.0 - smoothstep(w - 0.75, w + 0.75, distPx);
    }
  `,
  // Runs after lighting, so the lines are equally visible everywhere on the disc
  afterLight: /* glsl */ `
    if (gridOn > 0.5) {
      vec2 ll = vec2(vMapUv.x * 360.0 - 180.0, vMapUv.y * 180.0 - 90.0); // lon, lat
      vec2 dx = dFdx(ll), dy = dFdy(ll);
      dx.x -= 360.0 * floor(dx.x / 360.0 + 0.5); // the ±180° seam is not a real jump
      dy.x -= 360.0 * floor(dy.x / 360.0 + 0.5);
      vec2 fw = max(abs(dx) + abs(dy), vec2(1e-6)); // degrees per device pixel

      // Meridians crowd together towards the poles: fade them where they get too close
      float merid15 = smoothstep(8.0, 16.0, 15.0 / fw.x / gridPx);
      float merid5 = smoothstep(8.0, 16.0, 5.0 / fw.x / gridPx);
      float zoomed = smoothstep(40.0, 90.0, 5.0 / fw.y / gridPx); // 5° lines only when zoomed in

      float major = max(gridLine(ll.x, fw.x, 15.0, 0.5) * merid15, gridLine(ll.y, fw.y, 15.0, 0.5));
      float minor = max(gridLine(ll.x, fw.x, 5.0, 0.4) * merid5, gridLine(ll.y, fw.y, 5.0, 0.4)) * zoomed;
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), max(major * 0.45, minor * 0.22));

      // Equator and prime meridian: dark core with a light edge, readable on maria too
      float refEdge = max(gridLine(ll.x, fw.x, 360.0, 2.2) * merid15, gridLine(ll.y, fw.y, 360.0, 2.2));
      float refCore = max(gridLine(ll.x, fw.x, 360.0, 1.2) * merid15, gridLine(ll.y, fw.y, 360.0, 1.2));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), refEdge * 0.5);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.0, 0.0, 0.02), refCore * 0.9);
    }
  `,
};
