import { el } from "./panel.js";

// The Help button (right of the bottom-left panel): a panel with the help of the mode shown, read
// from help/<mode>.md. The Markdown is text only: headings, paragraphs, lists, **bold**, *italic*,
// `code`, [links](https://…) and --- lines.
const FILES = {
  visualisation: "help/visualisation.md",
  custom: "help/custom.md",
  search: "help/search.md",
  maps: "help/maps.md",
};

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text) {
  return escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// Markdown → HTML (every piece of text escaped first). "# Title" gives an h2: the panel's title.
export function markdown(md) {
  const out = [];
  let para = [];
  let list = null; // { tag: "ul" | "ol", items: [] }
  let quote = [];
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => { if (quote.length) out.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`); quote = []; };
  const flush = () => { flushPara(); flushList(); flushQuote(); };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) flush();
    else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flush();
      const level = m[1].length + 1;
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); flushList();
      quote.push(m[1]);
    } else if ((m = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/))) {
      flushPara(); flushQuote();
      const tag = m[1] ? "ul" : "ol";
      if (list?.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[3]);
    } else if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`; // the item goes on
    } else {
      flushList(); flushQuote();
      para.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}

// currentMode(): the mode shown ("visualisation", "custom", "search" or "maps")
export function setupHelp(currentMode) {
  const button = document.getElementById("helpButton");
  const dialog = document.getElementById("helpDialog");
  const body = document.getElementById("helpBody");
  const title = document.getElementById("helpTitle");
  const texts = new Map(); // mode → Promise of its Markdown

  async function open() {
    const mode = currentMode();
    const file = FILES[mode] ?? FILES.visualisation;
    title.textContent = "Help";
    body.replaceChildren(el("p", "help-note", "Loading…"));
    dialog.showModal();
    button.setAttribute("aria-expanded", "true");
    try {
      if (!texts.has(file)) {
        texts.set(file, fetch(file).then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        }));
      }
      const md = await texts.get(file);
      if (!dialog.open) return;
      body.innerHTML = markdown(md);
      // The first heading goes above the text, next to the ×, and stays there as it scrolls
      const h2 = body.querySelector("h2");
      if (h2) { title.innerHTML = h2.innerHTML; h2.remove(); }
    } catch (err) {
      texts.delete(file);
      body.replaceChildren(el("p", "help-note", `The help could not be loaded (${file}: ${err.message}).`));
    }
    body.scrollTop = 0;
  }

  button.addEventListener("click", () => (dialog.open ? dialog.close() : open()));
  document.getElementById("helpClose").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    button.setAttribute("aria-expanded", "false");
    button.focus();
  });
  // A click on the dimmed page closes it: a press and a release both outside the panel
  const outside = (e) => {
    if (e.target !== dialog) return false;
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (e) => { pressedOutside = outside(e); });
  dialog.addEventListener("click", (e) => {
    if (pressedOutside && outside(e)) dialog.close();
    pressedOutside = false;
  });
}
