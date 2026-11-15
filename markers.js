// Markers drawn on small canvases. Used as Three.js sprite textures on the Moon
// and as <img> icons in the side panels, so both always look the same.

const OUTLINE = "#100820";
const SIZE = 64; // drawn large and shown small, so they stay sharp on high-DPI screens

function canvas2d() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  return [canvas, canvas.getContext("2d")];
}

// shape: "circle" (mission landing), "diamond" (crash / impact) or "square" (noteworthy location).
export function markerCanvas(colour, shape = "circle") {
  const [canvas, g] = canvas2d();
  const c = SIZE / 2;
  g.beginPath();
  if (shape === "diamond") {
    const r = SIZE * 0.42;
    g.moveTo(c, c - r);
    g.lineTo(c + r, c);
    g.lineTo(c, c + r);
    g.lineTo(c - r, c);
    g.closePath();
  } else if (shape === "square") {
    const r = SIZE * 0.31;
    g.roundRect(c - r, c - r, 2 * r, 2 * r, SIZE * 0.06);
  } else {
    g.arc(c, c, SIZE * 0.36, 0, Math.PI * 2);
  }
  g.fillStyle = colour;
  g.fill();
  g.lineWidth = SIZE * 0.1;
  g.lineJoin = "round";
  g.strokeStyle = OUTLINE;
  g.stroke();
  return canvas;
}

export function ringCanvas() {
  const [canvas, g] = canvas2d();
  g.beginPath();
  g.arc(SIZE / 2, SIZE / 2, SIZE * 0.38, 0, Math.PI * 2);
  g.lineWidth = SIZE * 0.15;
  g.strokeStyle = OUTLINE;
  g.stroke();
  g.lineWidth = SIZE * 0.07;
  g.strokeStyle = "#FFFFFF";
  g.stroke();
  return canvas;
}

export function crosshairCanvas() {
  const [canvas, g] = canvas2d();
  const c = SIZE / 2;
  g.beginPath();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    g.moveTo(c + dx * SIZE * 0.16, c + dy * SIZE * 0.16);
    g.lineTo(c + dx * SIZE * 0.44, c + dy * SIZE * 0.44);
  }
  g.lineCap = "round";
  g.lineWidth = SIZE * 0.13;
  g.strokeStyle = OUTLINE;
  g.stroke();
  g.lineWidth = SIZE * 0.06;
  g.strokeStyle = "#FFFFFF";
  g.stroke();
  g.beginPath();
  g.arc(c, c, SIZE * 0.07, 0, Math.PI * 2);
  g.fillStyle = "#FF4D4D";
  g.fill();
  return canvas;
}

// Parametric Search: one of the best areas, a shiny ball in its panel's colour (as in the panel)
export function ballCanvas(colour) {
  const [canvas, g] = canvas2d();
  const c = SIZE / 2, r = SIZE * 0.36;
  g.beginPath();
  g.arc(c, c, r, 0, Math.PI * 2);
  g.lineWidth = SIZE * 0.13;
  g.strokeStyle = OUTLINE;
  g.stroke();
  const shine = g.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.1, c, c, r);
  shine.addColorStop(0, "#FFFFFF");
  shine.addColorStop(0.25, colour);
  shine.addColorStop(1, "#00000099");
  g.fillStyle = colour;
  g.fill();
  g.fillStyle = shine;
  g.fill();
  g.lineWidth = SIZE * 0.06;
  g.strokeStyle = "#FFFFFF";
  g.stroke();
  return canvas;
}

// Start (A) and destination (B) of a Sirona Maps route: a letter in a gold ring
export function letterCanvas(letter) {
  const [canvas, g] = canvas2d();
  const c = SIZE / 2;
  g.beginPath();
  g.arc(c, c, SIZE * 0.4, 0, Math.PI * 2);
  g.fillStyle = "#000026";
  g.fill();
  g.lineWidth = SIZE * 0.08;
  g.strokeStyle = "#C6BC00";
  g.stroke();
  g.fillStyle = "#FFFFFF";
  g.font = `600 ${SIZE * 0.42}px Inter, system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(letter, c, c + SIZE * 0.03);
  return canvas;
}

// A name tag at the end of a direction arrow: coloured text with a dark outline, no background,
// sized to the text so sprite.center can anchor its left edge at the arrow's tip.
export function tagCanvas(text, colour) {
  const height = SIZE * 0.56;
  const font = `700 ${Math.round(height * 0.72)}px Inter, system-ui, sans-serif`;
  const padX = height * 0.3;
  const probe = canvas2d()[1];
  probe.font = font;
  const canvas = document.createElement("canvas");
  canvas.height = height;
  canvas.width = Math.ceil(probe.measureText(text).width + padX * 2);
  const g = canvas.getContext("2d");
  g.font = font;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.lineJoin = "round";
  g.lineWidth = height * 0.22;
  g.strokeStyle = OUTLINE;
  g.strokeText(text, padX, height / 2 + 1);
  g.fillStyle = colour;
  g.fillText(text, padX, height / 2 + 1);
  return canvas;
}

const urlCache = new Map();
export function markerDataUrl(colour, shape) {
  const key = colour + shape;
  if (!urlCache.has(key)) urlCache.set(key, markerCanvas(colour, shape).toDataURL());
  return urlCache.get(key);
}
