import { el } from "./panel.js";

// The team's Python server. Started by "Start Windows.bat" / "Start Mac.command" (launcher.py), it
// sends this page too: then it is at the page's own address. Otherwise (Live Server, or
// "python -m uvicorn server:app --port 8000" run in Python_backend) it is on port 8000.
const PORT_8000 = "http://127.0.0.1:8000";
const server = fetch("health").then(
  (r) => (r.ok && (r.headers.get("content-type") ?? "").includes("json") ? location.origin : PORT_8000),
  () => PORT_8000,
);
export const EARTH_MIN_EL = 5; // degrees: lower than this, no direct radio link with Earth

export async function post(body) {
  const res = await fetch(`${await server}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().then((j) => j.detail, () => "");
    throw new Error(detail || `The Python server answered HTTP ${res.status}`);
  }
  return res.json();
}

const withRelief = (body, terrain) => ({ ...body, advanced: { ...body.advanced, terrain } });

// relief: hills and crater walls can hide the Sun and the Earth. If the server can't do it,
// it is asked again on a smooth Moon; the answer's "terrain" says which one it is.
export async function query(body, relief = true) {
  if (relief) {
    try {
      return await post(withRelief(body, true));
    } catch (err) {
      if (err instanceof TypeError) throw err; // server not running
    }
  }
  return post(withRelief(body, false));
}

// The note shown when a request failed; action: what to do once the server runs ("search again")
export function serverHelp(err, action) {
  return el("p", "note", err instanceof TypeError
    ? ["Needs the team's Python server: start the app with ", el("code", null, "Start Windows.bat"), " or ",
      el("code", null, "Start Mac.command"), ` (in the project folder), then ${action}.`]
    : `The Python server could not do it: ${err.message}`);
}
