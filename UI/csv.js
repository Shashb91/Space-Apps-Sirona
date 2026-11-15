export async function fetchCsv(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const bytes = await res.arrayBuffer();
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes); // file re-saved by Excel
  }
  return parseCsv(text);
}

function parseCsv(text) {
  const firstLine = text.slice(0, text.indexOf("\n"));
  const sep = firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",";
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// columns maps each field to its accepted headers (lower case), e.g. { name: ["nom", "name"] }.
export function table(rows, url, columns, required = []) {
  const headerToField = new Map(
    Object.entries(columns).flatMap(([field, headers]) => headers.map((h) => [h, field]))
  );
  const [header, ...body] = rows;
  const fields = header.map((h) => headerToField.get(h.trim().toLowerCase()));
  const unknown = header.filter((h, i) => h.trim() && !fields[i]);
  if (unknown.length) console.warn(`${url}: unrecognised column(s) ignored: ${unknown.join(", ")}`);
  for (const field of required) {
    if (!fields.includes(field)) {
      throw new Error(`${url} has no "${field}" column (accepted headers: ${columns[field].join(" / ")})`);
    }
  }
  return body.map((r) => {
    const obj = {};
    fields.forEach((f, i) => { if (f) obj[f] = (r[i] ?? "").trim(); });
    return obj;
  });
}

export const toNumber = (s) => (s ? (Number.isFinite(Number(s)) ? Number(s) : null) : null);
