import * as THREE from "three";
import { query } from "./api.js";
import { tagCanvas } from "./markers.js";

// 3D arrows attached to the Moon (1 = one Moon radius): yellow to the Sun and green to the Earth
// from the centre, red and blue out of the north and south poles. The Sun and Earth directions
// come from the team's Python server (query.py, time_series: sun_vector_km / earth_vector_km).
// Each arrow carries its name as a small sprite just past its tip.
export const ARROW_COLOURS = { sun: "#FFD23F", earth: "#3DDC84", north: "#FF4D4D", south: "#4FA3FF" };
const ARROW_NAMES = { sun: "Sun", earth: "Earth", north: "North", south: "South" };
const CENTRE_LENGTH = 1.6; // from the centre: 0.6 radius sticks out of the surface
const POLE_LENGTH = 0.3;   // from the surface; both fit the starting view
const SHAFT_RADIUS = 0.012;
const HEAD_RADIUS = 0.04;
const HEAD_LENGTH = 0.12;
const LABEL_HEIGHT = 0.1; // world units (1 = one Moon radius)
const LABEL_GAP = 0.08;   // past the tip

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const ORIGIN = new THREE.Vector3();

function makeArrow(colour, length) {
  const material = new THREE.MeshStandardMaterial({ color: colour, emissive: colour, emissiveIntensity: 0.35, roughness: 0.6 });
  const shaftLength = length - HEAD_LENGTH;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, shaftLength, 24), material);
  shaft.position.y = shaftLength / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(HEAD_RADIUS, HEAD_LENGTH, 32), material);
  head.position.y = shaftLength + HEAD_LENGTH / 2;
  const arrow = new THREE.Group(); // points along +y from its origin
  arrow.add(shaft, head);
  return arrow;
}

function aim(arrow, from, direction) {
  arrow.position.copy(from);
  arrow.quaternion.setFromUnitVectors(UP, direction.clone().normalize());
}

function makeLabel(key) {
  const canvas = tagCanvas(ARROW_NAMES[key], ARROW_COLOURS[key]);
  const material = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas), sizeAttenuation: true, depthTest: false, transparent: true,
  });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0, 0.5); // anchors the tag's left edge at its position, past the tip
  sprite.scale.set((LABEL_HEIGHT * canvas.width) / canvas.height, LABEL_HEIGHT, 1);
  sprite.renderOrder = 2;
  return sprite;
}

// Places a label just past an arrow's tip, along the same direction.
function placeLabel(label, from, direction, length) {
  label.position.copy(from).addScaledVector(direction, length + LABEL_GAP);
}

// MOON_ME (x towards 0° E on the equator, y towards 90° E, z towards the north pole) → the Moon mesh's axes
const fromMoonME = ([x, y, z]) => new THREE.Vector3(x, z, -y);

export function createArrows() {
  const sun = makeArrow(ARROW_COLOURS.sun, CENTRE_LENGTH);
  const earth = makeArrow(ARROW_COLOURS.earth, CENTRE_LENGTH);
  const north = makeArrow(ARROW_COLOURS.north, POLE_LENGTH);
  const south = makeArrow(ARROW_COLOURS.south, POLE_LENGTH);
  const sunLabel = makeLabel("sun");
  const earthLabel = makeLabel("earth");
  const northLabel = makeLabel("north");
  const southLabel = makeLabel("south");
  sun.visible = earth.visible = sunLabel.visible = earthLabel.visible = false; // until the server has answered
  const group = new THREE.Group();
  group.add(sun, earth, north, south, sunLabel, earthLabel, northLabel, southLabel);

  const cache = new Map(); // one day of hourly vectors per date
  let request = 0;
  let sunDirection = null; // Moon-mesh axes, unit length

  return {
    group,
    sunDirection: () => sunDirection,
    // Base of the pole arrows, on the displaced surface (follows the relief slider)
    placePoles(northBase, southBase) {
      aim(north, northBase, UP);
      aim(south, southBase, DOWN);
      placeLabel(northLabel, northBase, UP, POLE_LENGTH);
      placeLabel(southLabel, southBase, DOWN, POLE_LENGTH);
    },
    // value: "2026-11-14T21:00" (UTC). Returns the hour shown (ms), null if a newer call took over;
    // throws when the server can't answer.
    async setTime(value) {
      const id = ++request;
      const day = value.slice(0, 10);
      let data = cache.get(day);
      if (!data) {
        const [y, m, d] = day.split("-");
        try {
          const res = await query({ points: [{ lat: 0, lon: 0 }], date: `${d}/${m}/${y}`, advanced: { step_hours: 1 } }, false);
          data = { times: res.times.map((t) => Date.parse(`${t}Z`)), sun: res.sun_vector_km, earth: res.earth_vector_km };
          if (cache.size > 40) cache.clear();
          cache.set(day, data);
        } catch (err) {
          if (id === request) {
            sun.visible = earth.visible = sunLabel.visible = earthLabel.visible = false;
            sunDirection = null;
          }
          throw err;
        }
      }
      if (id !== request) return null;
      const { times } = data;
      const t = Date.parse(`${value.slice(0, 16)}:00Z`);
      const i = Math.max(0, Math.min(times.length - 1, Math.round((t - times[0]) / (times[1] - times[0]))));
      sunDirection = fromMoonME(data.sun[i]).normalize();
      const earthDirection = fromMoonME(data.earth[i]).normalize();
      aim(sun, ORIGIN, sunDirection);
      aim(earth, ORIGIN, earthDirection);
      placeLabel(sunLabel, ORIGIN, sunDirection, CENTRE_LENGTH);
      placeLabel(earthLabel, ORIGIN, earthDirection, CENTRE_LENGTH);
      sun.visible = earth.visible = sunLabel.visible = earthLabel.visible = true;
      return times[i];
    },
  };
}
