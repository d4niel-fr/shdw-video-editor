// Tiny DOM toolkit + shared widgets.

type Child = Node | string | number | null | undefined | false | Child[];
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") { for (const [sk, sv] of Object.entries(v)) sk.startsWith("--") ? el.style.setProperty(sk, String(sv)) : ((el.style as any)[sk] = sv); }
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else if (k in el && k !== "list") (el as any)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, kids);
  return el;
}
function append(el: Node, kids: Child[]) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.appendChild(typeof k === "object" ? k : document.createTextNode(String(k)));
  }
}
export const clear = (el: Element) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const svg = (inner: string, vb = "0 0 24 24") => {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return t.content.firstChild as SVGElement;
};

export const I = {
  play: () => svg('<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>'),
  pause: () => svg('<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>'),
  stop: () => svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>'),
  prev: () => svg('<path d="M6 5v14M19 5L9 12l10 7z"/>'),
  next: () => svg('<path d="M18 5v14M5 5l10 7-10 7z"/>'),
  stepB: () => svg('<path d="M15 6l-6 6 6 6"/>'),
  stepF: () => svg('<path d="M9 6l6 6-6 6"/>'),
  loop: () => svg('<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 01-4 4H4"/>'),
  media: () => svg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 9h18M8 5v4M16 5v4"/>'),
  edit: () => svg('<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="7" y="14" width="14" height="6" rx="1.5"/>'),
  motion: () => svg('<circle cx="7" cy="12" r="3"/><circle cx="17" cy="7" r="3"/><circle cx="17" cy="17" r="3"/><path d="M9.6 10.6l4.8-2.2M9.6 13.4l4.8 2.2"/>'),
  color: () => svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/><path d="M12 3v5.5M12 15.5V21M3 12h5.5M15.5 12H21"/>'),
  audio: () => svg('<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>'),
  deliver: () => svg('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2.5A1.5 1.5 0 005.5 21h13a1.5 1.5 0 001.5-1.5V17"/>'),
  spark: () => svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" fill="currentColor" stroke="none"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" fill="currentColor" stroke="none"/>'),
  send: () => svg('<path d="M12 19V5M5 12l7-7 7 7"/>', "0 0 24 24"),
  plus: () => svg('<path d="M12 5v14M5 12h14"/>'),
  minus: () => svg('<path d="M5 12h14"/>'),
  x: () => svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  cursor: () => svg('<path d="M5 3l14 8-6 1.5L10 19z" fill="currentColor" stroke="none"/>'),
  blade: () => svg('<path d="M14 4l6 6-11 11H3v-6z"/><path d="M10 8l6 6"/>'),
  trim: () => svg('<path d="M8 4v16M16 4v16M8 12H4M20 12h-4"/>'),
  hand: () => svg('<path d="M8 13V5.5a1.5 1.5 0 013 0V12m0-6.5a1.5 1.5 0 013 0V12m0-4.5a1.5 1.5 0 013 0V15a6 6 0 01-6 6h-1a6 6 0 01-5-2.7L3.5 15a1.6 1.6 0 012.6-1.8L8 15"/>'),
  magnet: () => svg('<path d="M6 3v8a6 6 0 0012 0V3M6 7h4M14 7h4"/>'),
  link: () => svg('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'),
  marker: () => svg('<path d="M6 3h12v12l-6 6-6-6z"/>'),
  text: () => svg('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  folder: () => svg('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
  import: () => svg('<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>'),
  eye: () => svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: () => svg('<path d="M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4M6.6 6.6A17 17 0 002 12s3.5 7 10 7a9.7 9.7 0 005.4-1.6"/>'),
  lock: () => svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>'),
  unlock: () => svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.5-2"/>'),
  trash: () => svg('<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12M9 7V4h6v3"/>'),
  gear: () => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>'),
  sidebar: () => svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/>'),
  undo: () => svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>'),
  redo: () => svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 000 10h3"/>'),
  wand: () => svg('<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/>'),
  caption: () => svg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 15h4M13 15h4M7 11h10"/>'),
  film: () => svg('<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18"/>'),
  image: () => svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>'),
  music: () => svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  code: () => svg('<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>'),
  zoomIn: () => svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>'),
  zoomOut: () => svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>'),
  fit: () => svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  reveal: () => svg('<path d="M14 3h7v7M10 14L21 3M21 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h5"/>'),
  refresh: () => svg('<path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  heart: () => svg('<path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 00-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 000-7.8z"/>'),
  split: () => svg('<path d="M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4"/>'),
  check: () => svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
};

// ---------- toasts ----------
let toastHost: HTMLElement | null = null;
export function toast(text: string, ms = 2600) {
  if (!toastHost) { toastHost = h("div", { class: "toasts" }); document.body.appendChild(toastHost); }
  const t = h("div", { class: "toast" }, text);
  toastHost.appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 320); }, ms);
}

// ---------- context menu ----------
export interface MenuItem { label?: string; key?: string; action?: () => void; sep?: boolean; header?: string; disabled?: boolean }
let openMenu: HTMLElement | null = null;
export function closeMenu() { openMenu?.remove(); openMenu = null; }
export function menu(x: number, y: number, items: MenuItem[]) {
  closeMenu();
  const m = h("div", { class: "menu" });
  for (const it of items) {
    if (it.sep) m.appendChild(h("hr"));
    else if (it.header) m.appendChild(h("div", { class: "mh" }, it.header));
    else m.appendChild(h("button", { disabled: it.disabled, onclick: () => { closeMenu(); it.action?.(); } }, it.label ?? "", it.key ? h("span", { class: "k" }, it.key) : null));
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  const left = Math.min(x, innerWidth - r.width - 8), top = Math.min(y, innerHeight - r.height - 8);
  m.style.left = left + "px"; m.style.top = top + "px";
  m.style.setProperty("--origin", `${x - left}px ${y - top}px`);
  openMenu = m;
  setTimeout(() => {
    const off = (e: Event) => { if (!m.contains(e.target as Node)) { closeMenu(); removeEventListener("pointerdown", off, true); } };
    addEventListener("pointerdown", off, true);
  });
}

// ---------- modal ----------
export function modal(build: (close: () => void) => HTMLElement, onClose?: () => void) {
  const scrim = h("div", { class: "scrim" });
  const close = () => { scrim.style.animation = "fadeIn .2s reverse forwards"; setTimeout(() => scrim.remove(), 180); onClose?.(); };
  const box = h("div", { class: "modal" }, build(close));
  scrim.appendChild(box);
  scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) close(); });
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); removeEventListener("keydown", esc, true); } };
  addEventListener("keydown", esc, true);
  document.body.appendChild(scrim);
  return close;
}

export function prompt(title: string, value = "", placeholder = ""): Promise<string | null> {
  return new Promise((res) => {
    let done = false;
    modal((close) => {
      const inp = h("input", { type: "text", value, placeholder, style: { width: "100%" } });
      const ok = () => { done = true; res(inp.value); close(); };
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
      return h("div", { class: "col" }, h("h2", {}, title), inp,
        h("div", { class: "row", style: { justifyContent: "flex-end", marginTop: "8px" } },
          h("button", { class: "btn", onclick: () => close() }, "Cancel"), h("button", { class: "btn primary", onclick: ok }, "OK")));
    }, () => { if (!done) res(null); });
  });
}

// ---------- form fields ----------
export function slider(value: number, min: number, max: number, step: number, onInput: (v: number) => void, onStart?: () => void) {
  const r = h("input", { type: "range", min, max, step, value });
  const num = h("input", { type: "number", min, max, step, value: round(value, step) });
  const paint = () => r.style.setProperty("--p", `${((+r.value - min) / (max - min)) * 100}%`);
  paint();
  r.addEventListener("pointerdown", () => onStart?.());
  r.addEventListener("input", () => { num.value = String(round(+r.value, step)); paint(); onInput(+r.value); });
  r.addEventListener("dblclick", () => { /* reset handled by caller via default */ });
  num.addEventListener("focus", () => onStart?.());
  num.addEventListener("change", () => { r.value = num.value; paint(); onInput(+num.value); });
  // scrub on number label drag
  return { range: r, num, set(v: number) { r.value = String(v); num.value = String(round(v, step)); paint(); } };
}
const round = (v: number, step: number) => { const d = Math.max(0, -Math.floor(Math.log10(step || 1))); return +v.toFixed(Math.min(4, d)); };

export function switchEl(on: boolean, onChange: (v: boolean) => void) {
  const s = h("div", { class: "switch" + (on ? " on" : "") });
  s.addEventListener("click", () => { s.classList.toggle("on"); onChange(s.classList.contains("on")); });
  return s;
}

export function group(title: string, body: HTMLElement[], closed = false, extra?: HTMLElement) {
  const g = h("div", { class: "group" + (closed ? " closed" : "") });
  const head = h("div", { class: "gh" }, svgChev(), h("span", { class: "grow" }, title), extra ?? null);
  head.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("button,input,select")) return; g.classList.toggle("closed"); });
  g.append(head, h("div", { class: "gb" }, body));
  return g;
}
const svgChev = () => { const s = svg('<path d="M6 9l6 6 6-6"/>'); s.classList.add("chev"); return s; };

export function fmtTime(s: number) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}

/** Pointer drag helper with capture. */
export function drag(e: PointerEvent, move: (dx: number, dy: number, ev: PointerEvent) => void, up?: (ev: PointerEvent, moved: boolean) => void) {
  const el = e.currentTarget as Element ?? e.target as Element;
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false;
  try { (el as any).setPointerCapture?.(e.pointerId); } catch { /* */ }
  const mv = (ev: PointerEvent) => { if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 2) moved = true; move(ev.clientX - x0, ev.clientY - y0, ev); };
  const end = (ev: PointerEvent) => { removeEventListener("pointermove", mv); removeEventListener("pointerup", end); up?.(ev, moved); };
  addEventListener("pointermove", mv);
  addEventListener("pointerup", end);
}
